import { describe, it, expect } from "vitest";
import {
  andamentoPerimetro, fraseAndamento, conteggiAzioni, selezionabile, tipoDellaSelezione, lunediDi, oggiDiEsercizio,
  type SettimanaStoria, type VetturaPerConti,
} from "./storia-avm";

const settimane: SettimanaStoria[] = [
  { lunedi: "2026-10-12", domenica: "2026-10-18", giornateContate: 7, chiusa: true },
  { lunedi: "2026-10-19", domenica: "2026-10-25", giornateContate: 6, chiusa: true },
  { lunedi: "2026-10-26", domenica: "2026-11-01", giornateContate: 7, chiusa: true },
  { lunedi: "2026-11-02", domenica: "2026-11-08", giornateContate: 2, chiusa: false },
];
const v = (vehicleRef: string, storia: string, primoGiorno: string | null, azione: VetturaPerConti["azione"] = "funziona",
  richiesta: VetturaPerConti["richiesta"] = null, ultimoGiorno: string | null = null): VetturaPerConti =>
  ({ vehicleRef, storia, primoGiorno, ultimoGiorno, azione, esclusa: null, richiesta });

describe("l'andamento nella pagina", () => {
  it("conta ogni vettura dalla settimana in cui compare, e lo dice in una frase", () => {
    const a = andamentoPerimetro(settimane, [v("1", "FFF.", "2026-10-12"), v("2", "PPF.", "2026-10-14"), v("3", "AMF.", "2026-10-21")]);
    expect(a.map(w => [w.F, w.P, w.M, w.A])).toEqual([[1, 1, 0, 0], [1, 1, 1, 0], [3, 0, 0, 0], [0, 0, 0, 0]]);
    expect(fraseAndamento(a)).toBe("Nella settimana dal 26/10 al 01/11 si sono localizzate 3 vetture su 3 (100%). "
      + "Nella prima settimana osservata, dal 12/10/2026, erano 1 su 2 (50%).");
  });

  it("senza settimane chiuse giudicabili lo dice", () => {
    expect(fraseAndamento(andamentoPerimetro([settimane[3]], []))).toMatch(/non si può ancora dire/);
  });

  it("le azioni contate, le richieste che si possono segnare, il tipo della selezione", () => {
    const togliere = v("12", "MMM.", "2026-10-12", "da_togliere_da_siri");
    const giaChiesta = v("13", "MMM.", "2026-10-12", "da_togliere_da_siri", { tipo: "togliere", esito: null, ricomparsaIl: null });
    const fattaAMano = v("16", "AAA.", null, "da_aggiungere_a_siri", { tipo: "aggiungere", esito: "fatta", ricomparsaIl: null });
    const ricomparsa = v("17", "MMM.", "2026-10-12", "da_togliere_da_siri", { tipo: "togliere", esito: "fatta", ricomparsaIl: "2026-10-30" });
    const annullata = v("18", "MMM.", "2026-10-12", "da_togliere_da_siri", { tipo: "togliere", esito: "annullata", ricomparsaIl: null });
    expect(selezionabile(fattaAMano)).toBe(false);
    expect(selezionabile(ricomparsa)).toBe(true);
    expect(selezionabile(annullata)).toBe(true);
    const aggiungere = v("14", "AAA.", null, "da_aggiungere_a_siri");
    expect(conteggiAzioni([togliere, giaChiesta, aggiungere]).da_togliere_da_siri).toBe(2);
    expect(selezionabile(togliere)).toBe(true);
    expect(selezionabile(giaChiesta)).toBe(false);
    expect(selezionabile(v("15", "FFF.", "2026-10-12"))).toBe(false);
    expect(tipoDellaSelezione([togliere])).toBe("togliere");
    expect(tipoDellaSelezione([togliere, aggiungere])).toBeNull();
    expect(tipoDellaSelezione([])).toBeNull();
  });

  it("una vettura già tolta esce dall'andamento dopo l'ultima settimana in cui c'era", () => {
    const a = andamentoPerimetro(settimane, [v("1", "FAA.", "2026-10-12", "gia_tolta", null, "2026-10-16"), v("2", "FFF.", "2026-10-12")]);
    expect(a.map(w => w.F + w.P + w.M + w.A)).toEqual([2, 1, 1, 0]);
  });

  it("la giornata di esercizio nel browser: Roma, taglio alle 03:00", () => {
    expect(oggiDiEsercizio(new Date("2026-11-03T01:30:00Z"))).toBe("2026-11-02"); // 02:30 a Roma
    expect(oggiDiEsercizio(new Date("2026-11-03T02:30:00Z"))).toBe("2026-11-03"); // 03:30 a Roma
  });

  it("il lunedì di una giornata", () => {
    expect(lunediDi("2026-11-08")).toBe("2026-11-02");
    expect(lunediDi("2026-11-02")).toBe("2026-11-02");
  });
});
