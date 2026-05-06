/**
 * Tenant — isolamento dati per utente.
 *
 * Aggiunge owner_user_id alle tabelle "user-owned":
 *   - gtfs_feeds (root: tutto il GTFS è cascade-figlio)
 *   - service_program_scenarios (turni macchina salvati)
 *   - driver_shift_scenarios (turni guida salvati)
 *   - planning_scenarios (workspace pianificazione)
 *
 * Backfill: tutti i record esistenti vengono assegnati al primo admin
 * (samuele@transitintel.local) così non si perde nulla durante il rollout.
 *
 * Helper:
 *   - tenantWhere(req): SQL fragment "(owner_user_id = $uid OR owner_user_id IS NULL)"
 *                      che gli admin bypassano (TRUE).
 *   - assertFeedAccess(feedId, req): 403 se il feed non appartiene all'utente.
 */
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

let bootstrapped = false;

const TENANT_TABLES = [
  "gtfs_feeds",
  "service_program_scenarios",
  "driver_shift_scenarios",
  "planning_scenarios",
] as const;

export async function ensureTenantColumns(): Promise<void> {
  if (bootstrapped) return;
  try {
    for (const t of TENANT_TABLES) {
      await db.execute(sql.raw(
        `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL`
      ));
      await db.execute(sql.raw(
        `CREATE INDEX IF NOT EXISTS idx_${t}_owner ON ${t}(owner_user_id)`
      ));
    }
    // Backfill: assegna i record orfani al primo admin (per ordine di creazione)
    const admin = await db.execute(sql`
      SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1
    `);
    const adminId = ((admin as any).rows?.[0] ?? (admin as any)[0])?.id;
    if (adminId) {
      for (const t of TENANT_TABLES) {
        await db.execute(sql.raw(
          `UPDATE ${t} SET owner_user_id = '${adminId}'::uuid WHERE owner_user_id IS NULL`
        ));
      }
    }

    // Feed di default globale: visibile a tutti gli utenti (read-only).
    // Permette alle pagine pubbliche (Dashboard, Cartografia, ecc.) di mostrare
    // sempre un GTFS anche se l'utente loggato non ha caricato i propri feed.
    try {
      await db.execute(sql`ALTER TABLE gtfs_feeds ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_gtfs_feeds_default ON gtfs_feeds(is_default) WHERE is_default = true`);
      // Auto-seed: se nessun feed è default ma ce n'è almeno uno nel DB,
      // marca come default il più recente in assoluto (best-effort).
      const has = await db.execute(sql`SELECT 1 FROM gtfs_feeds WHERE is_default = true LIMIT 1`);
      const hasDefault = ((has as any).rows?.length ?? 0) > 0;
      if (!hasDefault) {
        await db.execute(sql`
          UPDATE gtfs_feeds SET is_default = true
           WHERE id = (SELECT id FROM gtfs_feeds ORDER BY uploaded_at DESC LIMIT 1)
        `);
      }
    } catch (e: any) {
      console.warn("[tenant] is_default seed skipped:", e?.message || e);
    }

    bootstrapped = true;
    console.log("[tenant] owner_user_id columns ready + backfilled");
  } catch (e: any) {
    console.error("[tenant] bootstrap error:", e?.message || e);
  }
}
void ensureTenantColumns();

/**
 * Restituisce un fragment SQL da inserire in WHERE.
 * Admin → TRUE (vede tutto).
 * Utente normale → owner_user_id = <uid>
 */
export function tenantWhere(req: Request, columnExpr = "owner_user_id"): SQL {
  const u = req.user;
  if (!u) return sql.raw("FALSE");
  if (u.role === "admin") return sql.raw("TRUE");
  return sql.raw(`${columnExpr} = '${u.id}'::uuid`);
}

export function currentUserIdOrNull(req: Request): string | null {
  return req.user?.id ?? null;
}

/**
 * Fragment SQL che descrive l'accesso ai feed GTFS per l'utente corrente.
 * Include i feed di proprietà diretta + quelli referenziati da
 * scheduling_projects o ps_projects condivisi (owner o membro).
 *
 * Da usare nelle WHERE di SELECT su gtfs_feeds.
 */
export function feedAccessibleWhere(req: Request): SQL {
  const u = req.user;
  if (!u) return sql.raw("FALSE");
  if (u.role === "admin") return sql.raw("TRUE");
  const uid = u.id;
  return sql.raw(`(
    owner_user_id = '${uid}'::uuid
    OR is_default = true
    OR id IN (
      SELECT sp.feed_id FROM scheduling_projects sp
       WHERE sp.feed_id IS NOT NULL
         AND (sp.owner_user_id = '${uid}'::uuid
              OR EXISTS (SELECT 1 FROM project_members pm
                          WHERE pm.project_id = sp.id
                            AND pm.user_id = '${uid}'::uuid))
    )
    OR id IN (
      SELECT pp.materialized_feed_id FROM ps_projects pp
       WHERE pp.materialized_feed_id IS NOT NULL
         AND (pp.owner_user_id = '${uid}'::uuid
              OR EXISTS (SELECT 1 FROM ps_project_members ppm
                          WHERE ppm.project_id = pp.id
                            AND ppm.user_id = '${uid}'::uuid))
    )
  )`);
}

/**
 * Verifica che l'utente possa accedere a un feed GTFS.
 * Accetta sia owner diretto sia membro di un progetto (PS o Scheduling)
 * che referenzia il feed.
 * Risponde 403 e ritorna false se non autorizzato.
 */
export async function assertFeedAccess(
  feedId: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  await ensureTenantColumns();
  const u = req.user;
  if (!u) { res.status(401).json({ error: "Non autenticato" }); return false; }
  if (u.role === "admin") return true;

  // Esiste il feed?
  const exists = await db.execute(sql`
    SELECT id, owner_user_id, COALESCE(is_default, false) AS is_default FROM gtfs_feeds WHERE id = ${feedId}::uuid LIMIT 1
  `);
  const row: any = (exists as any).rows?.[0] ?? (exists as any)[0];
  if (!row) { res.status(404).json({ error: "Feed non trovato" }); return false; }

  // Owner diretto o legacy (owner NULL)
  if (!row.owner_user_id || row.owner_user_id === u.id) return true;

  // Feed di default globale visibile a tutti
  if (row.is_default === true) return true;

  // Membro/owner di un progetto che referenzia il feed
  try {
    const shared = await db.execute(sql`
      SELECT 1 FROM scheduling_projects sp
       WHERE sp.feed_id = ${feedId}::uuid
         AND (sp.owner_user_id = ${u.id}::uuid
              OR EXISTS (SELECT 1 FROM project_members pm
                          WHERE pm.project_id = sp.id
                            AND pm.user_id = ${u.id}::uuid))
       LIMIT 1
    `);
    if ((shared as any).rows?.length || (shared as any)[0]) return true;
  } catch {}
  try {
    const sharedPs = await db.execute(sql`
      SELECT 1 FROM ps_projects pp
       WHERE pp.materialized_feed_id = ${feedId}::uuid
         AND (pp.owner_user_id = ${u.id}::uuid
              OR EXISTS (SELECT 1 FROM ps_project_members ppm
                          WHERE ppm.project_id = pp.id
                            AND ppm.user_id = ${u.id}::uuid))
       LIMIT 1
    `);
    if ((sharedPs as any).rows?.length || (sharedPs as any)[0]) return true;
  } catch {}

  res.status(403).json({ error: "Accesso negato a questo feed" });
  return false;
}

/**
 * Middleware Express che si assicura che le colonne tenant siano pronte
 * prima di servire la richiesta. Da usare a monte dei router data-owned.
 */
export async function ensureTenantMiddleware(_req: Request, _res: Response, next: NextFunction) {
  await ensureTenantColumns();
  next();
}
