/**
 * Le versioni pubblicate dei programmi (PR 3.3, migrazione 0021).
 *
 * Quando un programma di Planning Studio va in esercizio, o se ne programma la
 * messa in esercizio, se ne fa una copia congelata: la versione pubblicata,
 * legata al feed materializzato in quel momento (ps_projects.versione_del_feed).
 * Stampa orari, quadri di palina, mappa orari pubblica (QR) e mappa di rete
 * condivisa leggono quella, non il progetto su cui si continua a lavorare
 * (la bozza).
 *
 *   in esercizio   la versione del feed acceso;
 *   programmata    la versione del feed di un'attivazione programmata;
 *   bozza          il progetto stesso, così com'è adesso.
 *
 * Una versione non ha proprietario: non compare fra i progetti di nessuno, e
 * le rotte che modificano un progetto non la trovano. Si legge solo dalla
 * stampa orari (chi può leggere il programma legge le sue versioni) e dai
 * link pubblici.
 *
 * La copia è la stessa della duplicazione (lib/progetto-copie.ts): gli id
 * della versione si ricavano da quelli del progetto (idDellaCopia), e i codici
 * stabili (PR 3.1) sono gli stessi.
 */
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { copiaProgetto, cancellaProgetto, idDellaCopia } from "./progetto-copie";

type Esecutore = { execute: (q: any) => Promise<any> };
const righe = (r: any): any[] => r?.rows ?? [];

export type QualeVersione = "esercizio" | "programmata" | "bozza";

export interface Versione {
  /** l'id da cui leggere: la versione, o il progetto per la bozza */
  id: string;
  quale: QualeVersione;
  /** in esercizio da (istante ISO), o in esercizio dal (giorno) per la programmata; null per la bozza */
  dal: string | null;
}

/** La data di oggi, per il nome della versione (giorno/mese/anno, ora italiana). */
function oggi(): string {
  return new Date().toLocaleDateString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric" });
}

/**
 * Crea la versione pubblicata del progetto per il feed `feedId`, in una
 * transazione sua. Se c'è già (stesso feed), la lascia com'è.
 */
export async function creaVersione(progettoId: string, feedId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const c = righe(await tx.execute(sql`SELECT id FROM ps_projects WHERE versione_del_feed = ${feedId}::uuid`))[0];
    if (c) return c.id as string;
    const nome = righe(await tx.execute(sql`SELECT name FROM ps_projects WHERE id = ${progettoId}::uuid`))[0]?.name ?? "Programma";
    return copiaProgetto(tx, progettoId, {
      nome: `${String(nome).slice(0, 160)} · versione pubblicata il ${oggi()}`,
      proprietario: null,
      versioneDelFeed: feedId,
    });
  });
}

/**
 * Toglie la versione del feed `feedId`, se c'è: una programmazione sostituita
 * o annullata, una messa in esercizio non riuscita. In `tx` se dato.
 */
export async function cancellaVersioneDelFeed(feedId: string, tx?: Esecutore): Promise<void> {
  const fai = async (t: Esecutore) => {
    const v = righe(await t.execute(sql`SELECT id FROM ps_projects WHERE versione_del_feed = ${feedId}::uuid`))[0];
    if (v) await cancellaProgetto(t as any, v.id);
  };
  if (tx) await fai(tx);
  else await db.transaction((t) => fai(t));
}

/** La versione in esercizio e quella programmata di un progetto, se ci sono. */
export async function versioniDelProgetto(progettoId: string): Promise<{ esercizio: Versione | null; programmata: Versione | null }> {
  const es = righe(await db.execute(sql`
    SELECT v.id, to_char(l.activated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS dal
      FROM ps_projects v
      JOIN gtfs_feeds f ON f.id = v.versione_del_feed AND f.is_active
      LEFT JOIN ps_activation_log l ON l.feed_id = f.id AND l.deactivated_at IS NULL
     WHERE v.versione_di = ${progettoId}::uuid
     LIMIT 1`))[0];
  const pr = righe(await db.execute(sql`
    SELECT v.id, to_char(pa.effective_from, 'YYYY-MM-DD') AS dal
      FROM ps_pending_activations pa
      JOIN ps_projects v ON v.versione_del_feed = pa.feed_id
     WHERE pa.project_id = ${progettoId}::uuid
     LIMIT 1`))[0];
  return {
    esercizio: es ? { id: es.id, quale: "esercizio", dal: es.dal ?? null } : null,
    programmata: pr ? { id: pr.id, quale: "programmata", dal: pr.dal ?? null } : null,
  };
}

/** Se `id` è una versione pubblicata: il progetto da cui viene (null se il progetto non c'è più). */
export async function seVersione(id: string): Promise<{ versione: true; progetto: string | null } | null> {
  const r = righe(await db.execute(sql`
    SELECT versione_di FROM ps_projects WHERE id = ${id}::uuid AND versione_del_feed IS NOT NULL`))[0];
  return r ? { versione: true, progetto: r.versione_di ?? null } : null;
}

/**
 * Da quale progetto legge un link pubblico del progetto `progettoId`: la
 * versione in esercizio se c'è, altrimenti il progetto stesso (com'era prima
 * delle versioni: i link già stampati continuano a funzionare finché il
 * programma non torna in esercizio). Gli id delle linee scelte nel link sono
 * quelli del progetto: nella versione diventano i loro (idDellaCopia).
 */
export async function fonteDelLink(progettoId: string, lineeDelLink: string[]): Promise<{ id: string; linee: string[]; versione: QualeVersione }> {
  const { esercizio } = await versioniDelProgetto(progettoId);
  if (!esercizio) return { id: progettoId, linee: lineeDelLink, versione: "bozza" };
  return { id: esercizio.id, linee: await idNellaVersione(esercizio.id, lineeDelLink), versione: "esercizio" };
}

/** Gli id di righe del progetto, nella sua versione `versioneId` (stesso ordine). */
export async function idNellaVersione(versioneId: string, idDelProgetto: string[]): Promise<string[]> {
  if (idDelProgetto.length === 0) return [];
  const r = await db.execute<any>(sql`
    SELECT ${idDellaCopia(versioneId, "x.id")} AS id
      FROM unnest(${`{${idDelProgetto.join(",")}}`}::uuid[]) WITH ORDINALITY AS x(id, n)
     ORDER BY x.n`);
  return righe(r).map((x: any) => x.id);
}

/**
 * Le linee scelte in una versione, come linee del progetto (per salvarle in
 * un link: il link resta del progetto e vale per ogni versione futura). Una
 * linea della versione si ritrova nel progetto dal codice stabile; un id che
 * è già del progetto resta com'è; il resto si scarta.
 */
export async function lineeDelProgetto(progettoId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await db.execute<any>(sql`
    WITH chieste AS (SELECT x.id, x.n FROM unnest(${`{${ids.join(",")}}`}::uuid[]) WITH ORDINALITY AS x(id, n))
    SELECT DISTINCT ON (p.id) p.id, c.n
      FROM chieste c
      LEFT JOIN ps_routes v ON v.id = c.id
      JOIN ps_routes p ON p.project_id = ${progettoId}::uuid
                      AND (p.id = c.id
                           OR (v.codice = p.codice
                               AND v.project_id IN (SELECT id FROM ps_projects WHERE versione_di = ${progettoId}::uuid)))
     ORDER BY p.id, c.n`);
  return righe(r).sort((a: any, b: any) => Number(a.n) - Number(b.n)).map((x: any) => x.id);
}

/* Gli id di progetto nei percorsi di Planning Studio: /planning-studio/projects/:id/… e /planning-studio/:projectId/… */
const PROGETTO_NEL_PERCORSO = /^\/planning-studio\/(?:projects\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/**
 * Middleware: una richiesta che scrive (tutto tranne GET e HEAD) su un
 * percorso di Planning Studio di una versione pubblicata si ferma con 403. Le
 * rotte che modificano un progetto già non la trovano (non ha proprietario né
 * membri); questo vale anche per l'amministratore, che le rotte lasciano
 * passare.
 */
export async function versioniInSolaLettura(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "GET" || req.method === "HEAD") { next(); return; }
  const m = PROGETTO_NEL_PERCORSO.exec(req.path);
  if (!m) { next(); return; }
  try {
    if (await seVersione(m[1]!)) {
      res.status(403).json({ error: "È una versione pubblicata di un programma: non si modifica. Si lavora sul programma, e la si sostituisce rimettendolo in esercizio" });
      return;
    }
  } catch (e) { next(e); return; }
  next();
}
