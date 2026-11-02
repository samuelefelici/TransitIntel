// Il diario delle migrazioni come modulo, per chi lo deve portare con sé:
// esbuild incorpora il JSON nel bundle dell'API, che così conosce le
// migrazioni della sua stessa immagine (la guardia di versione,
// artifacts/api-server/src/lib/guardia-schema.ts). Il migratore invece legge
// il file dal disco (migrazioni-regole.mjs, leggiDiario).
import diario from "../migrations/meta/_journal.json" with { type: "json" };

export const DIARIO = Object.freeze(diario.entries.map(({ idx, tag, when }) => Object.freeze({ idx, tag, when })));
