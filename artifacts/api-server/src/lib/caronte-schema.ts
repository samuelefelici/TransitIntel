/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Schema `caronte` — rilevazione
 * ───────────────────────────────────────────────────────────────────────────
 * Le tabelle dell'esercizio nascono dalle migrazioni (lib/db/migrations), ma
 * alcune possono preesistere perché create dal sistema AVM esterno, e il
 * baseline non tocca una tabella che c'è già. Così una tabella può esserci ma
 * mancarle una colonna: `to_regclass` la trova, il software conclude che
 * l'esercizio sia disponibile, e la prima query muore con "column does not
 * exist".
 *
 * schemaState() dice che cosa manca, in SOLA LETTURA: si può chiamare da
 * qualunque percorso, comprese le repliche di lettura. Se manca qualcosa il
 * connettore non scrive e lo dice; a sistemare lo schema è una migrazione,
 * mai l'app (che non esegue DDL).
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

/* ── La chiave primaria che non si genera da sola ─────────────────────────
 * `caronte.active_trips.id` è uuid NOT NULL SENZA valore predefinito, mentre
 * le altre due tabelle hanno `gen_random_uuid()`. Un INSERT che non elenca
 * `id` — cioè il nostro — riceve NULL e viene rifiutato con 23502. La tabella
 * è nata così dal sistema AVM, che l'id se lo calcola da sé.
 *
 * Si legge la struttura invece di presumerla: dove il valore predefinito c'è,
 * o dove `id` non è un uuid, non si tocca niente. */
const idCheck = new Map<string, { ok: boolean; at: number }>();

export async function idNeedsValue(table: string): Promise<boolean> {
  const c = idCheck.get(table);
  if (c && Date.now() - c.at < 60_000) return c.ok;
  const cols = await tableShape(table);
  const id = cols.find(x => x.colonna === "id");
  /* Struttura non leggibile: si dice di NO, così il comportamento resta
   * quello di prima invece di introdurre una colonna che potrebbe non
   * accettare un uuid. */
  const ok = !!id && id.obbligatoria && id.predefinito === null && id.tipo === "uuid";
  idCheck.set(table, { ok, at: Date.now() });
  return ok;
}

/* ── Lo stato una volta per processo, sul percorso di SCRITTURA ─────────────
 * Finché lo schema non è allineato si rilegge a ogni giro: quando arriva la
 * migrazione che mancava, il connettore riparte da solo. */
let allineato: Promise<CaronteSchemaState> | null = null;

export function schemaPerScrivere(): Promise<CaronteSchemaState> {
  if (!allineato) {
    allineato = schemaState().then(s => {
      if (!s.ready) allineato = null; // non allineato: si rileggerà
      return s;
    }).catch(e => {
      allineato = null;
      throw e;
    });
  }
  return allineato;
}

/** Per i test e per un riallineamento esplicito dopo una migrazione. */
export function resetCaronteSchemaCache(): void {
  allineato = null;
  sourceCheck = null;
  idCheck.clear();
}
