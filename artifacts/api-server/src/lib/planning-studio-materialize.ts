/**
 * Planning Studio → GTFS Feed materializer.
 *
 * Esporta i dati di un PsProject (tabelle ps_*) in un gtfs_feed dedicato (gtfs_*),
 * così la pipeline di scheduling (fucina) può lavorarci sopra senza dover importare
 * un secondo zip GTFS.
 *
 * Idempotente: se il PsProject ha già un feed materializzato (ps_projects.materialized_feed_id),
 * viene cancellato e ricreato (ON DELETE CASCADE pulisce tutte le tabelle gtfs_*).
 *
 * Uso programmatico:
 *   const { feedId, label } = await materializePsToFeed(psProjectId, ownerUserId);
 *
 * Endpoint HTTP:
 *   POST /api/scheduling/projects/:id/sync-from-ps  → re-materializza e aggiorna scheduling_projects.feed_id
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { materializePsToFeed as materializza, type MaterializeResult } from "./materializzazione/feed";

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;

/* ════════════════════════════════════════════════════════════
 *  Bootstrap colonna materialized_feed_id su ps_projects
 * ════════════════════════════════════════════════════════════ */
let bootstrapped = false;
export async function ensureMaterializedColumn(): Promise<void> {
  if (bootstrapped) return;
  await db.execute(sql`
    ALTER TABLE ps_projects
      ADD COLUMN IF NOT EXISTS materialized_feed_id uuid,
      ADD COLUMN IF NOT EXISTS materialized_at timestamptz
  `);
  bootstrapped = true;
}

/* Il cuore della materializzazione sta in lib/materializzazione/feed.ts (lo
 * esegue anche il lavoratore); qui il bootstrap pigro della colonna resta
 * davanti, come prima. */
export type { MaterializeResult } from "./materializzazione/feed";
export { mirrorPsClustersToLegacy } from "./materializzazione/feed";
export async function materializePsToFeed(...args: Parameters<typeof materializza>): ReturnType<typeof materializza> {
  await ensureMaterializedColumn();
  return materializza(...args);
}

/* ════════════════════════════════════════════════════════════
 *  Job tracker in-memory per sync async
 *  ────────────────────────────────────────────────────────────
 *  La materializzazione di un PS grande (300k+ stop_times) impiega
 *  60-180 secondi: oltre il timeout del proxy Render (~100 s) → 502.
 *  Quindi sync-from-ps è ASYNC: avvia il job e ritorna 202 subito;
 *  il frontend polla GET /scheduling/projects/:id/sync-status.
 * ════════════════════════════════════════════════════════════ */
type SyncJob = {
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  result?: MaterializeResult;
  error?: string;
};
const syncJobs = new Map<string, SyncJob>(); // key = scheduling project id

export function startSyncJob(
  projectId: string,
  psProjectId: string,
  ownerUserId: string,
  logger?: { info?: any; error?: any; warn?: any },
): SyncJob {
  const existing = syncJobs.get(projectId);
  if (existing && existing.status === "running") return existing;

  const job: SyncJob = { status: "running", startedAt: Date.now() };
  syncJobs.set(projectId, job);

  void (async () => {
    try {
      // Se il progetto-scheduling è agganciato a una UDP, materializza SOLO le
      // sue corse (feed = pacchetto della UDP, niente corse di altre UDP).
      let tripIds: string[] | null = null;
      try {
        const vuR: any = await db.execute(sql`SELECT validity_unit_id FROM scheduling_projects WHERE id = ${projectId}::uuid LIMIT 1`);
        const vuId = vuR.rows?.[0]?.validity_unit_id;
        if (vuId) {
          const tR: any = await db.execute(sql`SELECT trip_ids FROM ps_validity_units WHERE id = ${vuId}::uuid LIMIT 1`);
          const arr = tR.rows?.[0]?.trip_ids;
          if (Array.isArray(arr) && arr.length > 0) {
            // Interseca con le corse ESISTENTI: trip_ids stantii (corse
            // rigenerate in PS) produrrebbero un feed scopato VUOTO.
            const raw = arr.map((x: any) => String(x));
            const exR: any = await db.execute(sql`
              SELECT id::text AS id FROM ps_trips WHERE id = ANY(${`{${raw.join(",")}}`}::uuid[])`);
            const existing = ((exR.rows ?? []) as any[]).map((r) => String(r.id));
            if (existing.length < raw.length) {
              logger?.warn?.({ projectId, vuId, requested: raw.length, existing: existing.length },
                "UDP trip_ids parzialmente stantii: scoping sulle corse ancora esistenti");
            }
            tripIds = existing.length > 0 ? existing : null;
          }
        }
      } catch (scopeErr: any) {
        logger?.warn?.({ err: scopeErr, projectId }, "UDP scope lookup failed, materializzo tutto il progetto");
      }
      // Feed VECCHIO di QUESTA UDP (non lo slot globale del progetto): lo
      // rimpiazziamo col nuovo in modalità delete-last, senza toccare né il
      // feed d'esercizio né quello delle UDP sorelle.
      let oldFeedId: string | null = null;
      try {
        const ofR: any = await db.execute(sql`SELECT feed_id FROM scheduling_projects WHERE id = ${projectId}::uuid LIMIT 1`);
        oldFeedId = ofR.rows?.[0]?.feed_id ?? null;
      } catch { /* colonna assente su DB legacy → nessun vecchio feed da rimuovere */ }
      const result = await materializePsToFeed(psProjectId, ownerUserId, {
        tripIds,
        replaceFeedId: oldFeedId,
        updateProjectPointer: false,
      });
      await db.execute(sql`
        UPDATE scheduling_projects
           SET feed_id = ${result.feedId}::uuid,
               feed_label = ${result.label},
               updated_at = now()
         WHERE id = ${projectId}::uuid
      `);
      // Il feed è cambiato sotto gli scenari salvati: il loro result riflette
      // il feed precedente → marcali "dati superati" (stale_since). Un nuovo
      // salvataggio dello scenario azzera il flag. Best-effort su DB legacy.
      try {
        await db.execute(sql`
          UPDATE service_program_scenarios
             SET stale_since = COALESCE(stale_since, now())
           WHERE project_id = ${projectId}::uuid
        `);
        await db.execute(sql`
          UPDATE driver_shift_scenarios d
             SET stale_since = COALESCE(d.stale_since, now())
            FROM service_program_scenarios s
           WHERE d.service_program_scenario_id = s.id
             AND (s.project_id = ${projectId}::uuid OR d.project_id = ${projectId}::uuid)
        `);
      } catch (staleErr: any) {
        logger?.warn?.({ err: staleErr?.message, projectId }, "marcatura stale_since scenari fallita (sync comunque ok)");
      }
      job.status = "done";
      job.result = result;
      job.finishedAt = Date.now();
      logger?.info?.({ projectId, feedId: result.feedId, counts: result.counts,
        durationMs: job.finishedAt - job.startedAt }, "sync-from-ps completed");
    } catch (e: any) {
      job.status = "error";
      job.error = e?.message || String(e);
      job.finishedAt = Date.now();
      logger?.error?.({ err: e, projectId }, "sync-from-ps failed");
    }
  })();

  return job;
}

/* ════════════════════════════════════════════════════════════
 *  Endpoint HTTP: re-sync di uno scheduling_project con il PS linkato
 *  ────────────────────────────────────────────────────────────
 *  ASYNC: ritorna 202 subito + stato del job. Per attendere il
 *  completamento usa GET /scheduling/projects/:id/sync-status.
 *  Se ?wait=1 è passato, prova ad attendere fino a 90 s (utile in
 *  dev locale, in prod il proxy timeout potrebbe rispondere 502).
 * ════════════════════════════════════════════════════════════ */

async function loadProjectForSync(req: Request, res: Response): Promise<any | null> {
  const userId = req.user!.id;
  const projectId = String(req.params.id || "");
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "ID progetto non valido" }); return null; }

  const projR = await db.execute(sql`
    SELECT p.id, p.name, p.owner_user_id, p.planning_studio_project_id, p.feed_id, p.feed_label,
           CASE WHEN p.owner_user_id = ${userId}::uuid THEN 'owner'
                ELSE pm.role END AS my_role
      FROM scheduling_projects p
      LEFT JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const proj: any = (projR as any).rows?.[0] ?? (projR as any)[0] ?? null;
  if (!proj) { res.status(404).json({ error: "Progetto non trovato o senza permessi" }); return null; }
  if (proj.my_role === "viewer") {
    res.status(403).json({ error: "I viewer non possono sincronizzare il feed dal Planning Studio" });
    return null;
  }
  if (!proj.planning_studio_project_id) {
    res.status(400).json({ error: "Questo progetto non è collegato a nessun PsProject" });
    return null;
  }
  return proj;
}

router.post(
  "/scheduling/projects/:id/sync-from-ps",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const proj = await loadProjectForSync(req, res);
      if (!proj) return;
      const projectId = String(proj.id);
      const userId = req.user!.id;
      const wantWait = req.query.wait === "1" || (req.body && (req.body as any).wait === true);

      const job = startSyncJob(
        projectId,
        String(proj.planning_studio_project_id),
        userId,
        req.log,
      );

      // Modalità sync (legacy / dev): aspetta max 90 s prima di rispondere.
      if (wantWait) {
        const start = Date.now();
        while (job.status === "running" && (Date.now() - start) < 90_000) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (job.status === "done" && job.result) {
          res.json({ ok: true, ...job.result });
          return;
        }
        if (job.status === "error") {
          res.status(500).json({ error: job.error || "Errore materializzazione" });
          return;
        }
        // ancora in esecuzione → riporta 202 con stato
      }

      res.status(202).json({
        ok: true,
        status: job.status,
        message: "Sincronizzazione avviata in background. Polla /sync-status per il risultato.",
        startedAt: new Date(job.startedAt).toISOString(),
      });
    } catch (e: any) {
      req.log?.error?.({ err: e }, "sync-from-ps endpoint error");
      res.status(500).json({ error: e?.message || "Errore avvio sincronizzazione" });
    }
  },
);

router.get(
  "/scheduling/projects/:id/sync-status",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const proj = await loadProjectForSync(req, res);
      if (!proj) return;
      const projectId = String(proj.id);
      const job = syncJobs.get(projectId);

      // Se non c'è nessun job in memoria, il feed potrebbe essere già pronto
      // (job completato in una vita precedente del processo, o creato senza job).
      if (!job) {
        if (proj.feed_id) {
          // Recupera info sintetiche dal feed per allineare la response al
          // formato di MaterializeResult (counts/feedStartDate/feedEndDate).
          const fr: any = await db.execute(sql`
            SELECT id, feed_start_date, feed_end_date,
                   stops_count, routes_count, trips_count, shapes_count
              FROM gtfs_feeds WHERE id = ${proj.feed_id}::uuid
          `);
          const f: any = fr.rows?.[0] ?? fr[0];
          res.json({
            status: "done",
            feedId: proj.feed_id,
            label: proj.feed_label || `PS · ${proj.name || ""}`.trim(),
            feedStartDate: (f?.feed_start_date || "").toString().replace(/-/g, "").slice(0, 8),
            feedEndDate: (f?.feed_end_date || "").toString().replace(/-/g, "").slice(0, 8),
            counts: {
              stops: Number(f?.stops_count ?? 0),
              routes: Number(f?.routes_count ?? 0),
              trips: Number(f?.trips_count ?? 0),
              stopTimes: 0, calendars: 0, calendarDates: 0,
              shapes: Number(f?.shapes_count ?? 0),
            },
          });
          return;
        }
        res.json({ status: "idle" });
        return;
      }

      if (job.status === "done" && job.result) {
        res.json({ status: "done", ...job.result, durationMs: (job.finishedAt || Date.now()) - job.startedAt });
        return;
      }
      if (job.status === "error") {
        res.json({ status: "error", error: job.error });
        return;
      }
      res.json({
        status: "running",
        startedAt: new Date(job.startedAt).toISOString(),
        elapsedMs: Date.now() - job.startedAt,
      });
    } catch (e: any) {
      req.log?.error?.({ err: e }, "sync-status endpoint error");
      res.status(500).json({ error: e?.message || "Errore stato sincronizzazione" });
    }
  },
);

export default router;
