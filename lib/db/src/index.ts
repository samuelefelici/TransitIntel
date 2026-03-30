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
  // Neon serverless: close idle connections before Neon kills them
  idleTimeoutMillis: 20_000,       // release idle clients after 20s
  connectionTimeoutMillis: 10_000, // fail fast if can't connect in 10s
  max: 10,
});

// Prevent unhandled 'error' events from crashing the process
pool.on("error", (err) => {
  console.error("[DB Pool] Unexpected error on idle client:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
