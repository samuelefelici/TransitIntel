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
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseTranscodifica, leggiTranscodificaCompleta, indiceTranscodifica, verificaTranscodifica, caricaTranscodifica, resetTranscodifica, classificaAbbinamenti } from "../lib/stop-aliases";
import { resolveStop, namesCompatible, type GtfsIndex } from "../lib/siri-vm";

const CSV = `﻿mizar_ref,stop_id,nome
1122,20045,ANCONA (Via Marconi Gas)
200,20001,"Piazza Cavour (Conerobus Linee Nord)"
461,20928,OSIMO (Capolinea)
199,200,VIA DEL CONERO - CASACCIA
5102,new_CT,"FABRIANO (Via Dante, 39)"

`;

describe("parseTranscodifica", () => {
  it("legge il CSV con BOM, virgolette e righe vuote; salta le paline senza codice", () => {
    const r = parseTranscodifica(CSV);
    expect(r).toEqual([
      { mizarRef: "1122", stopId: "20045", nome: "ANCONA (Via Marconi Gas)" },
      { mizarRef: "200", stopId: "20001", nome: "Piazza Cavour (Conerobus Linee Nord)" },
      { mizarRef: "461", stopId: "20928", nome: "OSIMO (Capolinea)" },
      { mizarRef: "199", stopId: "200", nome: "VIA DEL CONERO - CASACCIA" },
    ]);
    expect(indiceTranscodifica(r).get("200")).toBe("20001");
  });
  it("il file vero nel repository si legge ed è grande", () => {
    const p = path.resolve(__dirname, "..", "..", "data", "transcodifica-paline-mizar.csv");
    const r = parseTranscodifica(fs.readFileSync(p, "utf8"));
    expect(r.length).toBeGreaterThan(4000);
    const idx = indiceTranscodifica(r);
    expect(idx.get("1122")).toBe("20045");
    expect(idx.get("200")).toBe("20001");
    expect(idx.get("461")).toBe("20928");
    expect(idx.has("5102")).toBe(false);   // new_CT
  });
  it("caricaTranscodifica trova il file dal percorso del sorgente", () => {
    resetTranscodifica();
    const t = caricaTranscodifica(true);
    expect(t.errore).toBeNull();
    expect(t.indice.get("1122")).toBe("20045");
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
    const v = verificaTranscodifica(parseTranscodifica(CSV), new Set(["20001", "200", "20045", "77"]));
    expect(v).toMatchObject({
      righe: 4, nelFeed: 3, nonNelFeed: ["20928"], feedSenzaCodice: 1,
      stopConPiuCodici: [],
      collisioni: [{ mizarRef: "200", stopIdGiusto: "20001", stopIdOmonimo: "200" }],
    });
  });
});

describe("classificaAbbinamenti: ogni palina con il suo stato", () => {
  const { valide, scartate } = leggiTranscodificaCompleta(CSV);
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
