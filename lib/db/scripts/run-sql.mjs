#!/usr/bin/env node
// Esegue un file .sql sul DATABASE_URL usando `pg` (così non serve psql).
// Carica il .env di root se DATABASE_URL non è già nell'ambiente.
//   node scripts/run-sql.mjs <path-al-file.sql>
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  const rootEnv = path.join(__dirname, "../../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL non impostata (né nell'ambiente né nel .env di root).");
  process.exit(1);
}

const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Uso: node scripts/run-sql.mjs <file.sql>");
  process.exit(1);
}
const sqlPath = path.resolve(process.cwd(), fileArg);
const sql = readFileSync(sqlPath, "utf8");

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  // certificati self-signed (es. Postgres Coolify esposto): PGSSL_NO_VERIFY=1
  ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
});
try {
  await client.connect();
  await client.query(sql);
  console.log(`OK: eseguito ${sqlPath}`);
} catch (e) {
  console.error("Errore:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
