/**
 * Ogni chiamata della pagina «Orari al pubblico» verso le stampe di un
 * programma (`${ptt}/…` in pages/timetables.tsx) ha la sua rotta nell'API.
 *
 * La 2.13b aveva tolto `timetables/route-stops` come «senza chiamanti»: la
 * pagina la chiama con un percorso composto, che la ricerca non aveva visto, e
 * i «Quadri palina» si chiudevano senza stampare (PR 7.2).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

import router from "../routes/planning-studio-timetables";

const PAGINA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../transitintel/src/pages/timetables.tsx");
const PREFISSO = "/planning-studio/:projectId/timetables";

/** `/stop/${encodeURIComponent(x)}/full` → `/stop/:x/full` */
const forma = (p: string) => p.replace(/\$\{[^}]*\}/g, ":x").replace(/:[A-Za-z_]+/g, ":x");

describe("Orari al pubblico: le chiamate della pagina hanno una rotta", () => {
  const chiamate = [...new Set([...readFileSync(PAGINA, "utf8").matchAll(/`\$\{ptt\}(\/[^`?]*)/g)].map((m) => forma(m[1]!)))];
  const rotte = new Set((router as any).stack
    .filter((l: any) => l.route?.methods?.get && String(l.route.path).startsWith(PREFISSO))
    .map((l: any) => forma(String(l.route.path).slice(PREFISSO.length))));

  it("la pagina ne fa più di cinque (la ricerca guarda davvero dentro)", () => {
    expect(chiamate.length).toBeGreaterThan(5);
    expect(chiamate).toContain("/route-stops");
  });

  it("nessuna chiamata senza la sua rotta GET", () => {
    expect(chiamate.filter((c) => !rotte.has(c))).toEqual([]);
  });
});
