/* L'andamento dell'AVM (lib/avm-storia.ts): stessa regola del controllo
 * settimanale (parità), le azioni con i confini delle soglie, le richieste a
 * Mizar che si chiudono da sole, i testi. */
import { describe, it, expect } from "vitest";
import {
  calcolaStoria, verificaRichieste, testiMizar, richiestaTogliere, andamentoStoria, fraseAndamento,
  vediRichiesta, SETTIMANE_SILENZIO_ALIENATA,
  type PresenzaVettura, type RichiestaMizar, type DatiStoria,
} from "../lib/avm-storia";
import { calcolaControllo, spostaGiorni, lunediDi, ultimaSettimanaChiusa, type InterventoAvm } from "../lib/avm-controllo";
import type { RigaDiario } from "../lib/avm-diario";
import type { MezzoOfficina, ParcoOfficina } from "../lib/officina";

const OGGI = "2026-11-04"; // mercoledì
const ULTIMA = ultimaSettimanaChiusa(OGGI); // 2026-10-26

/** Le giornate dal lunedì `inizio` a ieri. */
function giornate(inizio: string, fine = spostaGiorni(OGGI, -1)): string[] {
  const out: string[] = [];
  for (let g = inizio; g <= fine; g = spostaGiorni(g, 1)) out.push(g);
  return out;
}

/**
 * Una vettura da una stringa di settimane: per ogni settimana un carattere,
 * ripetuto su tutte le sue giornate. F si localizza, P parla soltanto, M muta,
 * - non elencata. Le settimane finiscono con quella in corso (fino a ieri).
 */
function perSettimane(primoLunedi: string, schema: string): Map<string, string> {
  const m = new Map<string, string>();
  [...schema].forEach((ch, k) => {
    const l = spostaGiorni(primoLunedi, 7 * k);
    for (let d = 0; d < 7; d++) {
      const g = spostaGiorni(l, d);
      if (g >= OGGI) break;
      m.set(g, ch);
    }
  });
  return m;
}

const CODICE: Record<string, string> = { F: "3", P: "2", M: "0" };

function presenza(ref: string, giorni: Map<string, string>): PresenzaVettura {
  const elencati = [...giorni.entries()].filter(([, ch]) => ch !== "-").sort(([a], [b]) => a.localeCompare(b));
  return { vehicleRef: ref, giorni: elencati.map(([g]) => g), esiti: elencati.map(([, ch]) => CODICE[ch]).join("") };
}

function righeDiario(ref: string, giorni: Map<string, string>, campioni: Map<string, number>): RigaDiario[] {
  return [...giorni.entries()].filter(([, ch]) => ch !== "-").map(([g, ch]) => ({
    giorno: g, vehicleRef: ref, letture: campioni.get(g) ?? 720,
    lettureFresche: ch === "F" || ch === "P" ? 10 : 0, lettureMonitorata: 0,
    letturePosizione: ch === "F" ? 10 : 0, lettureCorsa: ch === "F" ? 5 : 0,
    lettureErroreGps: 0, lettureErroreGprs: 0, lettureInRimessa: 0,
    primoContatto: null, ultimoContatto: null, linee: [], corse: [],
  }));
}

function mezzo(matricola: string, extra: Partial<MezzoOfficina> = {}): MezzoOfficina {
  return {
    matricola, numeroDiParco: matricola.padStart(4, "0"), targa: `AA${matricola}BB`, stato: "in_servizio",
    deposito: "Ancona", modello: "Citaro", fermoDal: null, fermoMotivo: null, commessa: null, segnalazioneAvm: null,
    ...extra,
  };
}
const parcoDi = (mezzi: MezzoOfficina[]): ParcoOfficina =>
  ({ disponibile: true, motivo: null, tenant: "conerobus", lettoAlle: "2026-11-04T08:00:00Z", mezzi });

const PRIMO = "2026-08-24"; // lunedì, inizio dei dati: 11 settimane fino a quella in corso

function dati(vetture: Record<string, string>, extra: Partial<DatiStoria> = {}): DatiStoria {
  const tutte = giornate(PRIMO);
  return {
    oggi: OGGI, inizio: spostaGiorni(ULTIMA, -7 * 51), generatoIl: "2026-11-04T08:00:00Z",
    campioni: new Map(tutte.map(g => [g, 720])),
    vetture: Object.entries(vetture).map(([ref, schema]) => presenza(ref, perSettimane(PRIMO, schema))),
    parco: null, interventi: null, richieste: [],
    ...extra,
  };
}
const una = (s: ReturnType<typeof calcolaStoria>, ref: string) => s.vetture.find(v => v.vehicleRef === ref)!;

describe("le settimane", () => {
  it("partono dalla prima con dati, l'ultima è quella in corso", () => {
    const s = calcolaStoria(dati({ "10": "FFFFFFFF" }));
    expect(s.settimane[0].lunedi).toBe(PRIMO);
    expect(s.settimane.at(-1)!.lunedi).toBe(lunediDi(OGGI));
    expect(s.settimane.at(-1)!.chiusa).toBe(false);
    expect(s.settimane.at(-2)!.lunedi).toBe(ULTIMA);
    expect(s.ultimaChiusa).toBe(ULTIMA);
    expect(una(s, "10").storia).toBe("FFFFFFFFAA."); // 8 settimane elencata, poi assente; in corso: 2 giornate, non si giudica // in corso: 2 giornate contate, non si giudica
  });
});

describe("la stessa regola del controllo settimanale", () => {
  it("le ultime 8 settimane coincidono con calcolaControllo, carattere per carattere", () => {
    const schemi: Record<string, string> = {
      "10": "FFFFFFFFFFF", "11": "FFFFFMMPPFF", "12": "PPPPPPPPPPP", "13": "MMMMMMMMMMM", "14": "-----FFFF--",
      "15": "FFFF-F-F-F-", "16": "---------FF", "11096": "FFFFPMFPMFF", "17": "FFFFFFFFF--",
    };
    /* una giornata a metà raccolta, una col connettore fermo (nessuna riga): non contano né qui né lì */
    const parziali = new Map([["2026-10-07", 200]]);
    const mappe = Object.fromEntries(Object.entries(schemi).map(([r, sc]) => [r, perSettimane(PRIMO, sc)]));
    for (const m of Object.values(mappe)) m.delete("2026-10-21");
    const righe = Object.entries(mappe).flatMap(([r, m]) => righeDiario(r, m, parziali));
    /* la raccolta di ogni giornata, come la legge lo store: il massimo dei campioni fra le vetture */
    const campioni = new Map<string, number>();
    for (const r of righe) campioni.set(r.giorno, Math.max(campioni.get(r.giorno) ?? 0, r.letture));
    const controllo = calcolaControllo({ righe, lunedi: ULTIMA, oggi: OGGI });
    const storia = calcolaStoria({
      ...dati({}), campioni,
      vetture: Object.entries(mappe).map(([r, m]) => presenza(r, m)),
    });
    const i0 = storia.settimane.findIndex(w => w.lunedi === controllo.settimane[0].lunedi);
    expect(i0).toBeGreaterThanOrEqual(0);
    for (const v of controllo.vetture) {
      expect(una(storia, v.vehicleRef).storia.slice(i0, i0 + 8), v.vehicleRef).toBe(v.storia);
    }
  });
});

describe("le azioni", () => {
  it("funziona, da riparare, riparata, instabile", () => {
    const s = calcolaStoria(dati({
      "1": "FFFFFFFFFFF",
      "2": "FFFFFFFFPPP", // l'ultimo carattere è la settimana in corso
      "3": "FFFFMMMFFFF",
      "4": "FFFFFFMFMFF",
      "5": "MFFFFFFFFFF", // tornata a localizzarsi 9 settimane fa: oltre SETTIMANE_RIPARATA
    }));
    expect(una(s, "1").azione).toBe("funziona");
    const r = una(s, "2");
    expect(r.azione).toBe("da_riparare");
    expect(r.settimaneSenzaPosizione).toBe(2);
    expect(r.perche).toMatch(/Parla col centro ma non si localizza: antenna o apparato/);
    const rip = una(s, "3");
    expect(rip.azione).toBe("riparata");
    expect(rip.riparataDal).toBe(spostaGiorni(PRIMO, 7 * 7));
    expect(una(s, "4").azione).toBe("instabile");
    expect(una(s, "5").azione).toBe("funziona");
  });

  it("da riparare viene prima, le più lunghe in cima", () => {
    const s = calcolaStoria(dati({ "1": "FFFFFFFFFFF", "2": "FFFFFFFFFPP", "3": "FFFFFFFPPPP" }));
    expect(s.vetture.map(v => v.vehicleRef)).toEqual(["3", "2", "1"]);
    expect(s.conteggi.da_riparare).toBe(2);
  });

  it("da verificare: muta da 4 settimane e in servizio senza fermi; 3 settimane, fermo o segnalazione no", () => {
    const silenzio4 = "FFFFFF" + "MMMM" + "M"; // 4 settimane chiuse mute, più quella in corso
    const silenzio3 = "FFFFFFF" + "MMM" + "M";
    const parco = parcoDi([
      mezzo("20"), mezzo("21"), mezzo("22", { stato: "in_officina", fermoDal: "2026-10-01T00:00:00Z" }),
      mezzo("23", { segnalazioneAvm: { numero: "S-1", fonte: "gestionale", dal: null } }), mezzo("24", { stato: "riserva" }),
    ]);
    const s = calcolaStoria(dati({ "20": silenzio4, "21": silenzio3, "22": silenzio4, "23": silenzio4, "24": "FFFFFF-----" }, { parco }));
    expect(una(s, "20").azione).toBe("da_verificare_alienata");
    expect(una(s, "20").settimaneSilenzio).toBe(SETTIMANE_SILENZIO_ALIENATA);
    expect(una(s, "21").azione).toBe("da_riparare");
    expect(una(s, "22").azione).toBe("da_riparare");
    expect(una(s, "22").perche).toMatch(/Ferma in officina/);
    expect(una(s, "23").azione).toBe("da_riparare");
    expect(una(s, "24").azione).toBe("da_verificare_alienata"); // di riserva, assente da 4 settimane
  });

  it("da togliere: fuori parco o dismessa ma ancora nel flusso; tolta quando non c'è più", () => {
    const parco = parcoDi([mezzo("30", { stato: "dismesso" }), mezzo("32")]);
    const s = calcolaStoria(dati({ "30": "FFFFFFFFFFF", "31": "MMMMMMMMMMM", "33": "FFFFFFFFF--", "32": "FFFFFFFFFFF" }, { parco }));
    expect(una(s, "30").azione).toBe("da_togliere_da_siri");
    expect(una(s, "30").esclusa?.motivo).toBe("dismesso");
    expect(una(s, "31").azione).toBe("da_togliere_da_siri");
    expect(una(s, "31").esclusa?.motivo).toBe("fuori_parco");
    expect(una(s, "33").azione).toBe("gia_tolta");
    expect(una(s, "32").azione).toBe("funziona");
  });

  it("da aggiungere: nel parco, mai nel flusso; una consorziata assente dal parco non si tocca", () => {
    const parco = parcoDi([mezzo("40"), mezzo("41"), mezzo("42", { stato: "dismesso" })]);
    const s = calcolaStoria(dati({ "40": "FFFFFFFFFFF", "11096": "FFFFFFFFFFF" }, { parco }));
    expect(una(s, "41").azione).toBe("da_aggiungere_a_siri");
    expect(una(s, "41").storia).toMatch(/^A+\.$/);
    expect(s.vetture.find(v => v.vehicleRef === "42")).toBeUndefined(); // dismessa e mai vista: niente da fare
    expect(una(s, "11096").azione).toBe("funziona");
    expect(una(s, "11096").esclusa).toBeNull();
  });

  it("senza il parco dell'officina: niente da togliere, aggiungere o verificare", () => {
    const s = calcolaStoria(dati({ "50": "FFFFFFFMMMM", "51": "FFFFFFFFFFF" }, {
      parco: { disponibile: false, motivo: "FleetCare non risponde", tenant: null, lettoAlle: "", mezzi: [] },
    }));
    expect(una(s, "50").azione).toBe("da_riparare");
    expect(s.conteggi.da_togliere_da_siri + s.conteggi.da_aggiungere_a_siri + s.conteggi.da_verificare_alienata).toBe(0);
  });

  it("comparsa solo nella settimana in corso: non giudicabile", () => {
    const s = calcolaStoria(dati({ "60": "----------F" }));
    expect(una(s, "60").azione).toBe("non_giudicabile");
  });

  it("le settimane prima della comparsa non contano come guasto", () => {
    const s = calcolaStoria(dati({ "61": "------FFFFF" }));
    expect(una(s, "61").azione).toBe("funziona");
    expect(una(s, "61").settimaneSenzaPosizione).toBe(0);
  });

  it("da riparare, ma in settimana si è già localizzata: lo dice", () => {
    const s = calcolaStoria(dati({ "62": "FFFFFFFFPPF" }));
    expect(una(s, "62").azione).toBe("da_riparare");
    expect(una(s, "62").posizioneInSettimana).toBe(lunediDi(OGGI));
    expect(una(s, "62").perche).toMatch(/In questa settimana si è localizzata/);
  });

  it("l'ultimo intervento si giudica sulle giornate di tutto il periodo", () => {
    const i: InterventoAvm = {
      matricola: "70", fonte: "commessa", riferimento: "C-9", apertaIl: "2026-10-05T08:00:00Z",
      chiusaIl: "2026-10-16T10:00:00Z", descrizione: "antenna", esito: null, commessa: "C-9",
    };
    const s = calcolaStoria(dati({ "70": "FFFMMMMFFFF" }, { interventi: [i] }));
    const v = una(s, "70");
    expect(v.ultimoIntervento?.esitoAvm).toBe("riuscito");
    expect(v.perche).toMatch(/Ultimo intervento C-9/);
  });
});

describe("le richieste a Mizar", () => {
  const contate = giornate("2026-10-19");
  const r = (id: string, vehicleRef: string, tipo: "togliere" | "aggiungere", richiestaIl: string) =>
    ({ id, vehicleRef, tipo, richiestaIl, esito: null });

  it("aggiungere: chiusa il primo giorno in cui compare, dalla richiesta", () => {
    const presenze = new Map([["80", ["2026-10-10", "2026-10-28", "2026-10-29"]]]);
    expect(verificaRichieste([r("a", "80", "aggiungere", "2026-10-20")], presenze, contate, OGGI))
      .toEqual([{ id: "a", chiusaIl: "2026-10-28" }]);
    expect(verificaRichieste([r("b", "81", "aggiungere", "2026-10-20")], presenze, contate, OGGI)).toEqual([]);
  });

  it("togliere: tre giornate contate di assenza dopo la richiesta e dopo l'ultima volta", () => {
    const presenze = new Map([["90", ["2026-10-20", "2026-10-29"]], ["91", ["2026-10-20", "2026-11-02"]]]);
    expect(verificaRichieste([r("a", "90", "togliere", "2026-10-21")], presenze, contate, OGGI))
      .toEqual([{ id: "a", chiusaIl: "2026-10-30" }]);
    // l'ultima volta il 2/11: dopo ci sono solo 3/11 (oggi è il 4): non basta
    expect(verificaRichieste([r("b", "91", "togliere", "2026-10-21")], presenze, contate, OGGI)).toEqual([]);
  });

  it("un connettore fermo non chiude niente: senza giornate contate non c'è assenza", () => {
    const presenze = new Map([["92", ["2026-10-20"]]]);
    expect(verificaRichieste([r("a", "92", "togliere", "2026-10-21")], presenze, [], OGGI)).toEqual([]);
  });

  it("una richiesta già chiusa non si ritocca; una tolta che ricompare lo dice", () => {
    const chiusa: RichiestaMizar = {
      id: "c", vehicleRef: "93", tipo: "togliere", richiestaIl: "2026-10-01", nota: null, creataIl: "2026-10-01T09:00:00Z",
      creataDa: "Anna", esito: "fatta", chiusaIl: "2026-10-10", chiusaDa: null, automatica: true,
    };
    expect(verificaRichieste([chiusa], new Map(), giornate("2026-10-01"), OGGI)).toEqual([]);
    const vista = vediRichiesta(chiusa, ["2026-10-05", "2026-10-25"], OGGI);
    expect(vista.ricomparsaIl).toBe("2026-10-25");
    expect(vista.giorniAttesa).toBe(9);
  });

  it("in attesa da più di due settimane: da sollecitare", () => {
    const aperta: RichiestaMizar = {
      id: "d", vehicleRef: "94", tipo: "aggiungere", richiestaIl: "2026-10-15", nota: null, creataIl: "2026-10-15T09:00:00Z",
      creataDa: null, esito: null, chiusaIl: null, chiusaDa: null, automatica: false,
    };
    expect(vediRichiesta(aperta, [], OGGI)).toMatchObject({ giorniAttesa: 20, sollecitare: true });
  });

  it("i testi lasciano fuori le vetture che hanno già una richiesta aperta", () => {
    const parco = parcoDi([mezzo("95", { stato: "dismesso" }), mezzo("97")]);
    const aperta: RichiestaMizar = {
      id: "e", vehicleRef: "96", tipo: "togliere", richiestaIl: "2026-11-02", nota: null, creataIl: "2026-11-02T09:00:00Z",
      creataDa: null, esito: null, chiusaIl: null, chiusaDa: null, automatica: false,
    };
    const s = calcolaStoria(dati({ "95": "FFFFFFFFFFF", "96": "MMMMMMMMMMM" }, { parco, richieste: [aperta] }));
    const t = testiMizar(s);
    expect(t.togliere).toEqual(richiestaTogliere(["95"]));
    expect(t.aggiungere?.matricole).toEqual(["97"]);
    expect(t.aggiungere?.testo).toMatch(/97 \(AA97BB, Citaro, Ancona\)/);
    expect(una(s, "96").richiesta?.id).toBe("e");
    expect(una(s, "96").perche).toMatch(/Richiesta a Mizar di togliere inviata il 02\/11/);
  });
});

describe("l'andamento", () => {
  it("conta per settimana dalla comparsa, e lo dice in una frase", () => {
    const s = calcolaStoria(dati({ "1": "FFFFFFFFFFF", "2": "PPPPPFFFFFF", "3": "-----MMMMFF" }));
    const a = andamentoStoria(s, s.vetture);
    expect(a[0]).toMatchObject({ F: 1, P: 1, M: 0, A: 0 }); // la 3 non c'era ancora
    expect(a.at(-2)).toMatchObject({ F: 3, P: 0, M: 0, A: 0 });
    expect(fraseAndamento(a)).toMatch(/si sono localizzate 3 vetture su 3 \(100%\).*erano 1 su 2 \(50%\)/);
  });
});
