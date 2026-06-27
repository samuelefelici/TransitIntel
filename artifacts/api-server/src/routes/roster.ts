/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROSTER — assegnazione turni guida al personale viaggiante
 * ───────────────────────────────────────────────────────────────────────────
 * Tabellone: righe = operatori (anche fittizi, in attesa dell'anagrafica HR),
 * colonne = giorni. I turni da coprire arrivano dai turni guida salvati
 * (driver_shift_scenarios.result.driverShifts, prodotti dallo Scheduling
 * Engine): per ogni giorno i turni non ancora assegnati sono gli "scoperti".
 *
 *   GET    /api/roster/drivers                 — operatori
 *   POST   /api/roster/drivers                 — crea operatore {name, badge?}
 *   POST   /api/roster/drivers/seed            — genera N operatori fittizi
 *   DELETE /api/roster/drivers/:id
 *   GET    /api/roster/duty-sources            — DSS disponibili come fonte turni
 *   GET    /api/roster/board?from=&days=&dssId=— griglia: turni, assegnazioni
 *   POST   /api/roster/assignments             — assegna {driverId, day, dutyCode, dssId}
 *   DELETE /api/roster/assignments/:id         — rimuovi assegnazione
 *
 * Vincoli: un solo turno per operatore al giorno; un turno coperto da un solo
 * operatore al giorno (per la stessa fonte DSS).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

let bootstrapped = false;
async function ensureRosterTables(): Promise<void> {
  if (bootstrapped) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_drivers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      badge text,
      is_fictitious boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id uuid NOT NULL REFERENCES roster_drivers(id) ON DELETE CASCADE,
      day date NOT NULL,
      dss_id uuid NOT NULL,
      duty_code text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (driver_id, day),
      UNIQUE (dss_id, day, duty_code)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_roster_assign_day ON roster_assignments(day)`);
  bootstrapped = true;
}

router.use(async (_req, _res, next) => { await ensureRosterTables(); next(); });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Estrae i turni guida dal result JSON di un DSS (formato crew_scheduler_v4). */
function extractDuties(result: any): Array<{
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
}> {
  const list = result?.driverShifts ?? result?.duties ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((d: any, i: number) => ({
    code: String(d.driverId ?? d.dutyId ?? d.id ?? `T${i + 1}`),
    type: d.type ?? d.dutyType ?? null,
    start: d.nastroStart ?? d.startTime ?? null,
    end: d.nastroEnd ?? d.endTime ?? null,
    nastro: d.nastro ?? null,
    work: d.work ?? null,
  }));
}

// ── Operatori ────────────────────────────────────────────────────────────────

router.get("/roster/drivers", async (_req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      SELECT id, name, badge, is_fictitious, is_active, created_at
      FROM roster_drivers WHERE is_active = true
      ORDER BY name
    `);
    res.json({ drivers: r.rows.map((d: any) => ({
      id: d.id, name: d.name, badge: d.badge, isFictitious: d.is_fictitious,
    })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/roster/drivers", async (req, res): Promise<void> => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name) { res.status(400).json({ error: "Nome obbligatorio" }); return; }
    const r = await db.execute<any>(sql`
      INSERT INTO roster_drivers (name, badge, is_fictitious)
      VALUES (${name}, ${req.body?.badge ?? null}, ${!!req.body?.isFictitious})
      RETURNING id, name, badge, is_fictitious
    `);
    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /roster/drivers/seed — genera operatori fittizi "Autista 01..N"
router.post("/roster/drivers/seed", async (req, res): Promise<void> => {
  try {
    const count = Math.min(Math.max(Number(req.body?.count) || 10, 1), 200);
    const existing = await db.execute<any>(sql`SELECT name FROM roster_drivers`);
    const names = new Set(existing.rows.map((r: any) => r.name));
    let created = 0;
    for (let i = 1; created < count && i <= 999; i++) {
      const name = `Autista ${String(i).padStart(2, "0")}`;
      if (names.has(name)) continue;
      await db.execute(sql`
        INSERT INTO roster_drivers (name, badge, is_fictitious)
        VALUES (${name}, ${`FIT-${String(i).padStart(3, "0")}`}, true)
      `);
      created++;
    }
    res.json({ ok: true, created });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/roster/drivers/:id", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`UPDATE roster_drivers SET is_active = false WHERE id = ${String(req.params.id)}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Fonti turni (DSS salvati) ────────────────────────────────────────────────

router.get("/roster/duty-sources", async (req, res): Promise<void> => {
  try {
    // Filtri opzionali:
    //   ?operationalOnly=1   → solo i turni-guida marcati "in esercizio"
    //   ?psProjectId=<uuid>  → solo quelli del servizio (progetto PS) indicato
    const operationalOnly = String(req.query.operationalOnly ?? "") === "1";
    const psProjectId = String(req.query.psProjectId ?? "").trim();
    const opWhere = operationalOnly ? sql`AND COALESCE(d.is_operational, false) = true` : sql``;
    const psWhere = psProjectId && UUID_RE.test(psProjectId)
      ? sql`AND sp.planning_studio_project_id = ${psProjectId}::uuid`
      : sql``;
    const r = await db.execute<any>(sql`
      SELECT d.id, d.name, d.created_at,
             COALESCE(d.is_operational, false) AS is_operational,
             s.name AS scenario_name, s.date AS scenario_date,
             sp.validity_unit_id AS validity_unit_id, vu.name AS unit_name,
             jsonb_array_length(COALESCE(d.result->'driverShifts', '[]'::jsonb)) AS duty_count
      FROM driver_shift_scenarios d
      LEFT JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
      LEFT JOIN scheduling_projects sp ON sp.id = s.project_id
      LEFT JOIN ps_validity_units vu ON vu.id = sp.validity_unit_id
      WHERE 1=1 ${opWhere} ${psWhere}
      ORDER BY d.is_operational DESC, d.created_at DESC
      LIMIT 50
    `);
    res.json({ sources: r.rows.map((x: any) => ({
      dssId: x.id, name: x.name, scenarioName: x.scenario_name,
      scenarioDate: x.scenario_date, dutyCount: Number(x.duty_count ?? 0),
      isOperational: !!x.is_operational,
      validityUnitId: x.validity_unit_id ?? null, validityUnitName: x.unit_name ?? null,
      createdAt: x.created_at,
    })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Tabellone ────────────────────────────────────────────────────────────────

router.get("/roster/board", async (req, res): Promise<void> => {
  try {
    const from = String(req.query.from ?? "");
    if (!DATE_RE.test(from)) { res.status(400).json({ error: "from=YYYY-MM-DD richiesto" }); return; }
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
    const dssId = String(req.query.dssId ?? "");

    const dayList: string[] = [];
    const d0 = new Date(`${from}T00:00:00Z`);
    for (let i = 0; i < days; i++) {
      dayList.push(new Date(d0.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    }

    const driversQ = await db.execute<any>(sql`
      SELECT id, name, badge, is_fictitious FROM roster_drivers
      WHERE is_active = true ORDER BY name
    `);

    let duties: ReturnType<typeof extractDuties> = [];
    if (dssId) {
      const dssQ = await db.execute<any>(sql`
        SELECT result FROM driver_shift_scenarios WHERE id = ${dssId}::uuid LIMIT 1
      `);
      duties = extractDuties(dssQ.rows[0]?.result);
    }

    const assignQ = await db.execute<any>(sql`
      SELECT a.id, a.driver_id, a.day::text AS day, a.duty_code, a.dss_id
      FROM roster_assignments a
      WHERE a.day >= ${from}::date AND a.day < ${from}::date + (${days} * interval '1 day')
        AND (${dssId}::text = '' OR a.dss_id = ${dssId || "00000000-0000-0000-0000-000000000000"}::uuid)
    `);

    res.json({
      from, days: dayList,
      drivers: driversQ.rows.map((d: any) => ({
        id: d.id, name: d.name, badge: d.badge, isFictitious: d.is_fictitious,
      })),
      duties,
      assignments: assignQ.rows.map((a: any) => ({
        id: a.id, driverId: a.driver_id, day: a.day.slice(0, 10), dutyCode: a.duty_code, dssId: a.dss_id,
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/roster/assignments", async (req, res): Promise<void> => {
  try {
    const { driverId, day, dutyCode, dssId } = req.body ?? {};
    if (!driverId || !DATE_RE.test(String(day ?? "")) || !dutyCode || !dssId) {
      res.status(400).json({ error: "driverId, day (YYYY-MM-DD), dutyCode e dssId richiesti" });
      return;
    }
    // Un turno per operatore al giorno: l'upsert sostituisce l'eventuale turno precedente.
    const r = await db.execute<any>(sql`
      INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code)
      VALUES (${driverId}::uuid, ${day}::date, ${dssId}::uuid, ${dutyCode})
      ON CONFLICT (driver_id, day)
      DO UPDATE SET duty_code = EXCLUDED.duty_code, dss_id = EXCLUDED.dss_id
      RETURNING id
    `);
    res.status(201).json({ ok: true, id: r.rows[0]?.id });
  } catch (e: any) {
    if (String(e.message).includes("roster_assignments_dss_id_day_duty_code_key")) {
      res.status(409).json({ error: "Turno già assegnato a un altro operatore in quel giorno" });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

router.delete("/roster/assignments/:id", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`DELETE FROM roster_assignments WHERE id = ${String(req.params.id)}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
