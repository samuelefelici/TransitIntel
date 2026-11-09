// Le relazioni del catalogo atteso come modulo, per chi le deve portare con
// sé: esbuild incorpora il JSON nel bundle dell'API e del lavoratore, che così
// sanno quali relazioni il riallineamento dei ruoli passa a cerbero_owner
// (lib/identita-db.ts: se una di queste è ancora di un superutente l'app non
// parte; le altre sono solo un avviso). Il migratore invece legge il file dal
// disco (migrazioni-regole.mjs, leggiCatalogo), come per il diario.
import catalogo from "../migrations/meta/catalogo.json" with { type: "json" };
import { elencoDalCatalogo } from "./ruoli-nomi.mjs";

export const RELAZIONI_DEL_CATALOGO = Object.freeze(elencoDalCatalogo(catalogo));
