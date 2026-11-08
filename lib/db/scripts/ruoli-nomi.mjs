// I nomi dei ruoli del database di Cerbero (PR 2.8). A parte da
// ruoli-regole.mjs perché li legge anche il lavoratore (lib/identita-db.ts),
// nel cui grafo non deve esserci DDL.

/** Il proprietario delle tabelle di Cerbero: nessuno entra come lui. */
export const PROPRIETARIO = "cerbero_owner";
/** L'utente dell'app (API e lavoratore): lavora come PROPRIETARIO. */
export const APP = "cerbero_app";
/** Relazioni negli schemi di Cerbero che non sono di Cerbero: non si spostano mai. */
export const ESCLUSE = Object.freeze(["caronte.app_users"]);

/**
 * L'event trigger che impedisce all'app di creare oggetti che un superutente
 * (o un altro ruolo) potrebbe eseguire senza volerlo: funzioni, operatori,
 * aggregati, tipi, cast, viste, regole, trigger, policy. All'app restano solo i
 * comandi delle unità pigre (fino alla 2.16, elenco in ruoli-regole.mjs).
 * Lo crea e lo tiene acceso il migratore; API e lavoratore non partono senza.
 */
export const EVENTO_DDL = "cerbero_ddl_dell_app";
export const FUNZIONE_EVENTO_DDL = "cerbero_migrazioni.ddl_dell_app()";
