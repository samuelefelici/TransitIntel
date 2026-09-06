/**
 * Planning Studio — AUDIT DELLE CORSE A GIRO (linee radiali).
 *
 * Regola dell'operatore: una corsa che esce dal centro (Ugo Bassi, Stazione,
 * Cavour, Stamira…) arriva al capolinea periferico, lascia un piccolo margine
 * per i ritardi e riparte SUBITO indietro con lo stesso bus. Se il ritorno
 * non c'è, parte prima che il bus arrivi o parte troppo tardi, lo scheduling
 * produce fuorilinea inutili (il bus rientra a vuoto da Massignano e un altro
 * esce a vuoto per fare il ritorno).
 *
 * GET /planning-studio/projects/:id/round-trips?dayTypeId=|dayTypeCode=&minDelta=2&maxDelta=25
 * → { dayType, minDelta, maxDelta, totals, lines: [{ routeId, shortName, issues: [...] }] }
 *
 * Per ogni linea con due direzioni e per ogni corsa che ARRIVA a un capolinea
 * PERIFERICO (fermata non appartenente a un nodo di interscambio):
 *   missingReturn       nessuna corsa di ritorno della stessa linea da quel capolinea dopo l'arrivo
 *   tooTight            il ritorno parte prima di arrivo+minDelta (margine insufficiente)
 *   lateReturn          il ritorno parte oltre arrivo+maxDelta (il bus aspetta o se ne va a vuoto)
 * e, dal lato dei ritorni:
 *   orphanReturn        un ritorno che parte dal capolinea periferico senza un'andata arrivata prima
 *                       (serve un bus a vuoto per farlo; spesso è il ritorno «partito prima dell'andata»)
 * più, per tutte le corse:
 *   noVariantCode       la variante della corsa non ha codice percorso (es. la 93 delle 20:02 senza «93R»)
 * Ogni segnalazione porta l'orario proposto (arrivo + minDelta) e, quando la
 * direzione ha una cadenza regolare, l'orario allineato alla cadenza.
 * Sola lettura: le correzioni le fa l'operatore (o Argos dopo il suo sì).
 */
import type { Request } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

async function canRead(projectId: string, userId: string): Promise<boolean> {
  const r = await db.execute<any>(sql`
    SELECT 1 FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
      LEFT JOIN gtfs_feeds f ON f.id = p.materialized_feed_id
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL
            OR (p.materialized_feed_id IS NOT NULL AND COALESCE(f.is_active, false)))
     LIMIT 1`);
  return !!r.rows?.length;
}

export type RoundTripIssueKind = "missingReturn" | "tooTight" | "lateReturn" | "orphanReturn" | "noVariantCode";

export interface RoundTripIssue {
  kind: RoundTripIssueKind;
  tripId: string;
  variantCode: string | null;
  direction: number | null;
  departTime: string;
  arriveTime: string;
  fromStop: string;
  toStop: string;
  /** capolinea dove il giro si chiude (arrivo dell'andata / partenza del ritorno) */
  terminal: string;
  /** ritorno trovato (se c'è) */
  returnTripId?: string;
  returnDepartTime?: string;
  /** orario proposto per il ritorno: arrivo + minDelta */
  suggestedDepartTime?: string;
  /** orario allineato alla cadenza della direzione (se regolare) */
  cadenceDepartTime?: string | null;
  note: string;
}

export interface RoundTripLine {
  routeId: string;
  shortName: string;
  longName: string | null;
  trips: number;
  directions: number;
  issues: RoundTripIssue[];
}

export interface RoundTripAudit {
  dayTypeId: string | null;
  dayTypeCode: string | null;
  minDelta: number;
  maxDelta: number;
  centerStops: number;
  totals: Record<RoundTripIssueKind, number> & { lines: number; linesWithIssues: number; trips: number };
  lines: RoundTripLine[];
}

interface TripRow {
  tripId: string; routeId: string; shortName: string; longName: string | null;
  direction: number | null; variantCode: string | null;
  firstStop: string; lastStop: string; firstStopName: string; lastStopName: string;
  depMin: number; arrMin: number;
}

function toMin(hms: string | null): number | null {
  if (!hms) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hms));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hhmm(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function resolveDayType(projectId: string, dayTypeId: string | null, dayTypeCode: string | null): Promise<{ id: string | null; code: string | null }> {
  if (dayTypeId && UUID_RE.test(dayTypeId)) {
    const r = await db.execute<any>(sql`SELECT id, code FROM ps_day_types WHERE project_id = ${projectId}::uuid AND id = ${dayTypeId}::uuid LIMIT 1`);
    return r.rows?.[0] ? { id: r.rows[0].id, code: r.rows[0].code } : { id: null, code: null };
  }
  if (dayTypeCode) {
    const r = await db.execute<any>(sql`SELECT id, code FROM ps_day_types WHERE project_id = ${projectId}::uuid AND lower(code) = ${dayTypeCode.toLowerCase()} LIMIT 1`);
    return r.rows?.[0] ? { id: r.rows[0].id, code: r.rows[0].code } : { id: null, code: null };
  }
  return { id: null, code: null };
}

/** Audit delle corse a giro su un progetto (e un giorno-tipo, se dato). */
export async function computeRoundTripAudit(projectId: string, opts: { dayTypeId?: string | null; dayTypeCode?: string | null; minDelta?: number; maxDelta?: number } = {}): Promise<RoundTripAudit> {
  const minDelta = Math.max(0, Math.min(60, Number(opts.minDelta ?? 2) || 0));
  const maxDelta = Math.max(minDelta, Math.min(180, Number(opts.maxDelta ?? 25) || 25));
  const dt = await resolveDayType(projectId, opts.dayTypeId ?? null, opts.dayTypeCode ?? null);

  // Validità per giorno-tipo: solo se il progetto usa la matrice corsa×giorno-tipo
  let valClause = "";
  if (dt.id) {
    const hasVal = await db.execute<any>(sql`SELECT 1 FROM ps_trip_day_validity v JOIN ps_trips t ON t.id = v.trip_id WHERE t.project_id = ${projectId}::uuid LIMIT 1`);
    if (hasVal.rows?.length) {
      valClause = `AND EXISTS (SELECT 1 FROM ps_trip_day_validity dv WHERE dv.trip_id = t.id AND dv.day_type_id = '${dt.id}' AND dv.is_valid = true)`;
    }
  }

  const rowsQ = await db.execute<any>(sql.raw(`
    WITH st AS (
      SELECT t.id AS trip_id, t.route_id, t.direction, v.code AS variant_code,
             r.short_name, r.long_name,
             s.stop_id, s.departure_time, s.arrival_time,
             ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY s.stop_seq ASC) AS rn_first,
             ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY s.stop_seq DESC) AS rn_last
        FROM ps_trips t
        JOIN ps_route_variants v ON v.id = t.variant_id
        JOIN ps_routes r ON r.id = t.route_id
        JOIN ps_stop_times s ON s.trip_id = t.id
       WHERE t.project_id = '${projectId}'
         AND COALESCE(t.is_active, true) = true
         ${valClause}
    )
    SELECT trip_id, route_id, direction, variant_code, short_name, long_name,
           max(CASE WHEN rn_first = 1 THEN stop_id END) AS first_stop,
           max(CASE WHEN rn_first = 1 THEN COALESCE(departure_time, arrival_time) END) AS dep,
           max(CASE WHEN rn_last = 1 THEN stop_id END) AS last_stop,
           max(CASE WHEN rn_last = 1 THEN COALESCE(arrival_time, departure_time) END) AS arr
      FROM st
     GROUP BY trip_id, route_id, direction, variant_code, short_name, long_name
  `));

  const stopIds = new Set<string>();
  for (const r of rowsQ.rows as any[]) { if (r.first_stop) stopIds.add(r.first_stop); if (r.last_stop) stopIds.add(r.last_stop); }
  const stopInfo = new Map<string, { name: string; clusterId: string | null; center: boolean }>();
  if (stopIds.size) {
    const list = Array.from(stopIds).filter((x) => UUID_RE.test(x)).map((x) => `'${x}'`).join(",");
    if (list) {
      const sq = await db.execute<any>(sql.raw(`
        SELECT s.id, s.name, s.cluster_id, COALESCE(c.kind, 'interchange') AS kind
          FROM ps_stops s LEFT JOIN ps_stop_clusters c ON c.id = s.cluster_id
         WHERE s.id IN (${list})`));
      for (const r of sq.rows as any[]) {
        stopInfo.set(r.id, { name: r.name ?? r.id, clusterId: r.cluster_id ?? null, center: !!r.cluster_id && String(r.kind) === "interchange" });
      }
    }
  }
  const nameOf = (id: string) => stopInfo.get(id)?.name ?? id;
  const clusterOf = (id: string) => stopInfo.get(id)?.clusterId ?? null;
  const isCenter = (id: string) => !!stopInfo.get(id)?.center;
  const samePlace = (a: string, b: string) => a === b || (!!clusterOf(a) && clusterOf(a) === clusterOf(b));

  const trips: TripRow[] = [];
  for (const r of rowsQ.rows as any[]) {
    const dep = toMin(r.dep), arr = toMin(r.arr);
    if (dep == null || arr == null || !r.first_stop || !r.last_stop) continue;
    trips.push({
      tripId: r.trip_id, routeId: r.route_id, shortName: r.short_name ?? "?", longName: r.long_name ?? null,
      direction: r.direction == null ? null : Number(r.direction), variantCode: r.variant_code ?? null,
      firstStop: r.first_stop, lastStop: r.last_stop, firstStopName: nameOf(r.first_stop), lastStopName: nameOf(r.last_stop),
      depMin: dep, arrMin: arr,
    });
  }

  const byRoute = new Map<string, TripRow[]>();
  for (const t of trips) byRoute.set(t.routeId, [...(byRoute.get(t.routeId) ?? []), t]);

  const totals: RoundTripAudit["totals"] = { missingReturn: 0, tooTight: 0, lateReturn: 0, orphanReturn: 0, noVariantCode: 0, lines: 0, linesWithIssues: 0, trips: trips.length };
  const lines: RoundTripLine[] = [];

  for (const [routeId, rts] of byRoute) {
    const issues: RoundTripIssue[] = [];
    const dirs = new Set(rts.map((t) => t.direction));
    for (const t of rts) {
      if (!t.variantCode) {
        issues.push({ kind: "noVariantCode", tripId: t.tripId, variantCode: null, direction: t.direction,
          departTime: hhmm(t.depMin), arriveTime: hhmm(t.arrMin), fromStop: t.firstStopName, toStop: t.lastStopName, terminal: t.lastStopName,
          note: "la variante di questa corsa non ha codice percorso: assegnale il percorso giusto (es. 93R)" });
      }
    }
    if (dirs.size >= 2) {
      // cadenza per direzione (minuto dell'ora comune a tutte le partenze)
      const cadenceMinute = new Map<number | null, number | null>();
      for (const d of dirs) {
        const mins = new Set(rts.filter((t) => t.direction === d).map((t) => t.depMin % 60));
        cadenceMinute.set(d, mins.size === 1 ? Array.from(mins)[0] : null);
      }
      const alignToCadence = (fromMin: number, dir: number | null): string | null => {
        const m = cadenceMinute.get(dir);
        if (m == null) return null;
        const cand = fromMin % 60 === m ? fromMin : fromMin + ((m - (fromMin % 60) + 60) % 60);
        return hhmm(cand);
      };
      for (const t of rts) {
        if (isCenter(t.lastStop)) continue;   // al centro l'interlinea è normale
        const returns = rts.filter((b) => b.direction !== t.direction && samePlace(b.firstStop, t.lastStop) && b.depMin >= t.arrMin)
          .sort((a, b) => a.depMin - b.depMin);
        const nxt = returns[0];
        const base = { tripId: t.tripId, variantCode: t.variantCode, direction: t.direction, departTime: hhmm(t.depMin), arriveTime: hhmm(t.arrMin),
          fromStop: t.firstStopName, toStop: t.lastStopName, terminal: t.lastStopName,
          suggestedDepartTime: hhmm(t.arrMin + minDelta), cadenceDepartTime: alignToCadence(t.arrMin + minDelta, t.direction === 0 ? 1 : 0) };
        if (!nxt) {
          issues.push({ ...base, kind: "missingReturn", note: `arriva a ${t.lastStopName} alle ${hhmm(t.arrMin)} e nessuna corsa di ritorno della linea parte da lì dopo: il bus rientra a vuoto. Aggiungi il ritorno alle ${hhmm(t.arrMin + minDelta)}` });
        } else if (nxt.depMin - t.arrMin < minDelta) {
          issues.push({ ...base, kind: "tooTight", returnTripId: nxt.tripId, returnDepartTime: hhmm(nxt.depMin),
            note: `il ritorno delle ${hhmm(nxt.depMin)} parte ${nxt.depMin - t.arrMin}′ dopo l'arrivo (${hhmm(t.arrMin)}): margine sotto ${minDelta}′, spostalo alle ${hhmm(t.arrMin + minDelta)}` });
        } else if (nxt.depMin - t.arrMin > maxDelta) {
          issues.push({ ...base, kind: "lateReturn", returnTripId: nxt.tripId, returnDepartTime: hhmm(nxt.depMin),
            note: `il primo ritorno parte alle ${hhmm(nxt.depMin)}, ${nxt.depMin - t.arrMin}′ dopo l'arrivo (${hhmm(t.arrMin)}): il bus aspetta o se ne va a vuoto. Ritorno subito dopo l'arrivo: ${hhmm(t.arrMin + minDelta)}` });
        }
      }
      // ritorni orfani: partono dal capolinea periferico senza un'andata arrivata prima
      for (const b of rts) {
        if (isCenter(b.firstStop)) continue;
        const feeders = rts.filter((a) => a.direction !== b.direction && samePlace(a.lastStop, b.firstStop) && a.arrMin <= b.depMin && b.depMin - a.arrMin <= Math.max(maxDelta, 60));
        if (feeders.length) continue;
        const later = rts.filter((a) => a.direction !== b.direction && samePlace(a.lastStop, b.firstStop) && a.arrMin > b.depMin).sort((x, y) => x.arrMin - y.arrMin)[0];
        issues.push({ kind: "orphanReturn", tripId: b.tripId, variantCode: b.variantCode, direction: b.direction, departTime: hhmm(b.depMin), arriveTime: hhmm(b.arrMin),
          fromStop: b.firstStopName, toStop: b.lastStopName, terminal: b.firstStopName,
          suggestedDepartTime: later ? hhmm(later.arrMin + minDelta) : undefined,
          cadenceDepartTime: later ? alignToCadence(later.arrMin + minDelta, b.direction) : null,
          note: later
            ? `parte da ${b.firstStopName} alle ${hhmm(b.depMin)} ma l'andata arriva solo alle ${hhmm(later.arrMin)}: serve un bus a vuoto. Spostala dopo l'arrivo, alle ${hhmm(later.arrMin + minDelta)}`
            : `parte da ${b.firstStopName} alle ${hhmm(b.depMin)} senza nessuna andata arrivata prima: serve un bus a vuoto` });
      }
    }
    issues.sort((a, b) => a.departTime.localeCompare(b.departTime));
    for (const i of issues) totals[i.kind]++;
    totals.lines++;
    if (issues.length) totals.linesWithIssues++;
    const first = rts[0];
    lines.push({ routeId, shortName: first.shortName, longName: first.longName, trips: rts.length, directions: dirs.size, issues });
  }
  lines.sort((a, b) => (b.issues.length - a.issues.length) || a.shortName.localeCompare(b.shortName, "it", { numeric: true }));
  return { dayTypeId: dt.id, dayTypeCode: dt.code, minDelta, maxDelta, centerStops: Array.from(stopInfo.values()).filter((s) => s.center).length, totals, lines };
}

router.get("/planning-studio/projects/:id/round-trips", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.id);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ error: "auth required" }); return; }
    const u = (req as any).user;
    if (u?.role !== "admin" && !(await canRead(projectId, userId))) {
      res.status(403).json({ error: "Accesso negato al progetto" }); return;
    }
    const audit = await computeRoundTripAudit(projectId, {
      dayTypeId: typeof req.query.dayTypeId === "string" ? req.query.dayTypeId : null,
      dayTypeCode: typeof req.query.dayTypeCode === "string" ? req.query.dayTypeCode : null,
      minDelta: req.query.minDelta != null ? Number(req.query.minDelta) : undefined,
      maxDelta: req.query.maxDelta != null ? Number(req.query.maxDelta) : undefined,
    });
    res.json(audit);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
