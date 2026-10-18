import { describe, it, expect } from "vitest";

/* I test non devono mai parlare col database dell'ambiente (vitest.config.ts). */
describe("il database dei test", () => {
  it("è quello di prova, mai il DATABASE_URL dell'ambiente", () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL || "postgresql://test:test@127.0.0.1:1/test");
  });
});
