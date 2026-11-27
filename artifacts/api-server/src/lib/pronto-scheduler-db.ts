/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRONTO PER LO SCHEDULER — letture, rotte e riallineamento dell'UDP
 * ───────────────────────────────────────────────────────────────────────────
 *   GET  /planning-studio/projects/:id/validity-units/:unitId/pronto-scheduler
 *        ?depositi=<id>,<id>&datiReali=0|1   — i controlli (regole in pronto-scheduler.ts)
 *   POST /planning-studio/projects/:id/validity-units/:unitId/riallinea
 *        { aggiungiLinee: [routeId…] }       — l'UDP prende le corse che
 *        circolano nei suoi giorni sulle sue linee PIÙ quelle indicate
 *
 * prontoPerScheduler() la usa anche il giro (agent-optimize): con un errore
 * il giro non parte. Lì i dati reali non si leggono (sono solo avvisi, e il
 * giro deve partire in fretta).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computeActiveDatesByTrip } from "./planning-studio-validity-eval";
import { computeRoundTripAudit } from "./planning-studio-round-trips";
import { caricaCorse } from "./percorrenze-acquisizione-db";
import { leggiOsservato } from "./percorrenze-reali-db";
import { esitiCorse, giorniOsservati, tipoPerGiornoTipo } from "./percorrenze-reali";
import { giornataOggi } from "./service-day";
import { getLatestFeedId } from "../routes/gtfs-helpers";
import { withVia } from "./agent-context";
import { sosteMinimeDelProgetto } from "./soste-minime-db";
import { sostaEffettiva } from "./soste-minime";
import {
  margineDaSegnalare, MARGINE_SCARSO_MIN,
  controlloUdp, controlloTipiMezzo, controlloDepositi, controlloArchi, controlloMargini,
  controlloMarginiReali, controlloDatiReali, esito,
  type Anomalia, type Arco, type Capolinea, type Controllo, type Deposito, type Esito,
} from "./pronto-scheduler";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: Iterable<string>) => `{${[...ids].filter(x => UUID_RE.test(x)).join(",")}}`;
const rows = (r: any): any[] => r?.rows ?? [];
/** Finestra osservata per i dati reali (giorni), come l'acquisizione dei tempi. */
const GIORNI_OSSERVATI = 91;

const normData = (x: unknown): string | null => {
  const t = String(x ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return null;
};

interface Udp { id: string; nome: string; corse: number; salvate: string[]; date: string[]; dayTypeId: string | null }

async function leggiUdp(psProjectId: string, unitId: string): Promise<Udp | null> {
  const u = rows(await db.execute(sql`
    SELECT id::text, name, trip_ids, representative_dates, day_type_id::text AS dt
      FROM ps_validity_units WHERE id = ${unitId}::uuid AND project_id = ${psProjectId}::uuid`))[0];
  if (!u) return null;
  const salvate = [...new Set<string>((Array.isArray(u.trip_ids) ? u.trip_ids : []).map((x: unknown) => String(x)))];
  const date: string[] = [...new Set<string>((Array.isArray(u.representative_dates) ? u.representative_dates : [])
    .map(normData).filter((d: string | null): d is string => !!d))].sort();
  return { id: u.id, nome: u.name ?? "", corse: salvate.length, salvate, date, dayTypeId: u.dt ?? null };
}

/** Le corse che circolano nelle date dell'UDP: prima, mediana e ultima, come il riallineamento al lancio. */
async function corseAttive(psProjectId: string, date: string[]): Promise<Set<string>> {
  const campione = [...new Set([date[0], date[Math.floor(date.length / 2)], date[date.length - 1]].filter(Boolean))];
  const attive = new Set<string>();
  for (const d of campione) {
    for (const id of (await computeActiveDatesByTrip({ projectId: psProjectId, from: d, to: d })).keys()) attive.add(String(id));
  }
  return attive;
}

export interface Pronto extends Esito {
  udp: { id: string; nome: string; corse: number };
  depositi: { id: string; nome: string }[];
  datiReali: boolean;
}

export async function prontoPerScheduler(
  psProjectId: string, unitId: string,
  opt: { depotIds?: string[] | null; datiReali?: boolean; feedId?: string | null } = {},
): Promise<Pronto | null> {
  const u = await leggiUdp(psProjectId, unitId);
  if (!u) return null;
  const controlli: Controllo[] = [];
  const attive = u.date.length ? await corseAttive(psProjectId, u.date) : new Set<string>();

  /* le linee delle corse salvate e di quelle che circolano */
  const tutte = new Set([...u.salvate, ...attive]);
  const lineaDi = new Map<string, string>();
  const etichetta = new Map<string, string>();
  const tipo = new Map<string, string | null>();
  for (const r of rows(await db.execute(sql`
    SELECT t.id::text AS trip, r.id::text AS route, COALESCE(NULLIF(r.short_name, ''), r.long_name, r.id::text) AS nome,
           r.attributes->'vehicleTypes' AS vt
      FROM ps_trips t JOIN ps_routes r ON r.id = t.route_id
     WHERE t.id = ANY(${uuids(tutte)}::uuid[])`))) {
    lineaDi.set(String(r.trip), String(r.route));
    etichetta.set(String(r.route), String(r.nome));
    const vt = r.vt;
    const am = vt && Array.isArray(vt.ammesse) ? vt.ammesse.map(String) : [];
    tipo.set(String(r.route), am.length ? String(vt.preferita ?? am[0]) : null);
  }

  /* 1. l'UDP: le corse delle altre UDP con date in comune non sono «fuori» */
  const mieDate = new Set(u.date);
  const inAltreUdp = new Set<string>();
  for (const a of rows(await db.execute(sql`
    SELECT trip_ids, representative_dates FROM ps_validity_units
     WHERE project_id = ${psProjectId}::uuid AND id <> ${unitId}::uuid`))) {
    const dd = (Array.isArray(a.representative_dates) ? a.representative_dates : []).map(normData);
    if (!dd.some((d: string | null) => d && mieDate.has(d))) continue;
    for (const id of Array.isArray(a.trip_ids) ? a.trip_ids : []) inAltreUdp.add(String(id));
  }
  if (!u.date.length) {
    controlli.push({ chiave: "udp_allineata", livello: "errore", titolo: "L'UDP è allineata alle validità", numero: 1,
      dettaglio: "L'UDP non ha date rappresentative: non si sa in che giorni circola.", campioni: [],
      rimedio: "Ricalcola l'UDP (Planning Studio → Unità di progettazione)." });
  } else {
    controlli.push(controlloUdp({ salvate: u.salvate, attive, lineaDi, etichetta, inAltreUdp }));
  }

  /* 2. i tipi di mezzo delle linee che il giro userà */
  const linee = [...new Set([...tutte].map(id => lineaDi.get(id)).filter((x): x is string => !!x))];
  controlli.push(controlloTipiMezzo(linee.map(r => ({ routeId: r, etichetta: etichetta.get(r) ?? r, tipo: tipo.get(r) ?? null }))));

  /* 3. i depositi del progetto e quelli scelti */
  let depRows: any[];
  try {
    depRows = rows(await db.execute(sql`
      SELECT id::text, name, lat, lon FROM depots
       WHERE lat IS NOT NULL AND lon IS NOT NULL AND (ps_project_id IS NULL OR ps_project_id = ${psProjectId}::uuid)
       ORDER BY name`));
  } catch {
    depRows = rows(await db.execute(sql`SELECT id::text, name, lat, lon FROM depots WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY name`));
  }
  const delProgetto: Deposito[] = depRows.map(d => ({ id: String(d.id), nome: String(d.name ?? ""), lat: Number(d.lat), lon: Number(d.lon) }));
  const scelti = opt.depotIds && opt.depotIds.length ? [...new Set(opt.depotIds.map(String))] : null;
  controlli.push(controlloDepositi(scelti, delProgetto));
  const depGiro = scelti ? delProgetto.filter(d => scelti.includes(d.id)) : delProgetto;

  /* 4. i capolinea delle corse che circolano e gli archi fuorilinea */
  const capRows = rows(await db.execute(sql`
    WITH estremi AS (
      (SELECT DISTINCT ON (trip_id) trip_id, stop_id FROM ps_stop_times
        WHERE trip_id = ANY(${uuids(attive)}::uuid[]) ORDER BY trip_id, stop_seq ASC)
      UNION
      (SELECT DISTINCT ON (trip_id) trip_id, stop_id FROM ps_stop_times
        WHERE trip_id = ANY(${uuids(attive)}::uuid[]) ORDER BY trip_id, stop_seq DESC)
    )
    SELECT DISTINCT s.id::text AS stop_id, s.name, s.lat, s.lon, s.cluster_id::text AS cluster_id
      FROM estremi e JOIN ps_stops s ON s.id = e.stop_id`));
  const capolinea: Capolinea[] = capRows.map(c => ({
    stopId: String(c.stop_id), nome: String(c.name ?? c.stop_id), clusterId: c.cluster_id ? String(c.cluster_id) : null,
    lat: c.lat == null ? null : Number(c.lat), lon: c.lon == null ? null : Number(c.lon),
  }));
  const archi: Arco[] = rows(await db.execute(sql`
    SELECT from_key, from_type, from_lat, from_lon, to_key, to_type, to_lat, to_lon FROM deadhead_arcs
     WHERE ps_project_id IS NULL OR ps_project_id = ${psProjectId}::uuid`)).map(a => ({
    fromKey: String(a.from_key), fromType: String(a.from_type), fromLat: Number(a.from_lat), fromLon: Number(a.from_lon),
    toKey: String(a.to_key), toType: String(a.to_type), toLat: Number(a.to_lat), toLon: Number(a.to_lon),
  }));
  controlli.push(controlloArchi(capolinea, depGiro, archi));

  /* 5. andata e ritorno ai capolinea, sulle corse dell'UDP: la soglia
   *    dell'audit è la sosta minima più alta dichiarata, poi ogni capolinea
   *    col suo valore (sotto, il giro non concatena le due corse) */
  const soste = await sosteMinimeDelProgetto(psProjectId);
  const dichiarate = [soste.predefinita, ...soste.perFermata.values(), ...soste.perNodo.values()].filter((x): x is number => x != null);
  const audit = await computeRoundTripAudit(psProjectId, { dayTypeId: u.dayTypeId, minDelta: Math.max(MARGINE_SCARSO_MIN, ...dichiarate) });
  const anomalie: Anomalia[] = [];
  for (const l of audit.lines) {
    for (const i of l.issues) {
      if (!attive.has(i.tripId) || i.kind === "lateReturn") continue;
      const sostaMinima = i.terminalStopId ? (sostaEffettiva(i.terminalStopId, soste)?.minuti ?? null) : null;
      const a: Anomalia = { tipo: i.kind, linea: l.shortName, capolinea: i.terminal, arrivo: i.arriveTime, ritorno: i.returnDepartTime ?? null, sostaMinima };
      if (i.kind === "tooTight" && !margineDaSegnalare(a)) continue;
      anomalie.push(a);
    }
  }
  controlli.push(controlloMargini(anomalie));

  /* 6. i dati reali: margini e copertura delle linee (SIRI) */
  if (opt.datiReali !== false && attive.size && linee.length) {
    try {
      const dt = u.dayTypeId ? rows(await db.execute(sql`SELECT code, name FROM ps_day_types WHERE id = ${u.dayTypeId}::uuid`))[0] : null;
      const tipoGiorno = tipoPerGiornoTipo(dt?.code ?? dt?.name ?? "feriale");
      const { corse } = await caricaCorse(psProjectId, linee, u.dayTypeId);
      const mie = corse.filter(c => attive.has(c.tripId));
      const coppie = new Map<string, { da: string; a: string }>();
      for (const c of mie) for (let i = 0; i + 1 < c.fermate.length; i++) {
        const da = c.fermate[i].gtfsId, a = c.fermate[i + 1].gtfsId;
        if (da && a) coppie.set(`${da}>${a}`, { da, a });
      }
      const feedId = opt.feedId !== undefined ? opt.feedId : await getLatestFeedId();
      const lettura = await leggiOsservato([...coppie.values()], giorniOsservati(tipoGiorno, giornataOggi(), GIORNI_OSSERVATI), feedId);
      const esiti = esitiCorse(mie, lettura.osservato);
      const lineaCorsa = new Map(mie.map(c => [c.tripId, etichetta.get(c.routeId) ?? c.routeId]));
      controlli.push(controlloMarginiReali(esiti.map(e => ({
        linea: lineaCorsa.get(e.tripId) ?? "?", partenza: e.partenza, capolinea: e.a, coperturaPct: e.coperturaPct, giudizio: e.giudizio,
      }))));
      const perLinea = new Map<string, number[]>();
      for (const e of esiti) {
        const l = lineaCorsa.get(e.tripId) ?? "?";
        perLinea.set(l, [...(perLinea.get(l) ?? []), e.coperturaPct]);
      }
      controlli.push(controlloDatiReali([...perLinea.entries()].map(([l, v]) => ({
        etichetta: l, coperturaPct: Math.round(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length)),
      }))));
    } catch (e: any) {
      controlli.push({ chiave: "dati_reali", livello: "avviso", titolo: "Le linee hanno tempi reali", numero: 0,
        dettaglio: `I transiti SIRI non si sono potuti leggere (${String(e?.message ?? e).slice(0, 120)}): margini e copertura non misurati.`,
        campioni: [], rimedio: null });
    }
  }

  return {
    udp: { id: u.id, nome: u.nome, corse: u.corse },
    depositi: depGiro.map(d => ({ id: d.id, nome: d.nome })),
    datiReali: opt.datiReali !== false,
    ...esito(controlli),
  };
}

export interface Riallineamento { prima: number; dopo: number; aggiunte: number; tolte: number; linee: string[] }

/**
 * L'UDP prende le corse che circolano nelle sue date sulle sue linee e su
 * quelle indicate. Senza linee nuove è il riallineamento del lancio.
 */
export async function riallineaUdp(psProjectId: string, unitId: string, aggiungiLinee: string[]): Promise<
  { ok: true; r: Riallineamento } | { ok: false; stato: number; errore: string }
> {
  const u = await leggiUdp(psProjectId, unitId);
  if (!u) return { ok: false, stato: 404, errore: "UDP non trovata in questo progetto" };
  if (!u.date.length) return { ok: false, stato: 400, errore: "L'UDP non ha date rappresentative: ricalcolala" };
  const nuove = [...new Set(aggiungiLinee.map(String))];
  if (nuove.some(x => !UUID_RE.test(x))) return { ok: false, stato: 400, errore: "aggiungiLinee: id di linea non validi" };
  if (nuove.length) {
    const trovate = rows(await db.execute(sql`
      SELECT id::text FROM ps_routes WHERE project_id = ${psProjectId}::uuid AND id = ANY(${uuids(nuove)}::uuid[])`));
    if (trovate.length !== nuove.length) return { ok: false, stato: 404, errore: "Linee non trovate nel progetto" };
  }
  const scope = new Set<string>(nuove);
  for (const r of rows(await db.execute(sql`
    SELECT DISTINCT route_id::text AS r FROM ps_trips WHERE id = ANY(${uuids(u.salvate)}::uuid[])`))) scope.add(String(r.r));
  const attive = await corseAttive(psProjectId, u.date);
  const dentro = rows(await db.execute(sql`
    SELECT id::text FROM ps_trips WHERE id = ANY(${uuids(attive)}::uuid[]) AND route_id = ANY(${uuids(scope)}::uuid[])`))
    .map(x => String(x.id)).sort();
  const prima = new Set(u.salvate);
  const r: Riallineamento = {
    prima: u.salvate.length, dopo: dentro.length,
    aggiunte: dentro.filter(id => !prima.has(id)).length,
    tolte: u.salvate.filter(id => !dentro.includes(id)).length,
    linee: nuove,
  };
  if (r.aggiunte || r.tolte) {
    await db.execute(sql`
      UPDATE ps_validity_units SET trip_ids = ${JSON.stringify(dentro)}::jsonb, trip_count = ${dentro.length}, updated_at = now()
       WHERE id = ${unitId}::uuid AND project_id = ${psProjectId}::uuid`);
  }
  return { ok: true, r };
}

/* ─────────────────────────────── rotte ─────────────────────────────── */

const router: IRouter = Router();

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

async function progettoPs(projectId: string, userId: string, needWrite: boolean): Promise<boolean> {
  const r = rows(await db.execute(sql`
    SELECT CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner' ELSE pm.role END AS ruolo
      FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1`))[0];
  if (!r) return false;
  return !needWrite || r.ruolo === "owner" || r.ruolo === "editor";
}

/** «a,b» o ["a","b"] → id validi; altro → errore. */
export function leggiDepositi(x: unknown): { ok: true; ids: string[] | null } | { ok: false; errore: string } {
  if (x === undefined || x === null || x === "") return { ok: true, ids: null };
  const lista = Array.isArray(x) ? x.map(String) : String(x).split(",");
  const ids = lista.map(s => s.trim()).filter(Boolean);
  if (ids.length > 50 || ids.some(s => !UUID_RE.test(s))) return { ok: false, errore: "depositi: id non validi (al massimo 50)" };
  return { ok: true, ids: ids.length ? ids : null };
}

router.get("/planning-studio/projects/:id/validity-units/:unitId/pronto-scheduler", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const { id, unitId } = req.params as { id: string; unitId: string };
  if (!UUID_RE.test(id) || !UUID_RE.test(unitId)) { res.status(400).json({ error: "id non valido" }); return; }
  const dep = leggiDepositi(req.query.depositi);
  if (!dep.ok) { res.status(400).json({ error: dep.errore }); return; }
  if (!(await progettoPs(id, userId, false))) { res.status(404).json({ error: "progetto non trovato" }); return; }
  try {
    const p = await prontoPerScheduler(id, unitId, { depotIds: dep.ids, datiReali: req.query.datiReali !== "0" });
    if (!p) { res.status(404).json({ error: "UDP non trovata in questo progetto" }); return; }
    res.json(p);
  } catch (e: any) {
    req.log?.error?.(e, "pronto per lo scheduler");
    res.status(500).json({ error: "controllo non riuscito" });
  }
});

router.post("/planning-studio/projects/:id/validity-units/:unitId/riallinea", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const { id, unitId } = req.params as { id: string; unitId: string };
  if (!UUID_RE.test(id) || !UUID_RE.test(unitId)) { res.status(400).json({ error: "id non valido" }); return; }
  const raw = (req.body ?? {}).aggiungiLinee;
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 200)) {
    res.status(400).json({ error: "aggiungiLinee: un elenco di id di linea (al massimo 200)" }); return;
  }
  if (!(await progettoPs(id, userId, true))) { res.status(403).json({ error: "serve il permesso di scrittura sul progetto" }); return; }
  try {
    const out = await riallineaUdp(id, unitId, (raw ?? []).map(String));
    if (!out.ok) { res.status(out.stato).json({ error: out.errore }); return; }
    if (out.r.aggiunte || out.r.tolte) {
      try {
        await db.execute(sql`
          INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, target_id, payload)
          VALUES (${id}::uuid, ${userId}::uuid, 'validity.unit.realign', 'validity_unit', ${unitId}::uuid,
                  ${JSON.stringify(withVia({ ...out.r }))}::jsonb)`);
      } catch (e: any) { req.log?.warn?.(e, "registro del riallineamento non scritto"); }
    }
    res.json({ ok: true, ...out.r });
  } catch (e: any) {
    req.log?.error?.(e, "riallineamento UDP");
    res.status(500).json({ error: "riallineamento non riuscito: l'UDP non è cambiata" });
  }
});

export default router;
