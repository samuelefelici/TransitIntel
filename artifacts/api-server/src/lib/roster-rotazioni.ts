/**
 * ROTAZIONI RIPOSI — cicli settimanali di riposo.
 *
 * Una rotazione riposi è un ciclo di N settimane × 7 giorni: ogni riga è una
 * settimana del ciclo, ogni cella contiene (o no) un'attività di riposo (es.
 * "R"). Ogni conducente parte da una riga diversa e avanza di una settimana; il
 * ciclo si chiude dopo N settimane e ricomincia.
 *
 *   GET    /roster/rotazioni-riposi          → elenco
 *   POST   /roster/rotazioni-riposi          → salva { name, pattern, meta? }
 *   DELETE /roster/rotazioni-riposi/:id      → elimina
 *   POST   /roster/rotazioni-riposi/solve    → assistente CP-SAT (OR-Tools)
 *                                              genera pattern candidati
 */
import type { Request } from "express";
import { Router, type IRouter } from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { SCRIPTS_DIR } from "./scripts-dir";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

let bootstrapped = false;
async function ensureTable(): Promise<void> {
  if (bootstrapped) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_rotazioni_riposi (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      weeks integer NOT NULL,
      pattern jsonb NOT NULL,          -- [ [ "R"|null × 7 ] × weeks ]
      meta jsonb,                      -- parametri/KPI dalla ricerca (opzionale)
      owner_user_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // ANCORA di fase del ciclo: la prima generazione la fissa; le rigenerazioni
  // successive mantengono la stessa fase anche partendo da una data diversa.
  await db.execute(sql`ALTER TABLE roster_rotazioni_riposi ADD COLUMN IF NOT EXISTS anchor_date date`);
  // Assegnazione conducenti agli scaglioni (righe = settimane) di una rotazione.
  // week_index = riga di partenza (scaglione, 0-based). Un conducente ha un solo
  // scaglione per rotazione.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_rotazione_assegnazioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      rotazione_id uuid NOT NULL REFERENCES roster_rotazioni_riposi(id) ON DELETE CASCADE,
      week_index integer NOT NULL,
      driver_id uuid NOT NULL REFERENCES roster_drivers(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (rotazione_id, driver_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_rot_asg_rot ON roster_rotazione_assegnazioni(rotazione_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_rot_asg_drv ON roster_rotazione_assegnazioni(driver_id)`);
  bootstrapped = true;
}
router.use(async (_req, _res, next) => { await ensureTable(); next(); });

function getUserId(req: Request): string | null {
  return (req as any).user?.id ?? (req as any).session?.userId ?? null;
}

function rowToRotazione(r: any) {
  return { id: r.id, name: r.name, weeks: r.weeks, pattern: r.pattern, meta: r.meta ?? null, createdAt: r.created_at };
}

/** Valida/normalizza un pattern: matrice weeks×7 di stringa(≤8) o null. */
function normalizePattern(raw: any): string[][] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 60) return null;
  const out: (string | null)[][] = [];
  for (const week of raw) {
    if (!Array.isArray(week) || week.length !== 7) return null;
    out.push(week.map((c: any) => {
      if (c == null || c === "") return null;
      const s = String(c).trim().toUpperCase().slice(0, 8);
      return s || null;
    }));
  }
  return out as string[][];
}

/* ─── CRUD ─── */

router.get("/roster/rotazioni-riposi", async (_req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      SELECT * FROM roster_rotazioni_riposi ORDER BY created_at DESC
    `);
    res.json({ rotazioni: r.rows.map(rowToRotazione) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/roster/rotazioni-riposi", async (req, res): Promise<void> => {
  try {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim().slice(0, 120);
    if (!name) { res.status(400).json({ error: "Nome obbligatorio" }); return; }
    const pattern = normalizePattern(b.pattern);
    if (!pattern) { res.status(400).json({ error: "Pattern non valido (matrice settimane × 7 giorni)" }); return; }
    const meta = b.meta && typeof b.meta === "object" ? b.meta : null;
    const r = await db.execute<any>(sql`
      INSERT INTO roster_rotazioni_riposi (name, weeks, pattern, meta, owner_user_id)
      VALUES (${name}, ${pattern.length}, ${JSON.stringify(pattern)}::jsonb,
              ${meta ? JSON.stringify(meta) : null}::jsonb, ${getUserId(req)}::uuid)
      RETURNING *
    `);
    res.status(201).json(rowToRotazione(r.rows[0]));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/roster/rotazioni-riposi/:id", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    await db.execute(sql`DELETE FROM roster_rotazioni_riposi WHERE id = ${id}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── Assistente CP-SAT ─── */

function runSolver(input: any): Promise<any> {
  const scriptPath = path.resolve(SCRIPTS_DIR, "rotazione_riposi.py");
  return new Promise((resolve, reject) => {
    const py = spawn("python3", [scriptPath], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { py.kill("SIGKILL"); reject(new Error("timeout ricerca (troppe combinazioni: restringi il range N/K)")); }, 180_000);
    py.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    py.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    py.on("error", (err) => { clearTimeout(timer); reject(err); });
    py.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`solver exit ${code}: ${stderr.slice(0, 300)}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (e: any) { reject(new Error(`parse solver: ${e.message}`)); }
    });
    py.stdin.on("error", () => { /* EPIPE guard */ });
    py.stdin.write(JSON.stringify(input)); py.stdin.end();
  });
}

/* ─── Assegnazione scaglioni (conducenti → righe della cadenza) ─── */

/** Letterale Postgres `{uuid,uuid}` per una colonna uuid[] (ANY / cast). */
function uuidArrayLiteral(ids: string[]): string {
  return `{${ids.filter((x) => UUID_RE.test(x)).join(",")}}`;
}

// GET assegnazioni di una rotazione → elenco { weekIndex, driverId }.
router.get("/roster/rotazioni-riposi/:id/assegnazioni", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const r = await db.execute<any>(sql`
      SELECT week_index, driver_id FROM roster_rotazione_assegnazioni
       WHERE rotazione_id = ${id}::uuid ORDER BY week_index
    `);
    res.json({ assegnazioni: r.rows.map((x: any) => ({ weekIndex: x.week_index, driverId: x.driver_id })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT assegnazioni: sostituisce l'intero set di scaglioni della rotazione.
// body: { assignments: [{ weekIndex, driverId }] }. Un conducente = un solo scaglione.
router.put("/roster/rotazioni-riposi/:id/assegnazioni", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const rot = await db.execute<any>(sql`SELECT weeks FROM roster_rotazioni_riposi WHERE id = ${id}::uuid`);
    if (!rot.rows[0]) { res.status(404).json({ error: "Rotazione non trovata" }); return; }
    const weeks = Number(rot.rows[0].weeks);
    const raw = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    // Deduplica per conducente (ultimo scaglione vince) e valida.
    const byDriver = new Map<string, number>();
    for (const a of raw) {
      const driverId = String(a?.driverId ?? "");
      const wi = Number(a?.weekIndex);
      if (!UUID_RE.test(driverId)) continue;
      if (!Number.isInteger(wi) || wi < 0 || wi >= weeks) continue;
      byDriver.set(driverId, wi);
    }
    await db.execute(sql`DELETE FROM roster_rotazione_assegnazioni WHERE rotazione_id = ${id}::uuid`);
    for (const [driverId, wi] of byDriver) {
      await db.execute(sql`
        INSERT INTO roster_rotazione_assegnazioni (rotazione_id, week_index, driver_id)
        VALUES (${id}::uuid, ${wi}, ${driverId}::uuid)
        ON CONFLICT (rotazione_id, driver_id) DO UPDATE SET week_index = EXCLUDED.week_index
      `);
    }
    res.json({ ok: true, count: byDriver.size });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET cadenze di un conducente → rotazioni a cui è assegnato + scaglione + pattern.
router.get("/roster/drivers/:id/cadenze", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const r = await db.execute<any>(sql`
      SELECT rr.id, rr.name, rr.weeks, rr.pattern, a.week_index
        FROM roster_rotazione_assegnazioni a
        JOIN roster_rotazioni_riposi rr ON rr.id = a.rotazione_id
       WHERE a.driver_id = ${id}::uuid
       ORDER BY rr.name
    `);
    res.json({ cadenze: r.rows.map((x: any) => ({
      rotazioneId: x.id, name: x.name, weeks: x.weeks,
      scaglione: x.week_index, pattern: x.pattern,
    })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/* ─── Generazione riposi (cadenza → voci sul tabellone, per tutto l'anno) ─── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Indice giorno settimana Lun=0 … Dom=6 da una data UTC. */
function weekdayMon0(d: Date): number { return (d.getUTCDay() + 6) % 7; }

// POST genera-riposi: carica i riposi della rotazione sul tabellone per i
// conducenti assegnati, filtrati per categoria/deposito, per `days` giorni.
// Idempotente: cancella e rigenera le voci con source='rotazione:<id>' nello
// scope (categoria/deposito) e range, gestendo variazioni (nuovo conducente,
// rimozione, cambio scaglione).
router.post("/roster/rotazioni-riposi/:id/genera-riposi", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    const b = req.body ?? {};
    const startDate = String(b.startDate ?? "");
    if (!DATE_RE.test(startDate)) { res.status(400).json({ error: "startDate=YYYY-MM-DD richiesto" }); return; }
    const days = Math.min(Math.max(Number(b.days) || 365, 7), 400);
    const categoria = b.categoria ? String(b.categoria).trim() : "";
    const deposito = b.deposito ? String(b.deposito).trim() : "";
    const codeDefault = String(b.code ?? "R").trim().toUpperCase().slice(0, 8) || "R";

    const rot = await db.execute<any>(sql`
      SELECT pattern, weeks, to_char(anchor_date, 'YYYY-MM-DD') AS anchor_date
        FROM roster_rotazioni_riposi WHERE id = ${id}::uuid
    `);
    if (!rot.rows[0]) { res.status(404).json({ error: "Rotazione non trovata" }); return; }
    const pattern: (string | null)[][] = rot.rows[0].pattern;
    const weeks = Number(rot.rows[0].weeks);
    if (!Array.isArray(pattern) || weeks < 1) { res.status(400).json({ error: "Pattern rotazione non valido" }); return; }

    // STORICO IMMUTABILE: la rigenerazione non riscrive mai i giorni già
    // trascorsi — la finestra effettiva parte al più presto da OGGI.
    const todayStr = new Date().toISOString().slice(0, 10);
    const effStartStr = startDate > todayStr ? startDate : todayStr;
    // ANCORA di fase: la prima generazione la fissa (= startDate richiesto);
    // le successive riusano quella salvata, così ripartire da una data diversa
    // non ri-fasa silenziosamente i riposi di tutti.
    let anchorStr: string = rot.rows[0].anchor_date ?? "";
    if (!anchorStr) {
      anchorStr = startDate;
      await db.execute(sql`
        UPDATE roster_rotazioni_riposi SET anchor_date = ${startDate}::date WHERE id = ${id}::uuid`);
    }

    // Scope = conducenti attivi che rientrano nei filtri categoria/deposito
    // (o tutti se nessun filtro). Le loro voci-rotazione nel range vengono
    // riconciliate. Target = scope ∩ assegnati alla rotazione.
    const scope = await db.execute<any>(sql`
      SELECT id, week_index FROM (
        SELECT d.id,
               (SELECT a.week_index FROM roster_rotazione_assegnazioni a
                 WHERE a.rotazione_id = ${id}::uuid AND a.driver_id = d.id) AS week_index
          FROM roster_drivers d
         WHERE d.is_active = true
           AND (${categoria}::text = '' OR d.categoria = ${categoria})
           AND (${deposito}::text = '' OR d.residenza_servizio = ${deposito})
      ) s
    `);
    const scopeIds: string[] = scope.rows.map((r: any) => r.id);
    if (scopeIds.length === 0) { res.json({ ok: true, drivers: 0, created: 0, cleared: 0 }); return; }

    // Range date EFFETTIVO (mai nel passato) + fase dal Lunedì dell'ANCORA.
    const start = new Date(`${effStartStr}T00:00:00Z`);
    const endStr = new Date(start.getTime() + days * DAY_MS).toISOString().slice(0, 10);
    const anchor = new Date(`${anchorStr}T00:00:00Z`);
    const startMonday = new Date(anchor.getTime() - weekdayMon0(anchor) * DAY_MS);

    // 1) Pulisci le voci-rotazione precedenti nello scope e nel range (solo futuro).
    const del = await db.execute<any>(sql`
      DELETE FROM roster_entries
       WHERE source = ${`rotazione:${id}`}
         AND day >= ${effStartStr}::date AND day < ${endStr}::date
         AND driver_id = ANY(${uuidArrayLiteral(scopeIds)}::uuid[])
    `);
    const cleared = del.rowCount ?? 0;

    // 2) Genera le voci per i target (assegnati).
    const targets = scope.rows.filter((r: any) => r.week_index != null);
    const values: any[] = [];
    for (const t of targets) {
      const scaglione = Number(t.week_index);
      for (let i = 0; i < days; i++) {
        const d = new Date(start.getTime() + i * DAY_MS);
        const wd = weekdayMon0(d);
        const mondayOfD = new Date(d.getTime() - wd * DAY_MS);
        const weekOffset = Math.round((mondayOfD.getTime() - startMonday.getTime()) / (7 * DAY_MS));
        const row = ((scaglione + weekOffset) % weeks + weeks) % weeks;
        const cell = pattern[row]?.[wd];
        if (cell == null || cell === "") continue;
        const code = String(cell).trim().toUpperCase().slice(0, 8) || codeDefault;
        values.push({ driverId: t.id, day: d.toISOString().slice(0, 10), code });
      }
    }

    // Bulk insert a blocchi.
    let created = 0;
    const src = `rotazione:${id}`;
    for (let off = 0; off < values.length; off += 500) {
      const chunk = values.slice(off, off + 500);
      const rows = chunk.map((v) => sql`(${v.driverId}::uuid, ${v.day}::date, 'assenza', ${v.code}, ${src})`);
      const r = await db.execute<any>(sql`
        INSERT INTO roster_entries (driver_id, day, category, code, source)
        VALUES ${sql.join(rows, sql`, `)}
        ON CONFLICT (driver_id, day, code) DO UPDATE SET source = EXCLUDED.source, category = 'assenza'
      `);
      created += r.rowCount ?? chunk.length;
    }

    res.json({ ok: true, drivers: targets.length, scope: scopeIds.length, created, cleared });
  } catch (e: any) {
    console.error("[rotazioni.genera-riposi]", e?.message || e);
    res.status(500).json({ error: e?.message || "Errore nella generazione" });
  }
});

router.post("/roster/rotazioni-riposi/solve", async (req, res): Promise<void> => {
  try {
    const b = req.body ?? {};
    // range limitato lato server per proteggere il worker
    const input = {
      domanda_feriali: Math.max(1, Number(b.domanda_feriali) || 51),
      domanda_domenica: Math.max(1, Number(b.domanda_domenica) || 15),
      mode: b.mode === "pct" ? "pct" : "forza",
      forza_feriale_reale: b.forza_feriale_reale != null ? Number(b.forza_feriale_reale) : 66,
      riserva_domenica_pct: b.riserva_domenica_pct != null ? Number(b.riserva_domenica_pct) : 25,
      riposi_anno_target: Number(b.riposi_anno_target) || 54,
      tol_riposi: Number(b.tol_riposi) || 1,
      max_consec: Math.max(1, Number(b.max_consec) || 6),
      balance_weekday: b.balance_weekday !== false,
      n_min: Math.max(1, Number(b.n_min) || 11),
      n_max: Math.min(80, Number(b.n_max) || 56),
      k_min: Math.max(1, Number(b.k_min) || 1),
      k_max: Math.min(10, Number(b.k_max) || 4),
      timeout_per_attempt: Math.min(20, Math.max(1, Number(b.timeout_per_attempt) || 4)),
      top_n: Math.min(30, Math.max(1, Number(b.top_n) || 12)),
    };
    const out = await runSolver(input);
    res.json(out);
  } catch (e: any) {
    console.error("[rotazioni.solve]", e?.message || e);
    res.status(500).json({ error: e?.message || "Errore nel calcolo" });
  }
});

export default router;
