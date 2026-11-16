/**
 * La proposta dall'AVM (tappa 4.4): la funzione pura, senza database. I casi
 * sono quelli di un giorno vero: corse viste per intero, a metà, da due
 * vetture, solo dichiarate, non viste; riconosciute per id, codice o numero;
 * viaggi dell'AVM che il programma non ha.
 */
import { describe, it, expect } from "vitest";
import { proponi, secondi, orarioDi, SOGLIE, type CorsaDaProporre, type TransitoAvm, type ViaggioAvm, type DatiProposta } from "../lib/esercizio-proposta";

const fermate = (n: number, prefisso = "F") => Array.from({ length: n }, (_, i) => ({ seq: i + 1, stopId: `${prefisso}${i + 1}` }));
const corsa = (chiave: string, x: Partial<CorsaDaProporre> = {}): CorsaDaProporre => ({
  chiave, codice: null, numero: chiave.replace(/\D/g, "") || "0", linea: "1", partenza: "07:00:00", arrivo: "07:30:00",
  vssId: null, turnoMacchina: null, dssId: null, turnoGuida: null, fermate: fermate(10), ...x,
});
/** passaggi alle posizioni indicate (da 0), un minuto l'una dall'altra a partire da `da` (secondi) */
const passaggi = (trip: string, posizioni: number[], da: number, vettura: string | null = "V1", prefisso = "F"): TransitoAvm[] =>
  posizioni.map((i) => ({ trip, stopId: `${prefisso}${i + 1}`, seq: i + 1, sec: da + i * 60, vettura }));
const viaggio = (journeyRef: string, x: Partial<ViaggioAvm> = {}): ViaggioAvm => ({
  journeyRef, trip: null, vettura: "V1", linea: "1", numero: null, partenza: "07:00", destinazione: null, osservazioni: 3, ...x,
});
const dati = (x: Partial<DatiProposta>): DatiProposta => ({ corse: [], transiti: [], viaggi: [], codiceDi: new Map(), turniGuidaScoperti: null, ...x });
const SETTE = 7 * 3600;

describe("proponi", () => {
  it("vista dal capolinea all'ultima fermata con una vettura: effettuata (AVM), con partenza reale e ritardo", () => {
    const e = proponi(dati({ corse: [corsa("c1")], transiti: passaggi("c1", [0, 4, 9], SETTE + 90) }));
    expect(e.perCorsa.get("c1")).toEqual({ proposta: "effettuata_avm", prove: expect.objectContaining({
      modo: "id", trip: ["c1"], programmate: 10, osservate: 3, prima: 1, ultima: 10, vetture: ["V1"],
      partenzaReale: "07:01:30", ritardoPartenza: 90, dichiarata: false,
    }) });
  });

  it("senza il capolinea ma con quasi tutte le fermate: effettuata; con poche fermate e nessun segnale: da verificare", () => {
    const e = proponi(dati({
      corse: [corsa("c1"), corsa("c2")],
      transiti: [...passaggi("c1", [1, 2, 3, 4, 5, 6, 7, 8], SETTE), ...passaggi("c2", [2, 3, 4], SETTE, "V2")],
    }));
    expect(e.perCorsa.get("c1")!.proposta).toBe("effettuata_avm");
    expect(e.perCorsa.get("c1")!.prove.partenzaReale).toBeNull();
    expect(e.perCorsa.get("c2")).toMatchObject({ proposta: "da_verificare", prove: { motivo: "fermate osservate non sufficienti" } });
  });

  it("due vetture sulla stessa corsa: da verificare, mai effettuata", () => {
    const e = proponi(dati({ corse: [corsa("c1")], transiti: [...passaggi("c1", [0, 1, 2, 3, 4], SETTE, "V1"), ...passaggi("c1", [5, 6, 7, 8, 9], SETTE, "V2")] }));
    expect(e.perCorsa.get("c1")).toMatchObject({ proposta: "da_verificare", prove: { motivo: "più vetture sulla stessa corsa", vetture: ["V1", "V2"] } });
  });

  it("partita e poi la vettura passa a un'altra corsa prima dell'arrivo: indizio di parziale", () => {
    const e = proponi(dati({
      corse: [corsa("c1"), corsa("c2", { partenza: "07:15:00", arrivo: "07:45:00" })],
      transiti: [...passaggi("c1", [0, 1, 2, 3], SETTE), ...passaggi("c2", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], SETTE + 15 * 60)],
    }));
    expect(e.perCorsa.get("c1")).toMatchObject({ proposta: "parziale", prove: { prima: 1, ultima: 4 } });
    expect(e.perCorsa.get("c2")!.proposta).toBe("effettuata_avm");
  });

  it("partita e poi la vettura non si vede più (fuori servizio): parziale; se poi riprende sulla stessa corsa più tardi no", () => {
    expect(proponi(dati({ corse: [corsa("c1")], transiti: passaggi("c1", [0, 1, 2], SETTE) })).perCorsa.get("c1")!.proposta).toBe("parziale");
    // la vettura riappare molto dopo l'arrivo su un'altra corsa: un buco nelle prove, non un parziale
    const e = proponi(dati({
      corse: [corsa("c1"), corsa("c9", { partenza: "10:00:00", arrivo: "10:30:00" })],
      transiti: [...passaggi("c1", [0, 1, 2], SETTE), ...passaggi("c9", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 10 * 3600)],
    }));
    expect(e.perCorsa.get("c1")!.proposta).toBe("da_verificare");
  });

  it("riconosciuta per codice stabile (id di un altro feed) e per numero solo se unico nel giorno", () => {
    const e = proponi(dati({
      corse: [corsa("c1", { codice: "689_A_100", numero: "100" }), corsa("c2", { numero: "200" }), corsa("c3", { numero: "300" }), corsa("c4", { numero: "300" })],
      transiti: [...passaggi("altro-feed-1", [0, 9], SETTE), ...passaggi("uuid-vecchio", [0, 9], SETTE, "V7")],
      viaggi: [viaggio("j2", { numero: "200", vettura: "V2" }), viaggio("j3", { numero: "300" })],
      codiceDi: new Map([["uuid-vecchio", "689_A_100"]]),
    }));
    expect(e.perCorsa.get("c1")).toMatchObject({ proposta: "effettuata_avm", prove: { modo: "codice", trip: ["uuid-vecchio"], vetture: ["V7"] } });
    expect(e.perCorsa.get("c2")).toMatchObject({ proposta: "da_verificare", prove: { modo: "numero", dichiarata: true, motivo: "viaggio dichiarato dall'AVM, senza passaggi alle fermate" } });
    // 300 è ripetuto: non si attribuisce a nessuna delle due
    expect(e.perCorsa.get("c3")!.prove.modo).toBeNull();
    expect(e.perCorsa.get("c4")!.prove.modo).toBeNull();
    expect(e.aggiunte.map((a) => a.chiaveAvm)).toEqual(["j3", "trip:altro-feed-1"]);
    expect(e.riepilogo.perModo).toEqual({ id: 0, codice: 1, numero: 1 });
  });

  it("anche per numero i passaggi del viaggio vanno alla sua corsa", () => {
    const e = proponi(dati({
      corse: [corsa("c1", { numero: "477789" })],
      viaggi: [viaggio("j1", { trip: "id-sconosciuto", numero: "477789" })],
      transiti: passaggi("id-sconosciuto", [0, 5, 9], SETTE),
    }));
    expect(e.perCorsa.get("c1")).toMatchObject({ proposta: "effettuata_avm", prove: { modo: "numero", osservate: 3, dichiarata: true } });
    expect(e.aggiunte).toEqual([]);
  });

  it("continuità: la stessa vettura effettua la corsa prima e quella dopo del turno macchina", () => {
    const tm = { vssId: "vss", turnoMacchina: "M1" };
    const e = proponi(dati({
      corse: [
        corsa("a", { ...tm, partenza: "07:00:00", arrivo: "07:30:00" }),
        corsa("b", { ...tm, partenza: "07:40:00", arrivo: "08:10:00" }),
        corsa("c", { ...tm, partenza: "08:20:00", arrivo: "08:50:00" }),
        corsa("d", { ...tm, partenza: "09:00:00", arrivo: "09:30:00" }),
      ],
      transiti: [...passaggi("a", [0, 9], SETTE), ...passaggi("c", [0, 9], SETTE + 80 * 60)],
    }));
    expect(e.perCorsa.get("b")).toMatchObject({ proposta: "continuita", prove: { continuita: { prima: "a", dopo: "c", vettura: "V1" } } });
    // l'ultima del turno non ha una successiva: resta non rilevata
    expect(e.perCorsa.get("d")!.proposta).toBe("non_rilevata");
  });

  it("niente continuità se le vetture prima e dopo sono diverse o se la corsa ha una vettura diversa", () => {
    const tm = { vssId: "vss", turnoMacchina: "M1" };
    const corse = [corsa("a", { ...tm, partenza: "07:00:00" }), corsa("b", { ...tm, partenza: "07:40:00" }), corsa("c", { ...tm, partenza: "08:20:00" })];
    const diverse = proponi(dati({ corse, transiti: [...passaggi("a", [0, 9], SETTE, "V1"), ...passaggi("c", [0, 9], SETTE + 80 * 60, "V2")] }));
    expect(diverse.perCorsa.get("b")!.proposta).toBe("non_rilevata");
    const contraria = proponi(dati({
      corse, transiti: [...passaggi("a", [0, 9], SETTE), ...passaggi("c", [0, 9], SETTE + 80 * 60)],
      viaggi: [viaggio("jb", { trip: "b", vettura: "V9" })],
    }));
    expect(contraria.perCorsa.get("b")!.proposta).toBe("da_verificare");
  });

  it("nessuna prova e turno guida senza conducente: indizio di soppressione; senza roster resta non rilevata", () => {
    const c = corsa("c1", { dssId: "dss", turnoGuida: "G7" });
    expect(proponi(dati({ corse: [c], turniGuidaScoperti: new Set(["dss|G7"]) })).perCorsa.get("c1"))
      .toMatchObject({ proposta: "soppressione_indizio", prove: { motivo: "turno guida senza conducente nel roster" } });
    expect(proponi(dati({ corse: [c], turniGuidaScoperti: null })).perCorsa.get("c1")!.proposta).toBe("non_rilevata");
    // con le prove dell'AVM, il roster non conta
    expect(proponi(dati({ corse: [c], transiti: passaggi("c1", [0, 9], SETTE), turniGuidaScoperti: new Set(["dss|G7"]) })).perCorsa.get("c1")!.proposta).toBe("effettuata_avm");
  });

  it("una linea circolare: la stessa fermata a inizio e fine si distingue col progressivo", () => {
    const giro = [{ seq: 1, stopId: "P" }, { seq: 2, stopId: "Q" }, { seq: 3, stopId: "R" }, { seq: 4, stopId: "P" }];
    const e = proponi(dati({
      corse: [corsa("c1", { fermate: giro })],
      transiti: [{ trip: "c1", stopId: "P", seq: 1, sec: SETTE, vettura: "V1" }, { trip: "c1", stopId: "P", seq: 4, sec: SETTE + 1500, vettura: "V1" }],
    }));
    expect(e.perCorsa.get("c1")!.prove).toMatchObject({ prima: 1, ultima: 4 });
    expect(e.perCorsa.get("c1")!.proposta).toBe("effettuata_avm");
    // senza progressivo la fermata ripetuta non si sa dove stia: non conta
    const senza = proponi(dati({ corse: [corsa("c1", { fermate: giro })], transiti: [{ trip: "c1", stopId: "P", seq: null, sec: SETTE, vettura: "V1" }] }));
    expect(senza.perCorsa.get("c1")!.prove.osservate).toBe(0);
  });

  it("annullata dall'AVM (giornale, 4.5) e senza prove: indizio di soppressione; con le prove conta la corsa vista", () => {
    const cancellate = new Set(["c1", "c2"]);
    const e = proponi(dati({ corse: [corsa("c1"), corsa("c2")], transiti: passaggi("c2", [0, 9], SETTE), cancellate }));
    expect(e.perCorsa.get("c1")).toMatchObject({ proposta: "soppressione_indizio", prove: { motivo: "annullata dall'AVM" } });
    expect(e.perCorsa.get("c2")!.proposta).toBe("effettuata_avm");
  });

  it("le candidate aggiunte: viaggi senza corsa raggruppati, coi passaggi dello stesso id", () => {
    const e = proponi(dati({
      corse: [corsa("c1")],
      viaggi: [
        viaggio("FRSRV1049", { numero: "FRSRV1049", linea: "130", partenza: "19:54", trip: "x", vettura: "V3" }),
        viaggio("FRSRV1049", { numero: "FRSRV1049", linea: "130", partenza: "19:54", trip: "x", vettura: "V4", osservazioni: 2 }),
      ],
      transiti: passaggi("x", [0, 1], 19 * 3600 + 54 * 60, "V3"),
    }));
    expect(e.aggiunte).toEqual([{
      chiaveAvm: "FRSRV1049", journeyRef: "FRSRV1049", trip: "x", linea: "130", numero: "FRSRV1049", partenza: "19:54",
      destinazione: null, vetture: ["V3", "V4"], transiti: 2, osservazioni: 5,
    }]);
    expect(e.riepilogo).toMatchObject({ viaggi: 2, viaggiRiconosciuti: 0, transiti: 2, transitiRiconosciuti: 0, aggiunte: 1 });
  });

  it("il riepilogo: conteggi per proposta e copertura, con le soglie usate", () => {
    const e = proponi(dati({ corse: [corsa("c1"), corsa("c2"), corsa("c3"), corsa("c4")], transiti: passaggi("c1", [0, 9], SETTE) }));
    expect(e.riepilogo).toMatchObject({
      corse: 4, conProve: 1, copertura: 25, soglie: SOGLIE,
      perProposta: { effettuata_avm: 1, parziale: 0, continuita: 0, da_verificare: 0, soppressione_indizio: 0, non_rilevata: 3 },
    });
  });

  it("orari: oltre le 24, e niente orari inventati", () => {
    expect(secondi("24:10:00")).toBe(87000);
    expect(secondi("7:05")).toBe(25500);
    expect(secondi("xx")).toBeNull();
    expect(orarioDi(87000)).toBe("24:10:00");
    expect(orarioDi(null)).toBeNull();
  });
});
