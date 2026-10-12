/**
 * Il controllo settimanale: chi ha ripreso a localizzarsi, chi ha smesso,
 * chi è ancora guasto, e che cosa hanno prodotto gli interventi.
 *
 * Le settimane sono quelle vere dell'autunno 2026: il controllo guarda la
 * settimana dal 5 all'11 ottobre (lunedì–domenica) e, per la storia, le sette
 * precedenti a partire dal 17 agosto.
 */
import { describe, it, expect } from "vitest";
import {
  calcolaControllo, giudicaIntervento, andamentoSettimane, contaCategorie, notaGenerale,
  lunediDi, spostaGiorni, eLunedi, ultimaSettimanaChiusa, settimanaChiusa, inizioFinestra,
  SETTIMANE_STORIA, GIORNATE_DOPO_MINIME,
  type InterventoAvm, type VetturaControllo,
} from "../lib/avm-controllo";
import { giornateDelPeriodo } from "../lib/fleet-trend";
import type { RigaDiario } from "../lib/avm-diario";
import type { MezzoOfficina } from "../lib/officina";

const LUNEDI = "2026-10-05";
const OGGI = "2026-10-12";
const INIZIO = inizioFinestra(LUNEDI);
const FINE = spostaGiorni(LUNEDI, 6);
const TUTTE = giornateDelPeriodo(INIZIO, FINE);

function riga(giorno: string, vehicleRef: string, p: Partial<RigaDiario> = {}): RigaDiario {
  return {
    giorno, vehicleRef, letture: 700, lettureFresche: 0, lettureMonitorata: 0, letturePosizione: 0,
    lettureCorsa: 0, lettureErroreGps: 0, lettureErroreGprs: 0, lettureInRimessa: 0,
    primoContatto: null, ultimoContatto: null, linee: [], corse: [], ...p,
  };
}
const posizione = { lettureFresche: 9, letturePosizione: 9 };
const corsa = { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 4 };
const parla = { lettureFresche: 9 };

function mezzo(matricola: string, p: Partial<MezzoOfficina> = {}): MezzoOfficina {
  return {
    matricola, numeroDiParco: matricola.padStart(4, "0"), targa: "T" + matricola,
    stato: "in_servizio", deposito: "ANCONA", modello: null, fermoDal: null, fermoMotivo: null,
    commessa: null, segnalazioneAvm: null, ...p,
  };
}

/** Il parco di prova: una vettura per categoria, più una che tiene piena la raccolta. */
function parcoDiProva(): RigaDiario[] {
  const r: RigaDiario[] = [];
  for (const g of TUTTE) {
    r.push(riga(g, "430", corsa));                                         // funziona sempre
    r.push(riga(g, "263", g >= "2026-10-07" ? posizione : {}));           // ripresa il 7 ottobre
    r.push(riga(g, "440", g <= "2026-10-02" ? corsa : g >= LUNEDI ? parla : {})); // fermata: parla
    r.push(riga(g, "1314", g <= "2026-09-30" ? posizione : {}));           // fermata: muta
    r.push(riga(g, "229"));                                                 // guasta, muta
    r.push(riga(g, "1372", { ...parla, lettureErroreGps: 9 }));             // guasta, parla con errore GPS
    if (g >= LUNEDI) r.push(riga(g, "11108", posizione));                   // nuova
    if (g < LUNEDI) r.push(riga(g, "12056", posizione));                    // uscita
  }
  return r;
}

const per = (c: { vetture: VetturaControllo[] }, ref: string) => c.vetture.find(v => v.vehicleRef === ref)!;

describe("le settimane", () => {
  it("il lunedì, la settimana chiusa e la finestra", () => {
    expect(lunediDi("2026-10-11")).toBe("2026-10-05");   // domenica
    expect(lunediDi("2026-10-05")).toBe("2026-10-05");   // lunedì
    expect(lunediDi("2026-10-08")).toBe("2026-10-05");
    expect(eLunedi("2026-10-05")).toBe(true);
    expect(eLunedi("2026-10-06")).toBe(false);
    expect(eLunedi("2026-13-40")).toBe(false);
    expect(eLunedi("2026-02-30")).toBe(false);                 // Date lo sposterebbe al 2 marzo
    expect(ultimaSettimanaChiusa("2026-10-12")).toBe("2026-10-05");
    expect(ultimaSettimanaChiusa("2026-10-11")).toBe("2026-09-28");
    expect(settimanaChiusa("2026-10-05", "2026-10-11")).toBe(false);
    expect(settimanaChiusa("2026-10-05", "2026-10-12")).toBe(true);
    expect(INIZIO).toBe("2026-08-17");
    expect(TUTTE).toHaveLength(7 * SETTIMANE_STORIA);
  });
});

describe("le categorie", () => {
  const c = calcolaControllo({ righe: parcoDiProva(), lunedi: LUNEDI, oggi: OGGI, generatoIl: "x" });

  it("una vettura per categoria", () => {
    expect(per(c, "430").categoria).toBe("funziona");
    expect(per(c, "263").categoria).toBe("ripresa");
    expect(per(c, "440").categoria).toBe("fermata");
    expect(per(c, "1314").categoria).toBe("fermata");
    expect(per(c, "229").categoria).toBe("guasta");
    expect(per(c, "1372").categoria).toBe("guasta");
    expect(per(c, "11108").categoria).toBe("nuova");
    expect(per(c, "12056").categoria).toBe("uscita");
    expect(c.conteggi).toEqual({
      fermata: 2, ripresa: 1, guasta: 2, nuova: 1, uscita: 1, funziona: 1, non_giudicabile: 0,
    });
    expect(c.settimana.chiusa).toBe(true);
  });

  it("l'ordine di lettura: prima chi si è fermato, poi chi ha ripreso", () => {
    expect(c.vetture.map(v => v.vehicleRef)).toEqual(
      ["440", "1314", "263", "229", "1372", "11108", "12056", "430"]);
  });

  it("la ripresa porta il giorno in cui è ricominciata e da quanto taceva", () => {
    const v = per(c, "263");
    expect(v.dal).toBe("2026-10-07");
    expect(v.settimana).toMatchObject({ stato: "F", conPosizione: 5, giornateOsservate: 7 });
    expect(v.prima).toMatchObject({ lunedi: "2026-09-28", stato: "M" });
    expect(v.nota).toContain("Si localizza di nuovo dal 07/10: 5 su 7 giornate");
    expect(v.nota).toContain("Non si localizzava in nessuna giornata contata dal 17/08");
  });

  it("chi si è fermato porta il primo giorno senza posizione, l'ultima posizione e il probabile perché", () => {
    const parlante = per(c, "440");
    expect(parlante.dal).toBe("2026-10-03");
    expect(parlante.ultimaPosizione).toBe("2026-10-02");
    expect(parlante.giorniSenzaPosizione).toBe(9);
    expect(parlante.settimana.stato).toBe("P");
    expect(parlante.nota).toContain("Ultima posizione il 02/10; da allora 9 giornate contate senza");
    expect(parlante.nota).toContain("antenna e GPS");
    const muta = per(c, "1314");
    expect(muta.dal).toBe("2026-10-01");
    expect(muta.settimana.stato).toBe("M");
    expect(muta.nota).toContain("Non dà più segno");
  });

  it("le strisce: 14 giornate e 8 settimane", () => {
    expect(c.giornate).toHaveLength(14);
    expect(c.giornate[0]).toBe("2026-09-28");
    expect(c.giornate[13]).toBe("2026-10-11");
    expect(per(c, "263").giorni).toBe("MMMMMMM" + "MMTTTTT");
    expect(per(c, "440").giorni).toBe("SSSSSMM" + "CCCCCCC");
    expect(per(c, "11108").giorni).toBe("-------" + "TTTTTTT");
    expect(per(c, "263").storia).toBe("MMMMMMMF");
    expect(per(c, "12056").storia).toBe("FFFFFFFA");
    expect(per(c, "11108").storia).toBe("AAAAAAAF");
  });

  it("l'andamento delle settimane si conta sulle vetture scelte", () => {
    const a = andamentoSettimane(c, c.vetture);
    expect(a).toHaveLength(SETTIMANE_STORIA);
    expect(a[7]).toMatchObject({ lunedi: LUNEDI, F: 3, P: 2, M: 2, A: 1 });
    const soloConerobus = andamentoSettimane(c, c.vetture.filter(v => /^\d{1,4}$/.test(v.vehicleRef)));
    expect(soloConerobus[7]).toMatchObject({ F: 2, P: 2, M: 2, A: 0 });
    expect(contaCategorie(c.vetture.slice(0, 3))).toMatchObject({ fermata: 2, ripresa: 1 });
  });
});

describe("i buchi del connettore", () => {
  it("se la settimana scorsa non ha raccolta, si confronta con quella prima", () => {
    const righe = parcoDiProva().map(r =>
      r.giorno >= "2026-09-28" && r.giorno <= "2026-10-04" ? { ...r, letture: 100 } : r);
    const c = calcolaControllo({ righe, lunedi: LUNEDI, oggi: OGGI });
    const v = per(c, "1314");
    expect(v.prima?.lunedi).toBe("2026-09-21");
    expect(v.categoria).toBe("fermata");
    expect(v.giorni.slice(0, 7)).toBe(".......");
    expect(c.precedente.giornateParziali).toBe(7);
  });

  it("una settimana senza raccolta non si giudica", () => {
    const righe = parcoDiProva().filter(r => r.giorno < LUNEDI);
    const c = calcolaControllo({ righe, lunedi: LUNEDI, oggi: OGGI });
    expect(c.conteggi.non_giudicabile).toBe(c.vetture.length);
    expect(c.settimana.giornateSenzaDati).toBe(7);
    expect(c.nota).toContain("non si può giudicare");
  });
});

describe("la settimana in corso", () => {
  it("oggi e i giorni a venire restano vuoti, e il risultato è provvisorio", () => {
    const c = calcolaControllo({ righe: parcoDiProva().filter(r => r.giorno <= "2026-10-08"), lunedi: LUNEDI, oggi: "2026-10-08" });
    expect(c.settimana.chiusa).toBe(false);
    expect(c.settimana.giornateFuture).toBe(4);
    expect(c.settimana.giornateOsservate).toBe(3);
    expect(per(c, "263").giorni.slice(7)).toBe("MMT    ");
    expect(c.nota).toContain("settimana in corso");
  });

  it("oggi non conta mai, nemmeno con mezza raccolta già fatta", () => {
    /* il lunedì pomeriggio un mezzo che non è ancora uscito non è «fermo» */
    const righe = parcoDiProva().filter(r => r.giorno <= "2026-10-12" && r.giorno >= "2026-08-17");
    const oggi = calcolaControllo({ righe, lunedi: LUNEDI, oggi: "2026-10-11" });
    expect(oggi.settimana.giornateOsservate).toBe(6);
    expect(per(oggi, "263").giorni.slice(7)).toBe("MMTTTT ");
  });

  it("con meno di tre giornate contate la settimana non si giudica", () => {
    const c = calcolaControllo({ righe: parcoDiProva().filter(r => r.giorno <= "2026-10-07"), lunedi: LUNEDI, oggi: "2026-10-07" });
    expect(c.settimana.giornateOsservate).toBe(2);
    expect(c.conteggi.non_giudicabile).toBe(c.vetture.length);
    expect(per(c, "440").nota).toContain("Solo 2 giornate contate in settimana");
    expect(c.nota).toContain("ne servono almeno 3 per giudicare");
  });
});

describe("l'officina", () => {
  const officina = new Map<string, MezzoOfficina>([
    ["430", mezzo("430")],
    ["263", mezzo("263")],
    ["440", mezzo("440", { stato: "in_officina", fermoDal: "2026-10-03T06:00:00.000Z", fermoMotivo: "Guasto meccanico", commessa: "LEG-1" })],
    ["1314", mezzo("1314", { stato: "riserva" })],
    ["1372", mezzo("1372", { segnalazioneAvm: { numero: "S-9", fonte: "gestionale", dal: "2026-09-20T08:00:00.000Z" } })],
    ["12056", mezzo("12056")],
  ]);
  const c = calcolaControllo({ righe: parcoDiProva(), lunedi: LUNEDI, oggi: OGGI, officina });

  it("fuori parco e dismesse sono escluse; le consorziate no", () => {
    expect(per(c, "229").esclusa?.motivo).toBe("fuori_parco");
    expect(per(c, "430").esclusa).toBeNull();
    expect(per(c, "11108").esclusa).toBeNull();
    expect(per(c, "229").nota).toContain("Non è nel parco dell'officina");
  });

  it("il fermo, la riserva e la segnalazione aperta finiscono nella nota", () => {
    expect(per(c, "440").nota).toContain("Ferma in officina dal 03/10/2026 (Guasto meccanico), commessa LEG-1");
    /* fermo in officina: nessuna diagnosi dell'apparato che contraddica il fermo */
    expect(per(c, "440").nota).not.toContain("antenna");
    expect(per(c, "1314").nota).toContain("Di riserva");
    expect(per(c, "1372").nota).toContain("Segnalazione AVM aperta in FleetCare: S-9");
    expect(per(c, "440").categoria).toBe("fermata");
  });

  it("senza officina nessuna esclusione", () => {
    const senza = calcolaControllo({ righe: parcoDiProva(), lunedi: LUNEDI, oggi: OGGI });
    expect(senza.vetture.every(v => v.esclusa === null && v.officina === null)).toBe(true);
  });
});

describe("gli interventi", () => {
  const intervento = (matricola: string, chiusaIl: string, riferimento = "LEG-" + matricola): InterventoAvm => ({
    matricola, fonte: "commessa", riferimento, apertaIl: null, chiusaIl, descrizione: "Sostituzione antenna",
    esito: "closed", commessa: riferimento,
  });
  const interventi = [
    intervento("263", "2026-10-06T15:00:00.000Z"),     // riuscito: dal 7 si localizza
    intervento("229", "2026-10-01T10:00:00.000Z"),     // senza effetto: dopo, 10 giornate mute
    intervento("440", "2026-10-11T16:00:00.000Z"),     // da verificare: nessuna giornata dopo
    intervento("430", "2026-09-15T09:00:00.000Z"),     // già funzionava
    intervento("1314", "2026-09-30T09:00:00.000Z"),    // peggiorato: dal 1° ottobre non si localizza più
    intervento("229", "2026-07-01T09:00:00.000Z", "VECCHIO"), // fuori finestra
  ];
  const c = calcolaControllo({ righe: parcoDiProva(), lunedi: LUNEDI, oggi: OGGI, interventi });

  it("ogni intervento ha il suo esito, misurato sull'apparato", () => {
    const esiti = Object.fromEntries(c.interventi.map(i => [i.riferimento, i.esitoAvm]));
    expect(esiti).toEqual({
      "LEG-430": "gia_funzionava", "LEG-1314": "peggiorato", "LEG-229": "senza_effetto",
      "LEG-263": "riuscito", "LEG-440": "da_verificare",
    });
    const riuscito = c.interventi.find(i => i.riferimento === "LEG-263")!;
    expect(riuscito).toMatchObject({ giornoChiusura: "2026-10-06", primaPosizioneDopo: "2026-10-07", posizionePrima: 0 });
  });

  it("l'intervento compare nella nota della vettura", () => {
    expect(per(c, "263").nota).toContain("Intervento LEG-263 chiuso il 06/10, riuscito, dopo si localizza.");
    expect(per(c, "229").interventi.map(i => i.riferimento)).toEqual(["LEG-229"]);
  });

  it("senza abbastanza giornate con contatto dopo, non si dice che non è servito", () => {
    const oss = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
    const i = intervento("1", "2026-10-02T09:00:00.000Z");
    const parla = () => true;
    expect(giudicaIntervento(i, oss, () => false, parla).esitoAvm).toBe("da_verificare");
    const piu = [...oss, "2026-10-05"];
    expect(giudicaIntervento(i, piu, () => false, parla).giorniDopoConContatto).toBe(GIORNATE_DOPO_MINIME);
    expect(giudicaIntervento(i, piu, () => false, parla).esitoAvm).toBe("senza_effetto");
    /* lo stesso apparato muto dopo la riparazione: il mezzo può essere in rimessa */
    expect(giudicaIntervento(i, piu, () => false, () => false).esitoAvm).toBe("da_verificare");
  });

  it("la chiusura di notte appartiene alla giornata di esercizio di prima", () => {
    /* le 02:30 di Roma del 7 ottobre sono ancora la giornata del 6 */
    const i = intervento("1", "2026-10-07T00:30:00.000Z");
    expect(giudicaIntervento(i, [], () => false).giornoChiusura).toBe("2026-10-06");
  });
});

describe("i casi trovati dalla revisione", () => {
  const giorniDa = (da: string, a: string) => giornateDelPeriodo(da, a);
  const oss = giorniDa("2026-09-14", "2026-10-11");
  const intervento = (p: Partial<InterventoAvm> & { chiusaIl: string }): InterventoAvm => ({
    matricola: "600", fonte: "commessa", riferimento: "LEG-600", apertaIl: null, descrizione: null,
    esito: "closed", commessa: "LEG-600", ...p,
  });

  it("guasto due giorni prima della riparazione: riuscita, non «si localizzava già»", () => {
    /* corse fino al 30/09, dal 01/10 parla senza posizione, segnalazione aperta il 01/10,
       chiusa il 05/10, si localizza dal 06/10 */
    const pos = (g: string) => g <= "2026-09-30" || g >= "2026-10-06";
    const i = giudicaIntervento(intervento({ apertaIl: "2026-10-01T08:00:00.000Z", chiusaIl: "2026-10-05T15:00:00.000Z" }), oss, pos, () => true);
    expect(i).toMatchObject({ esitoAvm: "riuscito", guastoPrima: true, giorniPrima: 4, posizionePrima: 0, primaPosizioneDopo: "2026-10-06" });
    /* senza la data di apertura bastano tre giornate di fila senza posizione nelle sette prima */
    const senzaApertura = giudicaIntervento(intervento({ chiusaIl: "2026-10-05T15:00:00.000Z" }), oss, pos, () => true);
    expect(senzaApertura.esitoAvm).toBe("riuscito");
  });

  it("commessa chiusa in ritardo: la ripresa prima della chiusura conta", () => {
    /* guasta dal 20/09, si localizza dal 03/10, commessa aperta il 20/09 e chiusa l'08/10 */
    const pos = (g: string) => g < "2026-09-20" || g >= "2026-10-03";
    const i = giudicaIntervento(intervento({ apertaIl: "2026-09-20T07:00:00.000Z", chiusaIl: "2026-10-08T10:00:00.000Z" }), oss, pos, () => true);
    expect(i).toMatchObject({ esitoAvm: "riuscito", ripresaIl: "2026-10-03" });
  });

  it("senza giornate contate prima, non si dice «riuscito»", () => {
    const i = giudicaIntervento(intervento({ chiusaIl: "2026-09-10T09:00:00.000Z" }), oss, () => true, () => true);
    expect(i).toMatchObject({ esitoAvm: "senza_confronto", giorniPrima: 0 });
  });

  it("riuscito e poi di nuovo zitto: ricaduta", () => {
    /* guasta fino al 15/09, intervento il 15, si localizza 16-17/09, poi più niente */
    const pos = (g: string) => g === "2026-09-16" || g === "2026-09-17";
    const i = giudicaIntervento(intervento({ apertaIl: "2026-09-14T07:00:00.000Z", chiusaIl: "2026-09-15T15:00:00.000Z" }), oss, pos, () => true);
    expect(i.esitoAvm).toBe("ricaduta");
  });

  it("le chiusure dopo la settimana si giudicano nelle settimane dopo", () => {
    const c = calcolaControllo({
      righe: parcoDiProva(), lunedi: "2026-09-21", oggi: OGGI,
      interventi: [intervento({ matricola: "229", riferimento: "LEG-229", chiusaIl: "2026-10-08T10:00:00.000Z" })],
    });
    expect(c.interventi).toEqual([]);
    expect(per(c, "229").nota).not.toContain("LEG-229");
  });

  it("un intervento su una vettura mai elencata dal flusso non sparisce", () => {
    const c = calcolaControllo({
      righe: parcoDiProva(), lunedi: LUNEDI, oggi: OGGI,
      interventi: [intervento({ matricola: "1401", riferimento: "LEG-1401", chiusaIl: "2026-10-06T10:00:00.000Z" })],
    });
    expect(c.interventi.map(i => [i.matricola, i.esitoAvm])).toEqual([["1401", "non_nel_flusso"]]);
  });

  it("la prima settimana del diario non rende «nuove» tutte le vetture", () => {
    const righe = parcoDiProva().filter(r => r.giorno >= "2026-09-14");
    const c = calcolaControllo({ righe, lunedi: "2026-09-14", oggi: OGGI });
    expect(c.conteggi.nuova).toBe(0);
    expect(c.conteggi.non_giudicabile).toBe(c.vetture.length);
    expect(per(c, "430").nota).toContain("Prima settimana del diario");
    /* e dopo, le note citano il primo giorno contato, non l'inizio della finestra */
    const dopo = calcolaControllo({ righe, lunedi: LUNEDI, oggi: OGGI });
    expect(per(dopo, "229").nota).toContain("dal 14/09");
    expect(per(dopo, "229").nota).not.toContain("17/08");
  });

  it("una corsa senza posizione non colora la giornata di verde", () => {
    const righe: RigaDiario[] = TUTTE.map(g => riga(g, "777", { lettureFresche: 9, lettureCorsa: 5, lettureErroreGps: 9 }));
    const c = calcolaControllo({ righe, lunedi: LUNEDI, oggi: OGGI });
    expect(per(c, "777").giorni).toBe("CCCCCCCCCCCCCC");
    expect(per(c, "777").categoria).toBe("guasta");
  });

  it("chi si è già localizzato e ora parla soltanto non è un problema di attivazione", () => {
    const c = calcolaControllo({ righe: parcoDiProva(), lunedi: spostaGiorni(LUNEDI, 0), oggi: OGGI });
    const righe = parcoDiProva().concat(
      giornateDelPeriodo("2026-10-12", "2026-10-18").map(g => riga(g, "440", { lettureFresche: 9 })),
      giornateDelPeriodo("2026-10-12", "2026-10-18").map(g => riga(g, "430", { lettureFresche: 9, letturePosizione: 9 })));
    const dopo = calcolaControllo({ righe, lunedi: "2026-10-12", oggi: "2026-10-19" });
    expect(per(c, "440").categoria).toBe("fermata");
    expect(per(dopo, "440").categoria).toBe("guasta");
    expect(per(dopo, "440").nota).toContain("non si localizza dal 02/10");
    expect(per(dopo, "440").nota).toContain("non l'attivazione");
    expect(per(dopo, "440").nota).not.toContain("attivazione al centro Mizar");
  });

  it("la frase di sintesi si scrive sul perimetro, con i singolari giusti", () => {
    const c = calcolaControllo({ righe: parcoDiProva(), lunedi: LUNEDI, oggi: OGGI });
    const conerobus = c.vetture.filter(v => /^\d{1,4}$/.test(v.vehicleRef));
    const frase = notaGenerale(c.settimana, true, contaCategorie(conerobus), conerobus.length);
    expect(frase).toBe("6 vetture dal 05/10 al 11/10: 2 hanno smesso di localizzarsi, 1 ha ripreso a localizzarsi, "
      + "2 ancora non si localizzano, 1 funziona.");
    expect(c.nota).toContain("1 è nuova nel flusso, 1 è uscita dal flusso");
  });
});
