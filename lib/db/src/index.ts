import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
