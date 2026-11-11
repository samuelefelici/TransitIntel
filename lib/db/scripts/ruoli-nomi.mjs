// I nomi dei ruoli del database di Cerbero (PR 2.8). A parte da
// ruoli-regole.mjs perché li legge anche il lavoratore (lib/identita-db.ts),
// nel cui grafo non deve esserci DDL.

/** Il proprietario delle tabelle di Cerbero: nessuno entra come lui. */
export const PROPRIETARIO = "cerbero_owner";
/** L'utente dell'app (API e lavoratore): lavora come PROPRIETARIO. */
export const APP = "cerbero_app";
/**
 * Il proprietario del registro delle modifiche (PR 2.10, schema registro):
 * NOLOGIN, non superutente. Le funzioni del registro girano come lui; l'app
 * non lo è e non ne è membro.
 */
export const REGISTRO = "cerbero_registro";
export const SCHEMA_REGISTRO = "registro";
/** Relazioni negli schemi di Cerbero che non sono di Cerbero: non si spostano mai. */
export const ESCLUSE = Object.freeze(["caronte.app_users"]);

/**
 * I due event trigger che fermano il DDL dell'app (PR 2.8; dalla 2.16b tutto
 * il DDL), con la stessa funzione:
 * - all'inizio del comando (EVENTO_DDL): l'app non crea, non altera e non
 *   toglie nessun oggetto, nemmeno temporaneo. Passano solo, dentro le
 *   funzioni del registro delle modifiche, i comandi della partizione del
 *   mese (elenco in ruoli-regole.mjs);
 * - alla fine (EVENTO_DDL_FINE): i default, i vincoli CHECK, le colonne
 *   generate e gli indici delle tabelle toccate da quei comandi usano solo
 *   funzioni ammesse.
 * Senza, l'app potrebbe togliere una colonna o una regola dalle tabelle che
 * possiede, e un oggetto o un'espressione messi da lei girerebbero come
 * superutente quando un superutente li incontra. Li crea e li tiene accesi il
 * migratore; API e lavoratore non partono senza.
 */
export const EVENTO_DDL = "cerbero_ddl_dell_app";
export const EVENTO_DDL_FINE = "cerbero_ddl_dell_app_fine";
/**
 * Il terzo, sulla riscrittura delle tabelle (table_rewrite, PR 2.10): l'app
 * non riscrive una tabella del registro delle modifiche (ALTER COLUMN … TYPE
 * … USING, SET EXPRESSION cambiano i dati senza passare dai trigger).
 */
export const EVENTO_DDL_RISCRIVE = "cerbero_ddl_dell_app_riscrive";
export const FUNZIONE_EVENTO_DDL = "cerbero_migrazioni.ddl_dell_app()";

/**
 * Le relazioni di Cerbero dal catalogo atteso (meta/catalogo.json, già letto):
 * tabelle, viste e sequenze, tolte le escluse.
 */
export function elencoDalCatalogo(catalogo) {
  const da = (o) => Object.keys(o ?? {});
  const escluse = new Set(ESCLUSE);
  return [...new Set([...da(catalogo.tabelle), ...da(catalogo.viste), ...da(catalogo.sequenze)])]
    .filter((v) => /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(v) && !escluse.has(v))
    .sort();
}
