/**
 * Planning Studio — CONTROLLO SALUTE PROGETTO (pre-flight di attivazione).
 *
 * Prima di questo modulo "Metti in esercizio" materializzava e promuoveva
 * incondizionatamente: orari non monotoni (08:00 → 07:00), corse duplicate,
 * varianti monche o corse senza orari finivano in produzione senza segnale.
 *
 * GET /planning-studio/projects/:id/health
 * → { checks: [{key, level: 'error'|'warning', label, count, samples[]}],
 *     errors, warnings }
 *
 * Tutte le verifiche sono SQL read-only sul progetto. `level`:
 *   error   = il feed materializzato sarebbe scorretto (orari indietro nel
 *             tempo, arrivo dopo la partenza) — l'attivazione va fermata;
 *   warning = quasi sempre una svista (duplicati, varianti monche, corse
 *             senza orari, fermate orfane) ma può essere voluta.
 */
import type { Request } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computeRoundTripAudit } from "./planning-studio-round-trips";

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

export interface HealthCheck {
  key: string;
  level: "error" | "warning";
  label: string;
  count: number;
  /** fino a 5 esempi leggibili per orientare l'operatore */
  samples: string[];
}

/** Esegue tutte le verifiche di salute su un progetto PS. */
export async function computeProjectHealth(projectId: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const pid = sql`${projectId}::uuid`;

  // ── ERRORE: orari non monotoni dentro la corsa (partenza fermata N+1
  //    precedente all'arrivo della fermata N) o arrivo > partenza alla stessa
  //    fermata. Confronto lessicografico su HH:MM:SS (valido anche oltre 24h
  //    finché il formato resta a 2 cifre di ora; le >24 sono "25:30:00" ecc.,
  //    comunque ordinabili come testo a parità di lunghezza).
  const nonMono = await db.execute<any>(sql`
    WITH st AS (
      SELECT t.id AS trip_id, t.short_name, t.headsign,
             s.stop_seq, s.arrival_time, s.departure_time,
             LAG(s.departure_time) OVER (PARTITION BY t.id ORDER BY s.stop_seq) AS prev_dep
        FROM ps_trips t
        JOIN ps_stop_times s ON s.trip_id = t.id
       WHERE t.project_id = ${pid} AND t.is_active = true
    )
    SELECT trip_id, short_name, headsign,
           min(stop_seq) AS first_bad_seq,
           bool_or(departure_time < arrival_time) AS dep_before_arr
      FROM st
     WHERE (prev_dep IS NOT NULL AND arrival_time < prev_dep)
        OR departure_time < arrival_time
     GROUP BY trip_id, short_name, headsign
     LIMIT 200
  `);
  checks.push({
    key: "non_monotonic_times",
    level: "error",
    label: "Corse con orari non monotoni (l'orario torna indietro lungo la corsa, o partenza prima dell'arrivo alla stessa fermata)",
    count: nonMono.rows.length,
    samples: nonMono.rows.slice(0, 5).map((r: any) =>
      `${r.short_name ?? r.trip_id.slice(0, 8)} · ${r.headsign ?? "—"} (dalla fermata #${r.first_bad_seq})`),
  });

  // ── WARNING: corse duplicate — stessa variante e stessa partenza al primo
  //    stop (con entrambe attive). Il merge-twins esiste apposta.
  const dups = await db.execute<any>(sql`
    WITH firsts AS (
      SELECT t.id, t.variant_id, t.short_name,
             (SELECT s.departure_time FROM ps_stop_times s
               WHERE s.trip_id = t.id ORDER BY s.stop_seq ASC LIMIT 1) AS dep0
        FROM ps_trips t
       WHERE t.project_id = ${pid} AND t.is_active = true
    )
    SELECT v.name AS variant_name, f.dep0, count(*)::int AS n
      FROM firsts f
      JOIN ps_route_variants v ON v.id = f.variant_id
     WHERE f.dep0 IS NOT NULL
     GROUP BY v.name, f.variant_id, f.dep0
    HAVING count(*) > 1
     ORDER BY n DESC
     LIMIT 200
  `);
  const dupTrips = dups.rows.reduce((a: number, r: any) => a + Number(r.n) - 1, 0);
  checks.push({
    key: "duplicate_trips",
    level: "warning",
    label: "Corse duplicate (stessa variante, stessa partenza): probabile doppio import — usa «Unifica gemelle»",
    count: dupTrips,
    samples: dups.rows.slice(0, 5).map((r: any) =>
      `${r.variant_name} · partenza ${String(r.dep0).slice(0, 5)} × ${r.n}`),
  });

  // ── WARNING: corse attive senza stop_times (invisibili in stampe/TTD/feed).
  const noTimes = await db.execute<any>(sql`
    SELECT t.id, t.short_name, t.headsign
      FROM ps_trips t
     WHERE t.project_id = ${pid} AND t.is_active = true
       AND COALESCE(t.attributes->>'prototype', 'false') <> 'true'
       AND NOT EXISTS (SELECT 1 FROM ps_stop_times s WHERE s.trip_id = t.id)
     LIMIT 200
  `);
  checks.push({
    key: "trips_without_times",
    level: "warning",
    label: "Corse attive senza orari (non compaiono in stampe, grafico e feed)",
    count: noTimes.rows.length,
    samples: noTimes.rows.slice(0, 5).map((r: any) => r.short_name ?? r.headsign ?? r.id.slice(0, 8)),
  });

  // ── WARNING: varianti con meno di 2 fermate (non percorribili).
  const shortVariants = await db.execute<any>(sql`
    SELECT v.id, v.name, count(vs.stop_id)::int AS n
      FROM ps_route_variants v
      LEFT JOIN ps_variant_stops vs ON vs.variant_id = v.id
     WHERE v.project_id = ${pid}
     GROUP BY v.id, v.name
    HAVING count(vs.stop_id) < 2
     LIMIT 200
  `);
  checks.push({
    key: "variants_too_short",
    level: "warning",
    label: "Percorsi con meno di 2 fermate",
    count: shortVariants.rows.length,
    samples: shortVariants.rows.slice(0, 5).map((r: any) => `${r.name} (${r.n} fermate)`),
  });

  // ── WARNING: corse attive con finestra di validità impossibile (from > to).
  const badWindow = await db.execute<any>(sql`
    SELECT t.id, t.short_name, t.valid_from, t.valid_to
      FROM ps_trips t
     WHERE t.project_id = ${pid} AND t.is_active = true
       AND t.valid_from IS NOT NULL AND t.valid_to IS NOT NULL
       AND t.valid_from > t.valid_to
     LIMIT 200
  `);
  checks.push({
    key: "invalid_validity_window",
    level: "error",
    label: "Corse con finestra di validità impossibile (dal > al): non circoleranno mai",
    count: badWindow.rows.length,
    samples: badWindow.rows.slice(0, 5).map((r: any) =>
      `${r.short_name ?? r.id.slice(0, 8)} (${r.valid_from} → ${r.valid_to})`),
  });

  // ── WARNING: corse attive con matrice validità configurata ma NESSUN
  //    day-type valido (mai in servizio pur risultando attive).
  const zeroDays = await db.execute<any>(sql`
    SELECT t.id, t.short_name, t.headsign
      FROM ps_trips t
     WHERE t.project_id = ${pid} AND t.is_active = true
       AND EXISTS (SELECT 1 FROM ps_trip_day_validity v WHERE v.trip_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM ps_trip_day_validity v WHERE v.trip_id = t.id AND v.is_valid = true)
     LIMIT 200
  `);
  checks.push({
    key: "trips_zero_days",
    level: "warning",
    label: "Corse attive ma valide in ZERO giorni-tipo (mai in servizio)",
    count: zeroDays.rows.length,
    samples: zeroDays.rows.slice(0, 5).map((r: any) => r.short_name ?? r.headsign ?? r.id.slice(0, 8)),
  });

  // ── WARNING: fermate orfane (nessun percorso le usa) — inquinano ricerche
  //    e quadri di palina, spesso residui di re-import.
  const orphanStops = await db.execute<any>(sql`
    SELECT count(*)::int AS n
      FROM ps_stops st
     WHERE st.project_id = ${pid}
       AND NOT EXISTS (SELECT 1 FROM ps_variant_stops vs WHERE vs.stop_id = st.id)
  `);
  checks.push({
    key: "orphan_stops",
    level: "warning",
    label: "Fermate non usate da alcun percorso",
    count: Number(orphanStops.rows[0]?.n ?? 0),
    samples: [],
  });

  // ── WARNING: BLOCCHI incoerenti. Stesso block_id (vettura) con corse
  //    sovrapposte nel tempo, o "teletrasporti" (la corsa successiva parte da
  //    una fermata diversa dall'arrivo con meno di 5' di stacco: nessun
  //    trasferimento possibile). Prima i blocchi non erano validati affatto.
  const blockIssues = await db.execute<any>(sql`
    WITH bt AS (
      SELECT t.id, t.block_id,
             MIN(s.departure_time) AS dep0,
             MAX(s.arrival_time)  AS arr_n,
             (array_agg(s.stop_id ORDER BY s.stop_seq ASC))[1]  AS first_stop,
             (array_agg(s.stop_id ORDER BY s.stop_seq DESC))[1] AS last_stop
        FROM ps_trips t
        JOIN ps_stop_times s ON s.trip_id = t.id
       WHERE t.project_id = ${pid} AND t.is_active = true
         AND t.block_id IS NOT NULL AND t.block_id <> ''
       GROUP BY t.id, t.block_id
    ), seq AS (
      SELECT *,
             LAG(arr_n)     OVER w AS prev_arr,
             LAG(last_stop) OVER w AS prev_last
        FROM bt
      WINDOW w AS (PARTITION BY block_id ORDER BY dep0)
    )
    SELECT block_id,
           bool_or(prev_arr IS NOT NULL AND dep0 < prev_arr) AS has_overlap,
           bool_or(prev_arr IS NOT NULL AND dep0 >= prev_arr
                   AND prev_last IS DISTINCT FROM first_stop
                   AND (split_part(dep0, ':', 1)::int * 3600 + split_part(dep0, ':', 2)::int * 60
                        + split_part(dep0, ':', 3)::int)
                     - (split_part(prev_arr, ':', 1)::int * 3600 + split_part(prev_arr, ':', 2)::int * 60
                        + split_part(prev_arr, ':', 3)::int) < 300) AS has_teleport
      FROM seq
     GROUP BY block_id
    HAVING bool_or(prev_arr IS NOT NULL AND dep0 < prev_arr)
        OR bool_or(prev_arr IS NOT NULL AND dep0 >= prev_arr
                   AND prev_last IS DISTINCT FROM first_stop
                   AND (split_part(dep0, ':', 1)::int * 3600 + split_part(dep0, ':', 2)::int * 60
                        + split_part(dep0, ':', 3)::int)
                     - (split_part(prev_arr, ':', 1)::int * 3600 + split_part(prev_arr, ':', 2)::int * 60
                        + split_part(prev_arr, ':', 3)::int) < 300)
     LIMIT 200
  `);
  checks.push({
    key: "inconsistent_blocks",
    level: "warning",
    label: "Blocchi vettura incoerenti (corse sovrapposte nello stesso blocco, o cambio fermata con meno di 5' di stacco)",
    count: blockIssues.rows.length,
    samples: blockIssues.rows.slice(0, 5).map((r: any) =>
      `${r.block_id} (${r.has_overlap ? "sovrapposizione" : ""}${r.has_overlap && r.has_teleport ? " + " : ""}${r.has_teleport ? "stacco impossibile" : ""})`),
  });

  // ── WARNING: linee attive senza corse attive.
  const emptyRoutes = await db.execute<any>(sql`
    SELECT r.id, r.short_name
      FROM ps_routes r
     WHERE r.project_id = ${pid} AND COALESCE(r.is_active, true) = true
       AND NOT EXISTS (SELECT 1 FROM ps_trips t
                        WHERE t.route_id = r.id AND t.is_active = true)
     LIMIT 200
  `);
  checks.push({
    key: "routes_without_trips",
    level: "warning",
    label: "Linee senza corse attive",
    count: emptyRoutes.rows.length,
    samples: emptyRoutes.rows.slice(0, 5).map((r: any) => r.short_name),
  });

  // ── WARNING: corse a giro — sulle linee radiali il ritorno deve partire
  //    dal capolinea periferico subito dopo l'arrivo dell'andata (stesso bus):
  //    ritorni mancanti, partiti prima dell'arrivo o con margine insufficiente
  //    producono fuorilinea inutili nello scheduling. Per giorno-tipo.
  try {
    // giorni-tipo di sistema (project_id NULL) + del progetto; a pari codice vince quello del progetto
    const dts = await db.execute<any>(sql`SELECT id, code, project_id FROM ps_day_types WHERE project_id IS NULL OR project_id = ${pid} ORDER BY sort_order NULLS LAST, code`);
    const seen = new Map<string, any>();
    for (const d of (dts.rows ?? []) as any[]) {
      const k = String(d.code ?? "").toLowerCase();
      const prev = seen.get(k);
      if (!prev || (!prev.project_id && d.project_id)) seen.set(k, d);
    }
    let count = 0;
    const samples: string[] = [];
    for (const d of Array.from(seen.values()).slice(0, 8)) {
      const a = await computeRoundTripAudit(projectId, { dayTypeId: d.id });
      const n = a.totals.missingReturn + a.totals.tooTight + a.totals.orphanReturn;
      count += n;
      if (n && samples.length < 5) {
        for (const l of a.lines) {
          for (const i of l.issues) {
            if (i.kind !== "missingReturn" && i.kind !== "tooTight" && i.kind !== "orphanReturn") continue;
            if (samples.length >= 5) break;
            samples.push(`${d.code} · linea ${l.shortName} ${i.departTime} ${i.fromStop} → ${i.toStop}: ${i.note}`);
          }
          if (samples.length >= 5) break;
        }
      }
    }
    checks.push({
      key: "round_trip_gaps",
      level: "warning",
      label: "Corse a giro: andate senza ritorno dal capolinea periferico, ritorni partiti prima dell'arrivo o con margine insufficiente (producono fuorilinea inutili)",
      count,
      samples,
    });
  } catch (e) { console.warn(`[health] round_trip_gaps saltato per ${projectId}: ${(e as Error)?.message ?? e}`); }

  return checks;
}

router.get("/planning-studio/projects/:id/health", async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.id);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ error: "auth required" }); return; }
    const u = (req as any).user;
    if (u?.role !== "admin" && !(await canRead(projectId, userId))) {
      res.status(403).json({ error: "Accesso negato al progetto" }); return;
    }
    const checks = await computeProjectHealth(projectId);
    const errors = checks.filter((c) => c.level === "error" && c.count > 0).length;
    const warnings = checks.filter((c) => c.level === "warning" && c.count > 0).length;
    res.json({ checks, errors, warnings });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
