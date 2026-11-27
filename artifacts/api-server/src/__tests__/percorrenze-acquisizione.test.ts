/**
 * Acquisire i tempi reali nel programma — collaudo delle regole (senza
 * database). Il caso vero: il ritorno della 2 ha 17′ in orario e i bus ne
 * fanno 19–20, con 3′ di sosta a Cavour: rifatti i tempi sul reale, la sosta
 * che resta si vede subito, prima di scrivere.
 */
import { describe, it, expect } from "vitest";
import { Osservato, secondi, CAMPIONI_MINIMI, type CorsaProgetto, type FermataCorsa } from "../lib/percorrenze-reali";
import { ricalcolaCorsa, confronto, hms, variazioneArrivoMin, TRATTO_MINIMO_S } from "../lib/percorrenze-acquisizione";

const F = (stopId: string, gtfsId: string | null, arr: string, dep = arr): FermataCorsa => ({
  stopId, gtfsId, nome: stopId, clusterId: null, lat: null, lon: null, arrivoS: secondi(arr), partenzaS: secondi(dep),
});
const stat = (medianaS: number, p85S: number, n = 20) => ({ n, giorni: 8, medianaS, p85S });
const corsa = (id: string, fermate: FermataCorsa[], variantId = "v"): CorsaProgetto => ({ tripId: id, variantId, direzione: 0, fermate });

/* A → B → C, 2′ + 2′ in orario */
const base = (dep = "08:00:00") => {
  const d = secondi(dep)!;
  return corsa(`T${dep}`, [F("a", "A", hms(d)), F("b", "B", hms(d + 120)), F("c", "C", hms(d + 240))]);
};

describe("gli orari nuovi di una corsa", () => {
  it("la partenza resta, i passaggi prendono il tempo dell'ora", () => {
    const o = new Osservato();
    o.aggiungi("A", "B", 8, stat(180, 240));
    o.aggiungi("B", "C", 8, stat(150, 200));
    const r = ricalcolaCorsa(base(), o, { valore: "mediana" });
    expect(r.saltata).toBeNull();
    expect(r.fermate.map(f => hms(f.arrivoS!))).toEqual(["08:00:00", "08:03:00", "08:05:30"]);
    expect(r.fonti).toMatchObject({ ora: 2, programmato: 0 });
    expect(r.cambia).toBe(true);
    expect(variazioneArrivoMin(base().fermate, r.fermate)).toBe(1.5);
  });

  it("all'85° percentile, più larga", () => {
    const o = new Osservato();
    o.aggiungi("A", "B", null, stat(180, 240));
    o.aggiungi("B", "C", null, stat(150, 200));
    const r = ricalcolaCorsa(base(), o, { valore: "p85" });
    expect(hms(r.fermate[2].arrivoS!)).toBe("08:07:20");
    expect(r.fonti.giornata).toBe(2);
  });

  it("la corsa che slitta nell'ora dopo ne prende i tempi (la punta)", () => {
    const o = new Osservato();
    o.aggiungi("A", "B", 7, stat(600, 700));          // 07:58 → 08:08
    o.aggiungi("B", "C", 7, stat(60, 70));
    o.aggiungi("B", "C", 8, stat(300, 360));          // si parte da B alle 08:08: vale l'ora 8
    const r = ricalcolaCorsa(base("07:58:00"), o, { valore: "mediana" });
    expect(r.fermate.map(f => hms(f.arrivoS!))).toEqual(["07:58:00", "08:08:00", "08:13:00"]);
  });

  it("con l'ora scarsa usa la fascia oraria, poi la giornata, poi il programmato", () => {
    const o = new Osservato();
    o.aggiungi("A", "B", 8, stat(999, 999, CAMPIONI_MINIMI - 1));
    o.aggiungiFascia("A", "B", "punta_mattino", stat(150, 170));
    const r = ricalcolaCorsa(base(), o, { valore: "mediana" });
    expect(r.fonti).toMatchObject({ fascia: 1, programmato: 1 });
    expect(r.fermate.map(f => hms(f.arrivoS!))).toEqual(["08:00:00", "08:02:30", "08:04:30"]);
  });

  it("dichiara i tratti presi dai feriali", () => {
    const o = new Osservato();
    o.aggiungi("A", "B", null, stat(100, 120));
    const r = ricalcolaCorsa(base(), o, { valore: "mediana", daRipiego: new Set(["A>B"]) });
    expect(r.fonti).toMatchObject({ feriale: 1, programmato: 1, giornata: 0 });
  });

  it("la sosta programmata resta esplicita e non si conta due volte", () => {
    // a B sosta di 2′ in orario; il reale B→C (fra due arrivi) contiene già il minuto di sosta normale
    const c = corsa("S", [F("a", "A", "08:00:00"), F("b", "B", "08:02:00", "08:04:00"), F("c", "C", "08:06:00")]);
    const o = new Osservato();
    o.aggiungi("A", "B", null, stat(120, 130));
    o.aggiungi("B", "C", null, stat(150, 170));
    const r = ricalcolaCorsa(c, o, { valore: "mediana" });
    expect(r.fermate.map(f => [hms(f.arrivoS!), hms(f.partenzaS!)])).toEqual([
      ["08:00:00", "08:00:00"], ["08:02:00", "08:04:00"], ["08:05:30", "08:05:30"],   // 150 − 60 = 90″ dopo la partenza da B
    ]);
  });

  it("un tratto non scende sotto il minimo, e gli orari mancanti fermano la corsa", () => {
    const o = new Osservato();
    o.aggiungi("A", "B", null, stat(2, 3));
    expect(ricalcolaCorsa(base(), o, { valore: "mediana" }).fermate[1].arrivoS! - secondi("08:00:00")!).toBe(TRATTO_MINIMO_S);
    const buca = corsa("X", [F("a", "A", "08:00:00"), { ...F("b", "B", "08:02:00"), arrivoS: null, partenzaS: null }, F("c", "C", "08:04:00")]);
    expect(ricalcolaCorsa(buca, o, { valore: "mediana" })).toMatchObject({ saltata: expect.stringMatching(/orari mancanti/), cambia: false });
    expect(ricalcolaCorsa(corsa("U", [F("a", "A", "08:00:00")]), o, { valore: "mediana" }).saltata).toMatch(/una fermata/);
  });

  it("senza dati la corsa resta com'è", () => {
    const r = ricalcolaCorsa(base(), new Osservato(), { valore: "mediana" });
    expect(r.cambia).toBe(false);
    expect(r.fonti.programmato).toBe(2);
  });
});

describe("la sosta al capolinea, prima e dopo", () => {
  /* andata A→B 17′ in orario, ritorno 3′ dopo l'arrivo: i bus fanno 20′ */
  const andata = corsa("andata", [F("a", "A", "08:00:00"), F("b", "B", "08:17:00")], "vA");
  const ritorno = corsa("ritorno", [F("b", "B", "08:20:00"), F("a", "A", "08:37:00")], "vR");
  const o = new Osservato();
  o.aggiungi("A", "B", null, stat(20 * 60, 24 * 60));
  o.aggiungi("B", "A", null, stat(17 * 60, 18 * 60));

  it("calcola la corsa dopo su tutte le corse della linea, con le ricalcolate al posto delle vecchie", () => {
    const r = ricalcolaCorsa(andata, o, { valore: "mediana" });
    const e = confronto([andata, ritorno], new Map([["andata", r]]), o).get("andata")!;
    expect(e.prima).toMatchObject({ sostaMin: 3, prossimaPartenza: "08:20", giudizio: "insufficiente" });
    // dopo: arriva alle 08:20, la sosta è zero — l'orario ora lo DICE
    expect(e.dopo).toMatchObject({ sostaMin: 0, giudizio: "insufficiente" });
    expect(confronto([andata, ritorno], new Map([["andata", r]]), o).has("ritorno")).toBe(false);
  });
});

describe("orari oltre la mezzanotte", () => {
  it("hh:mm:ss oltre le 24", () => {
    expect(hms(25 * 3600 + 10 * 60)).toBe("25:10:00");
    expect(hms(59.6)).toBe("00:01:00");
  });
});
