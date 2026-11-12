/**
 * Il registro delle modifiche dell'admin agli utenti (lib/azioni-admin.ts):
 * si scrive solo quello che cambia davvero, con i nomi dei moduli e mai i
 * valori personali.
 */
import { describe, it, expect } from "vitest";
import { azioniAdmin, type StatoUtente } from "../lib/azioni-admin";

const base: StatoUtente = {
  role: "user", ruoli: ["ufficio_turni"], accesso_di_prima: { fares: true, scheduling: true }, dati_sanitari: false, analisi: false,
  fleetcare_role: "driver", full_name: "Mario Rossi", active: true,
};

describe("azioni dell'admin sugli utenti", () => {
  it("creazione: ruolo di sistema, ruoli aziendali e capacità", () => {
    expect(azioniAdmin(null, { ...base, role: "admin" })).toEqual(["utente_creato admin ufficio_turni"]);
    expect(azioniAdmin(null, { ...base, ruoli: [] })).toEqual(["utente_creato user"]);
    expect(azioniAdmin(null, { ...base, ruoli: ["capo_deposito", "amministrazione"], dati_sanitari: true, analisi: true }))
      .toEqual(["utente_creato user amministrazione,capo_deposito,+dati_sanitari,+analisi"]);
  });

  it("eliminazione", () => {
    expect(azioniAdmin(base, null)).toEqual(["utente_eliminato"]);
  });

  it("niente cambiato, niente registrato", () => {
    expect(azioniAdmin(base, { ...base })).toEqual([]);
    expect(azioniAdmin(base, { ...base, active: true })).toEqual([]);
  });

  it("ruolo di sistema, ruoli aziendali, accesso di prima, capacità, ruolo FleetCare", () => {
    expect(azioniAdmin(base, { ...base, role: "admin" })).toEqual(["ruolo_cambiato user→admin"]);
    expect(azioniAdmin(base, { ...base, ruoli: ["pianificatore", "capo_deposito"] }))
      .toEqual(["ruoli_aziendali_cambiati +capo_deposito +pianificatore -ufficio_turni"]);
    expect(azioniAdmin(base, { ...base, accesso_di_prima: { scheduling: true } })).toEqual(["accesso_di_prima_cambiato -fares"]);
    expect(azioniAdmin(base, { ...base, accesso_di_prima: {} })).toEqual(["accesso_di_prima_cambiato -fares -scheduling"]);
    expect(azioniAdmin(base, { ...base, dati_sanitari: true })).toEqual(["dati_sanitari_dati"]);
    expect(azioniAdmin({ ...base, dati_sanitari: true }, base)).toEqual(["dati_sanitari_tolti"]);
    expect(azioniAdmin(base, { ...base, analisi: true })).toEqual(["analisi_data"]);
    expect(azioniAdmin({ ...base, analisi: true }, base)).toEqual(["analisi_tolta"]);
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

  it("i depositi: quali si aggiungono e quali si tolgono, e alla creazione quali ha", () => {
    expect(azioniAdmin(base, { ...base, depositi: ["jesi", "ancona"] })).toEqual(["depositi_cambiati +ancona +jesi"]);
    expect(azioniAdmin({ ...base, depositi: ["jesi", "ancona"] }, { ...base, depositi: ["jesi", "osimo"] })).toEqual(["depositi_cambiati +osimo -ancona"]);
    expect(azioniAdmin({ ...base, depositi: ["jesi"] }, { ...base, depositi: [] })).toEqual(["depositi_cambiati -jesi"]);
    // gli stessi depositi, anche in un altro ordine o scritti a metà: nessuna azione
    expect(azioniAdmin({ ...base, depositi: ["jesi", "ancona"] }, { ...base, depositi: ["ancona", "jesi"] })).toEqual([]);
    expect(azioniAdmin({ ...base, depositi: null }, { ...base, depositi: [] })).toEqual([]);
    expect(azioniAdmin(null, { ...base, depositi: ["jesi"] })).toEqual(["utente_creato user ufficio_turni,deposito:jesi"]);
  });

  it("più cambi insieme, in ordine fisso", () => {
    expect(azioniAdmin(base, { ...base, role: "admin", full_name: "X", active: false }, { password: true }))
      .toEqual(["ruolo_cambiato user→admin", "nome_cambiato", "password_provvisoria", "disattivato"]);
  });
});
