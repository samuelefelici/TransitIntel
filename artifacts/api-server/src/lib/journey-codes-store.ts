/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA RACCOLTA DELLE COPPIE DI CODICI
 * ───────────────────────────────────────────────────────────────────────────
 * Ogni giro l'aggancio per linea + ora di partenza produce, senza volerlo, la
 * cosa che serve per risolvere il disallineamento fra i due codici: la coppia
 * «codice dell'AVM ↔ corsa del GTFS». Finora quella coppia viveva il tempo di
 * un giro e poi spariva.
 *
 * Qui si conserva. Non le singole letture — sarebbero decine di migliaia al
 * giorno e non direbbero niente di più — ma le coppie DISTINTE per giornata,
 * con quante volte sono state viste. Poche righe al giorno.
 *
 * ── Perché due tabelle ──
 *
 * `journey_codes` tiene le coppie. `journey_code_days` tiene i totali del
 * giro: quanti mezzi c'erano e quanti dichiaravano un codice. Senza i totali,
 * "abbiamo 17 coppie" non si sa se voglia dire che il collegamento va male o
 * che l'AVM il codice lo manda solo su 17 mezzi. Sono due diagnosi opposte e
 * il rimedio è diverso.
 *
 * ── Se il database non risponde ──
 *
 * La raccolta è un di più: se la scrittura fallisce (database fermo, tabella
 * non ancora migrata) non deve fermare né l'ingestione né la Sala Operativa.
 * Si registra il motivo e si va avanti senza.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { CoppiaCodici } from "./journey-code-study";

/** Quello che l'AVM dichiara e quello a cui l'abbiamo attribuito, in un giro. */
export interface OsservazioneCodice {
  journeyRef: string;
  tripId: string | null;
  agganciatoCome: "id" | "orario" | null;
  vehicleRef: string | null;
  lineRef: string | null;
  publishedLineName: string | null;
  routeRef: string | null;
  courseRef: string | null;
  framedRef: string | null;
  dataFrameRef: string | null;
  patternRef: string | null;
  blockRef: string | null;
  /** partenza dichiarata dall'AVM, "HH:MM" nell'ora dell'azienda */
  partenzaAvm: string | null;
  destinazioneAvm: string | null;
  /** dal feed, per la corsa agganciata */
  routeId: string | null;
  partenzaGtfs: string | null;
  capolineaGtfs: string | null;
}

/** I totali del giro: danno il denominatore alle coppie. */
export interface TotaliGiro {
  mezzi: number;
  conCodice: number;
  agganciati: number;
  agganciatiPerId: number;
}

/* ── La tabella ───────────────────────────────────────────────────────────
 * La creano le migrazioni. L'ultimo errore di scrittura si ricorda solo
 * finché la scrittura dopo non riesce. */

let ultimoErrore: string | null = null;

/** Perché la raccolta non sta funzionando, quando non funziona. */
export function erroreRaccolta(): string | null {
  return ultimoErrore;
}

/* ── Scrittura ────────────────────────────────────────────────────────────── */

/**
 * Registra le coppie di un giro. Le ripetizioni dentro lo stesso giro si
 * sommano PRIMA di scrivere: un `ON CONFLICT` non può toccare due volte la
 * stessa riga nella stessa istruzione, e due mezzi che dichiarano lo stesso
 * codice — che capita — farebbero fallire l'intero inserimento.
 */
export async function registraCodici(
  giorno: string, osservazioni: OsservazioneCodice[], totali: TotaliGiro,
): Promise<number> {

  const per = new Map<string, { o: OsservazioneCodice; n: number }>();
  for (const o of osservazioni) {
    if (!o.journeyRef) continue;
    const k = `${o.journeyRef}\u0000${o.tripId ?? ""}`;
    const v = per.get(k);
    if (v) v.n++; else per.set(k, { o, n: 1 });
  }

  try {
    if (per.size > 0) {
      const righe = [...per.values()].map(({ o, n }) => sql`(
        ${giorno}::date, ${o.journeyRef}, ${o.tripId ?? ""}, ${o.agganciatoCome},
        ${o.vehicleRef}, ${o.lineRef}, ${o.publishedLineName}, ${o.routeRef},
        ${o.courseRef}, ${o.framedRef}, ${o.dataFrameRef}, ${o.patternRef},
        ${o.blockRef}, ${o.partenzaAvm}, ${o.destinazioneAvm},
        ${o.routeId}, ${o.partenzaGtfs}, ${o.capolineaGtfs}, ${n})`);
      await db.execute(sql`
        INSERT INTO caronte.journey_codes (
          day, journey_ref, trip_id, matched_by,
          vehicle_ref, line_ref, published_line_name, route_ref,
          course_ref, framed_ref, data_frame_ref, pattern_ref,
          block_ref, avm_departure, avm_destination,
          route_id, gtfs_departure, gtfs_headsign, observations)
        VALUES ${sql.join(righe, sql`, `)}
        ON CONFLICT (day, journey_ref, trip_id) DO UPDATE SET
          observations = caronte.journey_codes.observations + EXCLUDED.observations,
          last_seen = now(),
          /* I campi di contorno si aggiornano solo se prima erano vuoti: la
           * prima lettura di una corsa è la più completa, le successive
           * possono perdere pezzi quando il mezzo esce dalla copertura. */
          matched_by = COALESCE(caronte.journey_codes.matched_by, EXCLUDED.matched_by),
          route_id = COALESCE(caronte.journey_codes.route_id, EXCLUDED.route_id),
          gtfs_departure = COALESCE(caronte.journey_codes.gtfs_departure, EXCLUDED.gtfs_departure),
          gtfs_headsign = COALESCE(caronte.journey_codes.gtfs_headsign, EXCLUDED.gtfs_headsign),
          avm_departure = COALESCE(caronte.journey_codes.avm_departure, EXCLUDED.avm_departure),
          avm_destination = COALESCE(caronte.journey_codes.avm_destination, EXCLUDED.avm_destination)`);
    }

    await db.execute(sql`
      INSERT INTO caronte.journey_code_days
        (day, rounds, vehicles, with_code, matched, matched_by_id)
      VALUES (${giorno}::date, 1, ${totali.mezzi}, ${totali.conCodice},
              ${totali.agganciati}, ${totali.agganciatiPerId})
      ON CONFLICT (day) DO UPDATE SET
        rounds = caronte.journey_code_days.rounds + 1,
        vehicles = caronte.journey_code_days.vehicles + EXCLUDED.vehicles,
        with_code = caronte.journey_code_days.with_code + EXCLUDED.with_code,
        matched = caronte.journey_code_days.matched + EXCLUDED.matched,
        matched_by_id = caronte.journey_code_days.matched_by_id + EXCLUDED.matched_by_id,
        updated_at = now()`);
    ultimoErrore = null;
    return per.size;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] coppie di codici non registrate:", ultimoErrore);
    return 0;
  }
}

/* ── Lettura ──────────────────────────────────────────────────────────────── */

export interface RigaCodice extends CoppiaCodici {
  vehicleRef: string | null;
  lineRef: string | null;
  publishedLineName: string | null;
  routeRef: string | null;
  blockRef: string | null;
  partenzaAvm: string | null;
  destinazioneAvm: string | null;
  routeId: string | null;
  partenzaGtfs: string | null;
  capolineaGtfs: string | null;
  vistoLaPrimaVolta: string;
  vistoLUltimaVolta: string;
}

export interface GiornataCodici {
  giorno: string;
  giri: number;
  /** media per giro: i totali si accumulano a ogni giro, qui si dividono */
  mezziPerGiro: number;
  conCodicePerGiro: number;
  agganciatiPerGiro: number;
  /** quota dei mezzi che dichiarano un identificativo di corsa */
  quotaConCodice: number;
}

export async function leggiCodici(giorni: number): Promise<{
  righe: RigaCodice[]; giornate: GiornataCodici[]; disponibile: boolean;
}> {
  try {
    const r = await db.execute<any>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS giorno, journey_ref, trip_id, matched_by,
             vehicle_ref, line_ref, published_line_name, route_ref, block_ref,
             avm_departure, avm_destination, route_id, gtfs_departure, gtfs_headsign,
             observations, first_seen, last_seen
        FROM caronte.journey_codes
       WHERE day > (now() AT TIME ZONE 'UTC')::date - ${giorni}::int
       ORDER BY day DESC, journey_ref
       LIMIT 20000`);
    const d = await db.execute<any>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS giorno, rounds, vehicles, with_code,
             matched, matched_by_id
        FROM caronte.journey_code_days
       WHERE day > (now() AT TIME ZONE 'UTC')::date - ${giorni}::int
       ORDER BY day DESC`);

    const righe: RigaCodice[] = ((r as any).rows ?? []).map((x: any) => ({
      giorno: String(x.giorno),
      journeyRef: String(x.journey_ref),
      tripId: x.trip_id ? String(x.trip_id) : null,
      agganciatoCome: (x.matched_by ?? null) as RigaCodice["agganciatoCome"],
      osservazioni: Number(x.observations ?? 0),
      vehicleRef: x.vehicle_ref ?? null,
      lineRef: x.line_ref ?? null,
      publishedLineName: x.published_line_name ?? null,
      routeRef: x.route_ref ?? null,
      blockRef: x.block_ref ?? null,
      partenzaAvm: x.avm_departure ?? null,
      destinazioneAvm: x.avm_destination ?? null,
      routeId: x.route_id ?? null,
      partenzaGtfs: x.gtfs_departure ?? null,
      capolineaGtfs: x.gtfs_headsign ?? null,
      vistoLaPrimaVolta: new Date(x.first_seen).toISOString(),
      vistoLUltimaVolta: new Date(x.last_seen).toISOString(),
    }));

    const giornate: GiornataCodici[] = ((d as any).rows ?? []).map((x: any) => {
      const giri = Math.max(1, Number(x.rounds ?? 1));
      const mezzi = Number(x.vehicles ?? 0) / giri;
      return {
        giorno: String(x.giorno),
        giri: Number(x.rounds ?? 0),
        mezziPerGiro: Math.round(mezzi * 10) / 10,
        conCodicePerGiro: Math.round((Number(x.with_code ?? 0) / giri) * 10) / 10,
        agganciatiPerGiro: Math.round((Number(x.matched ?? 0) / giri) * 10) / 10,
        quotaConCodice: mezzi > 0 ? (Number(x.with_code ?? 0) / giri) / mezzi : 0,
      };
    });

    return { righe, giornate, disponibile: true };
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return { righe: [], giornate: [], disponibile: false };
  }
}

/** Per i collaudi e per un riallineamento esplicito. */
export function resetJourneyCodesCache(): void {
  ultimoErrore = null;
}
