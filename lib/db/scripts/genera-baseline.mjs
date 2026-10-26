#!/usr/bin/env node
// Rigenera lib/db/migrations/0000_baseline.sql dal dump della produzione.
//   node lib/db/scripts/genera-baseline.mjs [dump.sql]
// Il baseline non si modifica a mano: artifacts/api-server/src/__tests__/
// migrazioni.test.ts lo confronta con l'uscita di questo script.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generaBaseline } from "./baseline.mjs";

const qui = path.dirname(fileURLToPath(import.meta.url));
const radice = path.resolve(qui, "..");
const fonte = process.argv[2] ?? path.join(radice, "schema-produzione/2026-10-25.sql");
const uscita = path.join(radice, "migrations/0000_baseline.sql");

const sql = generaBaseline(readFileSync(fonte, "utf8"), {
  fonte: path.relative(path.resolve(radice, "../.."), fonte),
});
writeFileSync(uscita, sql);
console.log(`scritto ${path.relative(process.cwd(), uscita)} (${sql.split("\n").length} righe)`);
