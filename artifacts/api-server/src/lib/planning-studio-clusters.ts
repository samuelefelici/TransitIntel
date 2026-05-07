/**
 * Planning Studio — Cluster di fermate (interscambi, hub, ecc.)
 *
 * Endpoints (montati sotto /api/planning-studio):
 *   GET    /projects/:id/clusters
 *   POST   /projects/:id/clusters
 *   PATCH  /projects/:id/clusters/:clusterId
 *   DELETE /projects/:id/clusters/:clusterId
 *   PUT    /projects/:id/clusters/:clusterId/stops    (sostituisce lista fermate)
 *   GET    /projects/:id/clusters/suggest?radius=150  (algoritmo greedy)
 *
 * Tabelle: ps_stop_clusters (centroide auto-calcolato), ps_stops.cluster_id
 * Permessi: read = qualsiasi membro / write = owner|editor.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

/* ─── Helpers permessi (replica leggera) ──────────────────── */

async function loadProject(projectId: string, userId: string, needWrite: boolean): Promise<any | null> {
  const r = await db.execute(sql`
    SELECT p.*,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? null;
  if (!row) return null;
  if (needWrite && row.my_role !== "owner" && row.my_role !== "editor") return null;
  return row;
}

function getUserId(req: Request): string | null {
  return (req as any).session?.userId ?? (req as any).user?.id ?? null;
}

async function logActivity(
  projectId: string, userId: string, action: string,
  targetType: string | null, targetId: string | null, payload: Record<string, any> = {},
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO ps_project_activity_log (project_id, user_id, action, target_type, target_id, payload)
      VALUES (${projectId}::uuid, ${userId}::uuid, ${action}, ${targetType}, ${targetId}, ${JSON.stringify(payload)}::jsonb)
    `);
  } catch (e: any) {
    console.warn("[ps-clusters] activity log error:", e?.message || e);
  }
}

/** Ricalcola centroide e raggio (max distanza dal centroide) di un cluster. */
async function recomputeClusterCenter(clusterId: string): Promise<void> {
  const r = await db.execute(sql`
    SELECT
      AVG(lat)::float8 AS clat,
      AVG(lon)::float8 AS clon,
      COUNT(*)::int    AS n
    FROM ps_stops
    WHERE cluster_id = ${clusterId}::uuid
  `);
  const row: any = (r as any).rows?.[0] ?? null;
  if (!row || !row.n || row.n === 0) {
    // cluster vuoto: lascia centro com'è
    await db.execute(sql`UPDATE ps_stop_clusters SET updated_at = now() WHERE id = ${clusterId}::uuid`);
    return;
  }
  // raggio in metri (formula approx haversine semplificata su lat/lon piccoli)
  const r2 = await db.execute(sql`
    SELECT MAX(
      111320 * sqrt(
        pow(lat - ${row.clat}, 2) +
        pow((lon - ${row.clon}) * cos(radians(${row.clat})), 2)
      )
    )::float8 AS rad
    FROM ps_stops
    WHERE cluster_id = ${clusterId}::uuid
  `);
  const rad = ((r2 as any).rows?.[0]?.rad ?? 0) as number;
  await db.execute(sql`
    UPDATE ps_stop_clusters
       SET center_lat = ${row.clat},
           center_lon = ${row.clon},
           radius_m   = ${Math.max(50, Math.ceil(rad))},
           updated_at = now()
     WHERE id = ${clusterId}::uuid
  `);
}

/* ─── Auto-import idempotente cluster legacy → ps_stop_clusters ───
 * Strategia: i cluster legacy (stop_clusters) NON appartengono ad alcun
 * progetto PS. Vengono però copiati in ogni progetto PS con dedup tramite
 * attributes->>'importedFromLegacyId'. Le fermate vengono matchate per
 * prossimità geografica (default 60m) sulle ps_stops del progetto.
 */
const AUTO_IMPORT_RADIUS_M = 60;

async function autoImportLegacyClustersIfNeeded(projectId: string): Promise<void> {
  // 1) ID cluster legacy già importati nel progetto
  const doneR = await db.execute(sql`
    SELECT (attributes->>'importedFromLegacyId') AS lid
      FROM ps_stop_clusters
     WHERE project_id = ${projectId}::uuid
       AND attributes ? 'importedFromLegacyId'
  `);
  const done = new Set<string>(((doneR as any).rows ?? []).map((r: any) => String(r.lid)));

  // 2) Cluster legacy non ancora importati
  const lcR = await db.execute(sql`
    SELECT id, name, color, transfer_from_depot_min FROM stop_clusters ORDER BY name
  `);
  const legacyClusters: any[] = (lcR as any).rows ?? [];
  const todo = legacyClusters.filter(c => !done.has(String(c.id)));
  if (todo.length === 0) return;

  // 3) Carica ps_stops del progetto per match geografico
  const psStopsR = await db.execute(sql`
    SELECT id, lat::float8 AS lat, lon::float8 AS lon
      FROM ps_stops WHERE project_id = ${projectId}::uuid
  `);
  const psStops: { id: string; lat: number; lon: number }[] = (psStopsR as any).rows ?? [];

  function nearestPsStop(lat: number, lon: number): { id: string; dist: number } | null {
    let best: { id: string; dist: number } | null = null;
    const cosLat = Math.cos(lat * Math.PI / 180);
    for (const s of psStops) {
      const dy = (s.lat - lat) * 111320;
      const dx = (s.lon - lon) * 111320 * cosLat;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (best === null || d < best.dist) best = { id: s.id, dist: d };
    }
    return best;
  }

  for (const lc of todo) {
    const lsR = await db.execute(sql`
      SELECT stop_lat::float8 AS lat, stop_lon::float8 AS lon
        FROM stop_cluster_stops WHERE cluster_id = ${lc.id}::uuid
    `);
    const legacyStops: any[] = (lsR as any).rows ?? [];

    let cLat: number | null = null, cLon: number | null = null;
    if (legacyStops.length > 0) {
      cLat = legacyStops.reduce((a, s) => a + Number(s.lat), 0) / legacyStops.length;
      cLon = legacyStops.reduce((a, s) => a + Number(s.lon), 0) / legacyStops.length;
    }

    const matchedStopIds = new Set<string>();
    for (const ls of legacyStops) {
      const m = nearestPsStop(Number(ls.lat), Number(ls.lon));
      if (m && m.dist <= AUTO_IMPORT_RADIUS_M) matchedStopIds.add(m.id);
    }

    const insR = await db.execute(sql`
      INSERT INTO ps_stop_clusters (project_id, name, kind, center_lat, center_lon, radius_m, attributes)
      VALUES (${projectId}::uuid, ${lc.name}, 'interchange',
              ${cLat}, ${cLon}, 150,
              ${JSON.stringify({
                color: lc.color || "#3b82f6",
                transferFromDepotMin: Number(lc.transfer_from_depot_min ?? 10),
                importedFromLegacyId: lc.id,
              })}::jsonb)
      RETURNING id
    `);
    const psClusterId: string = (insR as any).rows?.[0]?.id;

    if (matchedStopIds.size > 0 && psClusterId) {
      const idsArr = Array.from(matchedStopIds);
      const idsLiteral = `{${idsArr.join(",")}}`;
      await db.execute(sql`
        UPDATE ps_stops
           SET cluster_id = ${psClusterId}::uuid
         WHERE project_id = ${projectId}::uuid
           AND id = ANY(${idsLiteral}::uuid[])
           AND cluster_id IS NULL
      `);
      await recomputeClusterCenter(psClusterId);
    }
  }
}

/* ─── GET lista cluster ───────────────────────────────────── */

router.get("/planning-studio/projects/:id/clusters", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }

  // [DISABILITATO 2026-05-07] Auto-import idempotente cluster legacy.
  // Causava la creazione di doppioni cross-tenant: la tabella stop_clusters
  // NON è partizionata per progetto/utente, quindi questo import copiava i
  // cluster di TUTTI gli utenti dentro ogni nuovo progetto PS. Ora il flusso
  // è invertito: i cluster vivono SOLO in ps_stop_clusters e vengono mirrorati
  // su stop_clusters in fase di materialize (planning-studio-materialize.ts).
  // L'helper autoImportLegacyClustersIfNeeded resta nel file per riferimento
  // ma non è più chiamato.
  void proj; // mantiene la variabile usata anche senza il blocco rimosso

  const r = await db.execute(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM ps_stops s WHERE s.cluster_id = c.id) AS stop_count
    FROM ps_stop_clusters c
    WHERE c.project_id = ${req.params.id}::uuid
    ORDER BY c.name ASC
  `);
  const rows: any[] = (r as any).rows ?? [];
  res.json({
    clusters: rows.map(c => ({
      id: c.id,
      projectId: c.project_id,
      code: c.code,
      name: c.name,
      kind: c.kind,
      centerLat: c.center_lat == null ? null : Number(c.center_lat),
      centerLon: c.center_lon == null ? null : Number(c.center_lon),
      radiusM: Number(c.radius_m),
      attributes: c.attributes ?? {},
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      stopCount: c.stop_count ?? 0,
    })),
  });
});

/* ─── POST crea cluster ───────────────────────────────────── */

router.post("/planning-studio/projects/:id/clusters", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const { code, name, kind = "interchange", centerLat = null, centerLon = null, radiusM = 150, attributes = {} } = req.body ?? {};
  if (!name || typeof name !== "string") { res.status(400).json({ error: "name required" }); return; }

  const r = await db.execute(sql`
    INSERT INTO ps_stop_clusters (project_id, code, name, kind, center_lat, center_lon, radius_m, attributes)
    VALUES (${req.params.id}::uuid, ${code ?? null}, ${name}, ${kind},
            ${centerLat}, ${centerLon}, ${radiusM}, ${JSON.stringify(attributes)}::jsonb)
    RETURNING *
  `);
  const c: any = (r as any).rows?.[0];
  await logActivity(req.params.id, userId, "cluster.create", "cluster", c.id, { name, kind });
  res.status(201).json({ cluster: {
    id: c.id, projectId: c.project_id, code: c.code, name: c.name, kind: c.kind,
    centerLat: c.center_lat == null ? null : Number(c.center_lat),
    centerLon: c.center_lon == null ? null : Number(c.center_lon),
    radiusM: Number(c.radius_m), attributes: c.attributes ?? {},
    createdAt: c.created_at, updatedAt: c.updated_at, stopCount: 0,
  }});
});

/* ─── PATCH cluster ───────────────────────────────────────── */

router.patch("/planning-studio/projects/:id/clusters/:clusterId", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const fields: string[] = [];
  const sets: any[] = [];
  const map: Record<string, string> = {
    code: "code", name: "name", kind: "kind",
    centerLat: "center_lat", centerLon: "center_lon", radiusM: "radius_m",
  };
  for (const [k, col] of Object.entries(map)) {
    if (k in req.body) { fields.push(col); sets.push(req.body[k]); }
  }
  if ("attributes" in req.body) { fields.push("attributes"); sets.push(JSON.stringify(req.body.attributes)); }

  if (fields.length === 0) { res.status(400).json({ error: "no fields to update" }); return; }

  const setSql = sql.join(
    fields.map((f, i) => sql`${sql.raw(f)} = ${sets[i]}${f === "attributes" ? sql`::jsonb` : sql``}`),
    sql`, `,
  );
  const r = await db.execute(sql`
    UPDATE ps_stop_clusters
       SET ${setSql}, updated_at = now()
     WHERE id = ${req.params.clusterId}::uuid
       AND project_id = ${req.params.id}::uuid
     RETURNING *
  `);
  const c: any = (r as any).rows?.[0];
  if (!c) { res.status(404).json({ error: "cluster not found" }); return; }
  await logActivity(req.params.id, userId, "cluster.update", "cluster", c.id, { fields });
  res.json({ cluster: {
    id: c.id, projectId: c.project_id, code: c.code, name: c.name, kind: c.kind,
    centerLat: c.center_lat == null ? null : Number(c.center_lat),
    centerLon: c.center_lon == null ? null : Number(c.center_lon),
    radiusM: Number(c.radius_m), attributes: c.attributes ?? {},
    createdAt: c.created_at, updatedAt: c.updated_at,
  }});
});

/* ─── DELETE cluster ──────────────────────────────────────── */

router.delete("/planning-studio/projects/:id/clusters/:clusterId", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  // sgancia le fermate prima di cancellare
  await db.execute(sql`UPDATE ps_stops SET cluster_id = NULL WHERE cluster_id = ${req.params.clusterId}::uuid`);
  const r = await db.execute(sql`
    DELETE FROM ps_stop_clusters
     WHERE id = ${req.params.clusterId}::uuid
       AND project_id = ${req.params.id}::uuid
     RETURNING id
  `);
  if (((r as any).rows ?? []).length === 0) { res.status(404).json({ error: "cluster not found" }); return; }
  await logActivity(req.params.id, userId, "cluster.delete", "cluster", req.params.clusterId, {});
  res.json({ ok: true });
});

/* ─── PUT lista fermate del cluster (sostituzione completa) ── */

router.put("/planning-studio/projects/:id/clusters/:clusterId/stops", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, true);
  if (!proj) { res.status(403).json({ error: "no write access" }); return; }

  const stopIds: string[] = Array.isArray(req.body?.stopIds) ? req.body.stopIds : [];
  // verifica esistenza cluster
  const ck = await db.execute(sql`
    SELECT id FROM ps_stop_clusters WHERE id = ${req.params.clusterId}::uuid AND project_id = ${req.params.id}::uuid LIMIT 1
  `);
  if (((ck as any).rows ?? []).length === 0) { res.status(404).json({ error: "cluster not found" }); return; }

  // sgancia tutte le fermate attuali del cluster
  await db.execute(sql`
    UPDATE ps_stops SET cluster_id = NULL
     WHERE cluster_id = ${req.params.clusterId}::uuid
  `);
  // aggancia le nuove (solo se appartengono al progetto)
  if (stopIds.length > 0) {
    const idsSql = sql.join(stopIds.map(id => sql`${id}::uuid`), sql`, `);
    await db.execute(sql`
      UPDATE ps_stops
         SET cluster_id = ${req.params.clusterId}::uuid
       WHERE project_id = ${req.params.id}::uuid
         AND id IN (${idsSql})
    `);
  }
  await recomputeClusterCenter(req.params.clusterId);
  await logActivity(req.params.id, userId, "cluster.set_stops", "cluster", req.params.clusterId, { count: stopIds.length });
  res.json({ ok: true, count: stopIds.length });
});

/* ─── GET suggerimenti cluster (greedy, raggio configurabile) ── */

router.get("/planning-studio/projects/:id/clusters/suggest", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }

  const radius = Math.max(20, Math.min(1000, parseInt(String(req.query.radius ?? "150"), 10) || 150));
  const minSize = Math.max(2, parseInt(String(req.query.minSize ?? "2"), 10) || 2);

  const r = await db.execute(sql`
    SELECT id, code, name, lat::float8 AS lat, lon::float8 AS lon, cluster_id
    FROM ps_stops
    WHERE project_id = ${req.params.id}::uuid
    ORDER BY name ASC
  `);
  const stops: { id: string; code: string | null; name: string; lat: number; lon: number; cluster_id: string | null }[] = (r as any).rows ?? [];
  // greedy: parte solo da fermate non già clusterizzate
  const used = new Set<string>();
  const groups: { center: { lat: number; lon: number }; stops: typeof stops; suggestedName: string }[] = [];
  const R = 6371000; // metri
  function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
    const dφ = (b.lat - a.lat) * Math.PI / 180;
    const dλ = (b.lon - a.lon) * Math.PI / 180;
    const x = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  for (const s of stops) {
    if (used.has(s.id) || s.cluster_id) continue;
    const cluster = [s];
    used.add(s.id);
    for (const t of stops) {
      if (used.has(t.id) || t.cluster_id) continue;
      if (haversine(s, t) <= radius) {
        cluster.push(t);
        used.add(t.id);
      }
    }
    if (cluster.length >= minSize) {
      const cLat = cluster.reduce((a, x) => a + x.lat, 0) / cluster.length;
      const cLon = cluster.reduce((a, x) => a + x.lon, 0) / cluster.length;
      // nome suggerito: prefisso comune o nome più corto
      const baseName = cluster.map(x => x.name).sort((a, b) => a.length - b.length)[0];
      groups.push({
        center: { lat: cLat, lon: cLon },
        stops: cluster,
        suggestedName: baseName,
      });
    }
  }
  res.json({
    radius, minSize,
    suggestions: groups.map(g => ({
      suggestedName: g.suggestedName,
      centerLat: g.center.lat,
      centerLon: g.center.lon,
      stops: g.stops.map(s => ({ id: s.id, code: s.code, name: s.name, lat: s.lat, lon: s.lon })),
    })),
  });
});

/* ─── GET change-points (cluster di tipo interchange) per Scheduling Engine ── */

router.get("/planning-studio/projects/:id/change-points", async (req, res): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ error: "auth required" }); return; }
  const proj = await loadProject(req.params.id, userId, false);
  if (!proj) { res.status(404).json({ error: "project not found" }); return; }

  const r = await db.execute(sql`
    SELECT
      c.id, c.code, c.name,
      c.center_lat::float8 AS center_lat,
      c.center_lon::float8 AS center_lon,
      c.radius_m,
      COALESCE(json_agg(
        json_build_object('id', s.id, 'name', s.name, 'code', s.code,
                          'lat', s.lat::float8, 'lon', s.lon::float8)
        ORDER BY s.name
      ) FILTER (WHERE s.id IS NOT NULL), '[]'::json) AS stops
    FROM ps_stop_clusters c
    LEFT JOIN ps_stops s ON s.cluster_id = c.id
    WHERE c.project_id = ${req.params.id}::uuid
      AND c.kind = 'interchange'
    GROUP BY c.id
    ORDER BY c.name ASC
  `);
  const rows: any[] = (r as any).rows ?? [];
  res.json({
    changePoints: rows.map(c => ({
      id: c.id,
      code: c.code,
      name: c.name,
      centerLat: c.center_lat == null ? null : Number(c.center_lat),
      centerLon: c.center_lon == null ? null : Number(c.center_lon),
      radiusM: Number(c.radius_m),
      stops: c.stops ?? [],
    })),
  });
});

export default router;
