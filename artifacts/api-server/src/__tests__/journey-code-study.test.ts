/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Il codice corsa dell'AVM e quello del GTFS — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questo modulo risponde a una domanda su cui è facilissimo ingannarsi: "che
 * regola lega i due codici?". Una regola con un parametro si ricava dai dati
 * e poi torna sempre su quegli stessi dati — sembra una scoperta ed è una
 * tautologia. I collaudi qui sotto servono soprattutto a garantire che quella
 * distinzione non si perda.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  forma, regoleDa, verifica, studiaCodici, type CoppiaCodici,
} from "../lib/journey-code-study";

const o = (
  giorno: string, journeyRef: string, tripId: string | null,
  agganciatoCome: CoppiaCodici["agganciatoCome"] = "orario",
): CoppiaCodici => ({ giorno, journeyRef, tripId, agganciatoCome, osservazioni: 1 });

describe("la forma di un codice", () => {
  it("riduce cifre e lettere alle loro classi, tenendo i separatori", () => {
    expect(forma("0072")).toBe("NNNN");
    expect(forma("L03_0072")).toBe("LNN_NNNN");
    expect(forma("VI1-12")).toBe("LLN-NN");
  });

  /* Serve a vedere a colpo d'occhio se i due mondi parlano la stessa lingua:
   * "NNNN" contro "LNN_NNNN" chiude la questione prima di ogni formula. */
  it("raggruppa i codici per aspetto, dal più comune", () => {
    const s = studiaCodici([o("2026-09-10", "12", "A_12"), o("2026-09-10", "13", "A_13"),
      o("2026-09-10", "X9", "A_X9")]);
    expect(s.forme.avm[0]).toMatchObject({ forma: "NN", quanti: 2 });
    expect(s.forme.gtfs[0]).toMatchObject({ forma: "L_NN", quanti: 2 });
  });
});

describe("le regole candidate", () => {
  it("riconosce un prefisso costante e lo sa riapplicare", () => {
    const da = [{ j: "0072", t: "CON_0072" }, { j: "0073", t: "CON_0073" }];
    const r = regoleDa(da).find(x => x.nome === "prefisso costante");
    expect(r).toBeTruthy();
    expect(r!.applica("0099")).toBe("CON_0099");
    expect(r!.enunciato).toMatch(/CON_/);
  });

  /* Con dati veri basta una corsa storta: se il parametro si imparasse dalla
   * totalità, una regola giusta non verrebbe nemmeno proposta. */
  it("impara il parametro dalla maggioranza, non dalla totalità", () => {
    const da = [{ j: "1", t: "P1" }, { j: "2", t: "P2" }, { j: "3", t: "ZZZ" }];
    const r = regoleDa(da).find(x => x.nome === "prefisso costante");
    expect(r?.applica("4")).toBe("P4");
  });

  it("riconosce lo stesso numero scritto con e senza zeri davanti", () => {
    const r = regoleDa([]).find(x => x.nome === "stesso numero")!;
    const esito = verifica(r, [{ j: "0072", t: "72" }, { j: "5", t: "005" }], false);
    expect(esito.spiegate).toBe(2);
    expect(esito.smentite).toBe(0);
  });

  it("non si pronuncia su codici senza cifre invece di dire di no", () => {
    const r = regoleDa([]).find(x => x.nome === "stesso numero")!;
    expect(verifica(r, [{ j: "ABC", t: "DEF" }], false).mute).toBe(1);
  });

  /* "83%" senza i casi che sbagliano non è azionabile: non si sa se sia una
   * regola quasi giusta o due regole diverse mescolate. */
  it("porta i controesempi, non solo la percentuale", () => {
    const r = regoleDa([]).find(x => x.nome === "identici")!;
    const esito = verifica(r, [{ j: "A", t: "A" }, { j: "B", t: "QQ" }], false);
    expect(esito.quota).toBe(0.5);
    expect(esito.controesempi).toEqual([{ avm: "B", feed: "QQ", regolaDice: "B" }]);
  });
});

describe("la controprova", () => {
  /* Il cuore del modulo: con un giorno solo la regola è ricavata e verificata
   * sugli stessi dati, e non vale niente come prova. Va detto, non nascosto
   * dietro un 100%. */
  it("con un giorno solo dichiara le regole tautologiche", () => {
    const s = studiaCodici([o("2026-09-10", "1", "P1"), o("2026-09-10", "2", "P2")]);
    expect(s.senzaControprova).toBe(true);
    expect(s.regole.every(r => r.tautologica)).toBe(true);
    expect(s.verdetto).toMatch(/non è ancora una prova|un giorno solo/i);
  });

  it("con due giorni ricava dal primo e misura sul secondo", () => {
    const s = studiaCodici([
      o("2026-09-10", "1", "P1"), o("2026-09-10", "2", "P2"),
      o("2026-09-11", "3", "P3"), o("2026-09-11", "4", "P4"),
    ]);
    expect(s.senzaControprova).toBe(false);
    const r = s.regole.find(x => x.nome === "prefisso costante")!;
    expect(r.tautologica).toBe(false);
    expect(r.spiegate).toBe(2);          // solo il secondo giorno
    expect(r.quota).toBe(1);
    expect(s.verdetto).toMatch(/corrispondenza vera/i);
  });

  /* La regola imparata dal primo giorno che crolla sul secondo: è esattamente
   * il caso che la controprova esiste per scoprire. */
  it("smaschera una regola che regge solo sul giorno da cui è nata", () => {
    const s = studiaCodici([
      o("2026-09-10", "1", "P1"), o("2026-09-10", "2", "P2"),
      o("2026-09-11", "3", "QQQ"), o("2026-09-11", "4", "RRR"),
    ]);
    const r = s.regole.find(x => x.nome === "prefisso costante")!;
    expect(r.quota).toBe(0);
    expect(r.controesempi.length).toBeGreaterThan(0);
    expect(s.verdetto).not.toMatch(/corrispondenza vera/i);
  });
});

describe("quando nessuna formula regge", () => {
  /* Non è un fallimento: due anagrafiche diverse non si trasformano l'una
   * nell'altra. Ma allora la tabella osservata è la traduzione, e va detto —
   * purché sia univoca e su più di un giorno. */
  it("propone la tabella osservata se la corrispondenza è univoca e ripetuta", () => {
    const righe: CoppiaCodici[] = [];
    for (const g of ["2026-09-10", "2026-09-11"]) {
      for (let i = 1; i <= 30; i++) righe.push(o(g, `AVM${i}`, `feed-xyz-${i * 7}`));
    }
    const s = studiaCodici(righe);
    expect(s.stabilita.quotaUnivoca).toBe(1);
    expect(s.stabilita.giorni).toBe(2);
    expect(s.verdetto).toMatch(/tabella raccolta/i);
  });

  /* Lo stesso codice su corse diverse: appoggiarcisi metterebbe i mezzi sulle
   * corse sbagliate, quindi il verdetto deve fermare, non incoraggiare. */
  it("segnala i codici dell'AVM comparsi su corse diverse", () => {
    const s = studiaCodici([
      o("2026-09-10", "A", "corsa-1"), o("2026-09-11", "A", "corsa-2"),
      o("2026-09-10", "B", "corsa-3"), o("2026-09-11", "B", "corsa-3"),
    ]);
    expect(s.stabilita.avmAmbigui).toEqual([{ journeyRef: "A", corse: ["corsa-1", "corsa-2"] }]);
    expect(s.stabilita.quotaUnivoca).toBe(0.5);
    expect(s.verdetto).toMatch(/non identifica la corsa/i);
  });

  it("segnala anche il verso opposto: una corsa con due codici AVM", () => {
    const s = studiaCodici([
      o("2026-09-10", "A", "corsa-1"), o("2026-09-11", "B", "corsa-1"),
    ]);
    expect(s.stabilita.corseAmbigue).toEqual([{ tripId: "corsa-1", codici: ["A", "B"] }]);
  });
});

describe("il conteggio", () => {
  it("tiene separate le letture senza aggancio dalle coppie", () => {
    const s = studiaCodici([
      o("2026-09-10", "1", "P1", "id"), o("2026-09-10", "2", null, null),
    ]);
    expect(s.coppie).toBe(1);
    expect(s.senzaAggancio).toBe(1);
    expect(s.giaAllineate).toBe(1);
    expect(s.codiciAvm).toBe(2);
    expect(s.corseGtfs).toBe(1);
  });

  it("senza nessuna coppia lo dice invece di inventare una regola", () => {
    const s = studiaCodici([o("2026-09-10", "1", null, null)]);
    expect(s.coppie).toBe(0);
    expect(s.verdetto).toMatch(/nulla da studiare/i);
  });

  it("su elenco vuoto non esplode", () => {
    const s = studiaCodici([]);
    expect(s.coppie).toBe(0);
    expect(s.giorni).toEqual([]);
  });
});
