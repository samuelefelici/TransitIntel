#!/usr/bin/env node
// Aggiunge a lib/db/migrations/meta/impronte.json l'impronta (sha256) delle
// migrazioni nuove del diario. Non cambia mai un'impronta che c'è già: una
// migrazione rilasciata non si modifica, se ne scrive una nuova.
//   pnpm --filter @workspace/db run impronte
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leggiDiario } from "./migrazioni-regole.mjs";

const cartella = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const file = path.join(cartella, "meta/impronte.json");
const impronte = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
let errori = 0;
for (const e of leggiDiario(cartella)) {
  if (!impronte[e.tag]) {
    impronte[e.tag] = e.impronta;
    console.log(`aggiunta: ${e.tag}`);
  } else if (impronte[e.tag] !== e.impronta) {
    console.error(`${e.tag}: il file è cambiato dopo il rilascio. Rimetti com'era e scrivi una migrazione nuova.`);
    errori++;
  }
}
if (errori) process.exit(1);
writeFileSync(file, JSON.stringify(impronte, null, 2) + "\n");
