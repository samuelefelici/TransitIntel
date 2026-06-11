/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DATABASE DI ESERCIZIO — vista unica di tutti i dati di pianificazione
 * ───────────────────────────────────────────────────────────────────────────
 * Un solo endpoint che aggrega l'intera catena per il colpo d'occhio:
 * programmi (PS projects, con quello operativo), unità di progettazione,
 * turni macchina (scenari), turni guida (DSS), roster.
 *
 *   GET /api/service-db/overview
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

async function safeRows(q: Promise<any>): Promise<any[]> {
  try { const r = await q; return (r as any).rows ?? []; } catch { return []; }
}

router.get("/service-db/overview", async (req, res): Promise<void> => {
  try {
    const userId = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const tenant = isAdmin ? sql`TRUE` : sql`p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL`;

    const projects = await safeRows(db.execute(sql`
      SELECT p.id, p.name, p.agency_name, p.status, p.updated_at,
             p.materialized_feed_id, p.materialized_at,
             (p.materialized_feed_id IS NOT NULL AND COALESCE(f.is_active, false)) AS is_operational,
             (SELECT count(*)::int FROM ps_routes r WHERE r.project_id = p.id) AS routes,
             (SELECT count(*)::int FROM ps_trips t WHERE t.project_id = p.id) AS trips,
             (SELECT count(*)::int FROM ps_validity_units vu WHERE vu.project_id = p.id) AS validity_units
      FROM ps_projects p
      LEFT JOIN gtfs_feeds f ON f.id = p.materialized_feed_id
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
      WHERE ${tenant}
      ORDER BY is_operational DESC, p.updated_at DESC
    `));

    const units = await safeRows(db.execute(sql`
      SELECT vu.id, vu.project_id, vu.name, vu.day_count, vu.trip_count,
             vu.representative_dates, p.name AS project_name
      FROM ps_validity_units vu
      JOIN ps_projects p ON p.id = vu.project_id
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
      WHERE ${tenant}
      ORDER BY vu.day_count DESC
      LIMIT 200
    `));

    const vehicleScenarios = await safeRows(db.execute(sql`
      SELECT s.id, s.name, s.date, s.created_at,
             (SELECT count(*)::int FROM driver_shift_scenarios d
               WHERE d.service_program_scenario_id = s.id) AS dss_count
      FROM service_program_scenarios s
      ORDER BY s.created_at DESC
      LIMIT 100
    `));

    const driverScenarios = await safeRows(db.execute(sql`
      SELECT d.id, d.name, d.created_at, d.service_program_scenario_id,
             s.name AS scenario_name, s.date AS scenario_date,
             jsonb_array_length(COALESCE(d.result->'driverShifts', '[]'::jsonb)) AS duties
      FROM driver_shift_scenarios d
      LEFT JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
      ORDER BY d.created_at DESC
      LIMIT 100
    `));

    const rosterStats = (await safeRows(db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM roster_drivers WHERE is_active = true) AS drivers,
        (SELECT count(*)::int FROM roster_assignments
          WHERE day >= current_date AND day < current_date + interval '7 days') AS assignments_next7
    `)))[0] ?? { drivers: 0, assignments_next7: 0 };

    res.json({
      projects: projects.map((p: any) => ({
        id: p.id, name: p.name, agencyName: p.agency_name, status: p.status,
        updatedAt: p.updated_at, isOperational: !!p.is_operational,
        materializedAt: p.materialized_at,
        routes: p.routes, trips: p.trips, validityUnits: p.validity_units,
      })),
      validityUnits: units.map((u: any) => ({
        id: u.id, projectId: u.project_id, projectName: u.project_name,
        name: u.name, dayCount: u.day_count, tripCount: u.trip_count,
        representativeDates: u.representative_dates ?? [],
      })),
      vehicleScenarios: vehicleScenarios.map((s: any) => ({
        id: s.id, name: s.name, date: s.date, createdAt: s.created_at, dssCount: Number(s.dss_count ?? 0),
      })),
      driverScenarios: driverScenarios.map((d: any) => ({
        id: d.id, name: d.name, createdAt: d.created_at,
        vehicleScenarioId: d.service_program_scenario_id,
        vehicleScenarioName: d.scenario_name, date: d.scenario_date,
        duties: Number(d.duties ?? 0),
      })),
      roster: { drivers: Number(rosterStats.drivers ?? 0), assignmentsNext7: Number(rosterStats.assignments_next7 ?? 0) },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
