/**
 * Planning Studio — Export GTFS
 *
 *   GET /api/planning-studio/projects/:id/export-gtfs?versione=&forza=1
 *       lo zip GTFS: stops, routes, trips, stop_times, calendar,
 *       calendar_dates, shapes, agency, feed_info;
 *   GET /api/planning-studio/projects/:id/export-gtfs/verifica?versione=
 *       il controllo dello stesso file, senza lo zip.
 *
 * È il deliverable che l'ufficio programmazione consegna a Regione/osservatorio,
 * open data (NAP), fornitori AVM/bigliettazione. Dalla PR 3.4 è «consegnabile»:
 *  - DA QUALE VERSIONE: quella in esercizio del programma (la copia congelata
 *    della PR 3.3), o quella programmata, o la bozza (?versione=). Senza
 *    indicazione, quella in esercizio se c'è, altrimenti la bozza.
 *  - L'AZIENDA VERA: agency.txt e feed_info.txt dai dati di Amministrazione ›
 *    Azienda (ragione sociale, identificativo GTFS, sito, telefono). Prima
 *    agency_id era «1» e il nome quello del progetto. Senza dati dell'azienda,
 *    quelli del progetto, come prima.
 *  - CONTROLLATO: prima dello zip il file passa da lib/gtfs-verifica.ts. Con
 *    errori l'export si ferma (422, con l'elenco), a meno di forza=1; gli
 *    avvisi si contano nell'intestazione X-Gtfs-Avvisi.
 *
 * Scelte di mappatura:
 *  - stop_id / route_id / trip_id = il CODICE STABILE della fermata, della
 *    linea e della corsa (PR 3.1, lib/codici-stabili.ts): per le righe
 *    importate è l'id che avevano nel file d'origine, e resta lo stesso nelle
 *    copie del programma e nelle sue versioni.
 *  - service_id / shape_id = id interni in testo (calendario, percorso) o la
 *    firma di circolazione: non sono nomi che chi riceve il file conserva.
 *  - VALIDITÀ EFFETTIVA: se il progetto usa la matrice di validità, lo zip
 *    replica ESATTAMENTE il ramo della materializzazione — calendar.txt vuoto
 *    e calendar_dates.txt puro (una riga per data attiva, corse raggruppate
 *    per firma di circolazione).
 *  - Ramo legacy (nessuna matrice): corse senza calendario → service fallback
 *    7/7 nel range del feed. Prototipi e corse inattive ESCLUSE in entrambi.
 *  - shapes.txt: ricampionato dalla geometry GeoJSON della variante.
 *
 * Solo lettura: nessuna scrittura su DB.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { projectHasTripValidity, computeActiveDatesByTrip } from "./planning-studio-validity-eval";
import { leggiAzienda, type Azienda } from "./azienda";
import { versioniDelProgetto, type Versione } from "./versioni-pubblicate";
import { verificaGtfs, type Gtfs, type EsitoVerifica } from "./gtfs-verifica";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Escape CSV RFC4180: quota se contiene virgola, doppio apice o newline. */
function csv(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Il sito scritto nel progetto, se è un indirizzo http o https; altrimenti niente. */
function sitoValido(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https?:\/\/[^\s",<>]{1,200}$/.test(s) ? s : null;
}

/** 'YYYY-MM-DD' (o Date) → 'YYYYMMDD' GTFS. */
function gtfsDate(d: unknown): string {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "");
  return s.replace(/-/g, "").slice(0, 8);
}

async function rows(q: any): Promise<any[]> {
  const r: any = await db.execute(q);
  return r.rows ?? r ?? [];
}

/** I file del GTFS come CSV. */
export function gtfsInCsv(g: Gtfs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [nome, f] of Object.entries(g)) {
    out[nome] = [f.colonne.join(","), ...f.righe.map((r) => f.colonne.map((c) => csv(r[c])).join(","))].join("\n") + "\n";
  }
  return out;
}

/**
 * L'azienda in agency.txt: quella di Amministrazione › Azienda se è stata
 * compilata, altrimenti quella del progetto (come prima della 3.4). Senza un
 * sito valido agency_url resta vuoto: lo dice la verifica, invece di
 * consegnare un indirizzo inventato.
 */
export function aziendaDelGtfs(azienda: Azienda, progetto: { name?: string | null; agency_name?: string | null; agency_url?: string | null; agency_timezone?: string | null }) {
  const daAzienda = azienda.compilata;
  return {
    agency_id: daAzienda ? azienda.gtfsAgencyId : "1",
    agency_name: daAzienda ? azienda.ragioneSociale : (progetto.agency_name || progetto.name || azienda.ragioneSociale),
    agency_url: (daAzienda ? azienda.sito : null) ?? sitoValido(progetto.agency_url) ?? azienda.sito ?? "",
    agency_timezone: progetto.agency_timezone || "Europe/Rome",
    agency_lang: "it",
    agency_phone: daAzienda ? (azienda.telefono ?? "") : "",
  };
}

/**
 * Costruisce il GTFS di un programma, dalle righe di `fonteId` (il progetto o
 * una sua versione pubblicata). `progetto` è la riga del programma (per il
 * nome, il fuso orario e il sito di riserva).
 */
export async function costruisciGtfs(
  fonteId: string, progetto: any, azienda: Azienda, etichetta: string,
): Promise<Gtfs> {
  /* ── range date feed dai calendari (fallback: anno corrente) ── */
  const drR = await rows(sql`
    SELECT to_char(MIN(start_date), 'YYYYMMDD') AS min_start,
           to_char(MAX(end_date),   'YYYYMMDD') AS max_end
      FROM ps_calendars WHERE project_id = ${fonteId}::uuid
  `);
  const today = new Date();
  let feedStart: string = drR[0]?.min_start || `${today.getFullYear()}0101`;
  let feedEnd: string = drR[0]?.max_end || `${today.getFullYear()}1231`;

  /* ── VALIDITÀ EFFETTIVA (stesso ramo della materializzazione) ──
   * Con la matrice di validità attiva, i giorni di servizio veri sono il
   * prodotto di bollini × eccezioni × valid_from/to × calendario categorie:
   * si espandono per data e si raggruppano le corse per firma (sha1
   * dell'insieme di date) → un service_id sintetico per firma. */
  const useEffective = await projectHasTripValidity(fonteId);
  let effectiveTripSvc: Map<string, string> | null = null;
  let effectiveSigDates: Map<string, string[]> | null = null;
  if (useEffective) {
    const isoFrom = `${feedStart.slice(0, 4)}-${feedStart.slice(4, 6)}-${feedStart.slice(6, 8)}`;
    let isoTo = `${feedEnd.slice(0, 4)}-${feedEnd.slice(4, 6)}-${feedEnd.slice(6, 8)}`;
    // cap difensivo ~2 anni, come materializzazione e compute UDP
    const cap = new Date(`${isoFrom}T00:00:00Z`);
    cap.setUTCDate(cap.getUTCDate() + 731);
    const capIso = cap.toISOString().slice(0, 10);
    if (isoTo > capIso) isoTo = capIso;
    if (isoTo < isoFrom) isoTo = isoFrom;
    const activeByTrip = await computeActiveDatesByTrip({ projectId: fonteId, from: isoFrom, to: isoTo });
    effectiveTripSvc = new Map();
    effectiveSigDates = new Map();
    let minD: string | null = null, maxD: string | null = null;
    for (const [tripId, dts] of activeByTrip) {
      if (dts.length === 0) continue; // mai attiva nel range: esclusa dallo zip
      const sig = createHash("sha1").update(dts.join(",")).digest("hex").slice(0, 16);
      if (!effectiveSigDates.has(sig)) effectiveSigDates.set(sig, dts);
      effectiveTripSvc.set(tripId, sig);
      if (minD === null || dts[0] < minD) minD = dts[0];
      const last = dts[dts.length - 1];
      if (maxD === null || last > maxD) maxD = last;
    }
    // feed_info riflette il range di servizio EFFETTIVO
    if (minD && maxD) { feedStart = gtfsDate(minD); feedEnd = gtfsDate(maxD); }
  }

  const agenzia = aziendaDelGtfs(azienda, progetto);
  const g: Gtfs = {};

  g["agency.txt"] = {
    colonne: ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone"],
    righe: [agenzia],
  };
  g["feed_info.txt"] = {
    colonne: ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
    righe: [{
      feed_publisher_name: agenzia.agency_name, feed_publisher_url: agenzia.agency_url, feed_lang: "it",
      feed_start_date: feedStart, feed_end_date: feedEnd,
      feed_version: `${etichetta}-${new Date().toISOString().slice(0, 10)}`,
    }],
  };

  /* ── stops.txt ── */
  const stops = await rows(sql`
    SELECT id, codice, code, name, description, lat, lon, zone_id, location_type,
           wheelchair_boarding, platform_code
      FROM ps_stops WHERE project_id = ${fonteId}::uuid ORDER BY name
  `);
  /* id interno → codice stabile. Una riga che manca dalla mappa (non dovrebbe
   * succedere: il codice è obbligatorio) esce col suo id interno, come prima. */
  const codiceFermata = new Map<string, string>(stops.map(s => [s.id, s.codice]));
  g["stops.txt"] = {
    colonne: ["stop_id", "stop_code", "stop_name", "stop_desc", "stop_lat", "stop_lon", "zone_id", "location_type", "wheelchair_boarding", "platform_code"],
    righe: stops.map(s => ({
      stop_id: s.codice ?? s.id, stop_code: s.code ?? "", stop_name: s.name, stop_desc: s.description ?? "",
      stop_lat: s.lat, stop_lon: s.lon, zone_id: s.zone_id ?? "", location_type: s.location_type ?? 0,
      wheelchair_boarding: s.wheelchair_boarding ?? 0, platform_code: s.platform_code ?? "",
    })),
  };

  /* ── routes.txt ── */
  const routes = await rows(sql`
    SELECT id, codice, code, short_name, long_name, description, route_type, color, text_color, sort_order
      FROM ps_routes WHERE project_id = ${fonteId}::uuid
     ORDER BY sort_order NULLS LAST, short_name
  `);
  const codiceLinea = new Map<string, string>(routes.map(r => [r.id, r.codice]));
  g["routes.txt"] = {
    colonne: ["route_id", "agency_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_color", "route_text_color", "route_sort_order"],
    righe: routes.map(r => ({
      route_id: r.codice ?? r.id, agency_id: agenzia.agency_id,
      route_short_name: r.short_name || r.code || "", route_long_name: r.long_name ?? "", route_desc: r.description ?? "",
      route_type: r.route_type ?? 3,
      route_color: (r.color ?? "").replace(/^#/, ""), route_text_color: (r.text_color ?? "").replace(/^#/, ""),
      route_sort_order: r.sort_order ?? "",
    })),
  };

  /* ── calendar.txt + calendar_dates.txt ──
   * Ramo effettivo: calendar.txt VUOTO (solo header) e calendar_dates puro,
   * come il feed materializzato ("no-mix"). Ramo legacy: ps_calendars +
   * fallback 7/7 per le corse senza calendario. */
  const colonneCalendario = ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"];
  const fallbackServiceId = "fallback-tutti-i-giorni";
  if (useEffective && effectiveSigDates) {
    g["calendar.txt"] = { colonne: colonneCalendario, righe: [] };
    const date: Gtfs[string]["righe"] = [];
    for (const [sig, dts] of effectiveSigDates) for (const d of dts) date.push({ service_id: sig, date: gtfsDate(d), exception_type: 1 });
    g["calendar_dates.txt"] = { colonne: ["service_id", "date", "exception_type"], righe: date };
  } else {
    const calendars = await rows(sql`
      SELECT id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date
        FROM ps_calendars WHERE project_id = ${fonteId}::uuid
    `);
    const needFallbackR = await rows(sql`
      SELECT EXISTS (
        SELECT 1 FROM ps_trips
         WHERE project_id = ${fonteId}::uuid
           AND COALESCE(is_active, true) = true
           AND COALESCE((attributes->>'prototype')::boolean, false) = false
           AND calendar_id IS NULL
      ) AS need
    `);
    const righe = calendars.map(c => ({
      service_id: c.id,
      monday: c.monday ? 1 : 0, tuesday: c.tuesday ? 1 : 0, wednesday: c.wednesday ? 1 : 0, thursday: c.thursday ? 1 : 0,
      friday: c.friday ? 1 : 0, saturday: c.saturday ? 1 : 0, sunday: c.sunday ? 1 : 0,
      start_date: gtfsDate(c.start_date) || feedStart, end_date: gtfsDate(c.end_date) || feedEnd,
    }));
    if (needFallbackR[0]?.need) {
      righe.push({ service_id: fallbackServiceId, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: feedStart, end_date: feedEnd });
    }
    g["calendar.txt"] = { colonne: colonneCalendario, righe };
    const calDates = await rows(sql`
      SELECT cd.calendar_id, cd.date, cd.exception_type
        FROM ps_calendar_dates cd
        JOIN ps_calendars c ON c.id = cd.calendar_id
       WHERE c.project_id = ${fonteId}::uuid
       ORDER BY cd.calendar_id, cd.date
    `);
    g["calendar_dates.txt"] = {
      colonne: ["service_id", "date", "exception_type"],
      righe: calDates.map(d => ({ service_id: d.calendar_id, date: gtfsDate(d.date), exception_type: d.exception_type ?? 1 })),
    };
  }

  /* ── trips.txt (attive, non prototipo) ──
   * Ramo effettivo: service_id = firma di circolazione; le corse mai attive
   * nel range sono ESCLUSE (come nel feed materializzato). */
  const trips = await rows(sql`
    SELECT t.id, t.codice, t.route_id, t.calendar_id, t.headsign, t.short_name, t.direction,
           t.block_id, t.variant_id,
           EXISTS (SELECT 1 FROM ps_shapes sh WHERE sh.variant_id = t.variant_id) AS has_shape
      FROM ps_trips t
     WHERE t.project_id = ${fonteId}::uuid
       AND COALESCE(t.is_active, true) = true
       AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
     ORDER BY t.route_id, t.id
  `);
  const exportedTrips = effectiveTripSvc ? trips.filter(t => effectiveTripSvc!.has(t.id)) : trips;
  const codiceCorsa = new Map<string, string>(trips.map(t => [t.id, t.codice]));
  g["trips.txt"] = {
    colonne: ["route_id", "service_id", "trip_id", "trip_headsign", "trip_short_name", "direction_id", "block_id", "shape_id"],
    righe: exportedTrips.map(t => ({
      route_id: codiceLinea.get(t.route_id) ?? t.route_id,
      service_id: effectiveTripSvc ? effectiveTripSvc.get(t.id)! : (t.calendar_id ?? fallbackServiceId),
      trip_id: t.codice ?? t.id,
      trip_headsign: t.headsign ?? "", trip_short_name: t.short_name ?? "", direction_id: t.direction ?? 0, block_id: t.block_id ?? "",
      shape_id: t.has_shape ? t.variant_id : "",
    })),
  };

  /* ── stop_times.txt ── */
  const stopTimes = await rows(sql`
    SELECT st.trip_id, st.stop_seq, st.stop_id, st.arrival_time, st.departure_time,
           st.pickup_type, st.drop_off_type, st.timepoint, st.shape_dist_traveled
      FROM ps_stop_times st
      JOIN ps_trips t ON t.id = st.trip_id
     WHERE t.project_id = ${fonteId}::uuid
       AND COALESCE(t.is_active, true) = true
       AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
     ORDER BY st.trip_id, st.stop_seq
  `);
  const exportedStopTimes = effectiveTripSvc ? stopTimes.filter(s => effectiveTripSvc!.has(s.trip_id)) : stopTimes;
  g["stop_times.txt"] = {
    colonne: ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type", "drop_off_type", "timepoint", "shape_dist_traveled"],
    righe: exportedStopTimes.map(s => ({
      trip_id: codiceCorsa.get(s.trip_id) ?? s.trip_id, arrival_time: s.arrival_time, departure_time: s.departure_time,
      stop_id: codiceFermata.get(s.stop_id) ?? s.stop_id, stop_sequence: s.stop_seq,
      pickup_type: s.pickup_type ?? 0, drop_off_type: s.drop_off_type ?? 0, timepoint: s.timepoint ?? 1, shape_dist_traveled: s.shape_dist_traveled ?? "",
    })),
  };

  /* ── shapes.txt dalle geometry GeoJSON delle varianti ── */
  const shapes = await rows(sql`
    SELECT variant_id, geometry FROM ps_shapes WHERE project_id = ${fonteId}::uuid
  `);
  const punti: Gtfs[string]["righe"] = [];
  for (const sh of shapes) {
    const coords: any[] = sh.geometry?.coordinates ?? [];
    coords.forEach((c: any, i: number) => {
      if (!Array.isArray(c) || c.length < 2) return;
      punti.push({ shape_id: sh.variant_id, shape_pt_lat: c[1], shape_pt_lon: c[0], shape_pt_sequence: i + 1 });
    });
  }
  g["shapes.txt"] = { colonne: ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], righe: punti };
  return g;
}

/**
 * Il programma (owner o membro: l'export non scrive, ma consegna il programma
 * fuori dall'azienda) e la versione da esportare: quella chiesta, altrimenti
 * quella in esercizio, altrimenti la bozza.
 */
async function programmaEVersione(req: Request, res: Response): Promise<{ progetto: any; fonte: Versione } | null> {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return null; }
  const projectId = String(req.params.id || "");
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "ID progetto non valido" }); return null; }
  const projR = await rows(sql`
    SELECT p.*
      FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid AND p.versione_del_feed IS NULL
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const progetto = projR[0];
  if (!progetto) { res.status(404).json({ error: "Progetto non trovato o non accessibile" }); return null; }
  const chiesta = String(req.query.versione ?? "");
  if (chiesta && !["esercizio", "programmata", "bozza"].includes(chiesta)) {
    res.status(400).json({ error: "versione: esercizio, programmata o bozza" }); return null;
  }
  const bozza: Versione = { id: projectId, quale: "bozza", dal: null };
  const v = await versioniDelProgetto(projectId);
  const fonte = chiesta === "bozza" ? bozza
    : chiesta === "esercizio" ? v.esercizio
    : chiesta === "programmata" ? v.programmata
    : (v.esercizio ?? bozza);
  if (!fonte) { res.status(404).json({ error: `Il programma non ha una versione ${chiesta}` }); return null; }
  return { progetto, fonte };
}

async function costruisciEVerifica(progetto: any, fonte: Versione): Promise<{ gtfs: Gtfs; verifica: EsitoVerifica }> {
  const azienda = await leggiAzienda();
  const gtfs = await costruisciGtfs(fonte.id, progetto, azienda, fonte.quale);
  return { gtfs, verifica: verificaGtfs(gtfs) };
}

/* GET …/export-gtfs/verifica — il controllo del file che si esporterebbe */
router.get("/planning-studio/projects/:id/export-gtfs/verifica", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const { gtfs, verifica } = await costruisciEVerifica(pv.progetto, pv.fonte);
    res.json({
      versione: pv.fonte,
      righe: Object.fromEntries(Object.entries(gtfs).map(([f, x]) => [f, x.righe.length])),
      ...verifica,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, projectId: req.params.id }, "verifica GTFS fallita");
    res.status(500).json({ error: "Errore durante la verifica del GTFS" });
  }
});

router.get("/planning-studio/projects/:id/export-gtfs", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const { gtfs, verifica } = await costruisciEVerifica(pv.progetto, pv.fonte);
    const forza = req.query.forza === "1";
    if (verifica.errori.length > 0 && !forza) {
      res.status(422).json({
        error: "Il GTFS ha errori che chi lo riceve non accetterebbe: correggili, oppure esporta forzando",
        versione: pv.fonte, ...verifica,
      });
      return;
    }
    const zip = new AdmZip();
    for (const [nome, contenuto] of Object.entries(gtfsInCsv(gtfs))) zip.addFile(nome, Buffer.from(contenuto, "utf8"));

    /* ── invio ── */
    const safeName = String(pv.progetto.name || "programma").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="gtfs_${safeName}_${pv.fonte.quale}_${dateStr}.zip"`);
    res.setHeader("X-Gtfs-Versione", pv.fonte.quale);
    res.setHeader("X-Gtfs-Avvisi", String(verifica.avvisi.reduce((n, a) => n + a.quante, 0)));
    res.setHeader("X-Gtfs-Errori", String(verifica.errori.reduce((n, a) => n + a.quante, 0)));
    /* i primi avvisi, per dirli a chi scarica senza rifare il controllo */
    res.setHeader("X-Gtfs-Avvisi-Elenco", encodeURIComponent(
      verifica.avvisi.slice(0, 5).map((a) => `${a.messaggio} (${a.quante})`).join(" · ").slice(0, 1500)));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Gtfs-Versione, X-Gtfs-Avvisi, X-Gtfs-Errori, X-Gtfs-Avvisi-Elenco");
    res.send(zip.toBuffer());
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, projectId: req.params.id }, "export GTFS fallito");
    res.status(500).json({ error: "Errore durante l'export GTFS" });
  }
});

export default router;
