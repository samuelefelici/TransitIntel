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
