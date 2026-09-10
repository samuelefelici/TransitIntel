/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Schema `caronte` — rilevazione e riparazione
 * ───────────────────────────────────────────────────────────────────────────
 * Le tabelle dell'esercizio nascono da migrazioni lanciate a mano, e alcune
 * possono preesistere perché create dal sistema AVM esterno. Basta quindi che
 * una migrazione non venga applicata perché la tabella ci sia ma le manchi una
 * colonna: `to_regclass` la trova, il software conclude che l'esercizio sia
 * disponibile, e la prima query muore con "column does not exist".
 *
 * Due funzioni distinte, e la distinzione è il punto:
 *
 *   schemaState()  — SOLA LETTURA. Dice che cosa manca. Si può chiamare da
 *                    qualunque percorso, comprese le repliche di lettura.
 *   repairSchema() — esegue DDL, ma SOLO se manca davvero qualcosa.
 *
 * Perché la separazione conta. Su un database dove le tabelle appartengono al
 * ruolo dell'AVM, `CREATE SCHEMA IF NOT EXISTS` fallisce con "permission
 * denied" ANCHE SE lo schema esiste già: il controllo dei permessi precede lo
 * skip. Eseguire DDL "tanto è idempotente" romperebbe quindi installazioni
 * che funzionano. E `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` prende un lock
 * ACCESS EXCLUSIVE PRIMA di valutare la condizione: un no-op costa quanto la
 * modifica vera e può restare in attesa dietro un lettore, bloccando insieme
 * le scritture dell'AVM e la Sala Operativa.
 *
 * Perciò: se non manca nulla non si tocca il database; se manca qualcosa si
 * altera solo quello, una istruzione per transazione, con un lock_timeout.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Colonne attese, tabella per tabella. */
const EXPECTED: Record<string, Array<[column: string, type: string]>> = {
  vehicle_positions: [
    ["vehicle_id", "text"], ["trip_id", "text"], ["ts", "timestamptz"],
    ["lat", "double precision"], ["lon", "double precision"],
    ["nearest_stop_id", "text"], ["speed", "double precision"],
    ["heading", "double precision"], ["source", "text"],
  ],
  active_trips: [
    ["trip_id", "text"], ["route_id", "text"], ["vehicle_id", "text"],
    ["device_id", "text"], ["started_at", "timestamptz"], ["ended_at", "timestamptz"],
    ["source", "text"],
  ],
  stop_transits: [
    ["trip_id", "text"], ["route_id", "text"], ["vehicle_id", "text"],
    ["device_id", "text"], ["stop_id", "text"], ["stop_seq", "integer"],
    ["scheduled", "text"], ["actual_ts", "timestamptz"],
    ["delay_seconds", "integer"], ["lat", "double precision"], ["lon", "double precision"],
    ["source", "text"],
  ],
};

/* ── Chi ha scritto la riga ───────────────────────────────────────────────
 * Le tre tabelle sono CONDIVISE: ci scrivono il connettore SIRI e il sistema
 * AVM Caronte. Finché le righe erano indistinguibili, "194 transiti oggi"
 * sembrava dire che il collegamento SIRI funzionasse mentre non aveva mai
 * scritto niente — un guasto nascosto dietro un numero sano.
 *
 * `source` marca l'origine. Il connettore la compila sempre; le righe scritte
 * direttamente dall'AVM restano a NULL, e NULL vale "non SIRI": è il default
 * corretto, perché l'unico a dichiararsi è chi conosce questa convenzione. */
export const SOURCE_SIRI = "siri";

/** Il filtro sull'origine esiste solo se la colonna c'è. */
let sourceCheck: { ok: boolean; at: number } | null = null;

export async function hasSourceColumn(): Promise<boolean> {
  if (sourceCheck && Date.now() - sourceCheck.at < 60_000) return sourceCheck.ok;
  const st = await schemaState();
  /* Stato ignoto: si dice di NO, così i lettori non filtrano e mostrano tutto.
   * Meglio una pagina con dati di troppo che una pagina vuota. */
  const ok = !st.unknown
    && !st.missingColumns.some(c => c.endsWith(".source"))
    && st.missingTables.length === 0;
  sourceCheck = { ok, at: Date.now() };
  return ok;
}

export interface CaronteSchemaState {
  /** true = le tre tabelle esistono con tutte le colonne attese */
  ready: boolean;
  /** tabelle assenti del tutto */
  missingTables: string[];
  /** colonne assenti, in forma "tabella.colonna" */
  missingColumns: string[];
  /** true se la rilevazione stessa non è riuscita: lo stato è IGNOTO, non "a posto" */
  unknown: boolean;
  error: string | null;
}

/**
 * Che cosa c'è davvero, letto da pg_catalog.
 *
 * NON da information_schema: quella vista è filtrata dai privilegi, e un ruolo
 * con GRANT su un sottoinsieme di colonne non vede le altre. Si concluderebbe
 * "colonna mancante" su una colonna esistente, e la Sala Operativa verrebbe
 * dichiarata non disponibile su un database perfettamente sano.
 */
export async function schemaState(): Promise<CaronteSchemaState> {
  try {
    const r = await db.execute<any>(sql`
      SELECT c.relname AS tbl, a.attname AS col
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attribute a
               ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE n.nspname = 'caronte'
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`);

    const present = new Map<string, Set<string>>();
    for (const x of ((r as any).rows ?? [])) {
      const t = String(x.tbl);
      if (!present.has(t)) present.set(t, new Set());
      if (x.col) present.get(t)!.add(String(x.col));
    }

    const missingTables: string[] = [];
    const missingColumns: string[] = [];
    for (const [table, cols] of Object.entries(EXPECTED)) {
      const have = present.get(table);
      if (!have) { missingTables.push(`caronte.${table}`); continue; }
      for (const [col] of cols) {
        if (!have.has(col)) missingColumns.push(`${table}.${col}`);
      }
    }
    return {
      ready: missingTables.length === 0 && missingColumns.length === 0,
      missingTables, missingColumns, unknown: false, error: null,
    };
  } catch (e: any) {
    /* Stato IGNOTO. Non si dichiara "a posto" (nasconderebbe il guasto) né
     * "mancante" (spegnerebbe una pagina sana): chi chiama decide. */
    return {
      ready: false, missingTables: [], missingColumns: [],
      unknown: true, error: e?.message ?? String(e),
    };
  }
}

/**
 * La struttura VERA di una tabella dell'esercizio.
 *
 * `schemaState()` dice solo se mancano le colonne che ci aspettiamo. Ma una
 * tabella creata dal sistema AVM può avere colonne IN PIÙ, dichiarate NOT NULL
 * e senza valore predefinito: il nostro INSERT, che non le elenca, viene
 * rifiutato: e senza vedere la struttura la causa resta invisibile.
 */
export async function tableShape(table: string): Promise<Array<{
  colonna: string; tipo: string; obbligatoria: boolean; predefinito: string | null;
}>> {
  try {
    const r = await db.execute<any>(sql`
      SELECT a.attname AS colonna,
             format_type(a.atttypid, a.atttypmod) AS tipo,
             a.attnotnull AS obbligatoria,
             pg_get_expr(d.adbin, d.adrelid) AS predefinito
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'caronte' AND c.relname = ${table}
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`);
    return ((r as any).rows ?? []).map((x: any) => ({
      colonna: String(x.colonna),
      tipo: String(x.tipo),
      obbligatoria: x.obbligatoria === true,
      predefinito: x.predefinito ?? null,
    }));
  } catch {
    return [];
  }
}

/** Una istruzione DDL isolata: un fallimento non trascina le altre. */
async function ddl(statement: ReturnType<typeof sql>, applied: string[], label: string): Promise<void> {
  try {
    await db.transaction(async (tx: any) => {
      // Un DDL che aspetta dietro un lettore blocca a catena anche l'AVM.
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      await tx.execute(statement);
    });
    applied.push(label);
  } catch (e: any) {
    console.warn(`[caronte] non riparabile (${label}): ${e?.message ?? e}`);
  }
}

export interface RepairResult extends CaronteSchemaState {
  /** che cosa è stato effettivamente creato o aggiunto adesso */
  applied: string[];
  /** true se non c'era nulla da fare: nessun DDL è stato eseguito */
  noop: boolean;
}

/**
 * Ripara ciò che manca. Se non manca nulla NON tocca il database — è il caso
 * normale, ed è ciò che rende sicuro chiamarla anche a ogni avvio.
 */
export async function repairSchema(): Promise<RepairResult> {
  const before = await schemaState();
  if (before.unknown) {
    return { ...before, applied: [], noop: true };
  }
  if (before.ready) {
    return { ...before, applied: [], noop: true };
  }

  const applied: string[] = [];

  if (before.missingTables.length > 0) {
    await ddl(sql`CREATE SCHEMA IF NOT EXISTS caronte`, applied, "schema caronte");
  }
  if (before.missingTables.includes("caronte.vehicle_positions")) {
    await ddl(sql`
      CREATE TABLE IF NOT EXISTS caronte.vehicle_positions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), vehicle_id text, trip_id text,
        ts timestamptz NOT NULL DEFAULT now(),
        lat double precision NOT NULL, lon double precision NOT NULL,
        nearest_stop_id text, speed double precision, heading double precision)`,
      applied, "caronte.vehicle_positions");
  }
  if (before.missingTables.includes("caronte.active_trips")) {
    await ddl(sql`
      CREATE TABLE IF NOT EXISTS caronte.active_trips (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id text, route_id text,
        vehicle_id text, device_id text,
        started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz)`,
      applied, "caronte.active_trips");
  }
  if (before.missingTables.includes("caronte.stop_transits")) {
    await ddl(sql`
      CREATE TABLE IF NOT EXISTS caronte.stop_transits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trip_id text, route_id text,
        vehicle_id text, device_id text, stop_id text NOT NULL, stop_seq integer,
        scheduled text, actual_ts timestamptz NOT NULL DEFAULT now(),
        delay_seconds integer, lat double precision, lon double precision)`,
      applied, "caronte.stop_transits");
  }

  /* Solo le colonne davvero assenti: un ALTER no-op costa un lock esclusivo
   * quanto uno vero, quindi non se ne emette nemmeno uno di troppo. */
  for (const miss of before.missingColumns) {
    const [table, column] = miss.split(".");
    const type = (EXPECTED[table] ?? []).find(([c]) => c === column)?.[1];
    if (!type) continue;
    await ddl(
      sql`ALTER TABLE ${sql.raw(`caronte.${table}`)}
          ADD COLUMN IF NOT EXISTS ${sql.raw(column)} ${sql.raw(type)}`,
      applied, `caronte.${miss}`);
  }

  const after = await schemaState();
  if (applied.length > 0) {
    console.warn(
      `[caronte] schema allineato: ${applied.join(", ")} — mancavano perché una `
      + "migrazione non è stata applicata. Sala Operativa e transiti erano fermi per questo.",
    );
  }
  return { ...after, applied, noop: applied.length === 0 };
}

/* ── Riparazione una volta per processo, sul percorso di SCRITTURA ──────────
 * Un fallimento NON viene memorizzato per sempre: un errore transitorio
 * all'avvio (contesa sul DDL, database non ancora pronto) disabiliterebbe il
 * connettore per tutta la vita del processo. Si ritenta al giro successivo. */
let repaired: Promise<RepairResult> | null = null;

export function ensureCaronteSchema(): Promise<RepairResult> {
  if (!repaired) {
    repaired = repairSchema().then(r => {
      if (!r.ready) repaired = null; // non allineato: si riproverà
      return r;
    }).catch(e => {
      repaired = null;
      throw e;
    });
  }
  return repaired;
}

/** Per i test e per un riallineamento esplicito dopo una migrazione. */
export function resetCaronteSchemaCache(): void {
  repaired = null;
  sourceCheck = null;
}
