// I nomi dei ruoli del database di Cerbero (PR 2.8). A parte da
// ruoli-regole.mjs perché li legge anche il lavoratore (lib/identita-db.ts),
// nel cui grafo non deve esserci DDL.

/** Il proprietario delle tabelle di Cerbero: nessuno entra come lui. */
export const PROPRIETARIO = "cerbero_owner";
/** L'utente dell'app (API e lavoratore): lavora come PROPRIETARIO. */
export const APP = "cerbero_app";
/** Relazioni negli schemi di Cerbero che non sono di Cerbero: non si spostano mai. */
export const ESCLUSE = Object.freeze(["caronte.app_users"]);
