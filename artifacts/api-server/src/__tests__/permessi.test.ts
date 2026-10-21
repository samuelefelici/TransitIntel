import { describe, it, expect } from "vitest";
import { normalizzaPermessi, PERMESSI, PERMESSI_NUOVO_UTENTE } from "../lib/permessi";

describe("i permessi come si salvano", () => {
  it("un utente nuovo senza indicazioni parte senza Analisi", () => {
    const p = normalizzaPermessi(undefined, { nuovo: true });
    expect(p).toEqual(PERMESSI_NUOVO_UTENTE);
    expect(p.analytics).toBe(false);
    expect(Object.keys(p).sort()).toEqual([...PERMESSI].sort());
  });

  it("quello che l'admin sceglie vale, anche Analisi accesa", () => {
    const p = normalizzaPermessi({ analytics: true, fares: false }, { nuovo: true });
    expect(p.analytics).toBe(true);
    expect(p.fares).toBe(false);
    expect(p.scheduling).toBe(true);
  });

  it("in modifica la chiave che manca è spenta, non torna al default", () => {
    const p = normalizzaPermessi({ roster: true }, { nuovo: false });
    expect(p.roster).toBe(true);
    expect(p.fares).toBe(false);
    expect(p.network).toBe(false);
  });

  it("Rete e orari porta con sé i Turni", () => {
    expect(normalizzaPermessi({ network: true, scheduling: false }, { nuovo: false }).scheduling).toBe(true);
    expect(normalizzaPermessi({ network: false, scheduling: false }, { nuovo: false }).scheduling).toBe(false);
  });

  it("si scartano le chiavi sconosciute e i valori che non sono booleani veri", () => {
    const p = normalizzaPermessi({ admin: true, analytics: "true", centrale: 1, personale: true }, { nuovo: false }) as Record<string, boolean>;
    expect(p.admin).toBeUndefined();
    expect(p.analytics).toBe(false);
    expect(p.centrale).toBe(false);
    expect(p.personale).toBe(true);
  });
});
