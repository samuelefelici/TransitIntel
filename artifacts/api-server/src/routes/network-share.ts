/**
 * Condivisione PUBBLICA della Mappa di Rete tramite link.
 * GET /api/network-share/:token  → dati rete (linee + nodi) per la pagina pubblica.
 * Nessuna autenticazione: il link è il segreto. La creazione del link avviene
 * invece dall'endpoint autenticato POST /planning-studio/:id/network-share.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { computeNetwork } from "./planning-studio-timetables";

const router: IRouter = Router();

let booted = false;
export async function ensureNetworkShareTable(): Promise<void> {
  if (booted) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ps_network_shares (
      token       text PRIMARY KEY,
      project_id  uuid NOT NULL,
      route_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,
      title       text,
      options     jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by  uuid,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
  booted = true;
}
router.use(async (_req, _res, next) => { await ensureNetworkShareTable(); next(); });

router.get("/network-share/:token", async (req, res): Promise<void> => {
  try {
    const token = String(req.params.token);
    if (!/^[a-z0-9]{6,64}$/i.test(token)) { res.status(400).json({ error: "token non valido" }); return; }
    const r = await db.execute<any>(sql`
      SELECT project_id, route_ids, title, options FROM ps_network_shares WHERE token = ${token} LIMIT 1`);
    const row = r.rows[0];
    if (!row) { res.status(404).json({ error: "Link non trovato o scaduto" }); return; }
    const routeIds: string[] = Array.isArray(row.route_ids) ? row.route_ids : [];
    const net = await computeNetwork(row.project_id, routeIds);
    let agencyName: string | null = null;
    try {
      const a = await db.execute<any>(sql`SELECT name, agency_name FROM ps_projects WHERE id = ${row.project_id}::uuid LIMIT 1`);
      agencyName = a.rows[0]?.agency_name ?? a.rows[0]?.name ?? null;
    } catch { /* opzionale */ }
    res.json({
      token,
      projectId: row.project_id,
      title: row.title ?? null,
      agencyName,
      options: row.options ?? {},
      lines: net.lines,
      cityNodes: net.cityNodes,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
