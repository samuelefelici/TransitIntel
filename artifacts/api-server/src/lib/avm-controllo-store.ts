/**
 * ═══════════════════════════════════════════════════════════════════════════
 * L'ARCHIVIO DEI CONTROLLI SETTIMANALI DELL'AVM
 * ───────────────────────────────────────────────────────────────────────────
 * Una riga per settimana chiusa, con il controllo come è stato calcolato il
 * lunedì dopo. Il diario resta e si può sempre ricalcolare; l'archivio serve
 * a un'altra cosa: congela anche quello che l'officina diceva in quel
 * momento (fermi, segnalazioni, interventi), che una settimana dopo è già
 * cambiato. Chi rilegge il controllo di tre settimane fa deve vedere quello
 * che si vedeva allora, non quello che si sa oggi.
 *
 * Come il diario: la tabella si crea da sé al primo bisogno (lo schema
 * caronte esiste già, e CREATE SCHEMA IF NOT EXISTS fallisce per permessi
 * anche quando c'è), e se non si può creare l'archivio si spegne senza
 * toccare il resto.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { ControlloSettimanale, Categoria } from "./avm-controllo.js";

let pronto: Promise<boolean> | null = null;
let ultimoErrore: string | null = null;

export function erroreArchivioControlli(): string | null { return ultimoErrore; }

async function crea(): Promise<boolean> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS caronte.avm_controllo_settimanale (
        /* il lunedì della settimana controllata */
        settimana date PRIMARY KEY,
        generato_il timestamptz NOT NULL DEFAULT now(),
        /* VERSIONE_CONTROLLO del calcolo che l'ha prodotta */
        versione integer NOT NULL,
        dati jsonb NOT NULL)`);
    ultimoErrore = null;
    return true;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] archivio dei controlli AVM non attivo:", ultimoErrore);
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

/**
 * Salva il controllo di una settimana. Di base non sovrascrive: il primo
 * calcolo dopo la chiusura è quello che resta. Con `sovrascrivi` si rifà
 * (per esempio dopo aver corretto un errore di calcolo).
 * Restituisce true se ha scritto.
 */
export async function salvaControllo(c: ControlloSettimanale, sovrascrivi = false): Promise<boolean> {
  if (!(await assicura())) return false;
  try {
    const dati = JSON.stringify(c);
    const r = sovrascrivi
      ? await db.execute(sql`
          INSERT INTO caronte.avm_controllo_settimanale (settimana, generato_il, versione, dati)
          VALUES (${c.settimana.lunedi}::date, ${c.generatoIl}::timestamptz, ${c.versione}, ${dati}::jsonb)
          ON CONFLICT (settimana) DO UPDATE
            SET generato_il = EXCLUDED.generato_il, versione = EXCLUDED.versione, dati = EXCLUDED.dati
          RETURNING settimana`)
      : await db.execute(sql`
          INSERT INTO caronte.avm_controllo_settimanale (settimana, generato_il, versione, dati)
          VALUES (${c.settimana.lunedi}::date, ${c.generatoIl}::timestamptz, ${c.versione}, ${dati}::jsonb)
          ON CONFLICT (settimana) DO NOTHING
          RETURNING settimana`);
    ultimoErrore = null;
    return (((r as any).rows ?? []) as unknown[]).length > 0;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] controllo AVM non archiviato:", ultimoErrore);
    return false;
  }
}

/** Il controllo archiviato di una settimana, se c'è. */
export async function leggiControllo(lunedi: string): Promise<ControlloSettimanale | null> {
  if (!(await assicura())) return null;
  try {
    const r = await db.execute<any>(sql`
      SELECT dati FROM caronte.avm_controllo_settimanale WHERE settimana = ${lunedi}::date`);
    const riga = ((r as any).rows ?? [])[0];
    if (!riga) return null;
    return (typeof riga.dati === "string" ? JSON.parse(riga.dati) : riga.dati) as ControlloSettimanale;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return null;
  }
}

export interface VoceArchivio {
  lunedi: string;
  generatoIl: string;
  versione: number;
  /** su tutto il flusso */
  conteggi: Partial<Record<Categoria, number>>;
  /** solo Conerobus, escluse fuori parco e dismesse: il perimetro di base della pagina */
  conteggiConerobus: Partial<Record<Categoria, number>>;
}

/** Le settimane archiviate, dalla più recente. */
export async function elencoControlli(limite = 26): Promise<VoceArchivio[]> {
  if (!(await assicura())) return [];
  try {
    const r = await db.execute<any>(sql`
      SELECT to_char(settimana, 'YYYY-MM-DD') AS lunedi, generato_il, versione,
             dati -> 'conteggi' AS conteggi,
             /* gli stessi conteggi sul perimetro che la pagina mostra di base:
                solo Conerobus (matricola di 1-4 cifre) e non escluse dall'officina */
             (SELECT coalesce(jsonb_object_agg(cat, n), '{}'::jsonb) FROM (
                SELECT v ->> 'categoria' AS cat, count(*) AS n
                  FROM jsonb_array_elements(dati -> 'vetture') v
                 WHERE v ->> 'vehicleRef' ~ '^[0-9]{1,4}$'
                   AND jsonb_typeof(coalesce(v -> 'esclusa', 'null'::jsonb)) = 'null'
                 GROUP BY 1) x) AS conteggi_conerobus
        FROM caronte.avm_controllo_settimanale
       ORDER BY settimana DESC
       LIMIT ${limite}`);
    return ((r as any).rows ?? []).map((x: any): VoceArchivio => ({
      lunedi: String(x.lunedi),
      generatoIl: new Date(x.generato_il).toISOString(),
      versione: Number(x.versione),
      conteggi: (typeof x.conteggi === "string" ? JSON.parse(x.conteggi) : x.conteggi) ?? {},
      conteggiConerobus: Object.fromEntries(Object.entries(
        (typeof x.conteggi_conerobus === "string" ? JSON.parse(x.conteggi_conerobus) : x.conteggi_conerobus) ?? {})
        .map(([k, n]) => [k, Number(n)])),
    }));
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return [];
  }
}

/** Le settimane già archiviate a partire da un lunedì (compreso). */
export async function settimaneArchiviate(daLunedi: string): Promise<Set<string>> {
  if (!(await assicura())) return new Set();
  try {
    const r = await db.execute<any>(sql`
      SELECT to_char(settimana, 'YYYY-MM-DD') AS lunedi
        FROM caronte.avm_controllo_settimanale WHERE settimana >= ${daLunedi}::date`);
    return new Set(((r as any).rows ?? []).map((x: any) => String(x.lunedi)));
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return new Set();
  }
}

/** Le settimane archiviate con un calcolo più vecchio di `versione`. */
export async function settimaneVersioneVecchia(daLunedi: string, versione: number): Promise<string[]> {
  if (!(await assicura())) return [];
  try {
    const r = await db.execute<any>(sql`
      SELECT to_char(settimana, 'YYYY-MM-DD') AS lunedi
        FROM caronte.avm_controllo_settimanale
       WHERE settimana >= ${daLunedi}::date AND versione < ${versione}
       ORDER BY settimana`);
    return ((r as any).rows ?? []).map((x: any) => String(x.lunedi));
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return [];
  }
}

/**
 * Le settimane archiviate senza i dati dell'officina o senza gli interventi
 * (FleetCare non leggibile quando sono state calcolate): l'archivio le rifà
 * appena FleetCare torna leggibile.
 */
export async function settimaneIncomplete(daLunedi: string): Promise<string[]> {
  if (!(await assicura())) return [];
  try {
    const r = await db.execute<any>(sql`
      SELECT to_char(settimana, 'YYYY-MM-DD') AS lunedi
        FROM caronte.avm_controllo_settimanale
       WHERE settimana >= ${daLunedi}::date
         AND (coalesce(dati -> 'officina' ->> 'disponibile', 'false') = 'false'
              OR coalesce(dati -> 'fonteInterventi' ->> 'disponibile', 'false') = 'false')
       ORDER BY settimana`);
    return ((r as any).rows ?? []).map((x: any) => String(x.lunedi));
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return [];
  }
}
