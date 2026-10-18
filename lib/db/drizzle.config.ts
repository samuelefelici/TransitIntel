import { defineConfig } from "drizzle-kit";
import path from "path";
import { existsSync } from "fs";

// drizzle-kit push è spento: decine di tabelle e colonne esistono solo nel
// database (le crea l'API al primo uso) e push proporrebbe di cancellarle.
// Lo schema si cambia con un file SQL in migrations/ (DEPLOY.md, STEP 1).
if (process.argv.some(a => a === "push" || a.startsWith("push:"))) {
  throw new Error("drizzle-kit push è disattivato in Cerbero: lo schema si cambia con un file in migrations/ (DEPLOY.md, STEP 1).");
}

// Carica le variabili dal .env di root se DATABASE_URL non è già nell'ambiente
// (start-backend.sh fa il source del .env, ma drizzle-kit gira da solo).
if (!process.env.DATABASE_URL) {
  const rootEnv = path.join(__dirname, "../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  // solo gli schemi di Cerbero: fleetcare è di FleetCare, che ha le sue migrazioni
  schemaFilter: ["public", "caronte"],
  strict: true,
  dbCredentials: {
    url: process.env.DATABASE_URL,
    // certificati self-signed (es. Postgres Coolify esposto): PGSSL_NO_VERIFY=1
    ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
  },
});
