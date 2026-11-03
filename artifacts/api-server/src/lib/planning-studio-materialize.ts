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
import { sincronizzaProgetto } from "./materializzazione/sincronizza";
import * as coda from "./lavori/coda";
import { arresto } from "./arresto";
import { AMBITI } from "./lavori/ambiti";

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
      await ensureMaterializedColumn();
      const result = await sincronizzaProgetto(projectId, psProjectId, ownerUserId, { log: logger });
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
 *  Sincronizzazione nella coda dei lavori (PR 2.7a)
 *  ────────────────────────────────────────────────────────────
 *  Con LAVORI_FEED_IN_CODA (default acceso) la sincronizzazione è un lavoro
 *  materializza_feed eseguito dal lavoratore: un deploy dell'API non la
 *  interrompe più, e lo stato si legge dalla riga in coda (niente più falso
 *  «done» dopo un riavvio). Al più una viva per progetto (chiave sync:<id>):
 *  una seconda richiesta si aggancia a quella in corso, come prima nello
 *  stesso processo. Con LAVORI_FEED_IN_CODA=0 resta il job in memoria.
 * ════════════════════════════════════════════════════════════ */
const AMBITO_SYNC = AMBITI.materializzazione;
const chiaveSync = (projectId: string) => `sync:${projectId}`;
/** Il tempo massimo di una sincronizzazione in coda (poi «fallito, scaduto»: lo applica il gestore). */
const TEMPO_MASSIMO_SYNC_SEC = 30 * 60;
/** Quanto si aspetta che una sincronizzazione che si sta fermando finisca, prima di accodarne una nuova. */
const ATTESA_FERMATA_MS = 15_000;

export function feedInCoda(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LAVORI_FEED_IN_CODA !== "0";
}

export type Sincronizzazione =
  | { tipo: "coda"; id: string }
  | { tipo: "memoria"; job: SyncJob };

export interface StatoSincronizzazione {
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  result?: MaterializeResult;
  error?: string;
}

/**
 * La sincronizzazione viva da seguire con questa chiave, se c'è. Una a cui è
 * stato chiesto lo stop non si segue (finirebbe «fermata»): si aspetta che
 * chiuda, al più ATTESA_FERMATA_MS, così la richiesta nuova ne accoda un'altra.
 */
async function vivaDaSeguire(chiave: string): Promise<{ id: string; stato: string } | null> {
  const fine = Date.now() + ATTESA_FERMATA_MS;
  for (;;) {
    const v = await coda.vivoConChiave(chiave);
    if (!v) return null;
    if (!v.annulla || Date.now() >= fine) return { id: v.id, stato: v.stato };
    await new Promise(r => setTimeout(r, 250));
  }
}

/** Avvia (o ritrova, se è già in corso) la sincronizzazione di un progetto di scheduling. */
export async function avviaSincronizzazione(
  projectId: string, psProjectId: string, utenteId: string,
  log?: { info?: any; error?: any; warn?: any }, via?: string | null,
): Promise<Sincronizzazione> {
  const chiave = chiaveSync(projectId);
  const viva = await vivaDaSeguire(chiave);
  if (viva) {
    // col flag a 0 (ritorno indietro) si segue solo una sincronizzazione che il
    // lavoratore sta già eseguendo; una ancora in coda (il lavoratore può essere
    // giù) si ferma e si rifà qui, invece di aspettarla per sempre
    if (feedInCoda() || viva.stato === "in_corso") return { tipo: "coda", id: viva.id };
    await coda.chiediAnnullamento(viva.id);
  }
  if (!feedInCoda()) return { tipo: "memoria", job: startSyncJob(projectId, psProjectId, utenteId, log) };
  // il bootstrap pigro della colonna resta qui, nell'API: il lavoratore non fa DDL
  await ensureMaterializedColumn();
  for (let tentativo = 1; ; tentativo++) {
    try {
      const id = await coda.accoda({
        tipo: "materializza_feed",
        corsia: "veloce",
        utenteId,
        via: via ?? "api",
        oggettoId: projectId,
        chiaveUnicita: chiave,
        richiesta: { schedulingProjectId: projectId, psProjectId, utenteId },
        metadati: { ambito: AMBITO_SYNC, schedulingProjectId: projectId, psProjectId },
        timeoutSec: TEMPO_MASSIMO_SYNC_SEC,
      });
      log?.info?.({ lavoro: id, projectId }, "sync-from-ps in coda");
      return { tipo: "coda", id };
    } catch (err: any) {
      // un'altra richiesta l'ha accodata un attimo prima: ci si aggancia; se è
      // già finita nel frattempo, si riprova ad accodare
      if (err?.code !== coda.CHIAVE_GIA_VIVA || tentativo >= 3) throw err;
      const v = await vivaDaSeguire(chiave);
      if (v) return { tipo: "coda", id: v.id };
    }
  }
}

/** Lo stato di una sincronizzazione dalla sua riga in coda. */
export function statoDaRiga(l: { stato: string; creato_il: Date; iniziato_il: Date | null; finito_il: Date | null; risultato: any; errore: string | null }): StatoSincronizzazione {
  const startedAt = +(l.iniziato_il ?? l.creato_il);
  if (l.stato === "in_coda" || l.stato === "in_corso") return { status: "running", startedAt };
  const finishedAt = l.finito_il ? +l.finito_il : undefined;
  if (l.stato === "completato") {
    // dopo 7 giorni la pulizia della coda svuota il risultato: «done» senza dettagli
    if (!l.risultato) return { status: "done", startedAt, finishedAt };
    const { durationMs: _d, ...result } = l.risultato as MaterializeResult & { durationMs?: number };
    return { status: "done", startedAt, finishedAt, result };
  }
  if (l.stato === "fermato") return { status: "error", startedAt, finishedAt, error: "Sincronizzazione fermata" };
  return { status: "error", startedAt, finishedAt, error: l.errore ?? "Errore materializzazione" };
}

export async function statoSincronizzazione(s: Sincronizzazione): Promise<StatoSincronizzazione> {
  if (s.tipo === "memoria") {
    const j = s.job;
    return { status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, result: j.result, error: j.error };
  }
  const l = await coda.leggi(s.id);
  if (!l) return { status: "error", startedAt: Date.now(), error: "Sincronizzazione sparita dalla coda" };
  return statoDaRiga(l);
}

/**
 * Attende la fine della sincronizzazione fino a `ms`; poi ne dà lo stato (anche
 * «running»). All'arresto dell'API smette subito di aspettare: la
 * sincronizzazione continua nel lavoratore e chi chiama riceve «running» (202),
 * invece di una connessione chiusa a metà.
 */
export async function attendiSincronizzazione(s: Sincronizzazione, ms: number, passoMs = 500): Promise<StatoSincronizzazione> {
  const fine = Date.now() + ms;
  for (;;) {
    const st = await statoSincronizzazione(s);
    if (st.status !== "running" || Date.now() >= fine || arresto.signal.aborted) return st;
    await new Promise(r => setTimeout(r, passoMs));
  }
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
    SELECT p.id, p.name, p.owner_user_id, p.planning_studio_project_id, p.feed_id, p.feed_label, p.updated_at,
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

      const sync = await avviaSincronizzazione(
        projectId,
        String(proj.planning_studio_project_id),
        userId,
        req.log,
        (req as any).authVia ?? null,
      );

      // Modalità sync (legacy / dev, e Argos): aspetta max 90 s prima di rispondere.
      if (wantWait) {
        const st = await attendiSincronizzazione(sync, 90_000);
        if (st.status === "done" && st.result) {
          res.json({ ok: true, ...st.result });
          return;
        }
        if (st.status === "error") {
          res.status(500).json({ error: st.error || "Errore materializzazione" });
          return;
        }
        // ancora in esecuzione → riporta 202 con stato
      }

      const st = await statoSincronizzazione(sync);
      res.status(202).json({
        ok: true,
        status: st.status,
        message: "Sincronizzazione avviata in background. Polla /sync-status per il risultato.",
        startedAt: new Date(st.startedAt).toISOString(),
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
      // il feed agganciato al progetto, se esiste ancora
      const f: any = proj.feed_id ? (await db.execute<any>(sql`
        SELECT id, feed_start_date, feed_end_date, uploaded_at,
               stops_count, routes_count, trips_count, shapes_count
          FROM gtfs_feeds WHERE id = ${proj.feed_id}::uuid
      `)).rows?.[0] : undefined;

      // 1. il job in memoria (solo con LAVORI_FEED_IN_CODA=0), come prima; un «done»
      //    vale solo se il progetto è ancora su quel feed
      const job = feedInCoda() ? undefined : syncJobs.get(projectId);
      if (job && !(job.status === "done" && job.result?.feedId !== proj.feed_id)) {
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
        return;
      }

      // 2. l'ultima sincronizzazione in coda: viva, finita o fallita, sopravvive ai riavvii
      const l = await coda.ultimoDi("materializza_feed", projectId);
      if (l) {
        const st = statoDaRiga(l);
        if (st.status === "running") {
          res.json({ status: "running", startedAt: new Date(st.startedAt).toISOString(), elapsedMs: Date.now() - st.startedAt });
          return;
        }
        // un errore vale se dopo non è cambiato niente: un feed creato dopo (una
        // sincronizzazione nell'API col flag a 0) o un progetto modificato dopo (un
        // PATCH che aggancia un altro feed) lo superano; una sincronizzazione
        // fallita non sposta il puntatore e non tocca il progetto
        const dopo = (t: unknown) => !!t && !!l.finito_il && new Date(t as any) > l.finito_il;
        const agganciatoDopo = dopo(f?.uploaded_at) || dopo(proj.updated_at);
        if (st.status === "error" && !agganciatoDopo) {
          res.json({ status: "error", error: st.error });
          return;
        }
        // finita: vale se il progetto è ancora agganciato a quel feed (un PATCH può averlo cambiato)
        if (st.status === "done" && st.result && st.result.feedId === proj.feed_id) {
          res.json({ status: "done", ...st.result, durationMs: (st.finishedAt ?? Date.now()) - st.startedAt });
          return;
        }
      }

      // 3. nessuna sincronizzazione nota: il feed agganciato, se esiste ancora
      if (f) {
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
    } catch (e: any) {
      req.log?.error?.({ err: e }, "sync-status endpoint error");
      res.status(500).json({ error: e?.message || "Errore stato sincronizzazione" });
    }
  },
);

export default router;
