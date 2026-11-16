/**
 * Le variazioni decise in anticipo (tappa 4.10), senza database: la lettura
 * della richiesta e quali corse toccano. E lo sciopero nella proposta.
 */
import { describe, it, expect } from "vitest";
import { leggiVariazione, toccata, type CorsaPerVariazione, type RegolaVariazione } from "../lib/esercizio-variazioni";
import { proponi, type CorsaDaProporre } from "../lib/esercizio-proposta";

const corsa = (chiave: string, linea: string, numero: string, partenza: string | null, origine = "programmata"): CorsaPerVariazione =>
  ({ chiave, linea, numero, partenza, origine });

describe("la richiesta", () => {
  it("una soppressione dice linee o numeri, e la fascia intera e nell'ordine", () => {
    expect(leggiVariazione({ tipo: "soppressione", giorno: "2026-12-01", causale: "LAVORI" })).toEqual({ errore: "Una soppressione dice le linee o i numeri di corsa" });
    expect(leggiVariazione({ tipo: "soppressione", giorno: "2026-12-01", linee: ["1"], dalle: "08:00", causale: "LAVORI" })).toEqual({ errore: "La fascia vuole dalle e alle" });
    expect(leggiVariazione({ tipo: "soppressione", giorno: "2026-12-01", linee: ["1"], dalle: "10:00", alle: "08:00", causale: "LAVORI" }))
      .toEqual({ errore: "La fascia: dalle viene prima di alle" });
    expect(leggiVariazione({ tipo: "soppressione", giorno: "2026-02-30", linee: ["1"], causale: "LAVORI" })).toEqual({ errore: "giorno: una data vera" });
    expect(leggiVariazione({ tipo: "soppressione", giorno: "2026-12-01", linee: ["1"], causale: "LAVORI", altro: 1 })).toHaveProperty("errore");
    const ok = leggiVariazione({ tipo: "soppressione", giorno: "2026-12-01", linee: [" 1 "], dalle: "08:00", alle: "25:30", causale: "LAVORI" });
    expect(ok).toEqual({ variazione: { tipo: "soppressione", giorno: "2026-12-01", linee: ["1"], numeri: [], dalle: "08:00", alle: "25:30", causale: "LAVORI" } });
  });
  it("uno sciopero: almeno una fascia garantita, la causale SCIOPERO se non detta", () => {
    expect(leggiVariazione({ tipo: "sciopero", giorno: "2026-12-01", fasce: [] })).toHaveProperty("errore");
    expect(leggiVariazione({ tipo: "sciopero", giorno: "2026-12-01", fasce: [{ dalle: "9:00", alle: "6:00" }] }))
      .toEqual({ errore: "Ogni fascia garantita: dalle viene prima di alle" });
    expect(leggiVariazione({ tipo: "sciopero", giorno: "2026-12-01", fasce: [{ dalle: "06:00", alle: "09:00" }], numeri: ["1"] })).toHaveProperty("errore");
    expect(leggiVariazione({ tipo: "sciopero", giorno: "2026-12-01", fasce: [{ dalle: "06:00", alle: "09:00" }] }))
      .toEqual({ variazione: { tipo: "sciopero", giorno: "2026-12-01", linee: [], fasce: [{ dalle: "06:00", alle: "09:00" }], causale: "SCIOPERO" } });
  });
});

describe("quali corse tocca", () => {
  const soppressione: RegolaVariazione = { tipo: "soppressione", linee: ["1"], numeri: [], dalle: "08:00", alle: "10:00", fasce: null };
  const sciopero: RegolaVariazione = { tipo: "sciopero", linee: [], numeri: [], dalle: null, alle: null,
    fasce: [{ dalle: "06:00", alle: "09:00" }, { dalle: "12:00", alle: "15:00" }] };

  it("soppressione: linea e fascia sulla partenza, [dalle, alle)", () => {
    expect(toccata(soppressione, corsa("a", "1", "10", "08:00:00"))).toBe(true);
    expect(toccata(soppressione, corsa("b", "1", "11", "09:59:00"))).toBe(true);
    expect(toccata(soppressione, corsa("c", "1", "12", "10:00:00"))).toBe(false);
    expect(toccata(soppressione, corsa("d", "2", "13", "08:30:00"))).toBe(false);
    expect(toccata(soppressione, corsa("e", "1", "14", null))).toBe(false);
    // le aggiunte non si toccano
    expect(toccata(soppressione, corsa("f", "1", "agg", "08:30:00", "aggiunta"))).toBe(false);
    // per numero, in tutto il giorno
    const perNumero: RegolaVariazione = { ...soppressione, linee: [], numeri: ["477789"], dalle: null, alle: null };
    expect(toccata(perNumero, corsa("g", "32", "477789", "22:10:00"))).toBe(true);
    expect(toccata(perNumero, corsa("h", "32", "477790", "22:10:00"))).toBe(false);
  });

  it("sciopero: fuori dalle fasce garantite, anche dopo la mezzanotte", () => {
    expect(toccata(sciopero, corsa("a", "1", "1", "05:59:00"))).toBe(true);
    expect(toccata(sciopero, corsa("b", "1", "2", "06:00:00"))).toBe(false);
    expect(toccata(sciopero, corsa("c", "1", "3", "09:00:00"))).toBe(true);
    expect(toccata(sciopero, corsa("d", "1", "4", "13:30:00"))).toBe(false);
    expect(toccata(sciopero, corsa("e", "1", "5", "24:30:00"))).toBe(true);
    expect(toccata(sciopero, corsa("f", "1", "6", null))).toBe(false);
    expect(toccata({ ...sciopero, linee: ["7"] }, corsa("g", "1", "7", "10:00:00"))).toBe(false);
  });
});

describe("lo sciopero nella proposta dall'AVM", () => {
  const c = (chiave: string, partenza: string): CorsaDaProporre => ({
    chiave, codice: null, numero: chiave, linea: "1", partenza, arrivo: null, vssId: null, turnoMacchina: null, dssId: null, turnoGuida: null,
    fermate: [{ seq: 1, stopId: "A" }, { seq: 2, stopId: "B" }],
  });
  it("senza prove, fuori fascia è «soppressione probabile» e non «non rilevata»; con le prove vale l'AVM", () => {
    const e = proponi({
      corse: [c("fuori", "10:00:00"), c("dentro", "07:00:00"), c("vista", "10:30:00")],
      transiti: [{ trip: "vista", stopId: "A", seq: 1, sec: 37800, vettura: "301" }, { trip: "vista", stopId: "B", seq: 2, sec: 38400, vettura: "301" }],
      viaggi: [], codiceDi: new Map(), turniGuidaScoperti: null, sciopero: new Set(["fuori", "vista"]),
    });
    expect(e.perCorsa.get("fuori")).toMatchObject({ proposta: "soppressione_indizio", prove: { motivo: "sciopero: fuori dalle fasce garantite" } });
    expect(e.perCorsa.get("dentro")!.proposta).toBe("non_rilevata");
    expect(e.perCorsa.get("vista")!.proposta).toBe("effettuata_avm");
  });
});
