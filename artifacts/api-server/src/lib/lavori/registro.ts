/**
 * La manutenzione del registro delle modifiche (PR 2.10), solo nel
 * lavoratore: ogni giorno (la prima volta 5 minuti dopo l'avvio), con lo
 * schema «ok».
 *
 * registro.manutenzione() (lib/db/migrations/0006_registro_delle_modifiche.sql)
 * crea le partizioni del mese e dei due successivi, sposta le righe rimaste
 * nella riserva, toglie chi ha fatto la modifica dopo anonimizza_dopo_mesi e
 * svuota quello che è oltre la conservazione. Gira come il proprietario del
 * registro, senza parametri: il lavoratore non sceglie cosa togliere. Due
 * lavoratori insieme non si pestano: la funzione ha il suo lucchetto.
 *
 * Poi registro.verifica(): quello che non va (un trigger spento, una
 * partizione che manca) finisce nel log come avviso; ruoli.mjs --verifica lo
 * dà come errore.
 *
 * Senza la migrazione 0006 (database indietro) non fa niente.
 */
import { pool } from "@workspace/db";
import { inSistema } from "@workspace/db/contesto";

export const OGNI_MS = 24 * 60 * 60 * 1000;
const PRIMO_GIRO_MS = 5 * 60 * 1000;

interface Log {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

export interface EsitoManutenzione {
  saltato?: boolean;
  partizioni?: string[];
  spostate?: number;
  anonimizzate?: number;
  svuotate?: string[];
  cancellate?: number;
  problemi: string[];
}

/** Un giro: manutenzione, poi verifica. Come «registro», non come chi ha avviato il lavoratore. */
export function manutieniRegistro(log: Log): Promise<EsitoManutenzione> {
  return inSistema("registro", async () => {
    const { rows: [c] } = await pool.query("SELECT pg_catalog.to_regprocedure('registro.manutenzione()') IS NOT NULL AS c");
    if (!c?.c) return { saltato: true, problemi: [] };
    const { rows: [m] } = await pool.query("SELECT registro.manutenzione() AS esito");
    const esito = (m?.esito ?? {}) as Omit<EsitoManutenzione, "problemi"> & { saltata?: boolean };
    const { rows } = await pool.query("SELECT v AS problema FROM registro.verifica() AS v");
    const problemi = rows.map((r: { problema: string }) => r.problema);
    if (esito.saltata) log.info({}, "registro delle modifiche: manutenzione già in corso altrove, salto");
    else if (esito.partizioni?.length || esito.spostate || esito.anonimizzate || esito.svuotate?.length || esito.cancellate) {
      log.info(esito, "registro delle modifiche: manutenzione fatta");
    }
    for (const p of problemi) log.warn({ problema: p }, `registro delle modifiche: ${p}`);
    return { ...esito, saltato: !!esito.saltata, problemi };
  });
}

/** Ogni giorno, solo quando `puo()` (schema «ok»). Restituisce lo stop. */
export function avviaRegistro(log: Log, puo: () => boolean = () => true, ogniMs = OGNI_MS): () => void {
  const giro = () => {
    if (!puo()) { log.info({}, "registro delle modifiche: manutenzione saltata, lo schema del database non è quello di questo codice"); return; }
    manutieniRegistro(log).catch(err => log.error({ err }, "registro delle modifiche: manutenzione non riuscita"));
  };
  const primo = setTimeout(giro, PRIMO_GIRO_MS);
  const ciclo = setInterval(giro, ogniMs);
  primo.unref(); ciclo.unref();
  return () => { clearTimeout(primo); clearInterval(ciclo); };
}
