/**
 * Il registro delle modifiche dell'admin agli utenti (lib/azioni-admin.ts):
 * si scrive solo quello che cambia davvero, con i nomi dei moduli e mai i
 * valori personali.
 */
import { describe, it, expect } from "vitest";
import { azioniAdmin, type StatoUtente } from "../lib/azioni-admin";

const base: StatoUtente = {
  role: "user", permissions: { analytics: false, fares: true, scheduling: true, roster: false },
  fleetcare_role: "driver", full_name: "Mario Rossi", active: true,
};

describe("azioni dell'admin sugli utenti", () => {
  it("creazione: ruolo e moduli accesi", () => {
    expect(azioniAdmin(null, { ...base, role: "admin" })).toEqual(["utente_creato admin fares,scheduling"]);
    expect(azioniAdmin(null, { ...base, permissions: {} })).toEqual(["utente_creato user"]);
  });

  it("eliminazione", () => {
    expect(azioniAdmin(base, null)).toEqual(["utente_eliminato"]);
  });

  it("niente cambiato, niente registrato", () => {
    expect(azioniAdmin(base, { ...base })).toEqual([]);
    expect(azioniAdmin(base, { ...base, active: true })).toEqual([]);
  });

  it("ruolo, permessi, ruolo FleetCare", () => {
    expect(azioniAdmin(base, { ...base, role: "admin" })).toEqual(["ruolo_cambiato user→admin"]);
    expect(azioniAdmin(base, { ...base, permissions: { fares: false, scheduling: true, roster: true, centrale: true } }))
      .toEqual(["permessi_cambiati +centrale +roster -fares"]);
    expect(azioniAdmin(base, { ...base, fleetcare_role: "mechanic" })).toEqual(["ruolo_fleetcare_cambiato driver→mechanic"]);
  });

  it("il nome: solo che è cambiato, mai il valore", () => {
    const a = azioniAdmin(base, { ...base, full_name: "Maria Bianchi" });
    expect(a).toEqual(["nome_cambiato"]);
    expect(a.join(" ")).not.toMatch(/Mario|Maria|Rossi|Bianchi/);
  });

  it("password, verifica, blocco", () => {
    expect(azioniAdmin(base, { ...base }, { password: true, resetMfa: true, sblocca: true }))
      .toEqual(["password_provvisoria", "verifica_tolta", "sbloccato"]);
  });

  it("disattivato e riattivato solo se lo stato cambia davvero", () => {
    expect(azioniAdmin(base, { ...base, active: false })).toEqual(["disattivato"]);
    expect(azioniAdmin({ ...base, active: false }, { ...base, active: true })).toEqual(["riattivato"]);
    expect(azioniAdmin({ ...base, active: false }, { ...base, active: false })).toEqual([]);
  });

  it("più cambi insieme, in ordine fisso", () => {
    expect(azioniAdmin(base, { ...base, role: "admin", full_name: "X", active: false }, { password: true }))
      .toEqual(["ruolo_cambiato user→admin", "nome_cambiato", "password_provvisoria", "disattivato"]);
  });
});
