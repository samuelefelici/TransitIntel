/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Transcodifica delle paline — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Il file dell'azienda, ridotto alle righe che il 14 settembre 2026 avevano
 * dimostrato il problema: la 200 di Mizar è la 20001 del feed, mentre nel
 * feed esiste uno stop_id 200 che è un'altra fermata (Via del Conero).
 * Senza la transcodifica l'aggancio per numero prendeva quella.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { impostaFornitoreAvm } from "../lib/vetture-azienda";
import { indiceTranscodifica, verificaTranscodifica, classificaAbbinamenti, fermataDelCodice, codiceDellaFermata, aliasNelFeed } from "../lib/stop-aliases";
import { leggiCsvTranscodifica, righeDellaBase, stopIdValido } from "../lib/transcodifica-paline";
import { resolveStop, namesCompatible, type GtfsIndex } from "../lib/siri-vm";


/* il fornitore dell'AVM dell'azienda di prova (tappa 6.27): i testi lo nominano */
beforeAll(() => impostaFornitoreAvm("Mizar"));
afterAll(() => impostaFornitoreAvm(null));
const CSV = `\uFEFFmizar_ref,stop_id,nome
1122,20045,ANCONA (Via Marconi Gas)
200,20001,"Piazza Cavour (Conerobus Linee Nord)"
461,20928,OSIMO (Capolinea)
199,200,VIA DEL CONERO - CASACCIA
5102,new_CT,"FABRIANO (Via Dante, 39)"

`;
const parseTranscodifica = (testo: string) => righeDellaBase(leggiCsvTranscodifica(testo).righe).righe.map(({ fonte: _f, ...r }) => r);

describe("il CSV della transcodifica (tappa 6.20: si importa nella tabella dell'azienda)", () => {
  it("legge il CSV con BOM, virgolette e righe vuote; le paline senza codice restano a parte", () => {
    const l = leggiCsvTranscodifica(CSV);
    expect(l.errori).toEqual([]);
    expect(l.righe).toEqual([
      { palina: "1122", stopId: "20045", codiceFile: null, nome: "ANCONA (Via Marconi Gas)" },
      { palina: "200", stopId: "20001", codiceFile: null, nome: "Piazza Cavour (Conerobus Linee Nord)" },
      { palina: "461", stopId: "20928", codiceFile: null, nome: "OSIMO (Capolinea)" },
      { palina: "199", stopId: "200", codiceFile: null, nome: "VIA DEL CONERO - CASACCIA" },
      { palina: "5102", stopId: null, codiceFile: "new_CT", nome: "FABRIANO (Via Dante, 39)" },
    ]);
    const r = parseTranscodifica(CSV);
    expect(r).toHaveLength(4);
    expect(indiceTranscodifica(r).get("200")).toBe("20001");
    expect(indiceTranscodifica(r).has("5102")).toBe(false);
  });
  it("senza intestazione si legge lo stesso; un codice palina doppio: vale il primo", () => {
    const l = leggiCsvTranscodifica("200,20001,A\n200,30001,B\n7,8,C");
    expect(l.righe.map((x) => [x.palina, x.stopId])).toEqual([["200", "20001"], ["7", "8"]]);
    expect(l.doppie).toBe(1);
  });
  it("un codice palina che non va ferma l'import, con il numero di riga", () => {
    const l = leggiCsvTranscodifica("mizar_ref,stop_id,nome\n1,2,A\nuno due,3,B\n");
    expect(l.errori).toEqual(["riga 3: il codice palina «uno due» non va (lettere, cifre e . _ : -, al più 40)"]);
    expect(leggiCsvTranscodifica("mizar_ref,stop_id,nome\n\n").errori).toEqual(["il file non ha nessuna riga con un codice palina"]);
    expect(leggiCsvTranscodifica("").errori).toHaveLength(1);
  });
  it("i nomi senza caratteri di controllo e al più 200 caratteri; lo stop_id «new_…» non vale", () => {
    const l = leggiCsvTranscodifica(`1,2,"A\u0007B"\n2,NEW_x,${"n".repeat(300)}`);
    expect(l.righe[0]!.nome).toBe("AB");
    expect(l.righe[1]).toMatchObject({ stopId: null, codiceFile: "NEW_x" });
    expect(l.righe[1]!.nome).toHaveLength(200);
    expect(stopIdValido("20045")).toBe(true);
    expect(stopIdValido("new_CT")).toBe(false);
    expect(stopIdValido("a b")).toBe(false);
  });
  it("l'esportazione con le colonne in più (fonte, nota, utente) si reimporta", () => {
    const l = leggiCsvTranscodifica('mizar_ref,stop_id,nome,fonte,nota,utente\r\n"200","20001","Piazza Cavour","manuale","spostata","a@b.it"\r\n');
    expect(l.errori).toEqual([]);
    expect(l.righe).toEqual([{ palina: "200", stopId: "20001", codiceFile: null, nome: "Piazza Cavour" }]);
  });
});

describe("resolveStop con la transcodifica", () => {
  const index = (): GtfsIndex => ({
    feedId: "f", trips: new Set(), routes: new Set(),
    stops: new Set(["20001", "200", "20045", "20928"]),
    tripRoute: new Map(), routeByCode: new Map(), routeLongNames: [],
    stopNames: new Map([["20001", "PIAZZA CAVOUR (CONEROBUS LINEE NORD)"], ["200", "VIA DEL CONERO - CASACCIA"], ["20045", "ANCONA (VIA MARCONI GAS)"]]),
    stopByName: new Map([["PIAZZA CAVOUR CONEROBUS LINEE NORD", "20001"]]),
    stopByAlias: indiceTranscodifica(parseTranscodifica(CSV)),
    timeZone: "Europe/Rome", loadedAt: 0,
  });
  it("la transcodifica vince sullo stop_id omonimo di un'altra fermata", () => {
    expect(resolveStop("200", "Piazza Cavour (Conerobus Linee Nord)", index())).toEqual({ stopId: "20001", how: "alias", conflict: null });
    /* e vince anche senza nome, dove prima il numero avrebbe preso Via del Conero */
    expect(resolveStop("200", null, index())).toEqual({ stopId: "20001", how: "alias", conflict: null });
  });
  it("senza transcodifica si torna alle regole di prima, col conflitto annotato", () => {
    const idx = index(); idx.stopByAlias = undefined;
    const r = resolveStop("200", "Piazza Cavour (Conerobus Linee Nord)", idx);
    expect(r).toMatchObject({ stopId: "20001", how: "name" });
    expect(r.conflict).toMatch(/200: AVM/);
  });
  it("un codice che la transcodifica non ha passa alle regole successive", () => {
    expect(resolveStop("999", "ANCONA (Via Marconi Gas)", index())).toMatchObject({ stopId: null, how: null });
  });
});

describe("verificaTranscodifica", () => {
  it("conta presenze, assenze, fermate senza codice e collisioni", () => {
    const v = verificaTranscodifica(parseTranscodifica(CSV), { stops: new Set(["20001", "200", "20045", "77"]) });
    expect(v).toMatchObject({
      righe: 4, nelFeed: 3, nonNelFeed: ["20928"], feedSenzaCodice: 1,
      stopConPiuCodici: [],
      collisioni: [{ mizarRef: "200", stopIdGiusto: "20001", stopIdOmonimo: "200" }],
    });
  });
});

describe("classificaAbbinamenti: ogni palina con il suo stato", () => {
  const { righe: valide, scartate } = righeDellaBase(leggiCsvTranscodifica(CSV).righe);
  const feed = {
    stops: new Set(["20001", "200", "20045", "77"]),
    stopNames: new Map([["20001", "PIAZZA CAVOUR (CONEROBUS LINEE NORD)"], ["200", "VIA DEL CONERO - CASACCIA"], ["20045", "OSIMO STAZIONE"], ["77", "Fermata orfana"]]),
  };
  it("distingue abbinata, sospetta, fermata assente e senza codice; segnala collisioni e orfane", () => {
    const a = classificaAbbinamenti(valide, scartate, feed, { refs: ["1122", "9999"] }, namesCompatible);
    const per = Object.fromEntries(a.righe.map(r => [r.mizarRef, r]));
    expect(per["200"]).toMatchObject({ stato: "abbinata", stopId: "20001", collisione: "200 = VIA DEL CONERO - CASACCIA", vistaNelFlusso: false });
    expect(per["1122"]).toMatchObject({ stato: "sospetta", nomeFeed: "OSIMO STAZIONE", vistaNelFlusso: true });   // nome incompatibile
    expect(per["461"]).toMatchObject({ stato: "fermata_assente", stopId: "20928", nomeFeed: null });
    expect(per["199"]).toMatchObject({ stato: "abbinata", stopId: "200", collisione: null });
    expect(per["5102"]).toMatchObject({ stato: "senza_codice", stopId: null, nomeMizar: "FABRIANO (Via Dante, 39)" });
    expect(a.feedSenzaCodice).toEqual([{ stopId: "77", nome: "Fermata orfana" }]);
    expect(a.flussoNonTrascodificato).toEqual(["9999"]);
    expect(a.riepilogo).toEqual({
      paline: 5, abbinate: 2, sospette: 1, fermateAssenti: 1, senzaCodice: 1,
      collisioni: 1, feedSenzaCodice: 1, flussoNonTrascodificato: 1,
    });
    expect(a.lettura.join("\n")).toMatch(/1 sospette/);
    expect(a.lettura.join("\n")).toMatch(/1 codici Mizar coincidono con lo stop_id di un'altra fermata/);
  });
  it("senza feed tutto risulta assente, e lo dice", () => {
    const a = classificaAbbinamenti(valide, [], { stops: new Set(), stopNames: new Map() });
    expect(a.riepilogo.fermateAssenti).toBe(4);
    expect(a.feedSenzaCodice).toEqual([]);
  });
});

/* ── Tappa 6.20b: un feed nato da Planning Studio ─────────────────────────────
 * Lo stop_id è l'identificativo della fermata nel progetto; il codice a cui
 * punta la tabella è il suo codice stabile. Lo stop_code non conta: in un
 * GTFS dell'azienda può essere il numero dell'AVM. */
describe("la transcodifica su un feed nato da Planning Studio", () => {
  const ID = { cavour: "a0000000-0000-4000-8000-000000020001", conero: "a0000000-0000-4000-8000-000000000200",
    gas: "a0000000-0000-4000-8000-000000020045", orfana: "a0000000-0000-4000-8000-000000000077" };
  const codici: Array<[string, string]> = [["20001", ID.cavour], ["200", ID.conero], ["20045", ID.gas], ["77", ID.orfana]];
  const feed = {
    stops: new Set(Object.values(ID)),
    stopNames: new Map([[ID.cavour, "PIAZZA CAVOUR (CONEROBUS LINEE NORD)"], [ID.conero, "VIA DEL CONERO - CASACCIA"], [ID.gas, "OSIMO STAZIONE"], [ID.orfana, "Fermata orfana"]]),
    stopByCodice: new Map(codici),
    codiceOfStop: new Map(codici.map(([c, id]) => [id, c] as [string, string])),
  };
  const { righe: valide, scartate } = righeDellaBase(leggiCsvTranscodifica(CSV).righe);

  it("il codice porta alla fermata per stop_id o per codice stabile; dalla fermata si torna al codice", () => {
    expect(fermataDelCodice("20001", feed)).toBe(ID.cavour);
    expect(fermataDelCodice(ID.cavour, feed)).toBe(ID.cavour);   // una correzione vecchia salvata con lo stop_id
    expect(fermataDelCodice("20928", feed)).toBeNull();
    expect(codiceDellaFermata(ID.cavour, feed)).toBe("20001");
    expect(codiceDellaFermata("20001", { stops: new Set(["20001"]) } as any)).toBe("20001");   // feed da file: lo stop_id
    expect(fermataDelCodice("20001", { stops: new Set(["20001"]) })).toBe("20001");
  });

  it("l'indice delle paline: prima nessuna trovava la fermata, ora la trova", () => {
    const indice = indiceTranscodifica(valide);
    expect([...indice].filter(([, s]) => feed.stops.has(s))).toEqual([]);   // la regola di prima
    expect(aliasNelFeed(indice, feed)).toEqual(new Map([["1122", ID.gas], ["200", ID.cavour], ["199", ID.conero]]));
  });

  it("resolveStop prende la fermata giusta, non quella col numero uguale", () => {
    const index: GtfsIndex = {
      feedId: "f", trips: new Set(), routes: new Set(), stops: feed.stops,
      tripRoute: new Map(), routeByCode: new Map(), routeLongNames: [],
      stopNames: feed.stopNames, stopByName: new Map(), stopByCodice: feed.stopByCodice, codiceOfStop: feed.codiceOfStop,
      stopByAlias: aliasNelFeed(indiceTranscodifica(valide), feed),
      timeZone: "Europe/Rome", loadedAt: 0,
    };
    expect(resolveStop("200", "Piazza Cavour (Conerobus Linee Nord)", index)).toEqual({ stopId: ID.cavour, how: "alias", conflict: null });
    expect(resolveStop("200", null, index)).toEqual({ stopId: ID.cavour, how: "alias", conflict: null });
  });

  it("la pagina: stati, collisioni e fermate senza codice come per un feed da file, coi codici", () => {
    const a = classificaAbbinamenti(valide, scartate, feed, { refs: [] }, namesCompatible);
    const per = Object.fromEntries(a.righe.map(r => [r.mizarRef, r]));
    expect(per["200"]).toMatchObject({ stato: "abbinata", stopId: "20001", collisione: "200 = VIA DEL CONERO - CASACCIA" });
    expect(per["1122"]).toMatchObject({ stato: "sospetta", nomeFeed: "OSIMO STAZIONE" });
    expect(per["461"]).toMatchObject({ stato: "fermata_assente", stopId: "20928" });
    expect(per["199"]).toMatchObject({ stato: "abbinata", stopId: "200", collisione: null });
    expect(a.feedSenzaCodice).toEqual([{ stopId: "77", nome: "Fermata orfana" }]);
    expect(verificaTranscodifica(valide, feed)).toMatchObject({
      righe: 4, nelFeed: 3, nonNelFeed: ["20928"], feedSenzaCodice: 1, stopConPiuCodici: [],
      collisioni: [{ mizarRef: "200", stopIdGiusto: "20001", stopIdOmonimo: "200" }],
    });
  });
});
