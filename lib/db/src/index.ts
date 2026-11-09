import { drizzle } from "drizzle-orm/node-postgres";
import { PoolConContesto } from "./contesto";
import * as schema from "./schema";

export { conContesto, contestoDb, inSistema, IMPOSTAZIONI, PoolConContesto, type ContestoDb } from "./contesto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Ogni prestito porta sulla connessione chi fa la modifica (contesto.ts, PR 2.9).
export const pool = new PoolConContesto({
  connectionString: process.env.DATABASE_URL,
  // in produzione PGAPPNAME lo mette docker/avvio.sh (cerbero-api, cerbero-lavoratore)
  application_name: process.env.PGAPPNAME || "cerbero",
  // PGSSL_NO_VERIFY=1 → accetta certificati self-signed (es. Postgres Coolify
  // esposto pubblicamente). Sulla rete interna Coolify in genere niente SSL.
  ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 30_000,       // release idle clients after 30s
  connectionTimeoutMillis: 10_000, // fail fast if can't connect in 10s
  max: 10,
});

// Prevent unhandled 'error' events from crashing the process
pool.on("error", (err) => {
  console.error("[DB Pool] Unexpected error on idle client:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
