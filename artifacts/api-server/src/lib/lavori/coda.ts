/**
 * La coda dei lavori (coda.lavori, migrazione 0004): solo SQL, niente Express,
 * così la usano sia l'API sia il lavoratore (src/lavoratore.ts).
 *
 * - L'API accoda e legge; chi esegue (il lavoratore, o l'esecutore interno
 *   dell'API: lib/lavori/esecutore.ts) prende un lavoro con
 *   FOR UPDATE SKIP LOCKED, così due processi non prendono mai lo stesso.
 * - Chi esegue batte ogni pochi secondi: il lease scade dopo LEASE_SEC senza
 *   battito. Un lavoro scaduto (il processo è morto) torna in coda finché ha
 *   tentativi, poi è «fallito, interrotto». Un errore del calcolo o un timeout
 *   non si ritentano mai.
 * - Lo stop: un lavoro in coda diventa subito «fermato»; uno in corso riceve
 *   `annulla`, che chi esegue legge al battito.
 * - La pulizia: risultato e richiesta svuotati dopo 7 giorni, righe cancellate
 *   dopo 30 (la riga dice chi ha lanciato quale calcolo: si tiene poco).
 * - Ogni query ha un tempo massimo: una connessione morta in silenzio (senza
 *   RST) non deve bloccare per sempre il battito o il giro dell'esecutore.
 */
import { pool } from "@workspace/db";

/** Tempo massimo di una query della coda (lato client: poi la connessione si scarta). */
const QUERY_MS = 30_000;
const q = (text: string, values: unknown[] = [], ms = QUERY_MS) => pool.query({ text, values, query_timeout: ms } as any);

export type StatoLavoro = "in_coda" | "in_corso" | "completato" | "fallito" | "fermato";
export type ErroreTipo = "calcolo" | "interrotto" | "scaduto" | "annullato" | "sistema";
export type Corsia = "veloce" | "lunga";
export type TipoLavoro = "python" | "ottimizza_veicoli" | "giro_agente" | "materializza_feed";

export interface Lavoro {
  id: string;
  tipo: TipoLavoro;
  versione: number;
  corsia: Corsia;
  stato: StatoLavoro;
  utente_id: string | null;
  via: string | null;
  oggetto_id: string | null;
  chiave_unicita: string | null;
  richiesta: any;
  metadati: Record<string, any>;
  avanzamento: any | null;
  http_codice: number | null;
  risultato: any | null;
  errore: string | null;
  errore_tipo: ErroreTipo | null;
  tentativi: number;
  max_tentativi: number;
  timeout_sec: number;
  disponibile_dal: Date;
  preso_da: string | null;
  battito_il: Date | null;
  scade_il: Date | null;
  annulla: boolean;
  creato_il: Date;
  iniziato_il: Date | null;
  finito_il: Date | null;
  aggiornato_il: Date;
}

/** Senza battito per tanto, il lavoro si considera abbandonato. */
export const LEASE_SEC = 60;
/** Dopo un abbandono si riprova con un ritardo: RITARDO_SEC × tentativi già fatti. */
const RITARDO_SEC = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NuovoLavoro {
  tipo: TipoLavoro;
  versione?: number;
  corsia: Corsia;
  utenteId?: string | null;
  via?: string | null;
  oggettoId?: string | null;
  chiaveUnicita?: string | null;
  richiesta: unknown;
  metadati?: Record<string, unknown>;
  timeoutSec: number;
  maxTentativi?: number;
}

export async function accoda(n: NuovoLavoro): Promise<string> {
  const r = await q(
    `INSERT INTO coda.lavori (tipo, versione, corsia, utente_id, via, oggetto_id, chiave_unicita, richiesta, metadati, timeout_sec, max_tentativi)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
     RETURNING id`,
    [n.tipo, n.versione ?? 1, n.corsia, n.utenteId ?? null, n.via ?? null, n.oggettoId ?? null, n.chiaveUnicita ?? null,
     JSON.stringify(n.richiesta ?? {}), JSON.stringify(n.metadati ?? {}), Math.round(n.timeoutSec), n.maxTentativi ?? 2],
  );
  return r.rows[0].id;
}

/** La riga, senza la richiesta (può essere grande e serve solo a chi esegue). */
export async function leggi(id: string): Promise<Omit<Lavoro, "richiesta"> | null> {
  if (!UUID.test(id)) return null;
  const r = await q(
    `SELECT id, tipo, versione, corsia, stato, utente_id, via, oggetto_id, chiave_unicita, metadati, avanzamento,
            http_codice, risultato, errore, errore_tipo, tentativi, max_tentativi, timeout_sec, disponibile_dal,
            preso_da, battito_il, scade_il, annulla, creato_il, iniziato_il, finito_il, aggiornato_il
       FROM coda.lavori WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/**
 * Stop: un lavoro in coda diventa subito «fermato»; uno in corso riceve la
 * richiesta di annullamento. null se il lavoro è già finito (o non c'è).
 *
 * Un solo UPDATE: se la riga è bloccata da chi la sta prendendo (o rimettendo
 * in coda), dopo il lock Postgres rilegge la versione nuova e i CASE decidono
 * su quella. Con due UPDATE sulla stessa istantanea lo stop si perdeva.
 */
export async function chiediAnnullamento(id: string): Promise<"fermato" | "in_fermata" | null> {
  if (!UUID.test(id)) return null;
  const r = await q(
    `UPDATE coda.lavori SET
            stato = CASE WHEN stato = 'in_coda' THEN 'fermato' ELSE stato END,
            errore_tipo = CASE WHEN stato = 'in_coda' THEN 'annullato' ELSE errore_tipo END,
            finito_il = CASE WHEN stato = 'in_coda' THEN now() ELSE finito_il END,
            annulla = true, aggiornato_il = now()
      WHERE id = $1 AND stato IN ('in_coda', 'in_corso')
     RETURNING CASE WHEN stato = 'fermato' THEN 'fermato' ELSE 'in_fermata' END AS esito`, [id]);
  return r.rows[0]?.esito ?? null;
}

/** Quanti lavori vivi (in coda o in corso) ha un utente in un ambito. */
export async function viviDi(utenteId: string, ambito: string): Promise<number> {
  const r = await q(
    `SELECT count(*)::int AS n FROM coda.lavori
      WHERE utente_id = $1 AND stato IN ('in_coda', 'in_corso') AND metadati->>'ambito' = $2`, [utenteId, ambito]);
  return r.rows[0]?.n ?? 0;
}

/**
 * Il lavoro vivo (in coda o in corso) con questa chiave di unicità, se c'è: al
 * più uno, per l'indice unico parziale lavori_unici_vivi. Serve a rispondere
 * 409 prima di un lavoro preliminare costoso; la garanzia resta l'indice
 * (un accoda in gara dà 23505).
 */
export async function vivoConChiave(chiave: string): Promise<{ id: string; utente_id: string | null; stato: StatoLavoro } | null> {
  const r = await q(
    `SELECT id, utente_id, stato FROM coda.lavori
      WHERE chiave_unicita = $1 AND stato IN ('in_coda', 'in_corso') LIMIT 1`, [chiave]);
  return r.rows[0] ?? null;
}

/** Il codice di Postgres per una chiave di unicità già viva (lavori_unici_vivi). */
export const CHIAVE_GIA_VIVA = "23505";

/** Prende il lavoro più vecchio di una corsia fra i tipi e le versioni che chi esegue conosce. */
export async function prendi(corsia: Corsia, chi: string, noti: ReadonlyArray<{ tipo: string; versione: number }>): Promise<Lavoro | null> {
  if (!noti.length) return null;
  const r = await q(
    `UPDATE coda.lavori SET
            stato = 'in_corso', preso_da = $2, tentativi = tentativi + 1,
            iniziato_il = coalesce(iniziato_il, now()), battito_il = now(),
            scade_il = now() + make_interval(secs => $3), aggiornato_il = now()
      WHERE id = (
        SELECT id FROM coda.lavori
         WHERE stato = 'in_coda' AND corsia = $1 AND disponibile_dal <= now()
           AND (tipo, versione) IN (SELECT t, v FROM unnest($4::text[], $5::smallint[]) AS n(t, v))
         ORDER BY creato_il
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
     RETURNING *`,
    [corsia, chi, LEASE_SEC, noti.map(n => n.tipo), noti.map(n => n.versione)]);
  return r.rows[0] ?? null;
}

/**
 * Il battito: rinnova il lease e, se c'è, scrive l'avanzamento. Risponde se
 * è stato chiesto l'annullamento; null se il lavoro non è più di chi batte
 * (lease scaduto e ripreso da altri, o già chiuso): chi esegue si ferma.
 */
export async function battito(id: string, chi: string, avanzamento?: unknown): Promise<{ annulla: boolean } | null> {
  const r = await q(
    `UPDATE coda.lavori SET
            battito_il = now(), scade_il = now() + make_interval(secs => $3),
            avanzamento = coalesce($4::jsonb, avanzamento),
            aggiornato_il = CASE WHEN $4::jsonb IS NULL THEN aggiornato_il ELSE now() END
      WHERE id = $1 AND preso_da = $2 AND stato = 'in_corso'
     RETURNING annulla`,
    [id, chi, LEASE_SEC, avanzamento === undefined ? null : JSON.stringify(avanzamento)]);
  return r.rows[0] ? { annulla: !!r.rows[0].annulla } : null;
}

export type Esito =
  | { stato: "completato"; risultato: unknown; httpCodice?: number; avanzamento?: unknown }
  | {
      stato: "fallito"; errore: string; erroreTipo: Exclude<ErroreTipo, "annullato" | "interrotto">; httpCodice?: number; avanzamento?: unknown;
      /** la risposta del calcolo, se ne ha una (per esempio il corpo di un 400 o di un 422: la facciata la ripete) */
      risultato?: unknown;
    }
  | { stato: "fermato" };

/** Il risultato da scrivere: quello di un completato, o quello che un fallito porta con sé. */
export function risultatoDi(e: Esito): unknown {
  if (e.stato === "completato") return e.risultato ?? null;
  if (e.stato === "fallito" && e.risultato !== undefined) return e.risultato;
  return undefined;
}

/** Chiude il lavoro (solo se è ancora di chi lo chiude). */
export async function chiudi(id: string, chi: string, e: Esito): Promise<boolean> {
  const r = await q(
    `UPDATE coda.lavori SET
            stato = $3, risultato = $4::jsonb, errore = $5, errore_tipo = $6, http_codice = $7,
            avanzamento = coalesce($8::jsonb, avanzamento),
            finito_il = now(), aggiornato_il = now(), battito_il = NULL, scade_il = NULL
      WHERE id = $1 AND preso_da = $2 AND stato = 'in_corso'
     RETURNING id`,
    [id, chi, e.stato,
     risultatoDi(e) === undefined ? null : JSON.stringify(risultatoDi(e)),
     e.stato === "fallito" ? e.errore : null,
     e.stato === "fallito" ? e.erroreTipo : e.stato === "fermato" ? "annullato" : null,
     e.stato === "fermato" ? null : (e.httpCodice ?? null),
     e.stato === "fermato" || e.avanzamento === undefined ? null : JSON.stringify(e.avanzamento)]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Arresto ordinato di chi esegue: il lavoro torna in coda senza consumare il
 * tentativo (o diventa «fermato», se intanto era stato chiesto lo stop).
 */
export async function rimettiInCoda(id: string, chi: string): Promise<boolean> {
  const r = await q(
    `UPDATE coda.lavori SET
            stato = CASE WHEN annulla THEN 'fermato' ELSE 'in_coda' END,
            errore_tipo = CASE WHEN annulla THEN 'annullato' END,
            finito_il = CASE WHEN annulla THEN now() END,
            tentativi = greatest(tentativi - 1, 0), avanzamento = NULL,
            preso_da = NULL, battito_il = NULL, scade_il = NULL, aggiornato_il = now()
      WHERE id = $1 AND preso_da = $2 AND stato = 'in_corso'
     RETURNING id`, [id, chi]);
  return (r.rowCount ?? 0) > 0;
}

/** I lavori il cui lease è scaduto: di nuovo in coda (con un ritardo) o «fallito, interrotto». */
export async function recuperaScaduti(): Promise<Array<{ id: string; stato: StatoLavoro }>> {
  const r = await q(
    `UPDATE coda.lavori SET
            stato = CASE WHEN annulla THEN 'fermato' WHEN tentativi < max_tentativi THEN 'in_coda' ELSE 'fallito' END,
            errore_tipo = CASE WHEN annulla THEN 'annullato' WHEN tentativi < max_tentativi THEN NULL ELSE 'interrotto' END,
            errore = CASE WHEN NOT annulla AND tentativi >= max_tentativi
                          THEN 'Calcolo interrotto: il processo che lo eseguiva si è fermato più volte. Rilancialo.' END,
            finito_il = CASE WHEN annulla OR tentativi >= max_tentativi THEN now() END,
            disponibile_dal = now() + make_interval(secs => $1 * tentativi),
            avanzamento = CASE WHEN annulla OR tentativi >= max_tentativi THEN avanzamento END,
            preso_da = NULL, battito_il = NULL, scade_il = NULL, aggiornato_il = now()
      WHERE stato = 'in_corso' AND scade_il < now()
     RETURNING id, stato`, [RITARDO_SEC]);
  return r.rows;
}

/** Conservazione: risultato e richiesta via dopo 7 giorni, righe via dopo 30. */
export async function pulisci(): Promise<{ svuotati: number; cancellati: number }> {
  const svuotati = await q(
    `UPDATE coda.lavori SET risultato = NULL, richiesta = '{}'::jsonb
      WHERE finito_il < now() - interval '7 days' AND (risultato IS NOT NULL OR richiesta <> '{}'::jsonb)`, [], 120_000);
  const cancellati = await q(
    `DELETE FROM coda.lavori
      WHERE stato <> 'in_corso' AND coalesce(finito_il, creato_il) < now() - interval '30 days'`, [], 120_000);
  return { svuotati: svuotati.rowCount ?? 0, cancellati: cancellati.rowCount ?? 0 };
}
