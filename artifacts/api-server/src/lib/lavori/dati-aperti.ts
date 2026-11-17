/**
 * I dati aperti (tappa 6.3), solo nel lavoratore: ogni 10 minuti (la prima
 * volta due minuti dopo l'avvio), con lo schema «ok».
 *
 * Guarda se il GTFS e il NeTEx in linea sono ancora quelli della versione in
 * esercizio e dei dati dell'azienda di adesso, e rifà quelli che non lo sono
 * (lib/dati-aperti.ts). Quasi sempre non c'è niente da fare: due letture.
 * Gira come «dati-aperti»; il lucchetto mette in fila due lavoratori, o il
 * lavoratore e l'amministratore che preme «Prepara adesso».
 *
 * Con la pubblicazione spenta, o senza la migrazione 0037 (database indietro),
 * non fa niente.
 */
import { pool } from "@workspace/db";
import { inSistema } from "@workspace/db/contesto";
import { preparaDatiAperti, type EsitoPreparazione } from "../dati-aperti";

export const OGNI_MS = 10 * 60 * 1000;
const PRIMO_GIRO_MS = 2 * 60 * 1000;

interface Log {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

/** Un giro: i file che non sono più quelli di adesso si rifanno. */
export function giroDatiAperti(log: Log): Promise<EsitoPreparazione | null> {
  return inSistema("dati-aperti", async () => {
    const { rows: [c] } = await pool.query("SELECT pg_catalog.to_regclass('public.dati_aperti') IS NOT NULL AS c");
    if (!c?.c) return null;
    const esito = await preparaDatiAperti({
      suGuasto: (err, tipo) => log.error({ err, tipo }, "dati aperti: preparazione non riuscita"),
    });
    if (esito.stato !== "fatto") return esito;
    const cambiati = Object.entries(esito.file).filter(([, e]) => e !== "invariato" && e !== "senza_versione");
    const pubblicati = cambiati.filter(([, e]) => e === "pubblicato");
    if (pubblicati.length) log.info({ file: Object.fromEntries(pubblicati) }, "dati aperti: file pubblicati");
    const fermi = cambiati.filter(([, e]) => e !== "pubblicato");
    if (fermi.length) log.warn({ file: Object.fromEntries(fermi) }, "dati aperti: file non pubblicati, resta in linea quello di prima");
    return esito;
  });
}

/** Ogni 10 minuti, solo quando `puo()` (schema «ok»). Restituisce lo stop. */
export function avviaDatiAperti(log: Log, puo: () => boolean = () => true, ogniMs = OGNI_MS): () => void {
  const giro = () => {
    if (!puo()) return;
    giroDatiAperti(log).catch(err => log.error({ err }, "dati aperti: giro non riuscito"));
  };
  const primo = setTimeout(giro, PRIMO_GIRO_MS);
  const ciclo = setInterval(giro, ogniMs);
  primo.unref(); ciclo.unref();
  return () => { clearTimeout(primo); clearInterval(ciclo); };
}
