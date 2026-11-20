import { describe, it, expect } from "vitest";
import {
  casellaCsv, confronta, corpoDecisione, csvCoppie, csvPunti, fermateNelVerso, nodiDaiPunti, nomeFile, riassunto, sceltaIniziale, sceltaPerPercorso,
  type Candidato, type FermataPercorso, type PercorsoUfficiale, type RigaUfficiale, type Scelta,
} from "./polimetrica-confronto";
import type { FasciaKm } from "./fasce-km";

const FASCE: FasciaKm[] = [6, 12, 18, 24].map((a, i) => ({ fascia: i + 1, kmFrom: a - 6, kmTo: a, price: 1 + i }));

const f = (stopId: string, nome: string, km: number): FermataPercorso => ({ stopId, nome, km });
/* il percorso dell'azienda parte un po' prima del primo punto tariffario */
const FERMATE = [f("100", "Deposito", 0), f("3001", "Borgo Alto", 1), f("3010", "Borgo scuole", 1.9), f("3002", "Ponte Nuovo", 6.4), f("4000", "Molino", 8.2), f("4002", "Fornace", 13.5)];

const candidato = (verso: "AB" | "BA", fermate: (string | null)[]): Candidato => ({
  routeId: "D", variantId: "a", verso, trovati: fermate.filter(Boolean).length,
  punti: fermate.map((x, i) => ({ ordine: i + 1, fermata: x, come: x ? (i === 2 ? "nome" : "codice") : null })),
});
const PERCORSO: PercorsoUfficiale = {
  percorso: "0", direzione: "1",
  punti: [
    { ordine: 1, codice: "3001", nome: "Borgo Alto", nodo: null, km: 0 },
    { ordine: 2, codice: "3002", nome: "Ponte Nuovo", nodo: "3900", km: 5.1 },
    { ordine: 3, codice: "9000", nome: "Molino", nodo: null, km: 6 },
    { ordine: 4, codice: "4002", nome: "Fornace", nodo: null, km: 13 },
    { ordine: 5, codice: "7777", nome: "Lago", nodo: null, km: 15 },
  ],
  candidati: [candidato("AB", ["3001", "3002", "4000", "4002", null]), candidato("BA", [null, null, null, "4002", null])],
  deciso: null,
};
const riga = (da: string, a: string, km: number | null, fascia: number | null, altro: Partial<RigaUfficiale> = {}): RigaUfficiale =>
  ({ percorso: "0", direzione: "1", da, a, km, tariffario: "EXT", fascia, forzata: false, ...altro });
const RIGHE: RigaUfficiale[] = [
  riga("3001", "3900", 5.1, 1), riga("3001", "9000", 6, 1), riga("3001", "4002", 13, 3),
  riga("3900", "9000", 0.9, 3, { forzata: true }), riga("3900", "4002", 7.9, 2),
  riga("9000", "4002", 7, 0, { tariffario: "VUOTA", forzata: true }),
  riga("3001", "7777", 15, 3),
  /* un'altra direzione: non c'entra */
  riga("4002", "3001", 13, 3, { direzione: "2" }),
];

describe("da dove si parte", () => {
  it("senza una decisione: la proposta migliore", () => {
    const { scelta, salvata } = sceltaIniziale(PERCORSO);
    expect(salvata).toBe(false);
    expect(scelta).toEqual({
      routeId: "D", variantId: "a", verso: "AB",
      fermate: { 1: "3001", 2: "3002", 3: "4000", 4: "4002", 5: null },
      come: { 1: "codice", 2: "codice", 3: "nome", 4: "codice" },
    });
    expect(sceltaIniziale({ ...PERCORSO, candidati: [] })).toEqual({ scelta: null, salvata: false });
  });

  it("con una decisione: quella; «come» resta solo sulle fermate che sono ancora quelle proposte", () => {
    const deciso = { routeId: "D", variantId: "a", verso: "AB" as const, nellImport: true, punti: [{ ordine: 1, fermata: "3010" }, { ordine: 2, fermata: "3002" }, { ordine: 3, fermata: null }] };
    const { scelta, salvata } = sceltaIniziale({ ...PERCORSO, deciso });
    expect(salvata).toBe(true);
    expect(scelta).toEqual({ routeId: "D", variantId: "a", verso: "AB", fermate: { 1: "3010", 2: "3002", 3: null }, come: { 2: "codice" } });
  });

  it("una decisione su un percorso che nell'import non c'è più non vale: torna la proposta", () => {
    const deciso = { routeId: "D", variantId: "vecchia", verso: "AB" as const, nellImport: false, punti: [{ ordine: 1, fermata: "1" }] };
    expect(sceltaIniziale({ ...PERCORSO, deciso })).toEqual(sceltaIniziale(PERCORSO));
  });

  it("cambiando percorso o verso: la proposta di quello, o tutti i punti senza fermata", () => {
    expect(sceltaPerPercorso(PERCORSO, "D", "a", "BA").fermate).toEqual({ 1: null, 2: null, 3: null, 4: "4002", 5: null });
    expect(sceltaPerPercorso(PERCORSO, "D", "z", "AB")).toEqual({ routeId: "D", variantId: "z", verso: "AB", fermate: { 1: null, 2: null, 3: null, 4: null, 5: null }, come: {} });
  });

  it("il corpo della decisione porta tutti i punti, nell'ordine", () => {
    const s = sceltaIniziale(PERCORSO).scelta!;
    expect(corpoDecisione("imp", "D", PERCORSO, s)).toEqual({
      importId: "imp", lineaUfficiale: "D", percorso: "0", direzione: "1", routeId: "D", variantId: "a", verso: "AB",
      punti: [{ ordine: 1, fermata: "3001" }, { ordine: 2, fermata: "3002" }, { ordine: 3, fermata: "4000" }, { ordine: 4, fermata: "4002" }, { ordine: 5, fermata: null }],
    });
  });
});

describe("il confronto", () => {
  const scelta = sceltaIniziale(PERCORSO).scelta!;
  const c = confronta(PERCORSO, RIGHE, FERMATE, scelta, FASCE);

  it("il km nuovo di un punto è contato dal primo punto abbinato, che tiene il km della bigliettazione", () => {
    expect(c.punti.map((x) => [x.ordine, x.fermata?.stopId ?? null, x.kmUfficiale, x.kmNuovo, x.differenza])).toEqual([
      [1, "3001", 0, 0, 0],            // il percorso dell'azienda parte 1 km prima: il punto resta a 0
      [2, "3002", 5.1, 5.4, 0.3],
      [3, "4000", 6, 7.2, 1.2],
      [4, "4002", 13, 12.5, -0.5],
      [5, null, 15, null, null],
    ]);
    expect(c.punti[1]!.nodo).toBe("3900");
  });

  it("di ogni coppia: la fascia della bigliettazione e quella dei km nuovi, e che cosa cambia", () => {
    expect(c.coppie.map((x) => [x.da, x.a, x.kmUfficiale, x.kmNuovo, x.fasciaUfficiale, x.fasciaNuova, x.forzata, x.esito])).toEqual([
      ["3001", "3900", 5.1, 5.4, 1, 1, false, "uguale"],
      ["3001", "9000", 6, 7.2, 1, 2, false, "cambia"],      // 6 km stavano nella fascia 1; coi km nuovi sono 7,2
      ["3001", "4002", 13, 12.5, 3, 3, false, "uguale"],
      ["3900", "9000", 0.9, 1.8, 3, 1, true, "cambia"],     // forzata a mano a 3: dai km è 1
      ["3900", "4002", 7.9, 7.1, 2, 2, false, "uguale"],
      ["9000", "4002", 7, 5.3, 0, 1, true, "spenta"],       // nella bigliettazione la coppia è senza fascia
    ]);
    expect(c.coppie[0]!.nomeDa).toBe("Borgo Alto");
    expect(c.coppie[0]!.nomeA).toBe("Ponte Nuovo");
    /* la riga col Lago ha un nodo senza fermata: resta fuori dalle coppie e si conta */
    expect(c.righeSenzaPunto).toBe(1);
  });

  it("il riassunto conta punti, scarto e coppie", () => {
    expect(riassunto(c)).toEqual({
      punti: 5, abbinati: 4, fuoriOrdine: 0, scartoMassimo: 1.2,
      coppie: 6, uguali: 3, cambiano: 2, cambianoForzate: 1, spente: 1, mancano: 0, righeSenzaPunto: 1,
    });
  });

  it("una coppia che nella bigliettazione non c'è manca; una riga «per tutti» vale se non c'è quella del percorso", () => {
    const senza = confronta(PERCORSO, RIGHE.filter((r) => !(r.da === "3001" && r.a === "4002")), FERMATE, scelta, FASCE);
    expect(senza.coppie.find((x) => x.da === "3001" && x.a === "4002")).toMatchObject({ fasciaUfficiale: null, kmUfficiale: null, esito: "manca" });
    const perTutti = [...RIGHE.filter((r) => !(r.da === "3001" && r.a === "4002")), riga("3001", "4002", 20, 4, { percorso: "", direzione: "", forzata: true })];
    expect(confronta(PERCORSO, perTutti, FERMATE, scelta, FASCE).coppie.find((x) => x.da === "3001" && x.a === "4002"))
      .toMatchObject({ fasciaUfficiale: 4, fasciaNuova: 3, forzata: true, esito: "cambia" });
    /* se ci sono tutte e due vale quella del percorso */
    expect(confronta(PERCORSO, [...RIGHE, riga("3001", "4002", 20, 4, { percorso: "", direzione: "" })], FERMATE, scelta, FASCE).coppie[2])
      .toMatchObject({ fasciaUfficiale: 3, esito: "uguale" });
  });

  it("una riga scritta nell'altro verso della coppia si ritrova lo stesso", () => {
    const rovescio = RIGHE.map((r) => (r.da === "3001" && r.a === "3900" ? { ...r, da: "3900", a: "3001" } : r));
    expect(confronta(PERCORSO, rovescio, FERMATE, scelta, FASCE).coppie[0]).toMatchObject({ da: "3001", a: "3900", esito: "uguale" });
  });

  it("una fermata scelta prima di quella del punto precedente è fuori ordine: si vede, e non sposta gli altri", () => {
    const storta: Scelta = { ...scelta, fermate: { ...scelta.fermate, 3: "3010" } };
    const s = confronta(PERCORSO, RIGHE, FERMATE, storta, FASCE);
    expect(s.punti.map((x) => [x.ordine, x.fermata?.stopId ?? null, x.fuoriOrdine])).toEqual([[1, "3001", false], [2, "3002", false], [3, "3010", true], [4, "4002", false], [5, null, false]]);
    expect(riassunto(s).fuoriOrdine).toBe(1);
  });

  it("nel verso BA i km si contano dall'altro capo", () => {
    expect(fermateNelVerso(FERMATE, "BA").map((x) => [x.stopId, x.km])).toEqual([["4002", 0], ["4000", 5.3], ["3002", 7.1], ["3010", 11.6], ["3001", 12.5], ["100", 13.5]]);
    const ritorno: PercorsoUfficiale = { ...PERCORSO, direzione: "2", punti: [{ ordine: 1, codice: "4002", nome: "Fornace", nodo: null, km: 0 }, { ordine: 2, codice: "3001", nome: "Borgo Alto", nodo: null, km: 13 }] };
    const r = confronta(ritorno, RIGHE, fermateNelVerso(FERMATE, "BA"), { routeId: "D", variantId: "a", verso: "BA", fermate: { 1: "4002", 2: "3001" }, come: {} }, FASCE);
    expect(r.punti.map((x) => x.kmNuovo)).toEqual([0, 12.5]);
    expect(r.coppie).toMatchObject([{ da: "4002", a: "3001", fasciaUfficiale: 3, fasciaNuova: 3, esito: "uguale" }]);
  });

  it("senza fasce dell'azienda la fascia nuova non c'è, e la coppia risulta cambiata", () => {
    expect(confronta(PERCORSO, RIGHE, FERMATE, scelta, []).coppie[0]).toMatchObject({ fasciaNuova: null, esito: "cambia" });
  });
});

describe("i nodi del percorso dai punti", () => {
  it("un nodo per punto abbinato, col punto sulla sua fermata; la prima tratta parte dalla prima fermata", () => {
    const c = confronta(PERCORSO, RIGHE, FERMATE, sceltaIniziale(PERCORSO).scelta!, FASCE);
    expect(nodiDaiPunti(c, FERMATE)).toEqual({
      confini: [3, 4, 5], scelte: [1, 3, 4, 5],
      nomi: { 0: "Borgo Alto", 1: "Ponte Nuovo", 2: "Molino", 3: "Fornace" },
    });
  });

  it("senza punti abbinati non fa tratte", () => {
    const c = confronta(PERCORSO, RIGHE, FERMATE, sceltaPerPercorso(PERCORSO, "D", "z", "AB"), FASCE);
    expect(nodiDaiPunti(c, FERMATE)).toEqual({ confini: [], scelte: [], nomi: {} });
  });
});

describe("i CSV", () => {
  const c = confronta(PERCORSO, RIGHE, FERMATE, sceltaIniziale(PERCORSO).scelta!, FASCE);
  const dove = { linea: "D", percorso: "0", direzione: "1" };

  it("una casella che comincia come una formula prende un apostrofo; quella col punto e virgola le virgolette", () => {
    expect(["=SOMMA(A1)", "+39", "-x", "@a", "Borgo; alto", 'dice "ciao"', "Ponte\nNuovo", null].map(casellaCsv))
      .toEqual(["'=SOMMA(A1)", "'+39", "'-x", "'@a", '"Borgo; alto"', '"dice ""ciao"""', "Ponte Nuovo", ""]);
  });

  it("i punti: una riga per punto, coi decimali con la virgola", () => {
    const righe = csvPunti(dove, c).replace(/^﻿/, "").trim().split("\r\n");
    expect(righe[0]).toBe("linea;percorso;direzione;ordine;codice;nome;nodo;km bigliettazione;fermata;nome fermata;km nuovo;differenza km");
    expect(righe.slice(1)).toEqual([
      "D;0;1;1;3001;Borgo Alto;3001;0;3001;Borgo Alto;0;0",
      "D;0;1;2;3002;Ponte Nuovo;3900;5,1;3002;Ponte Nuovo;5,4;0,3",
      "D;0;1;3;9000;Molino;9000;6;4000;Molino;7,2;1,2",
      "D;0;1;4;4002;Fornace;4002;13;4002;Fornace;12,5;-0,5",
      "D;0;1;5;7777;Lago;7777;15;;;;",
    ]);
    expect(csvPunti(dove, c).startsWith("﻿")).toBe(true);
  });

  it("le coppie: tutte, o solo quelle che non sono uguali", () => {
    const tutte = csvCoppie(dove, c, false).trim().split("\r\n");
    expect(tutte).toHaveLength(7);
    expect(tutte[2]).toBe("D;0;1;3001;Borgo Alto;9000;Molino;6;7,2;EXT;1;2;no;cambia");
    const diverse = csvCoppie(dove, c, true).trim().split("\r\n").slice(1);
    expect(diverse).toEqual([
      "D;0;1;3001;Borgo Alto;9000;Molino;6;7,2;EXT;1;2;no;cambia",
      "D;0;1;3900;Ponte Nuovo;9000;Molino;0,9;1,8;EXT;3;1;sì;cambia",
      "D;0;1;9000;Molino;4002;Fornace;7;5,3;VUOTA;0;1;sì;senza fascia nella bigliettazione",
    ]);
  });

  it("il nome del file non porta caratteri strani", () => {
    expect(nomeFile({ linea: "R/", percorso: "0", direzione: "1" }, "coppie")).toBe("coppie-R_-0-1.csv");
  });
});
