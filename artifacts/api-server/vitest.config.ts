import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 30_000,
    // Load .env from monorepo root if available
    env: {
      // Fallback DATABASE_URL so that the module system doesn't crash
      // before we can even run unit tests. Tests that hit the DB
      // should be skipped when the DB is unreachable.
      ...(process.env.DATABASE_URL ? {} : {
        DATABASE_URL: "postgresql://test:test@localhost:5432/testdb?sslmode=disable",
      }),
    },
  },
});
