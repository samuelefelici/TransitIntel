/**
 * Le giornate di esercizio (tappa 4.2), solo nel lavoratore: ogni 15 minuti
 * (la prima volta un minuto dopo l'avvio), con lo schema «ok».
 *
 * Prepara la giornata di domani (si rifà a ogni giro finché non comincia),
 * congela quella in corso e ogni giornata preparata già cominciata
 * (lib/esercizio-giornate.ts). Gira come «giornate»; il lucchetto per
 * giornata mette in fila due lavoratori, o il lavoratore e l'amministratore.
 *
 * Senza la migrazione 0025 (database indietro) non fa niente.
 *
 * Dalla 4.10 applica alle giornate appena congelate le variazioni decise in
 * anticipo (soppressioni e scioperi, lib/esercizio-variazioni-applica.ts).
 *
 * Dalla 4.4 fa anche la proposta dall'AVM, in modo definitivo, delle
 * giornate degli ultimi giorni passate le 04:00 del giorno dopo, quando i
 * passaggi tardivi sono arrivati (lib/esercizio-proposta.ts). Una proposta
 * che non riesce non ferma il giro: lo dice il log, e ci riprova al giro dopo.
 */
import { pool } from "@workspace/db";
import { inSistema } from "@workspace/db/contesto";
import { giroDelleGiornate } from "../esercizio-giornate";
import { calcolaProposta, giornateDaProporre } from "../esercizio-proposta";
import { applicaVariazioni, giornateConVariazioni } from "../esercizio-variazioni-applica";
import { giornataOggi } from "../service-day";

export const OGNI_MS = 15 * 60 * 1000;
const PRIMO_GIRO_MS = 60 * 1000;

interface Log {
  info(o: object, m: string): void;
  error(o: object, m: string): void;
}

const dopo = (g: string) => {
  const d = new Date(`${g}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Un giro: domani preparata, oggi e le cominciate congelate. */
export function giroGiornate(log: Log, adesso: Date = new Date()): Promise<Record<string, string> | null> {
  return inSistema("giornate", async () => {
    const { rows: [c] } = await pool.query("SELECT pg_catalog.to_regclass('public.esercizio_giornate') IS NOT NULL AS c");
    if (!c?.c) return null;
    const oggi = giornataOggi(adesso);
    const fatto = await giroDelleGiornate(oggi, dopo(oggi));
    const cambiate = Object.entries(fatto).filter(([, e]) => e !== "già congelata");
    if (cambiate.length) log.info({ giornate: Object.fromEntries(cambiate) }, "giornate di esercizio: preparate e congelate");
    const { rows: [v] } = await pool.query("SELECT pg_catalog.to_regclass('public.esercizio_variazioni') IS NOT NULL AS c");
    if (v?.c) {
      for (const g of await giornateConVariazioni()) {
        try {
          const r = await applicaVariazioni(g);
          const errori = r.filter((x) => x.errore);
          if (r.length - errori.length) fatto[g] = `variazioni applicate: ${r.length - errori.length}`;
          log.info({ giorno: g, variazioni: r }, "giornate di esercizio: variazioni decise in anticipo");
          if (errori.length) log.error({ giorno: g, errori }, "giornate di esercizio: variazioni non applicate");
        } catch (err) {
          log.error({ err, giorno: g }, "giornate di esercizio: variazioni non applicate");
        }
      }
    }
    const { rows: [p] } = await pool.query("SELECT pg_catalog.to_regclass('public.esercizio_aggiunte_proposte') IS NOT NULL AS c");
    if (p?.c) {
      for (const g of await giornateDaProporre(oggi)) {
        try {
          const r: any = await calcolaProposta(g);
          fatto[g] = r?.caronte === false ? "proposta: tabelle dell'AVM assenti" : `proposta definitiva, ${r?.perProposta?.effettuata_avm ?? 0} effettuate (AVM)`;
          log.info({ giorno: g, perProposta: r?.perProposta, aggiunte: r?.aggiunte }, "giornate di esercizio: proposta dall'AVM");
        } catch (err) {
          log.error({ err, giorno: g }, "giornate di esercizio: proposta non riuscita");
        }
      }
    }
    return fatto;
  });
}

/** Ogni 15 minuti, solo quando `puo()` (schema «ok»). Restituisce lo stop. */
export function avviaGiornate(log: Log, puo: () => boolean = () => true, ogniMs = OGNI_MS): () => void {
  const giro = () => {
    if (!puo()) return;
    giroGiornate(log).catch(err => log.error({ err }, "giornate di esercizio: giro non riuscito"));
  };
  const primo = setTimeout(giro, PRIMO_GIRO_MS);
  const ciclo = setInterval(giro, ogniMs);
  primo.unref(); ciclo.unref();
  return () => { clearTimeout(primo); clearInterval(ciclo); };
}
