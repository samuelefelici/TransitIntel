/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Quale calendario usa l'esercizio — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questa scelta decide se agosto viene letto come feriale scolastico. È il
 * tipo di errore che non dà mai un messaggio: le medie cambiano, i verdetti
 * restano plausibili, e nessuno va a ricontrollarli. Per questo con più
 * candidati il codice deve RIFIUTARSI di scegliere.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import { decidiCalendario } from "../lib/planning-studio-calendar";

describe("scelta del calendario aziendale", () => {
  it("con un solo progetto compilato lo usa, e dice quale", () => {
    const v = decidiCalendario([{ id: "16d13011-0589-4703-b1c7-b84758450479", name: "valido dal 2 agosto 2026" }]);
    expect(v.projectId).toBe("16d13011-0589-4703-b1c7-b84758450479");
    expect(v.candidati).toBe(1);
    expect(v.nota).toContain("valido dal 2 agosto 2026");
  });

  /* Il caso che questa funzione esiste per non sbagliare. */
  it("con più candidati non sceglie, e spiega perché", () => {
    const v = decidiCalendario([
      { id: "a", name: "Rete 2026" },
      { id: "b", name: "Jesi estivo" },
    ]);
    expect(v.projectId).toBeNull();
    expect(v.candidati).toBe(2);
    expect(v.nota).toMatch(/plausibili e sbagliati/);
    expect(v.nota).toMatch(/psProjectId/);
  });

  it("nomina i candidati, perché chi legge deve poter decidere", () => {
    const v = decidiCalendario([
      { id: "a", name: "Rete 2026" }, { id: "b", name: "Jesi estivo" },
      { id: "c", name: "Ancona urbano" }, { id: "d", name: "Prova" },
    ]);
    expect(v.nota).toContain("Rete 2026");
    expect(v.nota).toContain("…");   // i primi tre, poi troncato
    expect(v.nota).not.toContain("Prova");
  });

  it("senza candidati dichiara che le scuole non sono distinguibili", () => {
    const v = decidiCalendario([]);
    expect(v.projectId).toBeNull();
    expect(v.candidati).toBe(0);
    expect(v.nota).toMatch(/non sono distinguibili/i);
  });

  it("un progetto senza nome resta identificabile dall'id", () => {
    const v = decidiCalendario([{ id: "solo-id", name: null }]);
    expect(v.projectId).toBe("solo-id");
    expect(v.nota).toContain("solo-id");
  });
});
