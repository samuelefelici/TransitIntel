/**
 * POST /planning-studio/:projectId/quick-estimate — la stima istantanea.
 *
 * Alimenta lib/quick-estimate con le corse REALI del progetto (filtrate per
 * giorno-tipo e linee) più eventuali corse IPOTETICHE passate nel body: così
 * Argos può chiedere «il festivo di oggi + queste 20 corse che NON ho ancora
 * creato» e confrontare scenari senza scrivere nulla. Sola lettura, niente
 * registro attività, risposta in ben meno di un secondo.
 *
 * Body: {
 *   dayTypeId?:  uuid   — filtra le corse reali per validità su quel giorno-tipo
 *   routeIds?:   uuid[] — limita alle linee indicate (vuoto = tutte)
 *   includeReal?: boolean — default true; false = solo le ipotetiche
 *   hypothetical?: [{ partenza: "HH:MM", arrivo: "HH:MM", linea?: string }]
 *   turnaroundMin?: number — giro banchina minimo tra due corse in catena (default 8)
 * }
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { quickEstimate, parseHM, type EstTrip } from "../lib/quick-estimate";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Owner, membro o admin (stessa semantica delle altre letture di progetto). */
async function canRead(projectId: string, req: any): Promise<boolean> {
  const u = req.user;
  if (!u) return false;
  if (u.role === "admin") return true;
  const r = await db.execute(sql`
    SELECT 1 FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${u.id}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${u.id}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1`);
  return !!((r as any).rows?.length);
}

// Il path CANONICO è /planning-studio/projects/:projectId/... come tutti gli
// altri endpoint Planning Studio: la rotta era nata senza /projects/ e TUTTI
// i chiamanti (Argos, connettore MCP) rispondevano 404 in produzione.
// Il vecchio path resta come alias per compatibilità.
router.post([
  "/planning-studio/projects/:projectId/quick-estimate",
  "/planning-studio/:projectId/quick-estimate",
], async (req, res): Promise<void> => {
  try {
    const projectId = String(req.params.projectId);
    if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    if (!(await canRead(projectId, req))) { res.status(403).json({ error: "Accesso negato al progetto" }); return; }

    const body = req.body ?? {};
    const dayTypeId = UUID_RE.test(String(body.dayTypeId ?? "")) ? String(body.dayTypeId) : null;
    const routeIds: string[] = (Array.isArray(body.routeIds) ? body.routeIds : [])
      .filter((x: any) => typeof x === "string" && UUID_RE.test(x));
    const includeReal = body.includeReal !== false;
    const turnaroundMin = Math.min(60, Math.max(0, Number(body.turnaroundMin ?? 8) || 8));

    const trips: EstTrip[] = [];
    let realCount = 0;
    let discarded = 0;
    let validityNote: string | null = null;

    if (includeReal) {
      // Prototipi esclusi (corse-zero di lavoro, non servizio). La validità
      // filtra solo se il progetto la usa: altrimenti tutte le attive, con nota
      // — stessa semantica del quadro orario.
      let valClause = "";
      if (dayTypeId) {
        const hasV = await db.execute<any>(sql`
          SELECT EXISTS(SELECT 1 FROM ps_trip_day_validity v
                          JOIN ps_trips t ON t.id = v.trip_id
                         WHERE t.project_id = ${projectId}::uuid) AS has`);
        if (hasV.rows[0]?.has) {
          valClause = `AND EXISTS (SELECT 1 FROM ps_trip_day_validity v
                         WHERE v.trip_id = t.id AND v.day_type_id = '${dayTypeId}' AND v.is_valid = true)`;
        } else {
          validityNote = "Validità per giorno non configurata: contate tutte le corse attive";
        }
      }
      const routeClause = routeIds.length
        ? `AND t.route_id IN (${routeIds.map((x) => `'${x}'`).join(",")})`
        : "";
      const r = await db.execute<any>(sql.raw(`
        SELECT r.short_name,
               (SELECT COALESCE(st.departure_time, st.arrival_time) FROM ps_stop_times st
                 WHERE st.trip_id = t.id ORDER BY st.stop_seq ASC LIMIT 1) AS start_time,
               (SELECT COALESCE(st.arrival_time, st.departure_time) FROM ps_stop_times st
                 WHERE st.trip_id = t.id ORDER BY st.stop_seq DESC LIMIT 1) AS end_time
          FROM ps_trips t
          JOIN ps_routes r ON r.id = t.route_id
         WHERE t.project_id = '${projectId}'
           AND COALESCE(t.is_active, true) = true
           AND COALESCE((t.attributes->>'prototype')::boolean, false) = false
           ${routeClause}
           ${valClause}
      `));
      for (const row of r.rows as any[]) {
        const start = parseHM(row.start_time);
        const end = parseHM(row.end_time);
        if (start === null || end === null) { discarded++; continue; }
        trips.push({ start, end, routeKey: row.short_name || undefined });
        realCount++;
      }
    }

    const hypoIn: any[] = Array.isArray(body.hypothetical) ? body.hypothetical : [];
    if (hypoIn.length > 5000) { res.status(400).json({ error: "hypothetical: massimo 5000 corse" }); return; }
    let hypoCount = 0;
    for (const h of hypoIn) {
      const start = parseHM(h?.partenza);
      const end = parseHM(h?.arrivo);
      if (start === null || end === null) { discarded++; continue; }
      trips.push({ start, end, routeKey: h?.linea ? String(h.linea).slice(0, 40) : "(ipotetiche)" });
      hypoCount++;
    }

    if (trips.length === 0) {
      res.json({
        ok: true, corseReali: 0, corseIpotetiche: 0, scartate: discarded,
        nota: validityNote ?? (includeReal ? "Nessuna corsa trovata coi filtri indicati" : "Nessuna corsa ipotetica leggibile"),
        stima: quickEstimate([], turnaroundMin),
      });
      return;
    }

    res.json({
      ok: true,
      corseReali: realCount,
      corseIpotetiche: hypoCount,
      scartate: discarded || undefined,
      turnaroundMin,
      nota: validityNote,
      stima: quickEstimate(trips, turnaroundMin),
      // Onestà della stima, sempre nel payload: il chiamante non deve indovinare.
      limiti: "Catena libera senza km a vuoto, depositi né vincoli di cambio: stima ottimista. Il giudizio vero è ti_vehicle_feasibility (CP-SAT).",
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "quick-estimate fallita" });
  }
});

export default router;
