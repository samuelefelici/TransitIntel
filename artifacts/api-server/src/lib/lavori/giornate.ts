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
 */
import { pool } from "@workspace/db";
import { inSistema } from "@workspace/db/contesto";
import { giroDelleGiornate } from "../esercizio-giornate";
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
