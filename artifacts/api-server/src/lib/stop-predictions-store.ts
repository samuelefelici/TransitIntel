/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE PREVISIONI DI MIZAR ALLE FERMATE — conservate a parte dai transiti
 * ───────────────────────────────────────────────────────────────────────────
 * Lo StopMonitoring dice, per un mezzo seguito, a che ora PASSERÀ dalle
 * prossime fermate. È una previsione: cambia a ogni giro, e a mezzo passato
 * sparisce. Non è un transito, e non deve mai finire in `stop_transits`,
 * da cui tempi di percorrenza, puntualità e anomalie prendono i loro numeri:
 * un'ora prevista letta come ora osservata falserebbe tutto ciò che sta a
 * valle.
 *
 * Per questo ha una tabella sua. Una riga per (giornata, corsa, fermata):
 * l'ultima previsione e la PRIMA, così quando il passaggio osservato arriva
 * si potrà misurare quanto la previsione di Mizar ci aveva preso.
 *
 * Come per le coppie di codici: la tabella si crea da sé al primo bisogno,
 * e se il database non concede la raccolta si spegne senza fermare il giro.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface PrevisioneFermata {
  tripId: string;
  stopId: string;
  /** il codice palina di Mizar da cui la previsione è arrivata */
  mizarRef: string;
  vehicleRef: string | null;
  lineRef: string | null;
  /** programmato secondo Mizar */
  aimedTs: Date | null;
  /** previsto (partenza, o arrivo se manca) */
  expectedTs: Date;
  /** "onTime", "delayed", "early"… come lo dice Mizar */
  stato: string | null;
  /** quando l'AVM ha registrato il dato da cui nasce la previsione */
  recordedAt: Date | null;
}

let pronto: Promise<boolean> | null = null;
let ultimoErrore: string | null = null;

export function errorePrevisioni(): string | null { return ultimoErrore; }

async function crea(): Promise<boolean> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS caronte.stop_predictions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        day date NOT NULL,
        trip_id text NOT NULL,
        stop_id text NOT NULL,
        mizar_ref text NOT NULL,
        vehicle_ref text, line_ref text,
        aimed_ts timestamptz,
        expected_ts timestamptz NOT NULL,
        /* la prima previsione ricevuta: il termine di confronto per misurare
         * l'affidabilità quando arriva il passaggio osservato */
        expected_first_ts timestamptz NOT NULL,
        status text,
        recorded_at timestamptz,
        observations integer NOT NULL DEFAULT 1,
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_seen timestamptz NOT NULL DEFAULT now())`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_caronte_stop_pred_key
        ON caronte.stop_predictions(day, trip_id, stop_id)`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_caronte_stop_pred_trip
        ON caronte.stop_predictions(trip_id, day)`);
    ultimoErrore = null;
    return true;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] previsioni alle fermate non attive:", ultimoErrore);
    return false;
  }
}

function assicura(): Promise<boolean> {
  if (!pronto) {
    pronto = crea().then(ok => { if (!ok) pronto = null; return ok; })
      .catch(() => { pronto = null; return false; });
  }
  return pronto;
}

/** Scrive o aggiorna le previsioni di un giro. Duplicati nel giro: l'ultimo vince. */
export async function registraPrevisioni(giorno: string, previsioni: PrevisioneFermata[]): Promise<number> {
  if (!previsioni.length) return 0;
  if (!(await assicura())) return 0;
  const per = new Map<string, PrevisioneFermata>();
  for (const p of previsioni) per.set(`${p.tripId}|${p.stopId}`, p);
  try {
    const righe = [...per.values()].map(p => sql`(
      ${giorno}::date, ${p.tripId}, ${p.stopId}, ${p.mizarRef}, ${p.vehicleRef}, ${p.lineRef},
      ${p.aimedTs ? p.aimedTs.toISOString() : null}::timestamptz,
      ${p.expectedTs.toISOString()}::timestamptz, ${p.expectedTs.toISOString()}::timestamptz,
      ${p.stato}, ${p.recordedAt ? p.recordedAt.toISOString() : null}::timestamptz)`);
    await db.execute(sql`
      INSERT INTO caronte.stop_predictions
        (day, trip_id, stop_id, mizar_ref, vehicle_ref, line_ref, aimed_ts, expected_ts, expected_first_ts, status, recorded_at)
      VALUES ${sql.join(righe, sql`, `)}
      ON CONFLICT (day, trip_id, stop_id) DO UPDATE SET
        expected_ts = EXCLUDED.expected_ts,
        status = EXCLUDED.status,
        recorded_at = COALESCE(EXCLUDED.recorded_at, caronte.stop_predictions.recorded_at),
        vehicle_ref = COALESCE(EXCLUDED.vehicle_ref, caronte.stop_predictions.vehicle_ref),
        aimed_ts = COALESCE(caronte.stop_predictions.aimed_ts, EXCLUDED.aimed_ts),
        observations = caronte.stop_predictions.observations + 1,
        last_seen = now()`);
    ultimoErrore = null;
    return per.size;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] previsioni alle fermate non registrate:", ultimoErrore);
    return 0;
  }
}

export interface PrevisioneLetta {
  stopId: string;
  mizarRef: string;
  expectedTs: string;
  expectedFirstTs: string;
  aimedTs: string | null;
  stato: string | null;
  aggiornataAlle: string;
  osservazioni: number;
}

/** Le previsioni di una corsa nella giornata, fermata per fermata. */
export async function leggiPrevisioniCorsa(giorno: string, tripId: string): Promise<Map<string, PrevisioneLetta>> {
  const out = new Map<string, PrevisioneLetta>();
  try {
    const r = await db.execute<any>(sql`
      SELECT stop_id, mizar_ref, expected_ts, expected_first_ts, aimed_ts, status, last_seen, observations
        FROM caronte.stop_predictions
       WHERE day = ${giorno}::date AND trip_id = ${tripId}`);
    for (const x of ((r as any).rows ?? [])) {
      out.set(String(x.stop_id), {
        stopId: String(x.stop_id), mizarRef: String(x.mizar_ref),
        expectedTs: new Date(x.expected_ts).toISOString(),
        expectedFirstTs: new Date(x.expected_first_ts).toISOString(),
        aimedTs: x.aimed_ts ? new Date(x.aimed_ts).toISOString() : null,
        stato: x.status ?? null,
        aggiornataAlle: new Date(x.last_seen).toISOString(),
        osservazioni: Number(x.observations ?? 1),
      });
    }
  } catch (e: any) {
    /* Tabella assente = nessuna previsione ancora raccolta: non è un errore
     * della pagina, che continua con le sole misure. */
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
  }
  return out;
}

export function resetStopPredictionsCache(): void { pronto = null; ultimoErrore = null; }
