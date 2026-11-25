/**
 * Import dei turni esistenti in Fucina (tappa 7.38).
 *
 *   POST /api/scheduling/projects/:id/turni-esistenti/anteprima   (file; data facoltativa)
 *     → periodo e tipi di giorno del file; con la data, quante corse si
 *       riconoscono nel GTFS del progetto e quali no.
 *   POST /api/scheduling/projects/:id/turni-esistenti             (file, data, nome)
 *     → crea lo scenario dei turni macchina e quello dei turni guida del giorno.
 *
 * Il file (export dei turni dell'azienda) arriva come multipart, si legge in
 * memoria e non si salva: restano solo i turni creati. Serve il permesso di
 * scrittura sui turni (AREE_PER_PREFISSO: /scheduling → turni) e un ruolo da
 * editor nel progetto. L'intestazione X-Cerbero-Import obbliga il browser al
 * controllo CORS prima dell'invio: una pagina di un altro sito non può
 * mandare il modulo con i cookie di chi è collegato.
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { gtfsRoutes, gtfsStops, gtfsTrips } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { legaContesto } from "../contesto-http";
import { timeToMinutes, centroDeiPunti } from "../geo-utils";
import { arrayDiTesto, assignResidenzaToShifts, loadDepotPoints } from "../ottimizza-veicoli/esegui";
import { getActiveServiceIds, getServiceCategory, type TripBlock } from "../ottimizza-veicoli/modello";
import { loadProjectAccessible, logActivity } from "../scheduling-projects";
import { FileTurniNonValido, giorniDelFile, leggiFileTurni, testoDelFile, tipiDiGiorno, turniDelGiorno, type FileTurni } from "./file";
import { abbinaCorse, corseDelFile, type CorsaGtfs } from "./abbina";
import { costruisciTurni, residenzaAiTurniGuida } from "./costruisci";

const router: IRouter = Router();
const MAX_BYTE = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTE, files: 1, fields: 5 } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NON_TROVATE = 300;

/* Un limite suo, per persona: chi sceglie il giorno manda il file a ogni cambio, e il
 * limite dei calcoli pesanti (10 al minuto per indirizzo, condiviso) basterebbe a poco. */
const limiteImport = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => (req.user?.id ? `import:${req.user.id}` : ipKeyGenerator(req.ip ?? "")),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Troppe richieste di import, riprova tra un minuto." },
});

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;

/** Il file nel modulo: i rifiuti di multer (troppo grande, troppi file) si spiegano in chiaro. */
const leggiIlFile = legaContesto(upload.single("file"));
function conFile(req: Request, res: Response, next: NextFunction): void {
  leggiIlFile(req, res, (err?: any) => {
    if (err?.code === "LIMIT_FILE_SIZE") { res.status(413).json({ error: `Il file è troppo grande (massimo ${MAX_BYTE / 1024 / 1024} MB)` }); return; }
    if (err) { res.status(400).json({ error: "Modulo non valido: manda un solo file dei turni" }); return; }
    next();
  });
}

/** Solo dall'app: un'intestazione propria fa partire il controllo CORS (vedi in testa). */
function soloDallApp(req: Request, res: Response, next: NextFunction): void {
  if (req.get("x-cerbero-import") !== "1") { res.status(400).json({ error: "Richiesta non valida" }); return; }
  next();
}

/** Il progetto, se chi chiede ci può scrivere; altrimenti ha già risposto. */
async function progettoScrivibile(req: Request, res: Response): Promise<any | null> {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return null; }
  const p = await loadProjectAccessible(id, req.user!.id);
  if (!p) { res.status(404).json({ error: "Progetto non trovato" }); return null; }
  if (p.my_role === "viewer") { res.status(403).json({ error: "Permesso insufficiente: il progetto è in sola lettura per te" }); return null; }
  if (!p.feed_id) { res.status(409).json({ error: "Il progetto non ha ancora un GTFS: caricalo prima di importare i turni" }); return null; }
  return p;
}

function fileDallaRichiesta(req: Request, res: Response): FileTurni | null {
  const f = (req as any).file as { buffer?: Buffer } | undefined;
  if (!f?.buffer?.length) { res.status(400).json({ error: "Nessun file ricevuto: scegli il file dei turni" }); return null; }
  try {
    return leggiFileTurni(testoDelFile(f.buffer));
  } catch (e) {
    if (e instanceof FileTurniNonValido) { res.status(422).json({ error: `File dei turni non leggibile: ${e.message}` }); return null; }
    throw e;
  }
}

function dataDallaRichiesta(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Le corse del GTFS del progetto attive nel giorno, con orari, fermate e il
 * codice originale (nei feed nati da Planning Studio il trip_id è l'id della
 * corsa del progetto e il codice del GTFS caricato è `ps_trips.codice`).
 */
async function corseDelGiorno(feedId: string, dataYmd: string): Promise<{ blocchi: TripBlock[]; gtfs: CorsaGtfs[]; servizi: number }> {
  const servizi = await getActiveServiceIds(feedId, dataYmd);
  if (servizi.size === 0) return { blocchi: [], gtfs: [], servizi: 0 };
  const tutte = await db.select({
    tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId, serviceId: gtfsTrips.serviceId,
    headsign: gtfsTrips.tripHeadsign, directionId: gtfsTrips.directionId,
    onDemand: gtfsTrips.onDemand, variantCode: gtfsTrips.variantCode,
  }).from(gtfsTrips).where(eq(gtfsTrips.feedId, feedId));
  const corse = tutte.filter((t) => servizi.has(t.serviceId));
  if (corse.length === 0) return { blocchi: [], gtfs: [], servizi: servizi.size };
  const ids = corse.map((t) => t.tripId);
  /* prima e ultima fermata di ogni corsa, con gli orari */
  const fl = await db.execute<{ trip_id: string; f_stop: string; f_t: string | null; l_stop: string; l_t: string | null; n: number }>(sql`
    SELECT trip_id,
           (array_agg(stop_id ORDER BY stop_sequence))[1] AS f_stop,
           (array_agg(COALESCE(departure_time, arrival_time) ORDER BY stop_sequence))[1] AS f_t,
           (array_agg(stop_id ORDER BY stop_sequence DESC))[1] AS l_stop,
           (array_agg(COALESCE(arrival_time, departure_time) ORDER BY stop_sequence DESC))[1] AS l_t,
           count(*)::int AS n
      FROM gtfs_stop_times
     WHERE feed_id = ${feedId} AND trip_id = ANY(${arrayDiTesto(ids)}::text[])
     GROUP BY trip_id`);
  const routeRows = await db.select({ routeId: gtfsRoutes.routeId, shortName: gtfsRoutes.routeShortName, longName: gtfsRoutes.routeLongName })
    .from(gtfsRoutes).where(eq(gtfsRoutes.feedId, feedId));
  const nomeLinea = new Map(routeRows.map((r) => [r.routeId, r.shortName || r.longName || r.routeId]));
  const stopRows = await db.select({ stopId: gtfsStops.stopId, lat: gtfsStops.stopLat, lon: gtfsStops.stopLon, name: gtfsStops.stopName })
    .from(gtfsStops).where(eq(gtfsStops.feedId!, feedId));
  const fermate = new Map(stopRows.map((s) => [s.stopId, { lat: s.lat, lon: s.lon, name: s.name || s.stopId }]));
  const ripiego = centroDeiPunti(fermate.values()) ?? { lat: 0, lon: 0 };

  /* il codice originale delle corse che vengono da Planning Studio */
  const uuid = ids.filter((t) => UUID_RE.test(t));
  const codici = new Map<string, string>();
  for (let i = 0; i < uuid.length; i += 5000) {
    const parte = uuid.slice(i, i + 5000);
    const r = await db.execute<{ id: string; codice: string | null; gtfs_id: string | null }>(sql`
      SELECT id::text AS id, codice, gtfs_id FROM ps_trips WHERE id = ANY(${arrayDiTesto(parte)}::uuid[])`);
    for (const x of r.rows) { const c = x.codice || x.gtfs_id; if (c) codici.set(x.id, c); }
  }

  const perCorsa = new Map(fl.rows.map((r) => [r.trip_id, r]));
  const blocchi: TripBlock[] = [];
  const gtfs: CorsaGtfs[] = [];
  for (const t of corse) {
    const o = perCorsa.get(t.tripId);
    if (!o) continue;
    const dep = o.f_t || "00:00:00";
    const arr = o.l_t || dep;
    const f = fermate.get(o.f_stop), l = fermate.get(o.l_stop);
    const routeName = nomeLinea.get(t.routeId) || t.routeId;
    const b: TripBlock = {
      tripId: t.tripId, routeId: t.routeId, routeName, headsign: t.headsign,
      variantCode: t.variantCode ?? null, directionId: t.directionId ?? 0,
      departureTime: dep, arrivalTime: arr,
      departureMin: timeToMinutes(dep), arrivalMin: timeToMinutes(arr),
      stopCount: Number(o.n), firstStopId: o.f_stop, lastStopId: o.l_stop,
      firstStopLat: f?.lat ?? ripiego.lat, firstStopLon: f?.lon ?? ripiego.lon,
      lastStopLat: l?.lat ?? ripiego.lat, lastStopLon: l?.lon ?? ripiego.lon,
      firstStopName: f?.name || o.f_stop, lastStopName: l?.name || o.l_stop,
      requiredVehicle: "12m", category: getServiceCategory(routeName),
      forced: false, onDemand: !!t.onDemand,
    };
    blocchi.push(b);
    gtfs.push({ tripId: t.tripId, codice: codici.get(t.tripId) ?? t.tripId, linea: routeName, partenza: b.departureMin, arrivo: b.arrivalMin });
  }
  return { blocchi, gtfs, servizi: servizi.size };
}

/** I turni del giorno costruiti sul GTFS del progetto. */
async function costruisci(file: FileTurni, data: string, feedId: string) {
  const turni = turniDelGiorno(file, data);
  const giorno = await corseDelGiorno(feedId, data.replace(/-/g, ""));
  const abbinamento = abbinaCorse(corseDelFile(turni), giorno.gtfs);
  const esito = costruisciTurni({
    file, data, turni, abbinamento, corseDelGiorno: giorno.blocchi, serviziAttivi: giorno.servizi,
  });
  return { turni, giorno, abbinamento, esito };
}

function tipoDelGiornoDi(file: FileTurni, data: string): string {
  const g = giorniDelFile(file).find((x) => x.data === data);
  return g ? g.superlivelli.map((s) => s.nome).join(" + ") : "";
}

router.post("/scheduling/projects/:id/turni-esistenti/anteprima", limiteImport, soloDallApp,
  conFile, async (req, res) => {
    try {
      const p = await progettoScrivibile(req, res);
      if (!p) return;
      const file = fileDallaRichiesta(req, res);
      if (!file) return;
      const tipi = tipiDiGiorno(giorniDelFile(file));
      const data = dataDallaRichiesta(req.body?.data);
      const base = {
        periodo: { dal: file.dal, al: file.al },
        tipiDiGiorno: tipi.map((t) => ({ chiave: t.chiave, nomi: t.nomi, date: t.date, turniGuida: t.turniGuida, turniMacchina: t.turniMacchina })),
      };
      if (!data) { res.json(base); return; }
      if (!file.calendario.has(data)) { res.status(400).json({ error: "Il file non ha turni per questa data" }); return; }
      const { giorno, abbinamento, esito } = await costruisci(file, data, p.feed_id);
      res.json({
        ...base,
        data,
        tipoDelGiorno: tipoDelGiornoDi(file, data),
        gtfs: { corseDelGiorno: giorno.blocchi.length, serviziAttivi: giorno.servizi },
        resoconto: esito.resoconto,
        nonTrovate: abbinamento.nonTrovate.slice(0, MAX_NON_TROVATE).map((c) => ({
          linea: c.linea, partenza: hhmm(c.partenza), arrivo: hhmm(c.arrivo),
          da: file.nodi.get(c.da) || c.da, a: file.nodi.get(c.a) || c.a,
          turnoGuida: c.turnoGuida, turnoMacchina: c.turnoMacchina,
        })),
      });
    } catch (e: any) {
      req.log.error({ err: e?.message }, "anteprima turni esistenti");
      res.status(500).json({ error: "Errore nella lettura del file dei turni" });
    }
  });

router.post("/scheduling/projects/:id/turni-esistenti", limiteImport, soloDallApp,
  conFile, async (req, res) => {
    try {
      const p = await progettoScrivibile(req, res);
      if (!p) return;
      const file = fileDallaRichiesta(req, res);
      if (!file) return;
      const data = dataDallaRichiesta(req.body?.data);
      if (!data) { res.status(400).json({ error: "Scegli il giorno da importare" }); return; }
      if (!file.calendario.has(data)) { res.status(400).json({ error: "Il file non ha turni per questa data" }); return; }
      const { esito, giorno } = await costruisci(file, data, p.feed_id);
      if (giorno.blocchi.length === 0) {
        res.status(409).json({ error: "Nel GTFS del progetto non ci sono corse in questo giorno: controlla che il GTFS copra il periodo del file" });
        return;
      }
      if (esito.veicoli.shifts.length === 0) {
        res.status(409).json({ error: "Nessuna corsa del file si trova nel GTFS del progetto: i turni non si possono agganciare" });
        return;
      }

      // residenza di servizio come nei turni calcolati (deposito più vicino a inizio e fine)
      const depositi = await loadDepotPoints(p.id).catch(() => []);
      assignResidenzaToShifts(esito.veicoli.shifts, giorno.blocchi, depositi);
      residenzaAiTurniGuida(esito.guida, esito.veicoli.shifts);

      const [gg, mm, aaaa] = [data.slice(8, 10), data.slice(5, 7), data.slice(0, 4)];
      const nomeChiesto = typeof req.body?.nome === "string" ? req.body.nome.trim().slice(0, 120) : "";
      const nome = nomeChiesto || `Turni esistenti · ${gg}/${mm}/${aaaa}`;
      const cat = esito.veicoli.summary.byCategory;
      const serviceType = (cat.urbano ?? 0) > 0 && (cat.extraurbano ?? 0) > 0 ? "misto" : (cat.extraurbano ?? 0) > 0 ? "extraurbano" : "urbano";
      const importazione = {
        origine: "turni-esistenti", data, tipoDelGiorno: tipoDelGiornoDi(file, data),
        periodo: { dal: file.dal, al: file.al }, resoconto: esito.resoconto, importatoIl: new Date().toISOString(),
      };
      const input = { date: data.replace(/-/g, ""), serviceType, source: "turni-esistenti", routes: [] };
      const config = { source: "turni-esistenti", savedAt: importazione.importatoIl, importazione };

      const ids = await db.transaction(async (tx) => {
        const sps = await tx.execute<{ id: string }>(sql`
          INSERT INTO service_program_scenarios (name, date, feed_id, input, result, owner_user_id, project_id, config)
          VALUES (${nome}, ${input.date}, ${p.feed_id}::uuid, ${JSON.stringify(input)}::jsonb,
                  ${JSON.stringify({ ...esito.veicoli, importazione })}::jsonb,
                  ${req.user!.id}::uuid, ${p.id}::uuid, ${JSON.stringify(config)}::jsonb)
          RETURNING id`);
        const spsId = sps.rows[0]!.id;
        const dss = await tx.execute<{ id: string }>(sql`
          INSERT INTO driver_shift_scenarios (service_program_scenario_id, name, result, config, owner_user_id, project_id)
          VALUES (${spsId}::uuid, ${`${nome} · turni guida`},
                  ${JSON.stringify({ ...esito.guida, scenarioId: spsId, scenarioName: nome, date: input.date, solver: "turni-esistenti", importazione })}::jsonb,
                  ${JSON.stringify(config)}::jsonb, ${req.user!.id}::uuid, ${p.id}::uuid)
          RETURNING id`);
        return { vehicleScenarioId: spsId, driverScenarioId: dss.rows[0]!.id };
      });
      await logActivity(p.id, req.user!.id, "scenario.import", {
        targetType: "vehicle_scenario", targetId: ids.vehicleScenarioId,
        payload: { data, turniMacchina: esito.resoconto.turniMacchina, turniGuida: esito.resoconto.turniGuida },
      });
      res.json({ ...ids, nome, resoconto: esito.resoconto });
    } catch (e: any) {
      req.log.error({ err: e?.message }, "import turni esistenti");
      res.status(500).json({ error: "Errore nell'import dei turni" });
    }
  });

export default router;
