/**
 * Il numero di vetture di uno scenario turni macchina, letto dal JSON del
 * risultato. Gli ottimizzatori scrivono summary.totalVehicles
 * (routes/service-program.ts); le liste leggevano summary.numVehicles, che
 * nessuno scrive, e mostravano sempre vuoto. numVehicles resta come
 * ripiego, e per ultimo si contano i turni (un turno = una vettura).
 */
import { sql, type SQL } from "drizzle-orm";

export function numeroVettureSql(result: SQL): SQL {
  return sql`COALESCE(
    (${result}->'summary'->>'totalVehicles')::int,
    (${result}->'summary'->>'numVehicles')::int,
    CASE WHEN jsonb_typeof(${result}->'shifts') = 'array' THEN jsonb_array_length(${result}->'shifts') END)`;
}
