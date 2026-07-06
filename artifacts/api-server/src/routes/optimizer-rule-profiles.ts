/**
 * optimizer-rule-profiles — Profili-regole riusabili per l'ottimizzatore turni guida.
 *
 * Permette di salvare un set completo di parametri/regole (la config BDS) una
 * volta e riusarlo. Catena di precedenza:
 *   default azienda (scope='company')  →  default progetto (scope='project')
 *   →  override per-scenario (modifiche live nel pannello, non persistite qui).
 *
 * "Azienda" = account (owner_user_id, modello tenant single-owner di TransitIntel).
 * "Progetto" = planning_studio_project_id.
 *
 * Tabella additiva: optimizer_rule_profiles (CREATE TABLE IF NOT EXISTS).
 *
 * Endpoints (montati sotto /api):
 *   GET    /optimizer-rule-profiles?projectId=...
 *   POST   /optimizer-rule-profiles
 *   PATCH  /optimizer-rule-profiles/:id
 *   DELETE /optimizer-rule-profiles/:id
 *   GET    /optimizer-rule-profiles/resolve?projectId=...   (config di partenza)
 */
import type { Request } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS optimizer_rule_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      scope text NOT NULL DEFAULT 'company',
      project_id uuid,
      name text NOT NULL,
      service_type text,
      config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_orp_project_scope CHECK (NOT (scope = 'project' AND project_id IS NULL))
    )
  `);
  // domain distingue i profili turni guida ('crew') da turni macchina ('vsp')
  await db.execute(sql`ALTER TABLE optimizer_rule_profiles ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'crew'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_orp_owner ON optimizer_rule_profiles(owner_user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_orp_project ON optimizer_rule_profiles(project_id)`);
  schemaReady = true;
}

function uid(req: Request): string | null {
  return (req as any).user?.id ?? null;
}

function rowToProfile(r: any) {
  return {
    id: r.id,
    scope: r.scope,
    domain: r.domain ?? "crew",
    projectId: r.project_id ?? null,
    name: r.name,
    serviceType: r.service_type ?? null,
    config: r.config_json ?? {},
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function domainOf(req: Request): string {
  const d = String((req.query.domain ?? (req.body && req.body.domain) ?? "crew")).toLowerCase();
  // 'vcsp' = preset "algoritmo" completo della pipeline integrata (macchina+guida)
  return d === "vsp" || d === "vcsp" ? d : "crew";
}

/** Deep-merge: override sovrascrive base (oggetti uniti ricorsivamente, scalari/array rimpiazzati). */
function deepMerge(base: any, override: any): any {
  if (override == null) return base;
  if (base == null) return override;
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== "object" || typeof override !== "object") {
    return override;
  }
  const out: any = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = deepMerge(base[k], override[k]);
  }
  return out;
}

/* ─── GET lista profili (azienda + progetto opzionale) ────────────────────── */
router.get("/optimizer-rule-profiles", async (req, res): Promise<void> => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  await ensureSchema();
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
  const domain = domainOf(req);

  const r = await db.execute(sql`
    SELECT * FROM optimizer_rule_profiles
     WHERE owner_user_id = ${userId}::uuid
       AND domain = ${domain}
       AND (scope = 'company'
            ${projectId ? sql`OR (scope = 'project' AND project_id = ${projectId}::uuid)` : sql``})
     ORDER BY scope ASC, is_default DESC, name ASC
  `);
  res.json({ profiles: ((r as any).rows ?? []).map(rowToProfile) });
});

/* ─── GET resolve: config di partenza (azienda ⊕ progetto) ────────────────── */
router.get("/optimizer-rule-profiles/resolve", async (req, res): Promise<void> => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  await ensureSchema();
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
  const domain = domainOf(req);

  const companyR = await db.execute(sql`
    SELECT config_json FROM optimizer_rule_profiles
     WHERE owner_user_id = ${userId}::uuid AND domain = ${domain} AND scope = 'company' AND is_default = true
     ORDER BY updated_at DESC LIMIT 1
  `);
  const companyCfg = (companyR as any).rows?.[0]?.config_json ?? null;

  let projectCfg: any = null;
  if (projectId) {
    const projR = await db.execute(sql`
      SELECT config_json FROM optimizer_rule_profiles
       WHERE owner_user_id = ${userId}::uuid AND domain = ${domain} AND scope = 'project'
         AND project_id = ${projectId}::uuid AND is_default = true
       ORDER BY updated_at DESC LIMIT 1
    `);
    projectCfg = (projR as any).rows?.[0]?.config_json ?? null;
  }

  const merged = projectCfg ? deepMerge(companyCfg ?? {}, projectCfg) : companyCfg;
  res.json({
    config: merged,                                   // null se nessun profilo → il client usa i default
    sources: { company: !!companyCfg, project: !!projectCfg },
  });
});

/* ─── POST crea profilo ───────────────────────────────────────────────────── */
router.post("/optimizer-rule-profiles", async (req, res): Promise<void> => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  await ensureSchema();

  const { name, scope = "company", projectId = null, serviceType = null, config = {}, isDefault = false } = req.body ?? {};
  if (!name || typeof name !== "string") { res.status(400).json({ error: "name required" }); return; }
  if (scope !== "company" && scope !== "project") { res.status(400).json({ error: "invalid scope" }); return; }
  if (scope === "project" && !projectId) { res.status(400).json({ error: "projectId required for project scope" }); return; }
  const domain = domainOf(req);

  // un solo default per (domain, scope): clearDefaults + insert ATOMICI (no race)
  const r = await db.transaction(async (tx) => {
    if (isDefault) await clearDefaults(tx, userId, domain, scope, scope === "project" ? projectId : null);
    return tx.execute(sql`
      INSERT INTO optimizer_rule_profiles (owner_user_id, domain, scope, project_id, name, service_type, config_json, is_default)
      VALUES (${userId}::uuid, ${domain}, ${scope}, ${scope === "project" ? projectId : null}, ${name},
              ${serviceType}, ${JSON.stringify(config)}::jsonb, ${!!isDefault})
      RETURNING *
    `);
  });
  res.status(201).json({ profile: rowToProfile((r as any).rows[0]) });
});

/* ─── PATCH aggiorna profilo ──────────────────────────────────────────────── */
router.patch("/optimizer-rule-profiles/:id", async (req, res): Promise<void> => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  await ensureSchema();

  const existing = await db.execute(sql`
    SELECT * FROM optimizer_rule_profiles WHERE id = ${req.params.id}::uuid AND owner_user_id = ${userId}::uuid LIMIT 1
  `);
  const cur: any = (existing as any).rows?.[0];
  if (!cur) { res.status(404).json({ error: "profile not found" }); return; }

  const sets: any[] = [];
  if ("name" in req.body) sets.push(sql`name = ${req.body.name}`);
  if ("serviceType" in req.body) sets.push(sql`service_type = ${req.body.serviceType}`);
  if ("config" in req.body) sets.push(sql`config_json = ${JSON.stringify(req.body.config)}::jsonb`);
  if ("isDefault" in req.body) {
    sets.push(sql`is_default = ${!!req.body.isDefault}`);
  }
  if (sets.length === 0) { res.status(400).json({ error: "no fields" }); return; }

  const r = await db.transaction(async (tx) => {
    if (req.body.isDefault) await clearDefaults(tx, userId, cur.domain ?? "crew", cur.scope, cur.scope === "project" ? cur.project_id : null);
    return tx.execute(sql`
      UPDATE optimizer_rule_profiles SET ${sql.join(sets, sql`, `)}, updated_at = now()
       WHERE id = ${req.params.id}::uuid AND owner_user_id = ${userId}::uuid
       RETURNING *
    `);
  });
  const updated = (r as any).rows?.[0];
  if (!updated) { res.status(409).json({ error: "profile modified or deleted" }); return; }
  res.json({ profile: rowToProfile(updated) });
});

/* ─── DELETE profilo ──────────────────────────────────────────────────────── */
router.delete("/optimizer-rule-profiles/:id", async (req, res): Promise<void> => {
  const userId = uid(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  await ensureSchema();
  const r = await db.execute(sql`
    DELETE FROM optimizer_rule_profiles WHERE id = ${req.params.id}::uuid AND owner_user_id = ${userId}::uuid RETURNING id
  `);
  if (((r as any).rows ?? []).length === 0) { res.status(404).json({ error: "profile not found" }); return; }
  res.json({ ok: true });
});

async function clearDefaults(
  exec: { execute: (q: any) => Promise<any> },
  userId: string, domain: string, scope: string, projectId: string | null,
): Promise<void> {
  await exec.execute(sql`
    UPDATE optimizer_rule_profiles SET is_default = false, updated_at = now()
     WHERE owner_user_id = ${userId}::uuid AND domain = ${domain} AND scope = ${scope} AND is_default = true
       ${scope === "project" && projectId ? sql`AND project_id = ${projectId}::uuid` : sql``}
  `);
}

export default router;
