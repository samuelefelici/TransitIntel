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
    expect(voceAdminLeggibile("admin:ruolo_cambiato user→admin (capo@x.it)")).toBe("ruolo cambiato (user → admin), dall'admin capo@x.it");
    expect(voceAdminLeggibile("admin:ruolo_fleetcare_cambiato driver→mechanic (capo@x.it)"))
      .toBe("ruolo FleetCare cambiato (driver → mechanic), dall'admin capo@x.it");
  });

  it("le altre voci non sono dell'admin", () => {
    expect(voceAdminLeggibile("password_errata")).toBeNull();
    expect(voceAdminLeggibile("ok")).toBeNull();
  });
});
