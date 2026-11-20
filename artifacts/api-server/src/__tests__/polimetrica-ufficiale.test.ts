/**
 * La polimetrica della bigliettazione (tappa 6.34): la lettura dei due CSV e
 * la proposta di abbinamento delle linee. Senza database.
 */
import { describe, it, expect } from "vitest";
import {
  abbinaPunti, candidateDellaLinea, fermateNelVerso, leggiCsvPunti, leggiCsvRighe, normaCodice, paroleDelNome, percorsiCandidati, puntiRitrovati,
  type FermataPercorso, type LineaAzienda,
} from "../lib/polimetrica-ufficiale";

const PUNTI = `linea,percorso,direzione,ordine,codice,nome,nodo,km
d,0,1,1,3001,Borgo Alto,,0
d,0,1,2,3002,Ponte Nuovo,3900,5.1
d,0,1,3,3003,"Molino, bivio",,6
d,0,2,1,3003,"Molino, bivio",,0
`;

const RIGHE = `linea,percorso,direzione,da,a,km,tariffario,fascia,forzata
D,0,1,3001,3900,5.100,EXT,1,false
D,0,1,3001,3003,6.000,EXT,1,false
D,0,1,3900,3003,0.900,EXT,3,true
`;

describe("il file dei punti tariffari", () => {
  it("legge linea (in maiuscolo), ordine, codice, nome, nodo e km", () => {
    const r = leggiCsvPunti(PUNTI);
    expect(r.errori).toEqual([]);
    expect(r.saltate).toBe(0);
    expect(r.righe).toEqual([
      { linea: "D", percorso: "0", direzione: "1", ordine: 1, codice: "3001", nome: "Borgo Alto", nodo: null, km: 0 },
      { linea: "D", percorso: "0", direzione: "1", ordine: 2, codice: "3002", nome: "Ponte Nuovo", nodo: "3900", km: 5.1 },
      { linea: "D", percorso: "0", direzione: "1", ordine: 3, codice: "3003", nome: "Molino, bivio", nodo: null, km: 6 },
      { linea: "D", percorso: "0", direzione: "2", ordine: 1, codice: "3003", nome: "Molino, bivio", nodo: null, km: 0 },
    ]);
  });

  it("col punto e virgola, i decimali con la virgola, il BOM, le colonne in un altro ordine e una colonna in più", () => {
    const r = leggiCsvPunti("\uFEFFKM;Linea;Percorso;Direzione;Ordine;Codice;Altro\r\n12,35;a1;0;1;1;051;x\r\n");
    expect(r.errori).toEqual([]);
    expect(r.righe).toEqual([{ linea: "A1", percorso: "0", direzione: "1", ordine: 1, codice: "051", nome: null, nodo: null, km: 12.35 }]);
  });

  it("un punto senza km resta fuori e si conta; non è un errore", () => {
    const r = leggiCsvPunti("linea,percorso,direzione,ordine,codice,km\nX,0,1,1,10,\nX,0,1,2,11,3\n");
    expect([r.errori, r.saltate, r.righe.length]).toEqual([[], 1, 1]);
  });

  it("dice che cosa manca: una colonna, o tutti i punti", () => {
    expect(leggiCsvPunti("linea,percorso,direzione,ordine,codice\nX,0,1,1,10\n").errori[0]).toMatch(/^manca la colonna «km»/);
    expect(leggiCsvPunti("linea,ordine\n").errori[0]).toMatch(/^mancano le colonne «percorso», «direzione», «codice», «km»/);
    expect(leggiCsvPunti("linea,percorso,direzione,ordine,codice,km\nX,0,1,1,10,\n").errori).toEqual(["il file non ha nessun punto tariffario con i suoi km"]);
  });

  it("una riga che non va ferma tutto, col numero della riga; oltre le cinque si contano", () => {
    const r = leggiCsvPunti("linea,percorso,direzione,ordine,codice,km\nX,0,1,1,10,abc\nX,0,1,zero,10,1\n,0,1,3,10,1\nX,0,1,4,,1\nX,0,1,5,10,1\nX,0,1,5,10,2\nX,0,1,7,10,-1\nX,0,1,8,10,3000\n");
    expect(r.righe).toEqual([]);
    expect(r.errori).toEqual([
      "riga 2: i km «abc» non sono un numero fra 0 e 2000",
      "riga 3: l'ordine è un numero intero da 1 in su",
      "riga 4: manca la linea",
      "riga 5: manca il codice del punto",
      "riga 7: il punto 5 della linea X (percorso 0, direzione 1) c'è già alla riga 6",
      "…e altre 2 righe che non vanno",
    ]);
  });

  it("toglie i caratteri di controllo; un file che non è un CSV lo dice", () => {
    expect(leggiCsvPunti("linea,percorso,direzione,ordine,codice,nome,km\nX,0,1,1,10,\"Bor\u0007go\",1\n").righe[0]!.nome).toBe("Borgo");
    expect(leggiCsvPunti('linea,percorso\n"aperta,0\n').errori).toEqual(["il file non si legge come CSV (virgolette non chiuse?)"]);
  });
});

describe("il file della polimetrica", () => {
  it("legge la coppia di nodi, i km, il tariffario, la fascia e se è forzata", () => {
    const r = leggiCsvRighe(RIGHE);
    expect(r.errori).toEqual([]);
    expect(r.righe).toEqual([
      { linea: "D", percorso: "0", direzione: "1", da: "3001", a: "3900", km: 5.1, tariffario: "EXT", fascia: 1, forzata: false },
      { linea: "D", percorso: "0", direzione: "1", da: "3001", a: "3003", km: 6, tariffario: "EXT", fascia: 1, forzata: false },
      { linea: "D", percorso: "0", direzione: "1", da: "3900", a: "3003", km: 0.9, tariffario: "EXT", fascia: 3, forzata: true },
    ]);
  });

  it("km, tariffario, fascia e forzata possono mancare; «forzata» si scrive in più modi", () => {
    const r = leggiCsvRighe("linea,percorso,direzione,da,a,km,fascia,forzata\nX,0,1,1,2,,,\nX,0,1,1,3,4,0,1\nX,0,1,1,4,4,2,Sì\nX,0,1,1,5,4,2,NO\n");
    expect(r.errori).toEqual([]);
    expect(r.righe.map((x) => [x.km, x.tariffario, x.fascia, x.forzata])).toEqual([[null, null, null, false], [4, null, 0, true], [4, null, 2, true], [4, null, 2, false]]);
  });

  it("percorso e direzione vuoti: la riga vale per tutti, e si legge", () => {
    const r = leggiCsvRighe("linea,percorso,direzione,da,a,km,fascia,forzata\nX,,,1,2,8,2,true\nX,0,1,1,2,7.5,2,false\nX,,,1,2,9,2,true\n");
    expect(r.righe).toEqual([]);
    expect(r.errori).toEqual(["riga 4: la coppia 1 → 2 della linea X (percorso tutti, direzione tutte) c'è già alla riga 2"]);
    const buono = leggiCsvRighe("linea,percorso,direzione,da,a,km,fascia,forzata\nX,,,1,2,8,2,true\nX,0,1,1,2,7.5,2,false\n");
    expect(buono.errori).toEqual([]);
    expect(buono.righe.map((x) => [x.percorso, x.direzione, x.km, x.forzata])).toEqual([["", "", 8, true], ["0", "1", 7.5, false]]);
  });

  it("rifiuta una fascia che non è un numero, un «forzata» che non si capisce e una coppia ripetuta", () => {
    const r = leggiCsvRighe("linea,percorso,direzione,da,a,km,fascia,forzata\nX,0,1,1,2,1,uno,\nX,0,1,1,3,1,1,forse\nx,0,1,1,4,1,1,\nX,0,1,1,4,2,1,\n");
    expect(r.righe).toEqual([]);
    expect(r.errori).toEqual([
      "riga 2: la fascia «uno» non è un numero intero fra 0 e 999",
      "riga 3: «forzata» vale vero o falso (qui «forse»)",
      "riga 5: la coppia 1 → 4 della linea X (percorso 0, direzione 1) c'è già alla riga 4",
    ]);
    expect(leggiCsvRighe("linea,percorso,direzione,da,a,km,fascia\n").errori).toEqual(["il file non ha nessuna riga di polimetrica"]);
  });
});

describe("i confronti", () => {
  it("un codice vale senza gli zeri davanti e senza badare alle maiuscole", () => {
    expect(["051", "51", " bs024 ", "000", "A01"].map(normaCodice)).toEqual(["51", "51", "BS024", "0", "A01"]);
  });

  it("di un nome contano le parole che distinguono un luogo", () => {
    expect(paroleDelNome("Via Roma (Chiesa)")).toEqual(["ROMA", "CHIESA"]);
    expect(paroleDelNome("S. Maria Nuova - bivio")).toEqual(["MARIA", "NUOVA"]);
    expect(paroleDelNome("Città Alta")).toEqual(["CITTA", "ALTA"]);
    expect(paroleDelNome(null)).toEqual([]);
  });
});

describe("l'abbinamento delle linee", () => {
  const fermate = (...f: [string, string][]) => f.map(([codice, nome]) => ({ codice, nome }));
  const LINEE: LineaAzienda[] = [
    { codice: "D", nome: "Borgo Alto - Città", fermate: fermate(["3001", "Borgo Alto (capolinea)"], ["3002", "Ponte Nuovo"], ["4000", "Molino (bivio)"], ["4001", "Città (stazione)"]) },
    { codice: "V1", nome: "Valle", fermate: fermate(["5001", "Fornace"], ["5002", "Molino (bivio)"], ["5003", "Castello (piazza)"], ["5004", "Torre"]) },
    { codice: "K", nome: "Costa", fermate: fermate(["6001", "Porto"]) },
  ];

  it("un punto si ritrova per codice, o con tutte le parole del suo nome nel nome di una fermata", () => {
    const punti = [{ codice: "03001", nome: "Un altro nome" }, { codice: "9", nome: "Molino" }, { codice: "8", nome: "Castello Vecchio" }];
    expect(puntiRitrovati(punti, LINEE)).toEqual([{ linea: "D", trovati: 2 }, { linea: "V1", trovati: 1 }]);
  });

  it("propone la linea con lo stesso codice, senza badare alle maiuscole", () => {
    const c = candidateDellaLinea("d", [{ codice: "1", nome: "Porto" }], LINEE);
    expect([c.proposta, c.motivo]).toEqual(["D", "codice"]);
    expect(c.candidate).toEqual([{ linea: "K", trovati: 1 }]);
  });

  it("senza lo stesso codice propone la linea dove si ritrovano quasi tutti i punti, con distacco", () => {
    const punti = [{ codice: "x1", nome: "Fornace" }, { codice: "x2", nome: "Molino" }, { codice: "x3", nome: "Castello" }, { codice: "x4", nome: "Torre" }];
    const c = candidateDellaLinea("900", punti, LINEE);
    expect([c.proposta, c.motivo]).toEqual(["V1", "punti"]);
    expect(c.candidate).toEqual([{ linea: "V1", trovati: 4 }, { linea: "D", trovati: 1 }]);
  });

  it("non propone niente se i punti ritrovati sono pochi, o se due linee si equivalgono", () => {
    /* 2 su 4: sotto i 7 su 10 */
    expect(candidateDellaLinea("900", [{ codice: "a", nome: "Fornace" }, { codice: "b", nome: "Torre" }, { codice: "c", nome: "Lago" }, { codice: "d", nome: "Monte" }], LINEE).proposta).toBeNull();
    /* 3 su 3, ma su due linee uguali: nessun distacco */
    const doppie: LineaAzienda[] = [{ ...LINEE[1]!, codice: "V1" }, { ...LINEE[1]!, codice: "V2" }];
    const c = candidateDellaLinea("900", [{ codice: "a", nome: "Fornace" }, { codice: "b", nome: "Torre" }, { codice: "c", nome: "Castello" }], doppie);
    expect(c.proposta).toBeNull();
    expect(c.candidate).toEqual([{ linea: "V1", trovati: 3 }, { linea: "V2", trovati: 3 }]);
    /* una linea con due soli punti non basta mai */
    expect(candidateDellaLinea("900", [{ codice: "a", nome: "Fornace" }, { codice: "b", nome: "Torre" }], LINEE).proposta).toBeNull();
  });

  it("lo stesso punto in più percorsi e direzioni conta una volta", () => {
    const punti = [{ codice: "x1", nome: "Fornace" }, { codice: "X1", nome: "Fornace" }, { codice: "x2", nome: "Torre" }, { codice: "x3", nome: "Castello" }];
    expect(candidateDellaLinea("900", punti, LINEE).candidate[0]).toEqual({ linea: "V1", trovati: 3 });
  });
});

/* ── I punti sulle fermate (tappa 6.34b) ── */
describe("i punti tariffari sulle fermate di un percorso", () => {
  const f = (stopId: string, nome: string, km: number): FermataPercorso => ({ stopId, nome, km });
  const PERCORSO = [
    f("3001", "Borgo Alto (capolinea)", 0), f("3010", "Borgo Alto (scuole)", 0.8), f("3002", "Ponte Nuovo", 5.2),
    f("4000", "Molino (bivio)", 6.1), f("4001", "Molino (chiesa)", 6.6), f("4002", "Fornace", 9), f("3001", "Borgo Alto (capolinea)", 12),
  ];
  const punto = (ordine: number, codice: string, nome: string | null) => ({ ordine, codice, nome });

  it("il verso BA è il percorso al contrario, coi km contati dall'altro capo", () => {
    expect(fermateNelVerso(PERCORSO.slice(0, 3), "BA")).toEqual([f("3002", "Ponte Nuovo", 0), f("3010", "Borgo Alto (scuole)", 4.4), f("3001", "Borgo Alto (capolinea)", 5.2)]);
    expect(fermateNelVerso(PERCORSO.slice(0, 2), "AB")).toEqual(PERCORSO.slice(0, 2));
    expect(fermateNelVerso([], "BA")).toEqual([]);
  });

  it("per codice, senza gli zeri davanti; poi per nome, fra un punto abbinato e il successivo", () => {
    const r = abbinaPunti([punto(1, "03001", "Borgo"), punto(2, "900", "Ponte Nuovo"), punto(3, "901", "Molino"), punto(4, "4002", null), punto(5, "999", "Lago")], PERCORSO);
    expect(r).toEqual([
      { ordine: 1, fermata: "3001", come: "codice" },
      { ordine: 2, fermata: "3002", come: "nome" },
      { ordine: 3, fermata: "4000", come: "nome" },
      { ordine: 4, fermata: "4002", come: "codice" },
      { ordine: 5, fermata: null, come: null },
    ]);
  });

  it("un codice che compare due volte nel percorso: vale la volta che tiene l'ordine", () => {
    /* il percorso torna al capolinea: l'ultimo punto è il capolinea della seconda volta */
    const r = abbinaPunti([punto(1, "3002", null), punto(2, "4002", null), punto(3, "3001", null)], PERCORSO);
    expect(r.map((x) => x.fermata)).toEqual(["3002", "4002", "3001"]);
    /* due punti con lo stesso codice: il primo sulla prima volta, il secondo sulla seconda */
    const due = abbinaPunti([punto(1, "3001", null), punto(2, "4000", null), punto(3, "3001", null)], PERCORSO);
    expect(due.map((x) => x.fermata)).toEqual(["3001", "4000", "3001"]);
  });

  it("un nome non si ritrova fuori dal suo tratto, né due volte sulla stessa fermata", () => {
    /* «Fornace» sta dopo il punto 4002: un punto che viene prima di lui non la prende */
    const r = abbinaPunti([punto(1, "3001", null), punto(2, "x", "Fornace"), punto(3, "3002", null)], PERCORSO);
    expect(r.map((x) => x.fermata)).toEqual(["3001", null, "3002"]);
    const doppi = abbinaPunti([punto(1, "a", "Molino"), punto(2, "b", "Molino"), punto(3, "c", "Molino")], PERCORSO);
    expect(doppi.map((x) => x.fermata)).toEqual(["4000", "4001", null]);
  });

  it("più fermate col nome del punto: vale quella più vicina a dove il punto dovrebbe stare, coi km della bigliettazione", () => {
    /* la località «Città» ha quattro fermate lungo 5 km; il punto è al capolinea, a 9 km dal punto prima */
    const citta = [f("3001", "Borgo Alto", 0), f("7001", "Città (periferia)", 4.9), f("7002", "Città (stazione)", 6.5), f("7003", "Città (ospedale)", 8), f("7004", "Città (capolinea)", 9.4)];
    const conKm = abbinaPunti([{ ...punto(1, "3001", null), km: 0 }, { ...punto(2, "x", "Città"), km: 9 }], citta);
    expect(conKm.map((x) => [x.fermata, x.come])).toEqual([["3001", "codice"], ["7004", "nome"]]);
    /* senza km resta la prima che ha quel nome */
    expect(abbinaPunti([punto(1, "3001", null), punto(2, "x", "Città")], citta).map((x) => x.fermata)).toEqual(["3001", "7001"]);
    /* senza un punto abbinato prima si conta da quello dopo */
    const daDopo = abbinaPunti([{ ...punto(1, "x", "Città"), km: 0 }, { ...punto(2, "7004", null), km: 3 }], citta);
    expect(daDopo.map((x) => x.fermata)).toEqual(["7002", "7004"]);
    /* due punti nella stessa località: ognuno la sua fermata, nell'ordine */
    const due = abbinaPunti([{ ...punto(1, "3001", null), km: 0 }, { ...punto(2, "x", "Città"), km: 6.4 }, { ...punto(3, "y", "Città"), km: 9.5 }], citta);
    expect(due.map((x) => x.fermata)).toEqual(["3001", "7002", "7004"]);
  });

  it("fra i percorsi dell'azienda sceglie quello dove si ritrovano più punti, nel verso giusto; a parità quello con più corse", () => {
    const punti = [punto(1, "4002", "Fornace"), punto(2, "4000", "Molino"), punto(3, "3002", "Ponte Nuovo"), punto(4, "3001", "Borgo Alto")];
    const corto = { routeId: "D", variantId: "corto", corse: 9, fermate: PERCORSO.slice(0, 3) };
    const lungo = { routeId: "D", variantId: "lungo", corse: 2, fermate: PERCORSO.slice(0, 6) };
    const gemello = { routeId: "D", variantId: "gemello", corse: 5, fermate: PERCORSO.slice(0, 6) };
    const altro = { routeId: "K", variantId: "k", corse: 30, fermate: [f("6001", "Porto", 0), f("6002", "Faro", 3)] };
    const c = percorsiCandidati(punti, [corto, lungo, gemello, altro]);
    expect(c.map((x) => [x.variantId, x.verso, x.trovati])).toEqual([
      ["gemello", "BA", 4], ["lungo", "BA", 4], ["corto", "BA", 2], ["corto", "AB", 1], ["gemello", "AB", 1],
    ]);
    expect(c[0]!.punti.map((x) => [x.ordine, x.fermata, x.come])).toEqual([[1, "4002", "codice"], [2, "4000", "codice"], [3, "3002", "codice"], [4, "3001", "codice"]]);
    expect(percorsiCandidati(punti, [altro])).toEqual([]);
    expect(percorsiCandidati(punti, [corto, lungo, gemello], 2)).toHaveLength(2);
  });

  it("un percorso che va davvero in quella direzione vale più dell'altro verso letto al contrario, se ritrova quasi gli stessi punti", () => {
    /* cinque punti da Borgo a Fornace. L'andata ha le fermate di fronte (altri codici): 4 punti, per nome.
       Il ritorno, letto al contrario, ha i codici dei punti: 5. Si propone l'andata. */
    const punti = [punto(1, "3001", "Borgo Alto"), punto(2, "3002", "Ponte Nuovo"), punto(3, "4000", "Molino"), punto(4, "4001", "Chiesa Vecchia"), punto(5, "4002", "Fornace")]
      .map((x, i) => ({ ...x, km: [0, 5, 6, 6.5, 9][i]! }));
    const andata = { routeId: "D", variantId: "andata", corse: 4, fermate: [f("8001", "Borgo Alto", 0), f("8002", "Ponte Nuovo", 5.1), f("8003", "Molino", 6.2), f("8004", "Sagrato", 6.8), f("8005", "Fornace", 9.1)] };
    const ritorno = { routeId: "D", variantId: "ritorno", corse: 4, fermate: [f("4002", "Fornace", 0), f("4001", "Molino chiesa", 2.4), f("4000", "Molino", 2.9), f("3002", "Ponte Nuovo", 4), f("3001", "Borgo Alto", 9.2)] };
    const c = percorsiCandidati(punti, [ritorno, andata]);
    expect(c.slice(0, 2).map((x) => [x.variantId, x.verso, x.trovati])).toEqual([["andata", "AB", 4], ["ritorno", "BA", 5]]);
    /* se l'andata ne ritrova pochi (meno di 8 su 10 del migliore) resta il ritorno al contrario */
    const povera = { ...andata, fermate: andata.fermate.slice(0, 3) };
    expect(percorsiCandidati(punti, [ritorno, povera]).map((x) => [x.variantId, x.verso, x.trovati])[0]).toEqual(["ritorno", "BA", 5]);
  });

  it("a parità di punti vale il percorso coi km più vicini a quelli della bigliettazione", () => {
    const punti = [punto(1, "3001", null), punto(2, "3002", null), punto(3, "4002", null)].map((x, i) => ({ ...x, km: [0, 5, 9][i]! }));
    const diretto = { routeId: "D", variantId: "diretto", corse: 1, fermate: [f("3001", "Borgo Alto", 0), f("3002", "Ponte Nuovo", 5.2), f("4002", "Fornace", 9.3)] };
    const deviato = { routeId: "D", variantId: "deviato", corse: 9, fermate: [f("3001", "Borgo Alto", 0), f("3002", "Ponte Nuovo", 5.2), f("5000", "Zona industriale", 9), f("4002", "Fornace", 13)] };
    const c = percorsiCandidati(punti, [deviato, diretto]);
    expect(c.slice(0, 2).map((x) => [x.variantId, x.verso, x.trovati, x.scarto])).toEqual([["diretto", "AB", 3, 0.167], ["deviato", "AB", 3, 1.4]]);
  });
});
