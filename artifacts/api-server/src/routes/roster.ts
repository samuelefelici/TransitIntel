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
  // Anagrafica conducente ricca (colonne additive, idempotenti)
  for (const col of [
    "matricola text", "cognome text", "nome text", "cf text", "cellulare text",
    "residenza_anagrafica text", "residenza_servizio text",
    "ore_settimanali integer", "categoria text",
    "data_nascita date", "data_assunzione date", "data_fine_servizio date",
    "patente text", "patente_validita date",
    "cqc_numero text", "cqc_validita date",
    "visita_medica_validita date", "note text",
  ]) {
    await db.execute(sql.raw(`ALTER TABLE roster_drivers ADD COLUMN IF NOT EXISTS ${col}`));
  }
  bootstrapped = true;
}

router.use(async (_req, _res, next) => { await ensureRosterTables(); next(); });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Estrae i turni guida dal result JSON di un DSS (formato crew_scheduler_v4). */
function extractDuties(result: any): Array<{
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
  interruption: string | null; ripreseCount: number; tripsCount: number; costEuro: number | null;
}> {
  const list = result?.driverShifts ?? result?.duties ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((d: any, i: number) => {
    const riprese = Array.isArray(d.riprese) ? d.riprese : [];
    const tripsCount = riprese.reduce(
      (s: number, r: any) => s + (Array.isArray(r?.trips) ? r.trips.filter((t: any) => (t?.type ?? "trip") === "trip").length : 0),
      0,
    );
    return {
      code: String(d.driverId ?? d.dutyId ?? d.id ?? `T${i + 1}`),
      type: d.type ?? d.dutyType ?? null,
      start: d.nastroStart ?? d.startTime ?? null,
      end: d.nastroEnd ?? d.endTime ?? null,
      nastro: d.nastro ?? null,
      work: d.work ?? null,
      interruption: d.interruption ?? null,
      ripreseCount: riprese.length,
      tripsCount,
      costEuro: typeof d.costEuro === "number" ? d.costEuro : null,
    };
  });
}

// ── Operatori ────────────────────────────────────────────────────────────────

function rowToDriver(d: any) {
  return {
    id: d.id, name: d.name, badge: d.badge, isFictitious: d.is_fictitious,
    matricola: d.matricola ?? null, cognome: d.cognome ?? null, nome: d.nome ?? null,
    cf: d.cf ?? null, cellulare: d.cellulare ?? null,
    residenzaAnagrafica: d.residenza_anagrafica ?? null, residenzaServizio: d.residenza_servizio ?? null,
    oreSettimanali: d.ore_settimanali ?? null, categoria: d.categoria ?? null,
    dataNascita: d.data_nascita ?? null, dataAssunzione: d.data_assunzione ?? null,
    dataFineServizio: d.data_fine_servizio ?? null,
    patente: d.patente ?? null, patenteValidita: d.patente_validita ?? null,
    cqcNumero: d.cqc_numero ?? null, cqcValidita: d.cqc_validita ?? null,
    visitaMedicaValidita: d.visita_medica_validita ?? null, note: d.note ?? null,
  };
}

// mappa body camelCase → coppie colonna/valore per INSERT/UPDATE
function driverFieldPairs(b: any): Array<{ col: string; val: any }> {
  const m: Record<string, any> = {
    matricola: b.matricola, cognome: b.cognome, nome: b.nome, cf: b.cf, cellulare: b.cellulare,
    residenza_anagrafica: b.residenzaAnagrafica, residenza_servizio: b.residenzaServizio,
    ore_settimanali: b.oreSettimanali, categoria: b.categoria,
    data_nascita: b.dataNascita, data_assunzione: b.dataAssunzione, data_fine_servizio: b.dataFineServizio,
    patente: b.patente, patente_validita: b.patenteValidita,
    cqc_numero: b.cqcNumero, cqc_validita: b.cqcValidita,
    visita_medica_validita: b.visitaMedicaValidita, note: b.note, badge: b.badge,
  };
  const dateCols = new Set(["data_nascita", "data_assunzione", "data_fine_servizio", "patente_validita", "cqc_validita", "visita_medica_validita"]);
  const out: Array<{ col: string; val: any }> = [];
  for (const [col, raw] of Object.entries(m)) {
    if (raw === undefined) continue;
    let val = raw === "" ? null : raw;
    if (col === "ore_settimanali" && val != null) val = Number(val) || null;
    if (dateCols.has(col) && val != null && !DATE_RE.test(String(val))) val = null;
    out.push({ col, val });
  }
  return out;
}

router.get("/roster/drivers", async (_req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      SELECT * FROM roster_drivers WHERE is_active = true
      ORDER BY cognome NULLS LAST, nome NULLS LAST, name
    `);
    res.json({ drivers: r.rows.map(rowToDriver) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/roster/drivers", async (req, res): Promise<void> => {
  try {
    const b = req.body ?? {};
    // name = "Cognome Nome" se non passato esplicitamente
    const name = String(b.name ?? [b.cognome, b.nome].filter(Boolean).join(" ")).trim();
    if (!name) { res.status(400).json({ error: "Cognome/Nome obbligatori" }); return; }
    const pairs = driverFieldPairs(b);
    const cols = ["name", "is_fictitious", ...pairs.map((p) => p.col)];
    const vals = [name, !!b.isFictitious, ...pairs.map((p) => p.val)];
    const colSql = sql.raw(cols.join(", "));
    const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
    const r = await db.execute<any>(sql`
      INSERT INTO roster_drivers (${colSql}) VALUES (${valSql}) RETURNING *
    `);
    res.status(201).json(rowToDriver(r.rows[0]));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/roster/drivers/:id", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const b = req.body ?? {};
    const sets: any[] = [];
    if (typeof b.name === "string" && b.name.trim()) sets.push(sql`name = ${b.name.trim()}`);
    else if (b.cognome !== undefined || b.nome !== undefined) {
      const nm = [b.cognome, b.nome].filter(Boolean).join(" ").trim();
      if (nm) sets.push(sql`name = ${nm}`);
    }
    for (const { col, val } of driverFieldPairs(b)) sets.push(sql`${sql.raw(col)} = ${val}`);
    if (sets.length === 0) { res.status(400).json({ error: "Nessun campo da aggiornare" }); return; }
    const r = await db.execute<any>(sql`
      UPDATE roster_drivers SET ${sql.join(sets, sql`, `)}
       WHERE id = ${id}::uuid RETURNING *
    `);
    if (!r.rows[0]) { res.status(404).json({ error: "Conducente non trovato" }); return; }
    res.json(rowToDriver(r.rows[0]));
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
      SELECT * FROM roster_drivers
      WHERE is_active = true ORDER BY cognome NULLS LAST, nome NULLS LAST, name
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

    // Residenza di servizio = deposito dello scenario turni-macchina collegato al
    // DSS. I turni del Roster vengono colorati con il colore del deposito.
    let residenza: { name: string; color: string } | null = null;
    if (dssId) {
      try {
        const depR = await db.execute<any>(sql`
          SELECT dep.name, dep.color
            FROM driver_shift_scenarios d
            JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
            JOIN depots dep ON dep.id = s.depot_id
           WHERE d.id = ${dssId}::uuid LIMIT 1`);
        const dep = depR.rows?.[0];
        if (dep) residenza = { name: dep.name, color: dep.color || "#3b82f6" };
      } catch { /* depot_id può non esistere su scenari vecchi */ }
    }

    res.json({
      from, days: dayList,
      drivers: driversQ.rows.map(rowToDriver),
      duties,
      residenza,
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
