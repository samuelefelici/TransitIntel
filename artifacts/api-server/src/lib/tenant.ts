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
 * Verifica che l'utente possa accedere a un feed GTFS.
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
  const r = await db.execute(sql`
    SELECT owner_user_id FROM gtfs_feeds WHERE id = ${feedId}::uuid LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Feed non trovato" }); return false; }
  if (row.owner_user_id && row.owner_user_id !== u.id) {
    res.status(403).json({ error: "Accesso negato a questo feed" });
    return false;
  }
  return true;
}

/**
 * Middleware Express che si assicura che le colonne tenant siano pronte
 * prima di servire la richiesta. Da usare a monte dei router data-owned.
 */
export async function ensureTenantMiddleware(_req: Request, _res: Response, next: NextFunction) {
  await ensureTenantColumns();
  next();
}
