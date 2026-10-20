import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { accessoFleetCare, firmaAccessoFleetCare } from "../lib/auth";
import { mfaObbligatoria } from "../lib/accesso-regole";

const SEGRETO = "segreto-condiviso-di-prova-0123456789";
const utente = {
  id: "00000000-0000-4000-8000-000000000042",
  email: "autista@prova.it",
  fullName: "Mario Rossi",
  role: "user" as const,
  permissions: { fleetcare: true } as any,
  fleetcareRole: "mechanic",
};

/* Il biglietto che FleetCare (migrazione 0088) accetta una volta sola e poi
 * rilegge nel database: chi è, la versione della sessione, quando è cominciata. */
describe("il biglietto per FleetCare", () => {
  it("porta sub, sv, at e un jti; vale 60 secondi; emittente e destinatario giusti", () => {
    const t = firmaAccessoFleetCare(utente, { sv: 7, at: 1_700_000_000 }, SEGRETO);
    const d = jwt.verify(t, SEGRETO, { issuer: "cerbero", audience: "fleetcare" }) as any;
    expect(d).toMatchObject({ sub: utente.id, sv: 7, at: 1_700_000_000 });
    expect(typeof d.jti).toBe("string");
    expect(d.jti.length).toBeGreaterThanOrEqual(32);
    expect(d.exp - d.iat).toBe(60);
  });

  it("un jti diverso a ogni biglietto", () => {
    const jti = new Set(Array.from({ length: 20 }, () => (jwt.decode(firmaAccessoFleetCare(utente, { sv: 1 }, SEGRETO)) as any).jti));
    expect(jti.size).toBe(20);
  });

  it("tiene email, nome e ruolo per il FleetCare di prima, durante il rilascio", () => {
    const d = jwt.decode(firmaAccessoFleetCare(utente, { sv: 1 }, SEGRETO)) as any;
    expect(d).toMatchObject({ email: "autista@prova.it", name: "Mario Rossi", fleetcareRole: "mechanic" });
    expect(d.at).toBeUndefined();
  });
});

/* Le stesse regole sono copiate in fleetcare.cerbero_stato_utente (FleetCare,
 * migrazione 0088). Se questo test cambia, va cambiata anche quella funzione. */
describe("le regole che FleetCare copia (aggiorna FleetCare 0088 se cambiano)", () => {
  it("chi entra e con quale ruolo", () => {
    expect(accessoFleetCare({ role: "admin", permissions: {} as any, fleetcareRole: "driver" })).toEqual({ abilitato: true, ruolo: "fleet_admin" });
    expect(accessoFleetCare({ role: "user", permissions: { fleetcare: true } as any, fleetcareRole: "" })).toEqual({ abilitato: true, ruolo: "driver" });
    expect(accessoFleetCare({ role: "user", permissions: { fleetcare: true } as any, fleetcareRole: "workshop_manager" })).toEqual({ abilitato: true, ruolo: "workshop_manager" });
    expect(accessoFleetCare({ role: "user", permissions: { fleetcare: false } as any, fleetcareRole: "mechanic" }).abilitato).toBe(false);
  });

  it("per chi la verifica in due passaggi è obbligatoria", () => {
    const casi: Array<[string, Record<string, boolean>, boolean]> = [
      ["admin", {}, true],
      ["user", { personale: true }, true],
      ["user", { roster: true }, true],
      ["user", { fleetcare: true, scheduling: true, analytics: true }, false],
    ];
    for (const [role, permissions, atteso] of casi) expect(mfaObbligatoria({ role, permissions })).toBe(atteso);
  });
});
