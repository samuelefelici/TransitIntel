/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Schema `caronte` — allineamento idempotente
 * ───────────────────────────────────────────────────────────────────────────
 * Le tabelle dell'esercizio (posizioni mezzi, corse attive, transiti alle
 * fermate) nascono da file di migrazione lanciati a mano, e una di esse —
 * `stop_transits` — può preesistere perché creata dal sistema AVM esterno.
 * Basta quindi che una migrazione non venga applicata perché la tabella ci
 * sia ma le manchi una colonna.
 *
 * È una combinazione che inganna: `to_regclass` trova la tabella e il
 * software conclude che l'esercizio sia disponibile, poi la prima query
 * muore con "column does not exist" e la Sala Operativa risponde 500 con la
 * mappa vuota. Nel frattempo anche le SCRITTURE falliscono per la stessa
 * ragione, quindi non si accumulano dati: due sintomi, una causa sola.
 *
 * Qui le colonne mancanti si aggiungono da sole, come già fanno la matrice
 * di validità di Planner Studio e il materializzatore GTFS. Tutto è
 * `IF NOT EXISTS`: su un database già allineato non cambia nulla, e i dati
 * esistenti non vengono toccati.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

let ensured: Promise<CaronteSchemaState> | null = null;

export interface CaronteSchemaState {
  /** true = le tre tabelle esistono con tutte le colonne attese */
  ready: boolean;
  /** colonne/tabelle create adesso: se non è vuoto, il database era indietro */
  applied: string[];
  /** perché non è stato possibile allineare (di norma: permessi mancanti) */
  error: string | null;
}

/**
 * Allinea lo schema una sola volta per processo.
 * NON rilancia: un ruolo senza permessi di CREATE/ALTER non deve impedire
 * l'avvio del server né far fallire una richiesta di sola lettura — si
 * riporta l'errore e chi legge decide cosa dire all'utente.
 */
export function ensureCaronteSchema(): Promise<CaronteSchemaState> {
  if (!ensured) ensured = run();
  return ensured;
}

/** Solo per i test e per un riallineamento esplicito dopo una migrazione. */
export function resetCaronteSchemaCache(): void {
  ensured = null;
}

async function run(): Promise<CaronteSchemaState> {
  const applied: string[] = [];
  try {
    const before = await missingColumns();

    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS caronte`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS caronte.vehicle_positions (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        vehicle_id      text,
        trip_id         text,
        ts              timestamptz NOT NULL DEFAULT now(),
        lat             double precision NOT NULL,
        lon             double precision NOT NULL,
        nearest_stop_id text,
        speed           double precision,
        heading         double precision
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS caronte.active_trips (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id    text,
        route_id   text,
        vehicle_id text,
        device_id  text,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at   timestamptz
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS caronte.stop_transits (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trip_id       text,
        route_id      text,
        vehicle_id    text,
        device_id     text,
        stop_id       text NOT NULL,
        stop_seq      integer,
        scheduled     text,
        actual_ts     timestamptz NOT NULL DEFAULT now(),
        delay_seconds integer,
        lat           double precision,
        lon           double precision
      )`);

    /* Il caso che rompe davvero: tabella preesistente a cui manca una colonna
     * aggiunta da una migrazione successiva. `CREATE TABLE IF NOT EXISTS` non
     * la aggiunge — serve un ALTER esplicito per ciascuna. */
    for (const [table, column, type] of COLUMNS) {
      await db.execute(sql`
        ALTER TABLE ${sql.raw(`caronte.${table}`)}
        ADD COLUMN IF NOT EXISTS ${sql.raw(column)} ${sql.raw(type)}`);
    }

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_caronte_vpos_vehicle_ts
        ON caronte.vehicle_positions(vehicle_id, ts DESC)`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_caronte_vpos_ts
        ON caronte.vehicle_positions(ts)`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_caronte_transit_trip
        ON caronte.stop_transits(trip_id)`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_caronte_transit_ts
        ON caronte.stop_transits(actual_ts)`);

    /* Si dichiara solo ciò che MANCAVA prima: così il log dice se il database
     * era indietro, invece di ripetere a ogni avvio l'elenco delle colonne. */
    applied.push(...before);
    if (applied.length > 0) {
      console.warn(
        `[caronte] schema allineato: mancavano ${applied.join(", ")} `
        + "(migrazione non applicata). Sala Operativa e transiti erano fermi per questo.",
      );
    }
    return { ready: (await missingColumns()).length === 0, applied, error: null };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error("[caronte] impossibile allineare lo schema:", msg);
    return { ready: false, applied, error: msg };
  }
}

/** Colonne che una migrazione successiva ha aggiunto a tabelle già esistenti. */
const COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["vehicle_positions", "heading", "double precision"],
  ["vehicle_positions", "speed", "double precision"],
  ["vehicle_positions", "nearest_stop_id", "text"],
  ["stop_transits", "stop_seq", "integer"],
  ["stop_transits", "scheduled", "text"],
  ["stop_transits", "delay_seconds", "integer"],
  ["stop_transits", "route_id", "text"],
  ["stop_transits", "vehicle_id", "text"],
  ["stop_transits", "device_id", "text"],
  ["stop_transits", "lat", "double precision"],
  ["stop_transits", "lon", "double precision"],
  ["active_trips", "device_id", "text"],
  ["active_trips", "route_id", "text"],
];

/** Che cosa manca ADESSO, tabella per tabella: è la diagnosi in chiaro. */
export async function missingColumns(): Promise<string[]> {
  try {
    const r = await db.execute<any>(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'caronte'`);
    const have = new Set<string>();
    const tables = new Set<string>();
    for (const x of ((r as any).rows ?? [])) {
      have.add(`${x.table_name}.${x.column_name}`);
      tables.add(String(x.table_name));
    }
    const missing: string[] = [];
    for (const t of ["vehicle_positions", "active_trips", "stop_transits"]) {
      if (!tables.has(t)) { missing.push(`caronte.${t} (tabella)`); continue; }
      for (const [table, column] of COLUMNS) {
        if (table === t && !have.has(`${t}.${column}`)) missing.push(`caronte.${t}.${column}`);
      }
    }
    return missing;
  } catch {
    return [];
  }
}
