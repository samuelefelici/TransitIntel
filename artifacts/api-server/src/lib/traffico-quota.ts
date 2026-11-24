/**
 * Le letture del traffico da TomTom dentro la quota mensile del piano
 * (tappa 7.30).
 *
 * Prima si leggevano tutti i punti stradali ogni 30 minuti, più una volta a
 * ogni avvio dell'API: con 37 punti circa 54.000 richieste al mese. Il piano
 * gratuito ne concede circa 20.000: dal 12 del mese TomTom rifiutava tutto
 * (403) fino al 1° del mese dopo, e il traffico non si aggiornava più.
 *
 * Ora l'intervallo si calcola dal numero dei punti e dalla quota del mese
 * (TRAFFICO_RICHIESTE_MESE, 19.000 se manca): i punti per le letture di un
 * mese di 31 giorni stanno nella quota. Mai meno di 30 minuti, come prima.
 * All'avvio non si legge subito: la prima lettura arriva un intervallo dopo
 * l'ultima registrata, così i riavvii non consumano richieste in più.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { inSistema } from "@workspace/db/contesto";
import { leggiLuoghi } from "./territorio";
import { syncTrafficFromTomTom } from "../routes/cron";

export const RICHIESTE_MESE_PREDEFINITE = 19_000;
const MINUTI_MESE = 31 * 24 * 60;
const INTERVALLO_MINIMO_MIN = 30;
const PRIMA_LETTURA_MINIMA_MS = 10_000;

type Log = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

/** La quota mensile da TRAFFICO_RICHIESTE_MESE; un valore storto vale la predefinita. */
export function richiesteMese(valore = process.env.TRAFFICO_RICHIESTE_MESE): number {
  const n = Number(valore);
  return Number.isInteger(n) && n >= 100 ? n : RICHIESTE_MESE_PREDEFINITE;
}

/** Ogni quanti minuti leggere `punti` punti per stare in `quota` richieste al mese. */
export function intervalloTrafficoMin(punti: number, quota: number): number {
  if (punti <= 0) return 60;
  return Math.max(INTERVALLO_MINIMO_MIN, Math.ceil((punti * MINUTI_MESE) / quota));
}

/** Fra quanto fare la prima lettura dopo l'avvio: un intervallo dopo l'ultima registrata. */
export function primaLetturaTraMs(ultima: Date | null, intervalloMin: number, ora = Date.now()): number {
  if (!ultima) return PRIMA_LETTURA_MINIMA_MS;
  return Math.max(PRIMA_LETTURA_MINIMA_MS, ultima.getTime() + intervalloMin * 60_000 - ora);
}

async function ultimaLettura(): Promise<Date | null> {
  const r = await db.execute(sql`SELECT max(captured_at) AS ultima FROM traffic_snapshots`);
  const v = (r.rows[0] as any)?.ultima;
  return v ? new Date(v) : null;
}

/** Le letture periodiche del traffico, dentro la quota. Restituisce lo stop. */
export async function avviaTraffico(log: Log): Promise<() => void> {
  const quota = richiesteMese();
  let timer: NodeJS.Timeout | null = null;
  let fermo = false;

  const intervalloOra = async () => intervalloTrafficoMin((await leggiLuoghi("traffico")).length, quota);

  const leggi = async () => {
    let intervallo = 60;
    try {
      const r = await inSistema("timer:traffico", () => syncTrafficFromTomTom());
      intervallo = await intervalloOra();
      log.info({ ...r, prossimaTraMin: intervallo }, "Traffic auto-sync: done");
      if (r.inserted === 0 && r.rifiuti["403"]) {
        log.warn({ rifiuti: r.rifiuti, motivo: r.motivo },
          "Traffico: TomTom rifiuta le richieste (403). Di solito è la quota del mese finita (si azzera il 1°) oppure la chiave non valida: guarda la Dashboard di TomTom e TRAFFICO_RICHIESTE_MESE");
      }
    } catch (err) {
      log.error(err, "Traffic auto-sync: failed");
      try { intervallo = await intervalloOra(); } catch { /* resta 60 */ }
    }
    if (!fermo) { timer = setTimeout(leggi, intervallo * 60_000); timer.unref?.(); }
  };

  try {
    const [punti, ultima] = await Promise.all([leggiLuoghi("traffico").then((l) => l.length), ultimaLettura()]);
    const intervallo = intervalloTrafficoMin(punti, quota);
    const tra = primaLetturaTraMs(ultima, intervallo);
    timer = setTimeout(leggi, tra);
    log.info({ punti, quotaMese: quota, ogniMin: intervallo, primaTraMin: Math.round(tra / 60_000) },
      `Traffic auto-sync: ogni ${intervallo} min (${punti} punti, ~${punti * Math.round(MINUTI_MESE / intervallo)} richieste in un mese di 31 giorni, quota ${quota})`);
  } catch (err) {
    // database non ancora pronto: si riprova fra un'ora, poi l'intervallo si ricalcola da solo
    log.warn({ err: String(err) }, "Traffic auto-sync: punti o ultima lettura non leggibili, prima lettura fra 60 min");
    timer = setTimeout(leggi, 60 * 60_000);
  }
  timer.unref?.();
  return () => { fermo = true; if (timer) clearTimeout(timer); };
}
