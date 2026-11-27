/**
 * Le percorrenze di una linea, programmato contro reale, e il delta finale —
 * collaudo delle regole (senza database).
 * Il caso vero: la 22/24 della domenica arriva a Brecce Bianche alle :10 e
 * riparte alle :10. Se i bus ci mettono due minuti più dell'orario, la corsa
 * di ritorno parte in ritardo: il delta finale non assorbe niente.
 */
import { describe, it, expect } from "vitest";
import {
  secondi, hhmm, tipoDelGiorno, giorniOsservati, tipoPerGiornoTipo, Osservato, ritardoCorsa,
  esitiCorse, trattiENodi, riepilogoCorse, giudica, stessoCapolinea, CAMPIONI_MINIMI,
  type CorsaProgetto, type FermataCorsa,
} from "../lib/percorrenze-reali";

const F = (stopId: string, gtfsId: string | null, nome: string, arr: string, dep = arr, extra: Partial<FermataCorsa> = {}): FermataCorsa => ({
  stopId, gtfsId, nome, clusterId: null, lat: null, lon: null, arrivoS: secondi(arr), partenzaS: secondi(dep), ...extra,
});
const stat = (medianaS: number, p85S: number, n = 20) => ({ n, giorni: 8, medianaS, p85S });

/* Andata Ugo Bassi → Pinocchio → Brecce Bianche (25′), ritorno subito (0′ di sosta). */
const andata = (dep: string, arr: string, mid: string, id = `A${dep}`): CorsaProgetto => ({
  tripId: id, variantId: "vA", direzione: 0,
  fermate: [F("ub", "100", "Ugo Bassi", dep), F("pi", "200", "Pinocchio", mid), F("bb", "300", "Brecce Bianche", arr)],
});
const ritorno = (dep: string, arr: string, mid: string, id = `R${dep}`): CorsaProgetto => ({
  tripId: id, variantId: "vR", direzione: 1,
  fermate: [F("bb", "300", "Brecce Bianche", dep), F("pi2", "201", "Pinocchio", mid), F("ub2", "101", "Ugo Bassi Cap.", arr, arr, { clusterId: "nodo-ub" })],
});

describe("orari e giorni", () => {
  it("secondi e hh:mm, anche oltre la mezzanotte", () => {
    expect(secondi("07:45:00")).toBe(27900);
    expect(secondi("25:10")).toBe(90600);
    expect(secondi("x")).toBeNull();
    expect(hhmm(27900)).toBe("07:45");
    expect(hhmm(null)).toBeNull();
  });

  it("domeniche e festivi infrasettimanali sono festivo; il sabato è sabato", () => {
    expect(tipoDelGiorno("2026-11-29")).toBe("festivo");  // domenica
    expect(tipoDelGiorno("2026-12-08")).toBe("festivo");  // Immacolata, martedì
    expect(tipoDelGiorno("2026-11-28")).toBe("sabato");
    expect(tipoDelGiorno("2026-11-27")).toBe("feriale");
  });

  it("i giorni osservati: solo quelli del tipo, fino a ieri", () => {
    // 28 giorni prima del 30/11 arrivano al 2/11: quattro domeniche
    expect(giorniOsservati("festivo", "2026-11-30", 28)).toEqual(["2026-11-29", "2026-11-22", "2026-11-15", "2026-11-08"]);
    // con 34 giorni entrano l'1/11 (domenica e Ognissanti) e nessun altro festivo
    expect(giorniOsservati("festivo", "2026-11-30", 34)).toHaveLength(5);
    expect(giorniOsservati("sabato", "2026-11-30", 7)).toEqual(["2026-11-28"]);
    expect(giorniOsservati("festivo", "2026-11-29", 1)).toEqual([]); // oggi non conta
  });

  it("il tipo di giorno dal giorno-tipo del progetto", () => {
    expect(tipoPerGiornoTipo("festivo")).toBe("festivo");
    expect(tipoPerGiornoTipo("Sabato")).toBe("sabato");
    expect(tipoPerGiornoTipo("feriale")).toBe("feriale");
    expect(tipoPerGiornoTipo(null)).toBe("feriale");
  });
});

describe("Osservato", () => {
  it("usa l'ora se ha abbastanza campioni, altrimenti la giornata, altrimenti niente", () => {
    const o = new Osservato();
    o.aggiungi("1", "2", 8, stat(100, 130));
    o.aggiungi("1", "2", 9, stat(500, 600, CAMPIONI_MINIMI - 1));
    o.aggiungi("1", "2", null, stat(110, 140));
    expect(o.per("1", "2", 8)).toMatchObject({ medianaS: 100, fonte: "ora" });
    expect(o.per("1", "2", 9)).toMatchObject({ medianaS: 110, fonte: "giornata" });
    expect(o.per("1", "3", 8)).toBeNull();
    expect(o.per(null, "2", 8)).toBeNull();
  });

  it("con l'ora scarsa usa la sua fascia oraria (la punta non è la morbida), poi la giornata", () => {
    const o = new Osservato();
    o.aggiungi("1", "2", 8, stat(500, 600, CAMPIONI_MINIMI - 1));   // le 8: pochi campioni
    o.aggiungiFascia("1", "2", "punta_mattino", stat(150, 190));     // 6–9
    o.aggiungiFascia("1", "2", "morbida", stat(90, 110));            // 9–13
    o.aggiungi("1", "2", null, stat(110, 140));
    expect(o.per("1", "2", 8)).toMatchObject({ medianaS: 150, fonte: "fascia" });
    expect(o.per("1", "2", 10)).toMatchObject({ medianaS: 90, fonte: "fascia" });
    // la sera non ha fascia: giornata
    expect(o.per("1", "2", 20)).toMatchObject({ medianaS: 110, fonte: "giornata" });
  });

  it("la fascia peggiore è quella con lo scarto più grande, fra quelle con dati", () => {
    const o = new Osservato();
    o.aggiungi("1", "2", 8, stat(100, 130));
    o.aggiungi("1", "2", 17, stat(160, 200));
    o.aggiungi("1", "2", 18, stat(900, 950, 2)); // pochi campioni: non conta
    expect(o.oraPeggiore("1", "2", 90)).toEqual({ ora: 17, medianaS: 160, n: 20 });
  });
});

describe("una corsa: ritardo atteso e copertura", () => {
  it("somma i tratti all'ora in cui li percorre; un tratto senza dati vale il programmato", () => {
    const o = new Osservato();
    o.aggiungi("100", "200", 7, stat(15 * 60, 18 * 60));   // programmato 13′
    const r = ritardoCorsa(andata("07:45:00", "08:10:00", "07:58:00"), o);
    expect(r.programmatoS).toBe(25 * 60);
    expect(r.medianoS).toBe(15 * 60 + 12 * 60);   // 2′ in più sul primo tratto
    expect(r.p85S).toBe(15 * 60 + 12 * 60 + 3 * 60);  // un solo tratto con dati: il suo scarto intero
    expect(r.coperturaPct).toBe(52);               // 13′ su 25′ coperti
  });
});

describe("il delta finale", () => {
  const o = new Osservato();
  o.aggiungi("100", "200", null, stat(15 * 60, 18 * 60));
  o.aggiungi("200", "300", null, stat(12 * 60, 13 * 60));
  o.aggiungi("300", "201", null, stat(12 * 60, 14 * 60));
  o.aggiungi("201", "101", null, stat(12 * 60, 13 * 60));

  it("arriva 36″ dopo che il ritorno è partito: delta negativo, non la corsa di un'ora dopo", () => {
    const corse = [
      andata("07:45:00", "08:10:36", "07:58:00"),
      ritorno("08:10:00", "08:34:00", "08:22:00"),
      ritorno("09:10:00", "09:34:00", "09:22:00"),
    ];
    const a1 = esitiCorse(corse, o).find(x => x.tripId === "A07:45:00")!;
    expect(a1.prossimaPartenza).toBe("08:10");
    expect(a1.deltaFinaleMin).toBe(-0.6);
    expect(a1.giudizio).toBe("insufficiente");
    // oltre 3′ prima dell'arrivo non è più lo stesso bus
    const lontano = esitiCorse([andata("07:45:00", "08:14:00", "07:58:00"), ritorno("08:10:00", "08:34:00", "08:22:00")], o);
    expect(lontano[0].giudizio).toBe("rientro");
  });

  it("la 22/24 a Brecce Bianche: 0′ di sosta contro 2′ di ritardo → insufficiente", () => {
    const corse = [andata("07:45:00", "08:10:00", "07:58:00"), ritorno("08:10:00", "08:34:00", "08:22:00"), andata("08:45:00", "09:10:00", "08:58:00")];
    const e = esitiCorse(corse, o);
    const a1 = e.find(x => x.tripId === "A07:45:00")!;
    expect(a1.deltaFinaleMin).toBe(0);
    expect(a1.prossimaPartenza).toBe("08:10");
    expect(a1.ritardoMedianoMin).toBe(2);
    expect(a1.ritardoP85Min).toBe(5.4);  // 2′ + √(0,7·(3²+1²) + 0,3·(3+1)²) = 2′ + 3,4′
    expect(a1.restoMedianoMin).toBe(-2);
    expect(a1.giudizio).toBe("insufficiente");
  });

  it("il ritorno arriva al capolinea del nodo: la corsa dopo parte da una fermata vicina", () => {
    const corse = [
      ritorno("08:10:00", "08:34:00", "08:22:00"),
      { ...andata("08:45:00", "09:10:00", "08:58:00"), fermate: andata("08:45:00", "09:10:00", "08:58:00").fermate.map((f, i) => i === 0 ? { ...f, clusterId: "nodo-ub" } : f) },
    ];
    const e = esitiCorse(corse, o);
    const r = e.find(x => x.tripId === "R08:10:00")!;
    expect(r.deltaFinaleMin).toBe(11);
    expect(r.ritardoP85Min).toBe(2.5);
    expect(r.giudizio).toBe("assorbe");
  });

  it("l'ultima corsa rientra; senza dati reali non si giudica", () => {
    const e = esitiCorse([andata("19:45:00", "20:10:00", "19:58:00")], o);
    expect(e[0].giudizio).toBe("rientro");
    const vuoto = esitiCorse([andata("07:45:00", "08:10:00", "07:58:00"), ritorno("08:30:00", "08:54:00", "08:42:00")], new Osservato());
    expect(vuoto[0].giudizio).toBe("senza_dati");
    expect(vuoto[0].ritardoMedianoMin).toBeNull();
  });

  it("le soglie del giudizio", () => {
    expect(giudica(600, 120, 300, 100)).toBe("assorbe");      // 10′ ≥ 5′ + 2′
    expect(giudica(360, 120, 300, 100)).toBe("al_limite");    // 6′ < 7′ ma ≥ 2′+2′
    expect(giudica(180, 120, 300, 100)).toBe("insufficiente");
    expect(giudica(300, -120, -60, 100)).toBe("assorbe");     // in anticipo: il ritardo vale zero
    expect(giudica(null, 0, 0, 100)).toBe("rientro");
  });

  it("riepilogo e nota", () => {
    const corse = [andata("07:45:00", "08:10:00", "07:58:00"), ritorno("08:10:00", "08:34:00", "08:22:00")];
    const r = riepilogoCorse(esitiCorse(corse, o));
    expect(r).toMatchObject({ corse: 2, insufficiente: 1, rientro: 1, deltaMinimoMin: 0 });
    expect(r.nota).toMatch(/non assorbe/);
  });
});

describe("tratti e nodi", () => {
  it("per ogni tratto programmato e reale; per ogni nodo il cumulato", () => {
    const o = new Osservato();
    o.aggiungi("100", "200", null, stat(15 * 60, 18 * 60));
    o.aggiungi("100", "200", 17, stat(17 * 60, 20 * 60));
    const { tratti, nodi, coperturaPct } = trattiENodi([andata("07:45:00", "08:10:00", "07:58:00"), andata("17:45:00", "18:10:00", "17:58:00")], o);
    expect(tratti).toHaveLength(2);
    expect(tratti[0]).toMatchObject({ da: "Ugo Bassi", a: "Pinocchio", programmatoS: 780, scartoMedianoS: 120, scartoP85S: 300 });
    expect(tratti[0].oraPeggiore).toMatchObject({ ora: 17, scartoS: 240 });
    expect(tratti[1].reale).toBeNull();
    expect(coperturaPct).toBe(50);
    expect(nodi.map(n => [n.fermata, n.programmatoMin, n.realeMin, n.scartoMin])).toEqual([
      ["Ugo Bassi", 0, 0, 0], ["Pinocchio", 13, 15, 2], ["Brecce Bianche", 25, 27, 2],
    ]);
  });
});

describe("stesso capolinea", () => {
  it("stessa fermata, stesso nodo o entro 250 m", () => {
    const a = F("x", "1", "A", "08:00:00", "08:00:00", { lat: 43.6, lon: 13.5 });
    expect(stessoCapolinea(a, { ...a })).toBe(true);
    expect(stessoCapolinea({ ...a, clusterId: "n" }, { ...a, stopId: "y", clusterId: "n", lat: 44, lon: 14 })).toBe(true);
    expect(stessoCapolinea(a, { ...a, stopId: "y", lat: 43.6015, lon: 13.5 })).toBe(true);   // ~170 m
    expect(stessoCapolinea(a, { ...a, stopId: "y", lat: 43.61, lon: 13.5 })).toBe(false);    // ~1,1 km
  });
});
