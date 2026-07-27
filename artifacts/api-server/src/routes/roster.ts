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
  // SNAPSHOT minimo del turno al momento dell'assegnazione (inizio/fine/ore/
  // deposito): se il DSS viene versionato o sparisce, lo storico resta leggibile.
  await db.execute(sql`ALTER TABLE roster_assignments ADD COLUMN IF NOT EXISTS snapshot jsonb`);
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
  // `source` traccia l'origine di una voce generata (es. "rotazione:<uuid>"):
  // permette la rigenerazione idempotente (cancella per source + reinserisci) a
  // fronte di variazioni (nuovo conducente, cambio rotazione…). NULL = manuale.
  await db.execute(sql`ALTER TABLE roster_entries ADD COLUMN IF NOT EXISTS source text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_roster_entries_source ON roster_entries(source)`);
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

// ── Generatore anagrafica fittizia (dati falsi, coerenti) ─────────────────────
const FAKE_COGNOMI = [
  "Rossi", "Bianchi", "Ferrari", "Russo", "Romano", "Gallo", "Costa", "Fontana",
  "Conti", "Esposito", "Ricci", "Bruno", "De Luca", "Moretti", "Marino", "Greco",
  "Barbieri", "Lombardi", "Giordano", "Rizzo", "Colombo", "Mancini", "Longo",
  "Leone", "Martinelli", "Marchetti", "Serra", "Vitale", "Caruso", "Ferrara",
  "Galli", "Martini", "Pellegrini", "Palumbo", "Sanna", "Farina", "Rinaldi",
  "Villa", "Monti", "Cattaneo",
];
const FAKE_NOMI_M = [
  "Marco", "Luca", "Andrea", "Francesco", "Alessandro", "Matteo", "Davide",
  "Stefano", "Simone", "Giuseppe", "Antonio", "Giovanni", "Roberto", "Paolo",
  "Fabio", "Michele", "Riccardo", "Emanuele", "Daniele", "Nicola",
];
const FAKE_NOMI_F = [
  "Giulia", "Sara", "Martina", "Chiara", "Francesca", "Alessia", "Valentina",
  "Federica", "Elena", "Silvia", "Laura", "Anna", "Elisa", "Marta", "Serena",
];
// Depositi dell'azienda (residenza di servizio). "depositi diversi".
const FAKE_DEPOSITI = ["Ancona", "Jesi", "Senigallia", "Falconara", "Fabriano", "Osimo"];
const FAKE_CATEGORIE = ["Autista", "Autista", "Autista", "Verificatore", "Manovratore"];
const FAKE_ORE = [39, 39, 39, 38, 24];
const _pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
const _pad = (n: number, w: number) => String(n).padStart(w, "0");
/** Data casuale (YYYY-MM-DD) tra due anni interi inclusi. */
function _fakeDate(yearFrom: number, yearTo: number): string {
  const y = yearFrom + Math.floor(Math.random() * (yearTo - yearFrom + 1));
  const m = 1 + Math.floor(Math.random() * 12);
  const d = 1 + Math.floor(Math.random() * 28);
  return `${y}-${_pad(m, 2)}-${_pad(d, 2)}`;
}
/** Codice fiscale plausibile (NON valido: solo formato, dato fittizio). */
function _fakeCF(cognome: string, nome: string): string {
  const cons = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "").replace(/[AEIOU]/g, "");
  const c3 = (cons(cognome) + "XXX").slice(0, 3);
  const n3 = (cons(nome) + "XXX").slice(0, 3);
  const yy = _pad(50 + Math.floor(Math.random() * 50), 2);
  const mm = "ABCDEHLMPRST"[Math.floor(Math.random() * 12)];
  const dd = _pad(1 + Math.floor(Math.random() * 28), 2);
  const cat = "ABCDEFGHILMNPRSTZ";
  const catcode = cat[Math.floor(Math.random() * cat.length)] + _pad(100 + Math.floor(Math.random() * 899), 3);
  const chk = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)];
  return `${c3}${n3}${yy}${mm}${dd}${catcode}${chk}`;
}

// POST /roster/drivers/seed — genera N operatori fittizi con anagrafica ricca
// (cognome/nome/CF/cellulare/categoria/deposito/abilitazioni) e depositi diversi.
router.post("/roster/drivers/seed", async (req, res): Promise<void> => {
  try {
    const count = Math.min(Math.max(Number(req.body?.count) || 10, 1), 200);
    const existing = await db.execute<any>(sql`SELECT badge FROM roster_drivers WHERE badge LIKE 'FIT-%'`);
    const usedBadges = new Set(existing.rows.map((r: any) => r.badge));
    // prossima matricola libera
    let nextN = 1;
    while (usedBadges.has(`FIT-${_pad(nextN, 3)}`)) nextN++;

    let created = 0;
    for (let k = 0; created < count && k < count + 400; k++) {
      const badge = `FIT-${_pad(nextN, 3)}`;
      nextN++;
      if (usedBadges.has(badge)) continue;

      const female = Math.random() < 0.25;
      const cognome = _pick(FAKE_COGNOMI);
      const nome = female ? _pick(FAKE_NOMI_F) : _pick(FAKE_NOMI_M);
      const name = `${cognome} ${nome}`;
      const cf = _fakeCF(cognome, nome);
      const cellulare = `3${_pick([2, 3, 4, 6, 8])}${_pad(Math.floor(Math.random() * 10000000), 7)}`;
      const deposito = _pick(FAKE_DEPOSITI);
      const idx = Math.floor(Math.random() * FAKE_CATEGORIE.length);
      const categoria = FAKE_CATEGORIE[idx]!;
      const ore = FAKE_ORE[idx]!;
      const dataNascita = _fakeDate(1968, 2000);
      const dataAssunzione = _fakeDate(2005, 2024);
      const patenteValidita = _fakeDate(2026, 2031);
      const cqcValidita = _fakeDate(2026, 2030);
      const visitaFerrovie = _fakeDate(2026, 2028);
      const visitaMedico = _fakeDate(2026, 2028);
      // 1–3 abilitazioni casuali (sempre almeno "autobus")
      const abil = new Set<string>(["autobus"]);
      const nExtra = Math.floor(Math.random() * 3);
      for (let j = 0; j < nExtra; j++) abil.add(_pick(ABILITAZIONI));
      if (categoria === "Verificatore") abil.add("verificatore");
      const abilLit = `{${[...abil].join(",")}}`;

      const ins = await db.execute<any>(sql`
        INSERT INTO roster_drivers (
          name, badge, is_fictitious, cognome, nome, matricola, cf, cellulare,
          residenza_servizio, residenza_anagrafica, categoria, ore_settimanali,
          data_nascita, data_assunzione, patente, patente_validita,
          cqc_numero, cqc_validita, visita_ferrovie_validita, visita_medico_competente_validita,
          abilitazioni
        ) VALUES (
          ${name}, ${badge}, true, ${cognome}, ${nome}, ${badge.replace("FIT-", "")}, ${cf}, ${cellulare},
          ${deposito}, ${deposito}, ${categoria}, ${ore},
          ${dataNascita}::date, ${dataAssunzione}::date, ${"D-CQC"}, ${patenteValidita}::date,
          ${`CQC${_pad(100000 + Math.floor(Math.random() * 899999), 6)}`}, ${cqcValidita}::date,
          ${visitaFerrovie}::date, ${visitaMedico}::date,
          ${abilLit}::text[]
        ) RETURNING id
      `);
      const driverId = ins.rows[0]?.id;
      // Storico: deposito + categoria a partire dall'assunzione.
      if (driverId) {
        await db.execute(sql`
          INSERT INTO roster_driver_history (driver_id, kind, value, event_date)
          VALUES (${driverId}::uuid, 'deposito', ${deposito}, ${dataAssunzione}::date),
                 (${driverId}::uuid, 'categoria', ${categoria}, ${dataAssunzione}::date)
        `);
      }
      usedBadges.add(badge);
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

    // ── Modalità AUTO (dssId = "auto"): risoluzione del DSS competente PER
    // DATA usando i periodi valid_from/valid_to (P5). La settimana a cavallo
    // di un cambio turni diventa visibile in un'unica board: giorni < X sul
    // DSS vecchio, giorni ≥ X sul nuovo. I duty arrivano raggruppati per DSS.
    if (dssId === "auto") {
      const userId = (req as any).user?.id ?? null;
      const assignAll = await db.execute<any>(sql`
        SELECT a.id, a.driver_id, a.day::text AS day, a.duty_code, a.dss_id, a.snapshot
        FROM roster_assignments a
        WHERE a.day >= ${from}::date AND a.day < ${from}::date + (${days} * interval '1 day')
      `);
      // candidati = DSS referenziati dalle assegnazioni nel range ∪ DSS con
      // periodo che interseca la finestra o attualmente operativi (accessibili)
      const candQ = await db.execute<any>(sql`
        SELECT d.id, d.result, COALESCE(d.is_operational, false) AS is_operational,
               to_char(d.valid_from, 'YYYY-MM-DD') AS valid_from,
               to_char(d.valid_to,   'YYYY-MM-DD') AS valid_to,
               d.created_at
          FROM driver_shift_scenarios d
         WHERE (d.owner_user_id = ${userId}::uuid OR d.owner_user_id IS NULL)
           AND (
             d.id IN (SELECT DISTINCT dss_id FROM roster_assignments
                       WHERE day >= ${from}::date AND day < ${from}::date + (${days} * interval '1 day'))
             OR COALESCE(d.is_operational, false) = true
             OR (d.valid_from IS NOT NULL AND d.valid_from < ${from}::date + (${days} * interval '1 day')
                 AND (d.valid_to IS NULL OR d.valid_to >= ${from}::date))
           )
      `);
      const cands = (candQ.rows ?? []) as any[];
      const dutiesByDss: Record<string, ReturnType<typeof extractDuties>> = {};
      for (const c of cands) dutiesByDss[c.id] = extractDuties(c.result);
      // per ogni giorno: il DSS il cui periodo copre la data (preferendo
      // l'operativo, poi il più recente); null = nessun turno competente
      const dssByDay: Record<string, string | null> = {};
      for (const d of dayList) {
        const covering = cands.filter((c) =>
          c.valid_from && c.valid_from <= d && (!c.valid_to || c.valid_to >= d));
        covering.sort((a, b) => (Number(b.is_operational) - Number(a.is_operational))
          || String(b.created_at).localeCompare(String(a.created_at)));
        dssByDay[d] = covering[0]?.id ?? null;
      }
      const entriesA = await db.execute<any>(sql`
        SELECT id, driver_id, day::text AS day, category, code, source
          FROM roster_entries
         WHERE day >= ${from}::date AND day < ${from}::date + (${days} * interval '1 day')
      `);
      res.json({
        from, days: dayList,
        drivers: driversQ.rows.map(rowToDriver),
        duties: [], residenza: null,
        dutiesByDss, dssByDay,
        assignments: assignAll.rows.map((a: any) => ({
          id: a.id, driverId: a.driver_id, day: a.day.slice(0, 10), dutyCode: a.duty_code, dssId: a.dss_id,
          snapshot: a.snapshot ?? null,
        })),
        entries: entriesA.rows.map((e: any) => ({
          id: e.id, driverId: e.driver_id, day: e.day.slice(0, 10), category: e.category, code: e.code,
          source: e.source ?? null,
        })),
      });
      return;
    }

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
      SELECT id, driver_id, day::text AS day, category, code, source
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
        source: e.source ?? null,
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
    // SNAPSHOT del turno al momento dell'assegnazione: inizio/fine/ore pagate/
    // nome, così lo storico resta leggibile anche se il DSS viene versionato
    // (P5) o il duty rinumerato. Best-effort: mai bloccare l'assegnazione.
    let snapshot: string | null = null;
    try {
      const dQ = await db.execute<any>(sql`
        SELECT result FROM driver_shift_scenarios WHERE id = ${dssId}::uuid LIMIT 1`);
      const duty = extractDuties(dQ.rows[0]?.result).find((x: any) => String(x.code) === String(dutyCode));
      if (duty) {
        snapshot = JSON.stringify({
          start: (duty as any).start ?? null, end: (duty as any).end ?? null,
          paidHours: (duty as any).paidHours ?? null, name: (duty as any).name ?? null,
        });
      }
    } catch { /* snapshot facoltativo */ }
    // Un conducente può avere più turni in un giorno. Il turno resta però
    // assegnabile a un solo conducente (UNIQUE dss_id/day/duty_code): riassegnarlo
    // lo sposta sul nuovo conducente.
    const r = await db.execute<any>(sql`
      INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code, snapshot)
      VALUES (${driverId}::uuid, ${day}::date, ${dssId}::uuid, ${dutyCode}, ${snapshot}::jsonb)
      ON CONFLICT (dss_id, day, duty_code)
      DO UPDATE SET driver_id = EXCLUDED.driver_id,
                    snapshot = COALESCE(roster_assignments.snapshot, EXCLUDED.snapshot)
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
