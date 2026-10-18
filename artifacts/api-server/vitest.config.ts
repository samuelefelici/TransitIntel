import { defineConfig } from "vitest/config";

/* I test non usano MAI il DATABASE_URL dell'ambiente: può essere quello di
 * produzione, e importare l'app crea tabelle e utenti. Un database di prova
 * si passa con TEST_DATABASE_URL; senza, un indirizzo che rifiuta subito. */
const DB_DI_PROVA = process.env.TEST_DATABASE_URL || "postgresql://test:test@127.0.0.1:1/test";
process.env.DATABASE_URL = DB_DI_PROVA;

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 30_000,
    env: { DATABASE_URL: DB_DI_PROVA },
  },
});
