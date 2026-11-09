/* La nota manuale nel registro delle tariffe (POST /fares/audit): l'autore è
 * chi ha la sessione, non un campo del modulo (PR 2.10). Il database è
 * finto: getLatestFeedId risponde col feed A, l'insert registra i valori. */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";

const F = vi.hoisted(() => ({ valori: [] as any[] }));
vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  const insert = () => ({
    values: (v: any) => { F.valori.push(v); return { returning: async () => [{ id: 1, ...v }] }; },
  });
  return {
    ...schema,
    db: {
      execute: vi.fn(async () => ({ rows: [{ id: "aaaaaaaa-0000-0000-0000-000000000001" }] })),
      insert,
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
    },
    pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
  };
});

import faresRouter from "../routes/fares";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

describe("nota manuale delle tariffe", () => {
  it("l'autore è chi ha la sessione, anche se il modulo ne manda un altro", async () => {
    const utente = { ...utenteDiProva("u-tariffe", ["fares"]), fullName: "Anna Tariffe" };
    const r = await request(appDiProva(faresRouter, utente)).post("/api/fares/audit")
      .send({ description: "Delibera n. 12", actor: "Qualcun altro" });
    expect(r.status).toBe(200);
    expect(F.valori.at(-1)).toMatchObject({ action: "manual_note", description: "Delibera n. 12", actor: "Anna Tariffe" });
  });

  it("senza nome: l'email", async () => {
    const r = await request(appDiProva(faresRouter, utenteDiProva("u-due", ["fares"]))).post("/api/fares/audit")
      .send({ description: "Nota" });
    expect(r.status).toBe(200);
    expect(F.valori.at(-1).actor).toBe("u-due@prova.local");
  });
});
