/**
 * Il lavoro materializza_feed v1: la sincronizzazione di un progetto di
 * scheduling col suo progetto Planning Studio, nel lavoratore (e
 * nell'esecutore interno dell'API). Richiesta { schedulingProjectId,
 * psProjectId, utenteId } → risultato = MaterializeResult + durationMs, la
 * stessa forma di prima per sync-from-ps e sync-status.
 *
 * Il permesso sul progetto PS lo ricontrolla materializePsToFeed con l'utente
 * che ha chiesto la sincronizzazione. Niente DDL: la colonna di ps_projects
 * c'è dalle migrazioni (il bootstrap pigro resta nell'API).
 */
import type { Gestore } from "../lavori/esecutore";
import { MaterializzazioneFermata } from "./feed";
import { sincronizzaProgetto } from "./sincronizza";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESCRIZIONE: Record<string, string> = {
  udp: "Corse dell'unità di produzione",
  feed: "Costruzione del feed",
  aggancio: "Aggancio del feed al progetto",
  scenari: "Scenari da aggiornare",
};

export const gestoreMaterializzazione: Gestore = {
  tipo: "materializza_feed",
  versione: 1,
  async esegui(l, ctx) {
    const { schedulingProjectId, psProjectId, utenteId } = (l.richiesta ?? {}) as Record<string, unknown>;
    if (![schedulingProjectId, psProjectId, utenteId].every(x => typeof x === "string" && UUID.test(x))) {
      return { stato: "fallito", errore: "Richiesta della sincronizzazione non valida", erroreTipo: "sistema" };
    }
    const log = (ctx.log as any).child?.({ lavoro: l.id }) ?? ctx.log;
    const t0 = Date.now();
    try {
      const r = await sincronizzaProgetto(schedulingProjectId as string, psProjectId as string, utenteId as string, {
        log, segnale: ctx.segnale,
        passo: (fase, percentuale) => ctx.progresso({ phase: fase, percentage: percentuale, detail: DESCRIZIONE[fase] ?? fase, timestamp: Date.now() }),
      });
      log.info({ projectId: schedulingProjectId, feedId: r.feedId, counts: r.counts, durationMs: Date.now() - t0 }, "sync-from-ps completed");
      return { stato: "completato", risultato: { ...r, durationMs: Date.now() - t0 } };
    } catch (err: any) {
      if (err instanceof MaterializzazioneFermata || ctx.segnale.aborted) return { stato: "fermato" };
      log.error({ err, projectId: schedulingProjectId }, "sync-from-ps failed");
      return { stato: "fallito", errore: String(err?.message ?? err).slice(0, 2000), erroreTipo: "calcolo" };
    }
  },
};
