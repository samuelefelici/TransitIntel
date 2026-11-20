import { describe, it, expect } from "vitest";
import {
  casellaCsv, confronta, corpoDecisione, csvCoppie, csvCoppieDiTutte, csvPunti, csvPuntiDiTutte, fermateNelVerso, nodiDaiPunti, nomeFile, percorsiNelFile,
  riassunto, riepilogoLinee, sceltaIniziale, sceltaPerPercorso, totaliRiepilogo,
  type Candidato, type DettaglioLinea, type FermataPercorso, type PercorsoUfficiale, type RigaUfficiale, type Scelta,
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
    const righe = csvPunti(dove, c).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(righe[0]).toBe("linea;percorso;direzione;ordine;codice;nome;nodo;km bigliettazione;fermata;nome fermata;km nuovo;differenza km");
    expect(righe.slice(1)).toEqual([
      "D;0;1;1;3001;Borgo Alto;3001;0;3001;Borgo Alto;0;0",
      "D;0;1;2;3002;Ponte Nuovo;3900;5,1;3002;Ponte Nuovo;5,4;0,3",
      "D;0;1;3;9000;Molino;9000;6;4000;Molino;7,2;1,2",
      "D;0;1;4;4002;Fornace;4002;13;4002;Fornace;12,5;-0,5",
      "D;0;1;5;7777;Lago;7777;15;;;;",
    ]);
    expect(csvPunti(dove, c).startsWith("\uFEFF")).toBe(true);
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

describe("il riepilogo di tutte le linee", () => {
  const azienda = { routeId: "D", variantId: "a", direzione: 0, da: "Deposito", a: "Fornace", corse: 4, km: 13.5, fermate: FERMATE };
  /* la D: un percorso salvato (con una fermata corretta a mano) e uno solo proposto; la V: un percorso dove non si ritrova niente */
  const salvato: PercorsoUfficiale = {
    ...PERCORSO,
    deciso: { routeId: "D", variantId: "a", verso: "AB", nellImport: true, punti: [{ ordine: 1, fermata: "3001" }, { ordine: 2, fermata: "3002" }, { ordine: 3, fermata: "4000" }, { ordine: 4, fermata: "4002" }, { ordine: 5, fermata: null }] },
  };
  const proposto: PercorsoUfficiale = {
    percorso: "0", direzione: "2",
    punti: [{ ordine: 1, codice: "4002", nome: "Fornace", nodo: null, km: 0 }, { ordine: 2, codice: "3001", nome: "Borgo Alto", nodo: null, km: 13 }],
    candidati: [{ routeId: "D", variantId: "a", verso: "BA", trovati: 2, punti: [{ ordine: 1, fermata: "4002", come: "codice" }, { ordine: 2, fermata: "3001", come: "codice" }] }],
    deciso: null,
  };
  const LINEE: DettaglioLinea[] = [
    /* nella bigliettazione il ritorno da un capo all'altro è in fascia 2 */
    { linea: "D", abbinata: "D", percorsi: [salvato, proposto], righe: [...RIGHE.filter((r) => r.direzione !== "2"), riga("4002", "3001", 13, 2, { direzione: "2" })], percorsiAzienda: [azienda] },
    { linea: "V9", abbinata: "V", percorsi: [{ percorso: "0", direzione: "1", punti: [{ ordine: 1, codice: "x", nome: "Lago", nodo: null, km: 0 }], candidati: [], deciso: null }], righe: [], percorsiAzienda: [] },
    /* una linea che ha solo righe non ha percorsi da confrontare; una non abbinata non entra */
    { linea: "SPEC", abbinata: "K", percorsi: [], righe: [riga("a", "b", 0, 0)], percorsiAzienda: [] },
    { linea: "900", abbinata: null, percorsi: [proposto], righe: [], percorsiAzienda: [azienda] },
  ];
  const voci = riepilogoLinee(LINEE, FASCE);

  it("una voce per percorso: salvato, proposto o senza proposta, con gli stessi numeri del confronto di una linea", () => {
    expect(voci.map((v) => [v.linea, v.abbinata, v.percorso, v.direzione, v.da, v.a, v.stato, v.numeri?.abbinati ?? null, v.numeri?.coppie ?? null, v.numeri?.cambiano ?? null])).toEqual([
      ["D", "D", "0", "1", "Borgo Alto", "Lago", "salvato", 4, 6, 2],
      ["D", "D", "0", "2", "Fornace", "Borgo Alto", "proposta", 2, 1, 1],
      ["V9", "V", "0", "1", "Lago", "Lago", "senza", null, null, null],
    ]);
    /* il ritorno: 12,5 km coi km dell'azienda, fascia 3; nella bigliettazione era 2 */
    expect(voci[1]!.confronto!.coppie[0]).toMatchObject({ kmNuovo: 12.5, fasciaUfficiale: 2, fasciaNuova: 3, esito: "cambia" });
  });

  it("i totali, e a parte le differenze dei percorsi già salvati", () => {
    expect(totaliRiepilogo(voci)).toEqual({
      linee: 2, percorsi: 3, salvati: 1, proposte: 1, senza: 1,
      punti: 7, abbinati: 6, coppie: 7, cambiano: 3, cambianoNeiSalvati: 2, spente: 1, mancano: 0,
    });
    expect(totaliRiepilogo([])).toMatchObject({ linee: 0, percorsi: 0, cambiano: 0 });
  });

  it("nel file unico entrano i percorsi salvati; le proposte solo se lo si chiede, e si riconoscono", () => {
    expect([percorsiNelFile(voci, false), percorsiNelFile(voci, true)]).toEqual([1, 2]);
    const salvate = csvCoppieDiTutte(voci, { ancheLeProposte: false, soloDifferenze: true }).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(salvate[0]).toBe("linea;percorso;direzione;da;nome da;a;nome a;km bigliettazione;km nuovo;tariffario;fascia bigliettazione;fascia nuova;forzata;esito;linea azienda;abbinamento");
    expect(salvate.slice(1)).toEqual([
      "D;0;1;3001;Borgo Alto;9000;Molino;6;7,2;EXT;1;2;no;cambia;D;salvato",
      "D;0;1;3900;Ponte Nuovo;9000;Molino;0,9;1,8;EXT;3;1;sì;cambia;D;salvato",
      "D;0;1;9000;Molino;4002;Fornace;7;5,3;VUOTA;0;1;sì;senza fascia nella bigliettazione;D;salvato",
    ]);
    const tutte = csvCoppieDiTutte(voci, { ancheLeProposte: true, soloDifferenze: true }).trim().split("\r\n");
    expect(tutte).toHaveLength(5);
    expect(tutte[4]).toBe("D;0;2;4002;Fornace;3001;Borgo Alto;13;12,5;EXT;2;3;no;cambia;D;proposta da rivedere");
    /* con anche le coppie uguali */
    expect(csvCoppieDiTutte(voci, { ancheLeProposte: false, soloDifferenze: false }).trim().split("\r\n")).toHaveLength(7);
  });

  it("i punti di tutti i percorsi in un file", () => {
    const righe = csvPuntiDiTutte(voci, true).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(righe[0]).toBe("linea;percorso;direzione;ordine;codice;nome;nodo;km bigliettazione;fermata;nome fermata;km nuovo;differenza km;linea azienda;abbinamento");
    expect(righe).toHaveLength(8);
    expect(righe[2]).toBe("D;0;1;2;3002;Ponte Nuovo;3900;5,1;3002;Ponte Nuovo;5,4;0,3;D;salvato");
    expect(righe[7]).toBe("D;0;2;2;3001;Borgo Alto;3001;13;3001;Borgo Alto;12,5;-0,5;D;proposta da rivedere");
    expect(csvPuntiDiTutte(voci, false).trim().split("\r\n")).toHaveLength(6);
  });

  it("senza nessun percorso salvato il file ha solo l'intestazione", () => {
    const soloProposte = riepilogoLinee([{ ...LINEE[0]!, percorsi: [proposto] }], FASCE);
    expect(csvCoppieDiTutte(soloProposte, { ancheLeProposte: false, soloDifferenze: true }).trim().split("\r\n")).toHaveLength(1);
    expect(percorsiNelFile(soloProposte, false)).toBe(0);
  });
});
