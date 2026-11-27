/**
 * I profili delle regole nel giro di Argos: come la Fucina, il profilo
 * dell'azienda, poi quello del progetto, poi la richiesta (vince). Le regole
 * senza database, e la lettura sul database vero (TEST_DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { applicaProfili, profiliDelGiro, unisci, type ProfiliDelGiro } from "../lib/profili-regole";

describe("unire le configurazioni", () => {
  it("gli oggetti si uniscono, il resto lo decide chi sta sopra", () => {
    expect(unisci({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: 9 }, e: [2, 3] }))
      .toEqual({ a: 1, b: { c: 9, d: 3 }, e: [2, 3] });
    // come nella Fucina: un null sopra non cancella quello che c'è sotto
    expect(unisci({ f: 1 }, { f: null })).toEqual({ f: 1 });
    expect(unisci(null, { a: 1 })).toEqual({ a: 1 });
    expect(unisci({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("i profili nella richiesta del giro", () => {
  const profili: ProfiliDelGiro = {
    vsp: { vehicleCosts: { perKm: 1.2, perVehicle: 300 }, vspAdvanced: { minVehiclesPriority: "lexicographic" } },
    crew: { bds: { serviceType: "urbano", rd131: { maxGuidaContinuativa: 270 } }, weights: { minDrivers: 8 } },
    fonti: { vsp: { azienda: true, progetto: false }, crew: { azienda: true, progetto: true } },
  };

  it("sotto la richiesta: vince quello che la richiesta chiede, il tipo di servizio è del giro", () => {
    const { corpo, usati } = applicaProfili(
      { date: "2026-09-20", vehicleCosts: { perKm: 1.5 }, crewConfig: { weights: { minDrivers: 10 } } },
      profili, "vcsp", "extraurbano");
    expect(corpo.vehicleCosts).toEqual({ perKm: 1.5, perVehicle: 300 });
    expect(corpo.vspAdvanced).toEqual({ minVehiclesPriority: "lexicographic" });
    expect(corpo.crewConfig).toEqual({ bds: { serviceType: "extraurbano", rd131: { maxGuidaContinuativa: 270 } }, weights: { minDrivers: 10 } });
    expect(usati).toEqual({ vsp: "azienda", crew: "azienda+progetto" });
  });

  it("solo turni macchina: i turni guida non si toccano; senza profili la richiesta resta com'è", () => {
    expect(applicaProfili({ date: "x" }, profili, "cpsat", "urbano").corpo.crewConfig).toBeUndefined();
    const vuoti: ProfiliDelGiro = { vsp: null, crew: null, fonti: { vsp: { azienda: false, progetto: false }, crew: { azienda: false, progetto: false } } };
    expect(applicaProfili({ date: "x", robustness: "media" }, vuoti, "vcsp", "urbano"))
      .toEqual({ corpo: { date: "x", robustness: "media" }, usati: { vsp: null, crew: null } });
  });
});

const u = (n: number) => `d9e00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UTENTE = u(1), ALTRO = u(2), P = u(3), P2 = u(4);

describe.runIf(!!process.env.TEST_DATABASE_URL)("i profili delle regole, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM optimizer_rule_profiles WHERE owner_user_id IN (${UTENTE}::uuid, ${ALTRO}::uuid)`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${UTENTE}::uuid, ${ALTRO}::uuid)`);
  };
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${UTENTE}::uuid, 'profili@prova.local', 'x', 'user'), (${ALTRO}::uuid, 'profili-altro@prova.local', 'x', 'user')`);
    await db.execute(sql`INSERT INTO optimizer_rule_profiles (owner_user_id, scope, project_id, name, domain, config_json, is_default) VALUES
      (${UTENTE}::uuid, 'company', NULL, 'Azienda VSP', 'vsp', '{"vehicleCosts": {"perKm": 1.2, "perVehicle": 300}}'::jsonb, true),
      (${UTENTE}::uuid, 'project', ${P}::uuid, 'Progetto VSP', 'vsp', '{"vehicleCosts": {"perKm": 1.4}}'::jsonb, true),
      (${UTENTE}::uuid, 'project', ${P2}::uuid, 'Altro progetto', 'vsp', '{"vehicleCosts": {"perKm": 9}}'::jsonb, true),
      (${UTENTE}::uuid, 'company', NULL, 'Preset non predefinito', 'crew', '{"weights": {"minDrivers": 1}}'::jsonb, false),
      (${UTENTE}::uuid, 'company', NULL, 'Algoritmo', 'vcsp', '{"x": 1}'::jsonb, true),
      (${ALTRO}::uuid, 'company', NULL, 'Di un altro', 'crew', '{"weights": {"minDrivers": 2}}'::jsonb, true)`);
  });
  afterAll(pulisci);

  it("azienda poi progetto, solo predefiniti, solo di chi lancia, solo di questo progetto", async () => {
    const p = await profiliDelGiro(UTENTE, P);
    expect(p.vsp).toEqual({ vehicleCosts: { perKm: 1.4, perVehicle: 300 } });
    expect(p.fonti.vsp).toEqual({ azienda: true, progetto: true });
    expect(p.crew).toBeNull();                         // il preset non predefinito e quello di un altro non contano
    expect((await profiliDelGiro(UTENTE, null)).vsp).toEqual({ vehicleCosts: { perKm: 1.2, perVehicle: 300 } });
    expect((await profiliDelGiro(ALTRO, P)).crew).toEqual({ weights: { minDrivers: 2 } });
  });
});
