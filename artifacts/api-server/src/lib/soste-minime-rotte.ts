/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA SOSTA MINIMA AL CAPOLINEA — le rotte
 * ───────────────────────────────────────────────────────────────────────────
 *   GET /planning-studio/projects/:id/soste-minime
 *       il valore del progetto, i nodi e le fermate che hanno un dato, e i
 *       capolinea delle corse col valore che vale per ciascuno e da dove viene
 *   PUT /planning-studio/projects/:id/soste-minime
 *       { predefinitaMin?, nodi?: [{id, minuti|null}], fermate?: [{id, minuti|null}] }
 *       null toglie il dato; tutto in una transazione, nel registro
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { withVia } from "./agent-context";
import type { Ex } from "./anagrafica-store";
import { leggiModificheSoste } from "./soste-minime";
import { sosteMinimeDelProgetto, capolineaDelProgetto } from "./soste-minime-db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rows = (r: any): any[] => r?.rows ?? [];

/* ─────────────────────────────── rotte ─────────────────────────────── */

const router: IRouter = Router();

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

async function progettoPs(projectId: string, userId: string, needWrite: boolean): Promise<boolean> {
  const r = rows(await db.execute(sql`
    SELECT CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner' ELSE pm.role END AS ruolo
      FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1`))[0];
  if (!r) return false;
  return !needWrite || r.ruolo === "owner" || r.ruolo === "editor";
}

router.get("/planning-studio/projects/:id/soste-minime", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "id non valido" }); return; }
  if (!(await progettoPs(id, userId, false))) { res.status(404).json({ error: "progetto non trovato" }); return; }
  try {
    const s = await sosteMinimeDelProgetto(id);
    const nomiNodi = new Map(rows(await db.execute(sql`
      SELECT id::text, name FROM ps_stop_clusters WHERE project_id = ${id}::uuid`)).map(r => [String(r.id), String(r.name ?? "")]));
    res.json({
      predefinitaMin: s.predefinita,
      nodi: [...s.perNodo.entries()].map(([k, v]) => ({ id: k, nome: nomiNodi.get(k) ?? null, minuti: v })),
      fermate: [...s.perFermata.entries()].map(([k, v]) => ({ id: k, minuti: v })),
      capolinea: await capolineaDelProgetto(id, s),
      regola: "vince la fermata, poi il nodo, poi il valore del progetto; senza nessun dato allo stesso capolinea la sosta minima è 0′",
    });
  } catch (e: any) {
    req.log?.error?.(e, "soste minime");
    res.status(500).json({ error: "lettura delle soste minime non riuscita" });
  }
});

router.put("/planning-studio/projects/:id/soste-minime", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "id non valido" }); return; }
  const lettura = leggiModificheSoste(req.body);
  if (!lettura.ok) { res.status(400).json({ error: lettura.errore }); return; }
  if (!(await progettoPs(id, userId, true))) { res.status(403).json({ error: "serve il permesso di scrittura sul progetto" }); return; }
  const m = lettura.m;
  class Rifiuto extends Error {}
  try {
    await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      // gli id devono essere di questo progetto: altrimenti niente
      const controlla = async (tabella: "nodi" | "fermate", ids: string[]) => {
        if (!ids.length) return;
        const lista = `{${ids.join(",")}}`;
        const n = tabella === "nodi"
          ? rows(await ex.execute(sql`SELECT count(*)::int AS n FROM ps_stop_clusters WHERE project_id = ${id}::uuid AND id = ANY(${lista}::uuid[])`))[0].n
          : rows(await ex.execute(sql`SELECT count(*)::int AS n FROM ps_stops WHERE project_id = ${id}::uuid AND id = ANY(${lista}::uuid[])`))[0].n;
        if (Number(n) !== ids.length) throw new Rifiuto(`${tabella}: id non di questo progetto`);
      };
      await controlla("nodi", m.nodi.map(x => x.id));
      await controlla("fermate", m.fermate.map(x => x.id));
      for (const n of m.nodi) {
        await ex.execute(n.minuti == null
          ? sql`UPDATE ps_stop_clusters SET attributes = attributes - 'sostaMinimaMin', updated_at = now() WHERE id = ${n.id}::uuid AND project_id = ${id}::uuid`
          : sql`UPDATE ps_stop_clusters SET attributes = attributes || jsonb_build_object('sostaMinimaMin', ${n.minuti}::int), updated_at = now() WHERE id = ${n.id}::uuid AND project_id = ${id}::uuid`);
      }
      for (const f of m.fermate) {
        await ex.execute(f.minuti == null
          ? sql`UPDATE ps_stops SET attributes = attributes - 'sostaMinimaMin', updated_at = now() WHERE id = ${f.id}::uuid AND project_id = ${id}::uuid`
          : sql`UPDATE ps_stops SET attributes = attributes || jsonb_build_object('sostaMinimaMin', ${f.minuti}::int), updated_at = now() WHERE id = ${f.id}::uuid AND project_id = ${id}::uuid`);
      }
      if (m.predefinitaMin !== undefined) {
        await ex.execute(m.predefinitaMin == null
          ? sql`UPDATE ps_projects SET agency_settings = COALESCE(agency_settings, '{}'::jsonb) - 'sostaMinimaCapolineaMin' WHERE id = ${id}::uuid`
          : sql`UPDATE ps_projects SET agency_settings = COALESCE(agency_settings, '{}'::jsonb) || jsonb_build_object('sostaMinimaCapolineaMin', ${m.predefinitaMin}::int) WHERE id = ${id}::uuid`);
      }
      await ex.execute(sql`
        INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, target_id, payload)
        VALUES (${id}::uuid, ${userId}::uuid, 'soste_minime.update', 'project', ${id}::uuid, ${JSON.stringify(withVia({
          predefinitaMin: m.predefinitaMin, nodi: m.nodi, fermate: m.fermate,
        }))}::jsonb)`);
    });
  } catch (e: any) {
    if (e instanceof Rifiuto) { res.status(404).json({ error: e.message }); return; }
    req.log?.error?.(e, "soste minime, scrittura");
    res.status(500).json({ error: "scrittura delle soste minime non riuscita: non è cambiato niente" });
    return;
  }
  const s = await sosteMinimeDelProgetto(id);
  res.json({ ok: true, predefinitaMin: s.predefinita, nodi: s.perNodo.size, fermate: s.perFermata.size });
});

export default router;
