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
import { driverScenariosAccessibleWhere, requireDriverScenarioRead } from "../lib/scenario-access";

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
  // Un conducente può fare PIÙ turni nello stesso giorno: togliamo il vincolo
  // "un turno per giorno". Resta UNIQUE(dss_id, day, duty_code): un turno è
  // assegnabile a un solo conducente.
  await db.execute(sql`ALTER TABLE roster_assignments DROP CONSTRAINT IF EXISTS roster_assignments_driver_id_day_key`);
  // Anagrafica conducente ricca (colonne additive, idempotenti)
  for (const col of [
    "matricola text", "cognome text", "nome text", "cf text", "cellulare text",
    "residenza_anagrafica text", "residenza_servizio text",
    "ore_settimanali integer", "categoria text",
    "data_nascita date", "data_assunzione date", "data_fine_servizio date",
    "patente text", "patente_validita date",
    "cqc_numero text", "cqc_validita date",
    "visita_medica_validita date", "note text",
    // ── nuovi: foto, abilitazioni, visite mediche distinte ──
    "photo_url text",
    "abilitazioni text[] NOT NULL DEFAULT '{}'::text[]",
    "visita_ferrovie_validita date",           // idoneità sanitaria ferrovie
    "visita_medico_competente_validita date",  // sorveglianza sanitaria D.Lgs 81
  ]) {
    await db.execute(sql.raw(`ALTER TABLE roster_drivers ADD COLUMN IF NOT EXISTS ${col}`));
  }
  // Storico del conducente (append-only): depositi, categoria, visite, patente, cqc.
  // event_date = data di passaggio/visita; expiry_date = scadenza (dove ha senso).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_driver_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id uuid NOT NULL REFERENCES roster_drivers(id) ON DELETE CASCADE,
      kind text NOT NULL,               -- deposito | categoria | visita_ferrovie | visita_medico_competente | patente | cqc
      value text,                       -- deposito/categoria/classe patente/esito visita/n. cqc
      event_date date,                  -- data di passaggio o della visita
      expiry_date date,                 -- scadenza (visite/patenti/cqc)
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_roster_hist_driver ON roster_driver_history(driver_id, event_date DESC)`);
  // Voci di ASSENZA / PRESENZA inserite sul tabellone (conducente × giorno),
  // in aggiunta ai turni. Indipendenti dalla fonte turni (DSS).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_id uuid NOT NULL REFERENCES roster_drivers(id) ON DELETE CASCADE,
      day date NOT NULL,
      category text NOT NULL,   -- assenza | presenza
      code text NOT NULL,       -- R, MA3, STRA, D1 …
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (driver_id, day, code)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_roster_entries_day ON roster_entries(day)`);
  bootstrapped = true;
}

/** Catalogo voci Assenza/Presenza. Estendibile: aggiungi qui nuovi codici. */
const VOCI_CATALOG: Record<"assenza" | "presenza", Array<{ code: string; label: string }>> = {
  assenza: [
    { code: "R",   label: "Riposo" },
    { code: "MA3", label: "Malattia primi 3 giorni" },
    { code: "MA",  label: "Malattia giorni successivi" },
    { code: "I",   label: "Infortunio" },
    { code: "PAD", label: "Permesso 104" },
  ],
  presenza: [
    { code: "STRA", label: "Straordinario" },
    { code: "D1",   label: "Disposizione mattinale" },
    { code: "D2",   label: "Disposizione pomeridiana" },
    { code: "DISP", label: "Disposizione" },
    { code: "DAM1", label: "Controllerie mattinali" },
    { code: "DAM2", label: "Controllerie pomeridiane" },
  ],
};
const VOCE_CODES: Record<string, Set<string>> = {
  assenza: new Set(VOCI_CATALOG.assenza.map((v) => v.code)),
  presenza: new Set(VOCI_CATALOG.presenza.map((v) => v.code)),
};

/** Abilitazioni ammesse (chiavi stabili, il simbolo/label è lato frontend). */
const ABILITAZIONI = ["autobus", "filobus", "autosnodato", "ascensore", "verificatore"];
const HISTORY_KINDS = ["deposito", "categoria", "orario_lavoro", "visita_ferrovie", "visita_medico_competente", "patente", "cqc"];
/** kind dello storico che richiedono SEMPRE la data di inizio. */
const HISTORY_REQUIRES_DATE = new Set(HISTORY_KINDS);
/** kind → colonna "valore attuale" (denormalizzato = ultima voce dello storico). */
const CURRENT_COL: Record<string, { col: string; from: "value" | "expiry"; numeric?: boolean }> = {
  deposito: { col: "residenza_servizio", from: "value" },
  categoria: { col: "categoria", from: "value" },
  orario_lavoro: { col: "ore_settimanali", from: "value", numeric: true },
  visita_ferrovie: { col: "visita_ferrovie_validita", from: "expiry" },
  visita_medico_competente: { col: "visita_medico_competente_validita", from: "expiry" },
  patente: { col: "patente_validita", from: "expiry" },
  cqc: { col: "cqc_validita", from: "expiry" },
};

/** Riallinea la colonna "valore attuale" del conducente all'ultima voce dello
 *  storico per quel kind (o la azzera se non ce ne sono). */
async function syncCurrentFromHistory(driverId: string, kind: string): Promise<void> {
  const map = CURRENT_COL[kind];
  if (!map) return;
  const r = await db.execute<any>(sql`
    SELECT value, expiry_date FROM roster_driver_history
     WHERE driver_id = ${driverId}::uuid AND kind = ${kind}
     ORDER BY event_date DESC NULLS LAST, created_at DESC LIMIT 1
  `);
  const row = r.rows[0];
  let val: any = row ? (map.from === "expiry" ? row.expiry_date : row.value) : null;
  if (map.numeric) { const n = parseInt(String(val ?? ""), 10); val = Number.isFinite(n) ? n : null; }
  await db.execute(sql`UPDATE roster_drivers SET ${sql.raw(map.col)} = ${val} WHERE id = ${driverId}::uuid`);
}

router.use(async (_req, _res, next) => { await ensureRosterTables(); next(); });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

interface DutySegment {
  type: string;                 // trip | deadhead | depot | riserva …
  line: string | null;          // linea (route) — null per fuorilinea/attività
  startTime: string | null; startPlace: string | null;
  endTime: string | null;   endPlace: string | null;
}
const _hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;

/** Estrae i turni guida dal result JSON di un DSS (formato crew_scheduler_v4). */
function extractDuties(result: any): Array<{
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
  interruption: string | null; ripreseCount: number; tripsCount: number; costEuro: number | null;
  residenzaName: string | null; residenzaColor: string | null;
  segments: DutySegment[];
}> {
  const list = result?.driverShifts ?? result?.duties ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((d: any, i: number) => {
    const riprese = Array.isArray(d.riprese) ? d.riprese : [];
    const tripsCount = riprese.reduce(
      (s: number, r: any) => s + (Array.isArray(r?.trips) ? r.trips.filter((t: any) => (t?.type ?? "trip") === "trip").length : 0),
      0,
    );
    // Contenuto del turno: ogni tratta con linea, orari e luoghi (anche fuorilinea).
    const segments: DutySegment[] = [];
    for (const r of riprese) {
      for (const t of (Array.isArray(r?.trips) ? r.trips : [])) {
        segments.push({
          type: t?.type ?? "trip",
          line: t?.routeName ?? t?.routeShortName ?? (t?.routeId || null),
          startTime: t?.departureTime ?? (typeof t?.departureMin === "number" ? _hhmm(t.departureMin) : null),
          startPlace: t?.firstStopName ?? null,
          endTime: t?.arrivalTime ?? (typeof t?.arrivalMin === "number" ? _hhmm(t.arrivalMin) : null),
          endPlace: t?.lastStopName ?? null,
        });
      }
    }
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
      // Residenza per-turno (dal turno macchina, propagata dal crew scheduler)
      residenzaName: d.residenzaName ?? null,
      residenzaColor: d.residenzaColor ?? null,
      segments,
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
    photoUrl: d.photo_url ?? null,
    abilitazioni: Array.isArray(d.abilitazioni) ? d.abilitazioni : [],
    visitaFerrovieValidita: d.visita_ferrovie_validita ?? null,
    visitaMedicoCompetenteValidita: d.visita_medico_competente_validita ?? null,
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
    photo_url: b.photoUrl,
    visita_ferrovie_validita: b.visitaFerrovieValidita,
    visita_medico_competente_validita: b.visitaMedicoCompetenteValidita,
  };
  const dateCols = new Set([
    "data_nascita", "data_assunzione", "data_fine_servizio",
    "patente_validita", "cqc_validita", "visita_medica_validita",
    "visita_ferrovie_validita", "visita_medico_competente_validita",
  ]);
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

/** Letterale Postgres `{a,b}` per la colonna abilitazioni (chiavi allowlist,
 *  quindi alfanumeriche: nessun escaping necessario). undefined = non toccare. */
function abilitazioniLiteral(b: any): string | undefined {
  if (!Array.isArray(b.abilitazioni)) return undefined;
  const vals = b.abilitazioni.map((x: any) => String(x)).filter((x: string) => ABILITAZIONI.includes(x));
  return `{${vals.join(",")}}`;
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
    const frags = [sql`${name}`, sql`${!!b.isFictitious}`, ...pairs.map((p) => sql`${p.val}`)];
    const abil = abilitazioniLiteral(b);
    if (abil !== undefined) { cols.push("abilitazioni"); frags.push(sql`${abil}::text[]`); }
    const colSql = sql.raw(cols.join(", "));
    const valSql = sql.join(frags, sql`, `);
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
    const abil = abilitazioniLiteral(b);
    if (abil !== undefined) sets.push(sql`abilitazioni = ${abil}::text[]`);
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

// ── Storico conducente (depositi, categoria, visite, patente, cqc) ────────────

function rowToHistory(h: any) {
  return {
    id: h.id, driverId: h.driver_id, kind: h.kind, value: h.value ?? null,
    eventDate: h.event_date ?? null, expiryDate: h.expiry_date ?? null,
    note: h.note ?? null, createdAt: h.created_at,
  };
}

router.get("/roster/drivers/:id/history", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const r = await db.execute<any>(sql`
      SELECT * FROM roster_driver_history
       WHERE driver_id = ${id}::uuid
       ORDER BY event_date DESC NULLS LAST, created_at DESC
    `);
    res.json({ history: r.rows.map(rowToHistory) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/roster/drivers/:id/history", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const b = req.body ?? {};
    const kind = String(b.kind ?? "");
    if (!HISTORY_KINDS.includes(kind)) { res.status(400).json({ error: "kind non valido" }); return; }
    const value = b.value != null && String(b.value).trim() ? String(b.value).trim().slice(0, 200) : null;
    const eventDate = DATE_RE.test(String(b.eventDate ?? "")) ? String(b.eventDate) : null;
    const expiryDate = DATE_RE.test(String(b.expiryDate ?? "")) ? String(b.expiryDate) : null;
    const note = b.note != null && String(b.note).trim() ? String(b.note).trim().slice(0, 500) : null;
    // Ogni voce dello storico richiede la DATA DI INIZIO (data di passaggio/visita).
    if (HISTORY_REQUIRES_DATE.has(kind) && !eventDate) {
      res.status(400).json({ error: "Data di inizio obbligatoria" }); return;
    }
    const r = await db.execute<any>(sql`
      INSERT INTO roster_driver_history (driver_id, kind, value, event_date, expiry_date, note)
      VALUES (${id}::uuid, ${kind}, ${value}, ${eventDate}::date, ${expiryDate}::date, ${note})
      RETURNING *
    `);
    await syncCurrentFromHistory(id, kind); // allinea il "valore attuale"
    res.status(201).json(rowToHistory(r.rows[0]));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/roster/history/:hid", async (req, res): Promise<void> => {
  try {
    const hid = String(req.params.hid);
    if (!UUID_RE.test(hid)) { res.status(400).json({ error: "ID non valido" }); return; }
    // recupera driver_id + kind prima di eliminare, per ri-allineare il valore attuale
    const before = await db.execute<any>(sql`SELECT driver_id, kind FROM roster_driver_history WHERE id = ${hid}::uuid LIMIT 1`);
    const row = before.rows[0];
    await db.execute(sql`DELETE FROM roster_driver_history WHERE id = ${hid}::uuid`);
    if (row) await syncCurrentFromHistory(row.driver_id, row.kind);
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
      WHERE ${driverScenariosAccessibleWhere(req.user!.id, req.user!.role === "admin")} ${opWhere} ${psWhere}
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
      // IDOR fix: verifica che l'utente possa leggere QUESTO scenario turni
      // prima di esporne i duty (codici, orari, costi, residenze).
      if (!UUID_RE.test(dssId)) { res.status(400).json({ error: "dssId non valido" }); return; }
      const acc = await requireDriverScenarioRead(req, res, dssId);
      if (!acc) return;
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

    // Voci Assenza/Presenza nel range (indipendenti dal DSS selezionato).
    const entriesQ = await db.execute<any>(sql`
      SELECT id, driver_id, day::text AS day, category, code
        FROM roster_entries
       WHERE day >= ${from}::date AND day < ${from}::date + (${days} * interval '1 day')
    `);

    res.json({
      from, days: dayList,
      drivers: driversQ.rows.map(rowToDriver),
      duties,
      residenza,
      assignments: assignQ.rows.map((a: any) => ({
        id: a.id, driverId: a.driver_id, day: a.day.slice(0, 10), dutyCode: a.duty_code, dssId: a.dss_id,
      })),
      entries: entriesQ.rows.map((e: any) => ({
        id: e.id, driverId: e.driver_id, day: e.day.slice(0, 10), category: e.category, code: e.code,
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
    // Un conducente può avere più turni in un giorno. Il turno resta però
    // assegnabile a un solo conducente (UNIQUE dss_id/day/duty_code): riassegnarlo
    // lo sposta sul nuovo conducente.
    const r = await db.execute<any>(sql`
      INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code)
      VALUES (${driverId}::uuid, ${day}::date, ${dssId}::uuid, ${dutyCode})
      ON CONFLICT (dss_id, day, duty_code)
      DO UPDATE SET driver_id = EXCLUDED.driver_id
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

// ── Voci Assenza / Presenza ───────────────────────────────────────────────────

router.get("/roster/voci", async (_req, res): Promise<void> => {
  res.json({ catalog: VOCI_CATALOG });
});

router.post("/roster/entries", async (req, res): Promise<void> => {
  try {
    const { driverId, day, category, code } = req.body ?? {};
    if (!driverId || !UUID_RE.test(String(driverId)) || !DATE_RE.test(String(day ?? ""))) {
      res.status(400).json({ error: "driverId (uuid) e day (YYYY-MM-DD) richiesti" }); return;
    }
    if (category !== "assenza" && category !== "presenza") { res.status(400).json({ error: "category non valida" }); return; }
    if (!VOCE_CODES[category].has(String(code))) { res.status(400).json({ error: "codice voce non valido" }); return; }
    const r = await db.execute<any>(sql`
      INSERT INTO roster_entries (driver_id, day, category, code)
      VALUES (${driverId}::uuid, ${day}::date, ${category}, ${code})
      ON CONFLICT (driver_id, day, code) DO UPDATE SET category = EXCLUDED.category
      RETURNING id
    `);
    res.status(201).json({ ok: true, id: r.rows[0]?.id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/roster/entries/:id", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    await db.execute(sql`DELETE FROM roster_entries WHERE id = ${id}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/roster/assignments/:id", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`DELETE FROM roster_assignments WHERE id = ${String(req.params.id)}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
