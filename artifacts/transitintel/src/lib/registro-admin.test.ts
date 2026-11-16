import { describe, it, expect } from "vitest";
import { voceAdminLeggibile } from "./registro-admin";

describe("voci dell'admin nel registro degli accessi", () => {
  it("quelle di prima, senza dettaglio", () => {
    expect(voceAdminLeggibile("admin:password_provvisoria (capo@x.it)")).toBe("password provvisoria, dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:nome_cambiato (capo@x.it)")).toBe("nome cambiato, dall'admin capo@x.it");
  });

  it("le nuove, col dettaglio in italiano", () => {
    expect(voceAdminLeggibile("admin:permessi_cambiati +centrale -fares (capo@x.it)"))
      .toBe("permessi cambiati (+ Esercizio, − Tariffe), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:utente_creato user fares,scheduling (capo@x.it)"))
      .toBe("utente creato (utente; Tariffe, Turni), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:utente_creato admin (capo@x.it)")).toBe("utente creato (admin), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:ruolo_cambiato user→admin (capo@x.it)")).toBe("ruolo di sistema cambiato (user → admin), dall'admin capo@x.it");
    // i ruoli aziendali (PR 2.14a)
    expect(voceAdminLeggibile("admin:ruoli_aziendali_cambiati +capo_deposito -ufficio_turni (capo@x.it)"))
      .toBe("ruoli aziendali cambiati (+ Capo deposito, − Ufficio turni), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:accesso_di_prima_cambiato -fares -scheduling (capo@x.it)"))
      .toBe("accesso di prima cambiato (− Tariffe, − Turni), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:utente_creato user amministrazione,capo_deposito,+dati_sanitari (capo@x.it)"))
      .toBe("utente creato (utente; Amministrazione, Capo deposito, dati sanitari), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:dati_sanitari_dati (capo@x.it)")).toBe("dati sanitari: dati, dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:analisi_tolta (capo@x.it)")).toBe("Analisi: tolta, dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:ruolo_fleetcare_cambiato driver→mechanic (capo@x.it)"))
      .toBe("ruolo FleetCare cambiato (driver → mechanic), dall'admin capo@x.it");
    // i depositi del roster (PR 2.14c): codici del catalogo, anche col trattino
    expect(voceAdminLeggibile("admin:depositi_cambiati +jesi-urbano -ancona (capo@x.it)"))
      .toBe("depositi del roster cambiati (+ jesi-urbano, − ancona), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:utente_creato user capo_deposito,deposito:jesi (capo@x.it)"))
      .toBe("utente creato (utente; Capo deposito, deposito jesi), dall'admin capo@x.it");
  });

  it("le altre voci non sono dell'admin", () => {
    expect(voceAdminLeggibile("password_errata")).toBeNull();
    expect(voceAdminLeggibile("ok")).toBeNull();
  });
});
