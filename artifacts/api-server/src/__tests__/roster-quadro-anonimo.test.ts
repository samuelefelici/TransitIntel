/**
 * Il quadro del roster senza nomi (lib/roster-quadro-anonimo.ts): i conteggi
 * per deposito, i turni scoperti col codice, e niente che porti alle persone,
 * anche quando il calcolo da cui nasce ha nomi, id e titolari.
 */
import { describe, it, expect } from "vitest";
import { GIORNI_MASSIMI_QUADRO, giorniDelPeriodo, quadroDelGiorno, type CalcoloDelGiorno } from "../lib/roster-quadro-anonimo";

const NORD = "Deposito Nord", SUD = "Deposito Sud";
const turno = (codice: string, inizio: string, deposito: string | null, titolare: { id: string; nome: string } | null = null) =>
  ({ dssId: "d1", codice, inizio, fine: null, deposito, titolare });

/* lo stesso giorno della prova sul database (roster-copri-scoperti-db): G1 col titolare assente, G2 e G5 senza
   nessuno al Nord, G3 senza nessuno al Sud e senza candidati, G4 coperto */
const calcolo: CalcoloDelGiorno = {
  pubblicato: true,
  daCoprire: [],
  turni: [
    { deposito: NORD, daCoprire: true, titolareAssente: true },
    { deposito: NORD, daCoprire: true, titolareAssente: false },
    { deposito: SUD, daCoprire: true, titolareAssente: false },
    { deposito: NORD, daCoprire: false, titolareAssente: false },
    { deposito: NORD, daCoprire: true, titolareAssente: false },
  ],
  coperture: [
    { turno: turno("G1", "06:00", NORD, { id: "id-titolare", nome: "TITOLARE Mario" }), driverId: "id-scarico", nome: "SCARICO Anna", gruppo: "libero" },
    { turno: turno("G2", "10:00", NORD), driverId: "id-alba", nome: "ALBA Luca", gruppo: "libero" },
    { turno: turno("G5", "18:00", NORD), driverId: "id-carico", nome: "CARICO Rita", gruppo: "libero" },
  ],
  scoperti: [{ turno: turno("G3", "14:00", SUD), motivo: "nessun_candidato" }],
  liberi: [
    { deposito: NORD, disposizione: false }, { deposito: NORD, disposizione: false },
    { deposito: NORD, disposizione: false }, { deposito: NORD, disposizione: true },
  ],
  assenti: [{ deposito: NORD }, { deposito: NORD }],
};

describe("il quadro del roster senza nomi", () => {
  it("conta per deposito quello che il calcolo ha visto", () => {
    const q = quadroDelGiorno("2032-06-15", calcolo);
    expect(q.pubblicato).toBe(true);
    expect(q.depositi.map(d => d.deposito)).toEqual([NORD, SUD]);
    const [nord, sud] = q.depositi;
    expect(nord).toMatchObject({ turni: 4, coperti: 1, daCoprire: 3, senzaConducente: 2, titolareAssente: 1, proponibili: 3,
      senzaCandidati: 0, candidatiFiniti: 0, liberi: 4, aDisposizione: 1, assenti: 2, scoperti: [] });
    expect(sud).toMatchObject({ turni: 1, coperti: 0, daCoprire: 1, senzaConducente: 1, proponibili: 0, senzaCandidati: 1, liberi: 0, assenti: 0 });
    expect(sud!.scoperti).toEqual([{ turno: "G3", inizio: "14:00", fine: null, motivo: "nessun_candidato" }]);
  });

  it("non porta nomi, id delle persone né titolari, nemmeno se il calcolo li ha", () => {
    const testo = JSON.stringify(quadroDelGiorno("2032-06-15", calcolo));
    for (const vietato of ["TITOLARE", "Mario", "SCARICO", "ALBA", "CARICO", "id-titolare", "id-scarico", "id-alba", "id-carico", "driverId", "nome", "titolare\""]) {
      expect(testo).not.toContain(vietato);
    }
  });

  it("le chiavi sono quelle della lista chiusa, nient'altro", () => {
    const [nord] = quadroDelGiorno("2032-06-15", calcolo).depositi;
    expect(Object.keys(nord!).sort()).toEqual(["aDisposizione", "assenti", "candidatiFiniti", "coperti", "daCoprire", "deposito", "liberi",
      "proponibili", "scoperti", "senzaCandidati", "senzaConducente", "titolareAssente", "turni"]);
    const [, sud] = quadroDelGiorno("2032-06-15", calcolo).depositi;
    expect(Object.keys(sud!.scoperti[0]!).sort()).toEqual(["fine", "inizio", "motivo", "turno"]);
  });

  it("un giorno non pubblicato, il filtro per deposito, i senza deposito, gli scoperti in ordine", () => {
    expect(quadroDelGiorno("2032-06-16", { ...calcolo, pubblicato: false })).toEqual({ giorno: "2032-06-16", pubblicato: false, depositi: [] });
    expect(quadroDelGiorno("2032-06-15", calcolo, "sud").depositi.map(d => d.deposito)).toEqual([SUD]);
    const q = quadroDelGiorno("2032-06-15", {
      ...calcolo, coperture: [], turni: [{ deposito: null, daCoprire: true, titolareAssente: false }], liberi: [], assenti: [],
      scoperti: [{ turno: turno("B2", "09:00", null), motivo: "candidati_finiti" }, { turno: turno("B1", "05:30", null), motivo: "nessun_candidato" }],
    });
    expect(q.depositi.map(d => d.deposito)).toEqual(["Senza deposito"]);
    expect(q.depositi[0]!.scoperti.map(s => s.turno)).toEqual(["B1", "B2"]);
    expect(q.depositi[0]).toMatchObject({ senzaCandidati: 1, candidatiFiniti: 1 });
  });

  it("il periodo: da dal ad al compresi, al più quattordici giorni", () => {
    expect(giorniDelPeriodo("2032-02-27", "2032-03-01", GIORNI_MASSIMI_QUADRO)).toEqual(["2032-02-27", "2032-02-28", "2032-02-29", "2032-03-01"]);
    expect(giorniDelPeriodo("2032-06-15", "2032-06-15", GIORNI_MASSIMI_QUADRO)).toEqual(["2032-06-15"]);
    expect(giorniDelPeriodo("2032-06-15", "2032-06-14", GIORNI_MASSIMI_QUADRO)).toBeNull();
    expect(giorniDelPeriodo("2032-06-01", "2032-06-14", GIORNI_MASSIMI_QUADRO)).toHaveLength(14);
    expect(giorniDelPeriodo("2032-06-01", "2032-06-15", GIORNI_MASSIMI_QUADRO)).toBeNull();
  });
});
