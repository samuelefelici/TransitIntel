/**
 * Il parco dell'officina (FleetCare) dentro l'AVM: la traduzione del numero
 * di parco, la scelta del tenant, le vetture che l'officina toglie dalle
 * segnalazioni e i mezzi che l'AVM non ha mai visto.
 *
 * I casi vengono dal confronto del 6/10/2026 fra il parco dell'officina
 * (245 mezzi) e le 277 matricole Conerobus di SIRI.
 */
import { describe, it, expect } from "vitest";
import {
  matricolaDaNumeroDiParco, costruisciParco, mezziSenzaAvm, parcoCredibile,
  type RigaParcoAvm, type MezzoOfficina,
} from "../lib/officina";
import {
  analizzaDiario, esclusioneOfficina, type RigaDiario,
} from "../lib/avm-diario";

function riga(p: Partial<RigaParcoAvm> & { fleet_number: string }): RigaParcoAvm {
  return {
    tenant: "demo", plate: "AN" + p.fleet_number, status: "in_service", deposito: "ANCONA",
    modello: null, fermo_dal: null, fermo_motivo: null, commessa: null,
    segnalazione_avm: null, segnalazione_avm_fonte: null, segnalazione_avm_dal: null,
    ...p,
  };
}

function mezzo(matricola: string, p: Partial<MezzoOfficina> = {}): MezzoOfficina {
  return {
    matricola, numeroDiParco: matricola.padStart(4, "0"), targa: "T" + matricola,
    stato: "in_servizio", deposito: "ANCONA", modello: null, fermoDal: null, fermoMotivo: null,
    commessa: null, segnalazioneAvm: null, ...p,
  };
}

describe("dal numero di parco alla matricola SIRI", () => {
  it("l'officina scrive gli zeri davanti, SIRI no", () => {
    expect(matricolaDaNumeroDiParco("0010")).toBe("10");
    expect(matricolaDaNumeroDiParco("0263")).toBe("263");
    expect(matricolaDaNumeroDiParco("1372")).toBe("1372");
    expect(matricolaDaNumeroDiParco("0000")).toBe("0");
  });

  it("un codice con le lettere passa dalla transcodifica FlashNet", () => {
    expect(matricolaDaNumeroDiParco("CJ096")).toBe("11096");
    expect(matricolaDaNumeroDiParco("AF002")).toBeNull();
    expect(matricolaDaNumeroDiParco("  ")).toBeNull();
  });
});

describe("la scelta del tenant", () => {
  const LETTO = "2026-10-06T10:00:00.000Z";

  it("con un tenant solo si usa quello, e le righe diventano mezzi", () => {
    const p = costruisciParco([
      riga({ fleet_number: "0263", status: "grounded", fermo_dal: "2026-10-02T06:00:00Z", fermo_motivo: "Guasto meccanico", commessa: "WO-1" }),
      riga({ fleet_number: "0229", status: "decommissioned" }),
      riga({ fleet_number: "1372", segnalazione_avm: "S-123", segnalazione_avm_fonte: "gestionale", segnalazione_avm_dal: new Date("2026-09-26T08:00:00Z") }),
    ], null, LETTO);
    expect(p.disponibile).toBe(true);
    expect(p.tenant).toBe("demo");
    expect(p.mezzi.map(m => [m.matricola, m.stato])).toEqual([
      ["263", "in_officina"], ["229", "dismesso"], ["1372", "in_servizio"],
    ]);
    expect(p.mezzi[0].fermoDal).toBe("2026-10-02T06:00:00.000Z");
    expect(p.mezzi[2].segnalazioneAvm).toEqual({ numero: "S-123", fonte: "gestionale", dal: "2026-09-26T08:00:00.000Z" });
  });

  it("con più tenant non sceglie a caso: chiede FLEETCARE_TENANT", () => {
    const righe = [riga({ fleet_number: "0010" }), riga({ fleet_number: "0010", tenant: "altra" })];
    const senza = costruisciParco(righe, null, LETTO);
    expect(senza.disponibile).toBe(false);
    expect(senza.motivo).toContain("FLEETCARE_TENANT");
    const con = costruisciParco(righe, "altra", LETTO);
    expect(con.tenant).toBe("altra");
    expect(con.mezzi).toHaveLength(1);
    const sbagliato = costruisciParco(righe, "nessuno", LETTO);
    expect(sbagliato.disponibile).toBe(false);
    expect(sbagliato.motivo).toContain("altra, demo");
  });

  it("un parco vuoto non è un parco disponibile", () => {
    expect(costruisciParco([], null, LETTO).disponibile).toBe(false);
  });
});

describe("i mezzi del parco che l'AVM non ha mai visto", () => {
  it("in servizio o fermi sì, dismessi no", () => {
    const parco = costruisciParco([
      riga({ fleet_number: "0467" }), riga({ fleet_number: "0263" }),
      riga({ fleet_number: "1401", status: "grounded" }),
      riga({ fleet_number: "0229", status: "decommissioned" }),
    ], null, "x");
    expect(mezziSenzaAvm(parco, ["263", "10"]).map(m => m.matricola)).toEqual(["467", "1401"]);
  });

  it("senza parco non c'è niente da dire", () => {
    expect(mezziSenzaAvm({ disponibile: false, motivo: "x", tenant: null, lettoAlle: "x", mezzi: [] }, [])).toEqual([]);
  });
});

describe("che cosa l'officina spiega", () => {
  it("una vettura che l'officina non ha più si toglie dall'anagrafica, anche se funziona", () => {
    expect(esclusioneOfficina("452", "funziona", undefined)?.motivo).toBe("fuori_parco");
    expect(esclusioneOfficina("229", "muta", mezzo("229", { stato: "dismesso" }))?.motivo).toBe("dismesso");
  });

  it("una vettura che funziona non ha bisogno di spiegazioni", () => {
    expect(esclusioneOfficina("263", "funziona", mezzo("263", { stato: "in_officina" }))).toBeNull();
  });

  it("ferma in officina: il silenzio si spiega col fermo, con data, motivo e commessa", () => {
    const e = esclusioneOfficina("263", "muta", mezzo("263", {
      stato: "in_officina", fermoDal: "2026-10-02T06:00:00.000Z", fermoMotivo: "Guasto meccanico", commessa: "WO-1",
    }));
    expect(e?.motivo).toBe("in_officina");
    expect(e?.testo).toContain("dal 02/10/2026 (Guasto meccanico), commessa WO-1");
  });

  it("già segnalata in FleetCare: niente seconda segnalazione", () => {
    const e = esclusioneOfficina("1372", "non_attivata", mezzo("1372", {
      segnalazioneAvm: { numero: "S-123", fonte: "gestionale", dal: "2026-09-26T08:00:00.000Z" },
    }));
    expect(e?.motivo).toBe("gia_segnalata");
    expect(e?.testo).toContain("S-123, gestionale, dal 26/09/2026");
  });

  it("le consorziate non si giudicano col parco Conerobus", () => {
    expect(esclusioneOfficina("11096", "muta", undefined)).toBeNull();
  });

  it("una vettura in servizio e muta resta da segnalare", () => {
    expect(esclusioneOfficina("440", "muta", mezzo("440"))).toBeNull();
  });
});

describe("il diario con l'officina", () => {
  function r(giorno: string, vehicleRef: string, p: Partial<RigaDiario> = {}): RigaDiario {
    return {
      giorno, vehicleRef, letture: 700, lettureFresche: 0, lettureMonitorata: 0, letturePosizione: 0,
      lettureCorsa: 0, lettureErroreGps: 0, lettureErroreGprs: 0, lettureInRimessa: 0,
      primoContatto: null, ultimoContatto: null, linee: [], corse: [], ...p,
    };
  }
  const giorni = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const righe: RigaDiario[] = [];
  for (const g of giorni) {
    righe.push(r(g, "430", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 3, corse: [g] }));
    righe.push(r(g, "229"));            // muta, dismessa per l'officina
    righe.push(r(g, "263"));            // muta, ferma in officina
    righe.push(r(g, "440"));            // muta, in servizio: da segnalare
    righe.push(r(g, "1228"));           // muta, non è nel parco
    righe.push(r(g, "11096"));          // muta, consorziata: fuori dal giudizio dell'officina
    righe.push(r(g, "1372", { lettureFresche: 9 }));   // parla e non si localizza, già segnalata
  }
  const officina = new Map<string, MezzoOfficina>([
    ["430", mezzo("430")],
    ["229", mezzo("229", { stato: "dismesso" })],
    ["263", mezzo("263", { stato: "in_officina", fermoDal: "2026-09-30T06:00:00.000Z" })],
    ["440", mezzo("440")],
    ["1372", mezzo("1372", { segnalazioneAvm: { numero: "S-123", fonte: "conducenti", dal: null } })],
  ]);

  it("senza officina il diario è quello di sempre", () => {
    const d = analizzaDiario(righe, giorni);
    expect(d.riepilogo.daSegnalare).toBe(6);
    expect(d.riepilogo.esclusiOfficina).toEqual([]);
    expect(d.vetture.every(v => v.officina === null && v.esclusa === null)).toBe(true);
  });

  it("con l'officina le vetture spiegate escono da segnalazioni e conteggi", () => {
    const d = analizzaDiario(righe, giorni, officina);
    const per = (ref: string) => d.vetture.find(v => v.vehicleRef === ref)!;
    expect(per("229").esclusa?.motivo).toBe("dismesso");
    expect(per("263").esclusa?.motivo).toBe("in_officina");
    expect(per("1228").esclusa?.motivo).toBe("fuori_parco");
    expect(per("1372").esclusa?.motivo).toBe("gia_segnalata");
    expect(per("440").esclusa).toBeNull();
    expect(per("11096").esclusa).toBeNull();
    /* l'esito resta quello visto dall'AVM, cambia solo a chi scrivere */
    expect(per("229").esito).toBe("muta");
    expect(per("229").destinatario).toBe("nessuno");
    expect(per("430").officina?.targa).toBe("T430");

    const segnalate = d.segnalazioni.flatMap(s => s.matricole).sort();
    expect(segnalate).toEqual(["11096", "440"]);
    expect(d.riepilogo.daSegnalare).toBe(2);
    expect(d.riepilogo.esclusiOfficina.map(x => [x.motivo, x.matricole])).toEqual([
      ["fuori_parco", ["1228"]], ["dismesso", ["229"]], ["in_officina", ["263"]], ["gia_segnalata", ["1372"]],
    ]);
    expect(d.nota).toContain("Altre 4 le spiega l'officina");
    /* nessun avviso per chi l'officina spiega */
    expect(d.avvisi.flatMap(a => a.matricole)).not.toContain("1372");
  });
});

describe("un parco dell'officina che non somiglia a quello dell'AVM non si usa", () => {
  const parco = costruisciParco(
    ["0010", "0263", "0440", "1372"].map(n => riga({ fleet_number: n })), null, "x");

  it("con più di metà delle Conerobus riconosciute il parco vale", () => {
    expect(parcoCredibile(parco, ["10", "263", "440", "999", "11096"]).disponibile).toBe(true);
  });

  it("con meno di metà risulta non disponibile, e dice perché", () => {
    const p = parcoCredibile(parco, ["10", "501", "502", "503", "504", "11096"]);
    expect(p.disponibile).toBe(false);
    expect(p.mezzi).toEqual([]);
    expect(p.motivo).toContain("solo 1 delle 5 matricole Conerobus");
  });

  it("le consorziate non contano, e senza Conerobus non si giudica", () => {
    expect(parcoCredibile(parco, ["11096", "10003"]).disponibile).toBe(true);
  });
});
