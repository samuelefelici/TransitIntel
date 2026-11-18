import { describe, it, expect } from "vitest";
import {
  bozzaDa, categoriaDi, categorieDelleLinee, classiFermate, coloreDi, corpoModificaRete, corpoNuovaRete, corpoRegole, domandaTogliRete, erroriRegole, erroriRete, etichettaDi,
  etichettaRete, MODULO_RETE_VUOTO, opzioniReti, regoleCambiate, reteInUso, RETI_NEUTRE, retiValide, riassuntoAnteprima, siglaDaLuogo, siglaDi,
  spostaRegola, testoRegola, usoDellaRete, type AnteprimaRegole, type RegolaInBozza, type RegolaLinea, type Rete,
} from "./reti";

const urbana = (luogo: string, sigla: string, codice: number, colore: string): Rete =>
  ({ rete: `urbano_${luogo.toLowerCase()}`, tipo: "urbano", nome: `Urbano di ${luogo}`, luogo, sigla, codice, colore });
const RETI: Rete[] = [
  urbana("Ancona", "AN", 2, "#3b82f6"), urbana("Jesi", "JE", 3, "#8b5cf6"),
  { rete: "extraurbano", tipo: "extraurbano", nome: "Extraurbano Provincia di Ancona", luogo: null, sigla: null, codice: null, colore: "#f59e0b" },
];

describe("le reti che arrivano con la sessione", () => {
  it("passano se sono un elenco con l'extraurbano", () => {
    expect(retiValide(RETI)).toEqual(RETI);
  });

  it("senza elenco, o senza l'extraurbano, valgono quelle neutre", () => {
    for (const x of [undefined, null, "reti", {}, [], [RETI[0]]]) expect(retiValide(x), JSON.stringify(x)).toEqual(RETI_NEUTRE);
    expect(RETI_NEUTRE.map((r) => r.rete)).toEqual(["extraurbano"]);
  });

  it("scarta le righe storte e mette un colore di riserva dove manca", () => {
    const lette = retiValide([
      { rete: "urbano_x", tipo: "urbano", nome: "Urbano di X", luogo: "X", sigla: "XX", codice: 42, colore: "rosso" },
      { rete: "Urbano Y", tipo: "urbano", nome: "storta" }, { nome: "senza rete" }, 7,
      { rete: "extraurbano", tipo: "extraurbano", nome: "Extraurbano", luogo: "non vale", sigla: "NO", codice: 3, colore: "#F59E0B" },
    ]);
    expect(lette).toEqual([
      { rete: "urbano_x", tipo: "urbano", nome: "Urbano di X", luogo: "X", sigla: "XX", codice: null, colore: "#64748b" },
      { rete: "extraurbano", tipo: "extraurbano", nome: "Extraurbano", luogo: null, sigla: null, codice: null, colore: "#f59e0b" },
    ]);
  });
});

describe("come si mostra una rete", () => {
  it("l'etichetta corta è «Urbano <luogo>», o «Extraurbano»", () => {
    expect(RETI.map(etichettaRete)).toEqual(["Urbano Ancona", "Urbano Jesi", "Extraurbano"]);
    expect([etichettaDi(RETI, "urbano_jesi"), etichettaDi(RETI, "urbano_osimo"), etichettaDi(RETI, null), etichettaDi(RETI, "")])
      .toEqual(["Urbano Jesi", "urbano_osimo", "—", "—"]);
  });

  it("colore e sigla, con la riserva per una rete che non è nell'elenco", () => {
    expect([coloreDi(RETI, "urbano_ancona"), coloreDi(RETI, "urbano_osimo"), coloreDi(RETI, undefined, "#111111")]).toEqual(["#3b82f6", "#64748b", "#111111"]);
    expect([siglaDi(RETI, "urbano_ancona"), siglaDi(RETI, "extraurbano"), siglaDi(RETI, "urbano_osimo")]).toEqual(["AN", "Extra", "urbano_osimo"]);
  });

  it("le voci del menu a tendina, nell'ordine dell'elenco", () => {
    expect(opzioniReti(RETI)).toEqual([
      { value: "urbano_ancona", label: "Urbano Ancona", color: "#3b82f6" },
      { value: "urbano_jesi", label: "Urbano Jesi", color: "#8b5cf6" },
      { value: "extraurbano", label: "Extraurbano", color: "#f59e0b" },
    ]);
  });
});

describe("le classi delle fermate", () => {
  it("una per rete urbana, la stessa con l'extraurbano, e le tre fisse", () => {
    expect(classiFermate(RETI)).toEqual([
      { code: 0, label: "Non servita", shortCode: "NONE", kind: "none" },
      { code: 1, label: "Extraurbano", shortCode: "EXTRA", kind: "extra" },
      { code: 2, label: "Urbano Ancona", shortCode: "URB_AN", kind: "urban" },
      { code: 3, label: "Urbano Jesi", shortCode: "URB_JE", kind: "urban" },
      { code: 12, label: "Mista Extraurbano + Urbano Ancona", shortCode: "MIX_EX_AN", kind: "mixed" },
      { code: 13, label: "Mista Extraurbano + Urbano Jesi", shortCode: "MIX_EX_JE", kind: "mixed" },
      { code: 99, label: "Multi-rete non prevista", shortCode: "OTHER", kind: "other" },
    ]);
  });

  it("senza reti urbane restano le tre fisse", () => {
    expect(classiFermate(RETI_NEUTRE).map((c) => c.code)).toEqual([0, 1, 99]);
  });
});

describe("il modulo di una rete", () => {
  it("una rete urbana nuova vuole il luogo e la sigla; nome, colore e ordine li decide il server", () => {
    expect(erroriRete(MODULO_RETE_VUOTO, true, true)).toEqual([
      "Scrivi il luogo della rete, per esempio «Pesaro».", "La sigla ha da una a quattro lettere o cifre, per esempio «PS».",
    ]);
    const m = { ...MODULO_RETE_VUOTO, luogo: " Pesaro ", sigla: "ps" };
    expect(erroriRete(m, true, true)).toEqual([]);
    expect(corpoNuovaRete(m)).toEqual({ luogo: "Pesaro", sigla: "PS" });
    expect(corpoNuovaRete({ luogo: "Pesaro", sigla: "PS", nome: "Rete di Pesaro", colore: "#AABBCC", ordine: "4" }))
      .toEqual({ luogo: "Pesaro", sigla: "PS", nome: "Rete di Pesaro", colore: "#aabbcc", ordine: 4 });
  });

  it("dice che cosa non va, campo per campo", () => {
    expect(erroriRete({ luogo: "...", nome: "x".repeat(61), sigla: "TROPPA", colore: "rosso", ordine: "-1" }, true, true)).toEqual([
      "Nel luogo servono lettere o cifre.", "La sigla ha da una a quattro lettere o cifre, per esempio «PS».",
      "Il nome è troppo lungo: al più 60 caratteri.", "Il colore è di sei cifre esadecimali, per esempio «#3b82f6».", "L'ordine è un numero da 0 a 9999.",
    ]);
    expect(erroriRete({ ...MODULO_RETE_VUOTO, luogo: "Pesaro", sigla: "PS" }, true, false)).toEqual(["Scrivi il nome della rete."]);
  });

  it("niente virgolette, virgole o segni di minore e maggiore nel nome e nel luogo: finiscono nei file del GTFS", () => {
    expect(erroriRete({ ...MODULO_RETE_VUOTO, luogo: 'Pesaro "centro"', sigla: "PS", nome: "Urbano, di Pesaro" }, true, true)).toEqual([
      "Nel luogo vanno solo lettere, cifre, spazi e i segni . ' - / ( ).", "Nel nome vanno solo lettere, cifre, spazi e i segni . ' - / ( ).",
    ]);
    expect(erroriRete({ ...MODULO_RETE_VUOTO, luogo: "Porto Sant'Elpidio", sigla: "PE", nome: "Urbano di Porto Sant’Elpidio (mare)" }, true, true)).toEqual([]);
  });

  it("dell'extraurbano partono solo nome, colore e ordine", () => {
    const m = { luogo: "", nome: " Extraurbano ", sigla: "", colore: "#F59E0B", ordine: "9" };
    expect(erroriRete(m, false, false)).toEqual([]);
    expect(corpoModificaRete(m, false)).toEqual({ nome: "Extraurbano", colore: "#f59e0b", ordine: 9 });
    expect(corpoModificaRete({ luogo: "Fano", nome: "Urbano di Fano", sigla: "fn", colore: "", ordine: "" }, true))
      .toEqual({ nome: "Urbano di Fano", luogo: "Fano", sigla: "FN" });
  });

  it("la sigla proposta sono le prime due lettere del luogo", () => {
    expect(["Pesaro", "Ùrbino", "San Benedetto", "", "9 Colli"].map(siglaDaLuogo)).toEqual(["PE", "UR", "SA", "", "9C"]);
  });

  it("chi usa una rete, a parole; le regole delle linee non contano", () => {
    expect(usoDellaRete({ linee: 36, titoli: 1, catalogo: 27, zone: 0, regoleTariffarie: 12345, regole: 2 }))
      .toEqual(["36 linee", "1 titolo di viaggio", "27 titoli nel catalogo", "12.345 regole tariffarie"]);
    const nessuno = { linee: 0, titoli: 0, catalogo: 0, zone: 0, regoleTariffarie: 0, regole: 0 };
    expect([reteInUso({ ...nessuno, regole: 3 }), reteInUso({ ...nessuno, linee: 1 }), reteInUso({ ...nessuno, catalogo: 1 })]).toEqual([false, true, true]);
  });

  it("la domanda prima di togliere dice che cosa se ne va con la rete", () => {
    const uso = { linee: 0, titoli: 0, catalogo: 0, zone: 0, regoleTariffarie: 0, regole: 0 };
    expect(domandaTogliRete({ nome: "Urbano di Fano", uso })).toBe("Tolgo la rete «Urbano di Fano»? Se servirà di nuovo va ricreata.");
    expect(domandaTogliRete({ nome: "Urbano di Fano", uso: { ...uso, regole: 1 } }))
      .toBe("Tolgo la rete «Urbano di Fano»? Con lei tolgo la sua regola: le linee che la seguivano tornano extraurbane. Se servirà di nuovo va ricreata.");
    expect(domandaTogliRete({ nome: "Urbano di Fano", uso: { ...uso, regole: 2 } })).toContain("Con lei tolgo le sue 2 regole");
  });
});

describe("le regole in bozza", () => {
  const SALVATE: RegolaLinea[] = [
    { tipo: "inizia", valore: "JE", rete: "urbano_jesi" },
    { tipo: "inizia_con_cifra", valore: null, rete: "urbano_ancona" },
  ];

  it("come si legge una regola", () => {
    expect([
      testoRegola({ tipo: "inizia", valore: "JE" }), testoRegola({ tipo: "uguale", valore: "CIRCA" }), testoRegola({ tipo: "inizia_poi_cifra", valore: "BUS" }),
      testoRegola({ tipo: "inizia_con_cifra", valore: null }), testoRegola({ tipo: "lettere_puntate", valore: null }),
    ]).toEqual(["comincia con JE", "è CIRCA", "comincia con BUS seguito da una cifra", "comincia con una cifra", "sono due lettere puntate"]);
  });

  it("la bozza appena aperta è uguale alle regole salvate; un valore riscritto uguale non conta", () => {
    const bozza = bozzaDa(SALVATE);
    expect(regoleCambiate(bozza, SALVATE)).toBe(false);
    expect(regoleCambiate([{ ...bozza[0]!, valore: " je " }, bozza[1]!], SALVATE)).toBe(false);
    expect(regoleCambiate([{ ...bozza[0]!, valore: "JES" }, bozza[1]!], SALVATE)).toBe(true);
    expect(regoleCambiate([bozza[1]!, bozza[0]!], SALVATE)).toBe(true);
  });

  it("parte in maiuscole, e senza valore dove il tipo non ne ha", () => {
    const bozza: RegolaInBozza[] = [{ tipo: "inizia", valore: " je ", rete: "urbano_jesi" }, { tipo: "inizia_con_cifra", valore: "resto", rete: "urbano_ancona" }];
    expect(corpoRegole(bozza)).toEqual({ regole: [{ tipo: "inizia", valore: "JE", rete: "urbano_jesi" }, { tipo: "inizia_con_cifra", valore: null, rete: "urbano_ancona" }] });
  });

  it("dice che cosa non va, regola per regola", () => {
    const bozza: RegolaInBozza[] = [
      { tipo: "inizia", valore: "", rete: "urbano_jesi" },
      { tipo: "uguale", valore: "A;B", rete: "urbano_jesi" },
      { tipo: "uguale", valore: "C", rete: "urbano_osimo" },
      { tipo: "inizia_con_cifra", valore: "", rete: "urbano_ancona" },
      { tipo: "inizia_con_cifra", valore: "", rete: "urbano_jesi" },
      { tipo: "uguale", valore: "c", rete: "urbano_ancona" },
    ];
    expect(erroriRegole(bozza, RETI, 100)).toEqual([
      "Regola 1: manca il valore.",
      "Regola 2: il valore ha al più 12 fra lettere, cifre, punto, barra, trattino e spazio.",
      "Regola 3: scegli la rete.",
      "Regola 5: è uguale alla 4, e vale solo la prima.",
      "Regola 6: è uguale alla 3, e vale solo la prima.",
    ]);
    expect(erroriRegole(bozzaDa(SALVATE), RETI, 100)).toEqual([]);
    expect(erroriRegole(bozzaDa(SALVATE), RETI, 1)).toEqual(["Le regole sono al più 1."]);
  });

  it("una regola si sposta di un posto; ai bordi resta dov'è", () => {
    expect(spostaRegola(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(spostaRegola(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(spostaRegola(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(spostaRegola(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("l'anteprima in una frase", () => {
  const base: AnteprimaRegole = { fonte: "esercizio", linee: 128, cambiano: [], perRete: {} };

  it("niente cambia", () => {
    expect(riassuntoAnteprima(base)).toBe("Su 128 linee del programma in esercizio nessuna cambia rete.");
    expect(riassuntoAnteprima({ ...base, linee: 0 })).toBe("Non ci sono linee su cui provare le regole.");
  });

  it("quante cambiano rete, e quante cambiano riposo nel Roster", () => {
    const c = (linea: string, cambiaServizio: boolean) => ({ linea, da: "urbano_ancona", a: cambiaServizio ? "extraurbano" : "urbano_jesi", cambiaServizio });
    expect(riassuntoAnteprima({ ...base, cambiano: [c("41", false)] })).toBe("Su 128 linee del programma in esercizio, una cambia rete.");
    expect(riassuntoAnteprima({ ...base, fonte: "planning", linee: 1, cambiano: [c("41", true)] }))
      .toBe("Su 1 linea di Planning Studio, una cambia rete. Passa da urbana a extraurbana o viceversa: nel Roster cambia il riposo minimo fra due turni.");
    expect(riassuntoAnteprima({ ...base, cambiano: [c("1", true), c("2", true)] }))
      .toBe("Su 128 linee del programma in esercizio, 2 cambiano rete. Passano tutte da urbane a extraurbane o viceversa: nel Roster cambia il riposo minimo fra due turni.");
    expect(riassuntoAnteprima({ ...base, cambiano: [c("1", true), c("2", false)] }))
      .toBe("Su 128 linee del programma in esercizio, 2 cambiano rete. Una passa da urbana a extraurbana o viceversa: nel Roster cambia il riposo minimo fra due turni.");
    expect(riassuntoAnteprima({ ...base, cambiano: [c("1", true), c("2", true), c("3", false)] }))
      .toBe("Su 128 linee del programma in esercizio, 3 cambiano rete. 2 passano da urbane a extraurbane o viceversa: nel Roster cambia il riposo minimo fra due turni.");
  });
});

describe("le categorie delle linee nell'analisi di un feed", () => {
  it("una per rete dell'azienda, con il suo colore; poi «Notturno» e «Altro»", () => {
    expect(categorieDelleLinee(RETI)).toEqual([
      { id: "urbano_ancona", label: "Urbano Ancona", fareType: "urban", color: "#3b82f6" },
      { id: "urbano_jesi", label: "Urbano Jesi", fareType: "urban", color: "#8b5cf6" },
      { id: "extraurbano", label: "Extraurbano", fareType: "suburban", color: "#f59e0b" },
      { id: "notturno", label: "Notturno", fareType: "night", color: "#8b5cf6" },
      { id: "altro", label: "Altro", fareType: null, color: "#6b7280" },
    ]);
  });

  it("un'installazione che non ha detto le sue reti ha l'extraurbano e le due fisse, e nessun nome di luogo", () => {
    const neutre = categorieDelleLinee(RETI_NEUTRE);
    expect(neutre.map((c) => c.id)).toEqual(["extraurbano", "notturno", "altro"]);
    expect(JSON.stringify(neutre)).not.toMatch(/ancona|jesi|falconara/i);
  });

  it("l'API ricava il tipo di tariffa dall'inizio dell'identificativo: quelli delle reti cominciano come si aspetta", () => {
    /* lib/planning/feed-analyzer.ts: «urban…» è urbano, «extra…» extraurbano, «nott…» notturno */
    for (const c of categorieDelleLinee(RETI)) {
      const inizio = c.fareType === "urban" ? /^urban/ : c.fareType === "suburban" ? /^extra/ : c.fareType === "night" ? /^nott/ : /^altro$/;
      expect(c.id, c.id).toMatch(inizio);
    }
  });

  it("la categoria salvata su una linea: quella di oggi, o niente se la rete non c'è più", () => {
    const categorie = categorieDelleLinee(RETI);
    expect(categoriaDi(categorie, "urbano_jesi")?.label).toBe("Urbano Jesi");
    expect([categoriaDi(categorie, "urbano_osimo"), categoriaDi(categorie, ""), categoriaDi(categorie, null), categoriaDi(categorie, undefined)]).toEqual([null, null, null, null]);
  });
});
