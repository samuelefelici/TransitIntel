/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Registro anomalie — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Queste rilevazioni finiscono in un elenco che qualcuno userà per parlare
 * con chi guida. Un falso positivo qui non è un numero sbagliato: è una
 * contestazione a una persona che non ha fatto niente. Perciò si collauda
 * soprattutto ciò che NON deve essere segnalato.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  rilevaAnomalie, riepiloga, distanzaDaSegmento, distanzaDalPercorso,
  sogliaFuoriPercorso,
  type CorsaDaEsaminare, type FermataCorsa,
} from "../lib/anomaly-detection";

const GIORNO = "2026-09-10";
const at = (hhmmss: string) => `${GIORNO}T${hhmmss}+02:00`;
const sec = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s;

/** Una corsa urbana: 5 fermate lungo Corso Amendola, 20 minuti. */
function corsa(over: Partial<CorsaDaEsaminare> = {}): CorsaDaEsaminare {
  const fermate: FermataCorsa[] = [
    { seq: 1, stopId: "S1", stopName: "Capolinea",  lat: 43.600, lon: 13.500, scheduledSec: sec(8, 0),  actualTs: at("08:00:00"), osservato: true },
    { seq: 2, stopId: "S2", stopName: "Via Roma",   lat: 43.605, lon: 13.505, scheduledSec: sec(8, 5),  actualTs: at("08:05:00"), osservato: true },
    { seq: 3, stopId: "S3", stopName: "Ospedale",   lat: 43.610, lon: 13.510, scheduledSec: sec(8, 10), actualTs: at("08:10:00"), osservato: true },
    { seq: 4, stopId: "S4", stopName: "Stazione",   lat: 43.615, lon: 13.515, scheduledSec: sec(8, 15), actualTs: at("08:15:00"), osservato: true },
    { seq: 5, stopId: "S5", stopName: "Terminal",   lat: 43.620, lon: 13.520, scheduledSec: sec(8, 20), actualTs: at("08:20:00"), osservato: true },
  ];
  return { tripId: "T1", vehicleId: "268", routeShortName: "4", day: GIORNO, fermate, ...over };
}

/** Sostituisce l'orario reale di una fermata. */
function conTransito(c: CorsaDaEsaminare, seq: number, ts: string | null, osservato = true): CorsaDaEsaminare {
  return { ...c, fermate: c.fermate.map(f => f.seq === seq ? { ...f, actualTs: ts, osservato } : f) };
}

describe("geometria del percorso", () => {
  it("misura la distanza dal segmento, non dai suoi estremi", () => {
    /* Un punto a metà di una tratta lunga è vicino al PERCORSO anche se è
     * lontano da entrambe le fermate: misurare dalle fermate darebbe falsi
     * allarmi su ogni tratta lunga. */
    const aLat = 43.60, aLon = 13.50, bLat = 43.62, bLon = 13.50;
    const meta = { lat: 43.61, lon: 13.50 };
    expect(Math.round(distanzaDaSegmento(meta.lat, meta.lon, aLat, aLon, bLat, bLon))).toBe(0);
    // e a 500 m di lato, la distanza è quella
    const lato = 13.50 + 500 / (111320 * Math.cos(43.61 * Math.PI / 180));
    expect(Math.round(distanzaDaSegmento(43.61, lato, aLat, aLon, bLat, bLon))).toBeGreaterThan(480);
  });

  it("oltre il segmento misura dall'estremo", () => {
    const d = distanzaDaSegmento(43.63, 13.50, 43.60, 13.50, 43.62, 13.50);
    expect(Math.round(d)).toBeGreaterThan(1000);   // ~1.1 km oltre il capolinea
  });

  it("prende la tratta più vicina di tutto il percorso", () => {
    const c = corsa();
    expect(distanzaDalPercorso(43.6125, 13.5125, c.fermate)!).toBeLessThan(50);
    expect(distanzaDalPercorso(43.700, 13.600, c.fermate)!).toBeGreaterThan(5000);
  });

  it("senza coordinate non si pronuncia", () => {
    const senzaCoord = corsa().fermate.map(f => ({ ...f, lat: null, lon: null }));
    expect(distanzaDalPercorso(43.6, 13.5, senzaCoord)).toBeNull();
  });
});

/* ── Ciò che NON deve essere segnalato ─────────────────────────────────── */
describe("una corsa regolare non produce anomalie", () => {
  it("in orario esatto: elenco vuoto", () => {
    expect(rilevaAnomalie(corsa())).toEqual([]);
  });

  it("un ritardo modesto e costante non è un'anomalia", () => {
    let c = corsa();
    [1, 2, 3, 4, 5].forEach(s => {
      c = conTransito(c, s, at(`08:${String((s - 1) * 5 + 2).padStart(2, "0")}:00`));
    });
    expect(rilevaAnomalie(c)).toEqual([]);
  });

  /* 40 secondi di anticipo alla partenza sono dentro la tolleranza:
   * segnalarli riempirebbe l'elenco e nasconderebbe i casi veri. */
  it("un anticipo sotto il minuto non viene segnalato", () => {
    const c = conTransito(corsa(), 1, at("07:59:20"));
    expect(rilevaAnomalie(c).some(a => a.tipo === "anticipo_partenza")).toBe(false);
  });

  /* Il mezzo passa a 200 m dal tracciato: nel centro storico le vie parallele
   * stanno dentro quella distanza, e segnalarle sarebbe rumore. */
  it("una deviazione entro il raggio non è fuori percorso", () => {
    const off = 200 / (111320 * Math.cos(43.61 * Math.PI / 180));
    const c = corsa({
      posizioni: [0, 1, 2, 3, 4].map(i => ({
        ts: at(`08:0${i}:00`), lat: 43.610, lon: 13.510 + off,
      })),
    });
    expect(rilevaAnomalie(c).some(a => a.tipo === "fuori_percorso")).toBe(false);
  });

  /* Un solo punto GPS fuori può essere un salto del segnale. Su un dato che
   * mette in discussione un conducente non si parte da una lettura sola. */
  it("una sola lettura fuori non basta a dire fuori percorso", () => {
    const c = corsa({
      posizioni: [
        { ts: at("08:01:00"), lat: 43.601, lon: 13.501 },
        { ts: at("08:02:00"), lat: 43.700, lon: 13.700 },   // salto isolato
        { ts: at("08:03:00"), lat: 43.606, lon: 13.506 },
      ],
    });
    expect(rilevaAnomalie(c).some(a => a.tipo === "fuori_percorso")).toBe(false);
  });
});

/* ── Ciò che deve essere segnalato ─────────────────────────────────────── */
describe("anticipo alla partenza", () => {
  it("segnala la partenza anticipata con la gravità più alta", () => {
    const c = conTransito(corsa(), 1, at("07:57:00"));   // 3 minuti prima
    const a = rilevaAnomalie(c).find(x => x.tipo === "anticipo_partenza")!;
    expect(a).toBeDefined();
    expect(a.confidenza).toBe("certa");
    expect(a.gravita).toBeGreaterThan(60);
    expect(a.misure.anticipoSec).toBe(180);
    expect(a.dettaglio).toMatch(/non ha rimedio/i);
  });

  /* L'anticipo pesa più di un ritardo di pari entità: è l'unico caso in cui
   * chi ha rispettato l'orario resta a terra. */
  it("pesa più di un ritardo della stessa entità", () => {
    const ant = rilevaAnomalie(conTransito(corsa(), 1, at("07:55:00")))
      .find(x => x.tipo === "anticipo_partenza")!;
    let tardi = corsa();
    [1, 2, 3, 4, 5].forEach(s => {
      tardi = conTransito(tardi, s, at(`08:${String((s - 1) * 5 + 5).padStart(2, "0")}:00`));
    });
    const rit = rilevaAnomalie(tardi).find(x => x.tipo === "ritardo_accumulato");
    if (rit) expect(ant.gravita).toBeGreaterThan(rit.gravita);
    else expect(ant.gravita).toBeGreaterThan(60);
  });
});

describe("ritardo che non rientra", () => {
  it("distingue un ritardo crescente da un picco isolato", () => {
    let c = corsa();
    c = conTransito(c, 1, at("08:00:00"));
    c = conTransito(c, 2, at("08:07:00"));
    c = conTransito(c, 3, at("08:14:00"));
    c = conTransito(c, 4, at("08:21:00"));
    c = conTransito(c, 5, at("08:28:00"));   // +8 minuti, crescente
    const a = rilevaAnomalie(c).find(x => x.tipo === "ritardo_accumulato")!;
    expect(a).toBeDefined();
    expect(a.dettaglio).toMatch(/tempo di percorrenza insufficiente/i);
  });

  it("non segnala un ritardo che rientra", () => {
    let c = corsa();
    c = conTransito(c, 2, at("08:11:00"));   // picco
    c = conTransito(c, 3, at("08:12:00"));
    c = conTransito(c, 5, at("08:20:30"));   // rientrato
    expect(rilevaAnomalie(c).some(x => x.tipo === "ritardo_accumulato")).toBe(false);
  });
});

describe("fuori percorso", () => {
  it("segnala la deviazione dopo letture consecutive", () => {
    const lontano = 13.510 + 800 / (111320 * Math.cos(43.61 * Math.PI / 180));
    const c = corsa({
      posizioni: [0, 1, 2, 3].map(i => ({
        ts: at(`08:0${i + 5}:00`), lat: 43.610, lon: lontano,
      })),
    });
    const a = rilevaAnomalie(c).find(x => x.tipo === "fuori_percorso")!;
    expect(a).toBeDefined();
    /* Il percorso è diagonale, quindi la perpendicolare dal punto al tracciato
     * è più corta dell'offset in longitudine: ~650 m, ben oltre la soglia. */
    expect(Number(a.misure.distanzaMassimaM)).toBeGreaterThan(600);
    /* Il dato dice che è successo, non perché: cantiere e percorso sbagliato
     * si somigliano nei numeri. */
    expect(a.confidenza).toBe("probabile");
    expect(a.dettaglio).toMatch(/non perché/i);
  });
});

describe("fermate forse non servite", () => {
  it("segnala un tratto percorso in molto meno del previsto", () => {
    /* Da S1 a S4 sono 15 minuti previsti, che includono le soste a S2 e S3.
     * Percorrerlo in 4 significa non aver fermato — oppure che l'orario di
     * quel tratto è molto sbagliato. */
    let c = corsa();
    c = conTransito(c, 2, null, false);
    c = conTransito(c, 3, null, false);
    c = conTransito(c, 4, at("08:04:00"));
    const a = rilevaAnomalie(c).find(x => x.tipo === "fermate_saltate")!;
    expect(a).toBeDefined();
    expect(a.misure.fermateNelTratto).toBe(2);
    expect(a.confidenza).toBe("probabile");
  });

  /* IL FALSO POSITIVO DA EVITARE. Fermate non RILEVATE, ma tempo di
   * percorrenza normale: il mezzo ha servito tutto, semplicemente non
   * l'abbiamo visto passare. Segnalarlo manderebbe a contestare qualcuno che
   * non ha fatto niente. */
  it("non scambia una fermata non rilevata per una non servita", () => {
    let c = corsa();
    c = conTransito(c, 2, null, false);
    c = conTransito(c, 3, null, false);
    // S4 all'orario giusto: il tratto è stato percorso nel tempo previsto
    expect(rilevaAnomalie(c).some(x => x.tipo === "fermate_saltate")).toBe(false);
  });
});

describe("corsa senza passaggi", () => {
  it("non conclude che non sia partita", () => {
    const c = { ...corsa(), fermate: corsa().fermate.map(f => ({ ...f, actualTs: null, osservato: false })) };
    const a = rilevaAnomalie(c)[0];
    expect(a.tipo).toBe("corsa_non_effettuata");
    expect(a.confidenza).toBe("probabile");
    expect(a.dettaglio).toMatch(/non si distingue/i);
  });
});

describe("sintesi della giornata", () => {
  it("nomina per primo l'anticipo anche quando non è il più frequente", () => {
    const molti = Array.from({ length: 8 }, (_, i) =>
      rilevaAnomalie(conTransito(corsa({ tripId: `R${i}` }), 5, at("08:29:00")))).flat();
    const uno = rilevaAnomalie(conTransito(corsa({ tripId: "A1" }), 1, at("07:56:00")));
    const s = riepiloga([...molti, ...uno]);
    expect(s.nota).toMatch(/anticipo/i);
    expect(s.nota).toMatch(/perde il servizio/i);
  });

  it("su una giornata pulita lo dice", () => {
    const s = riepiloga([]);
    expect(s.totale).toBe(0);
    expect(s.nota).toMatch(/nessuna anomalia/i);
  });

  it("conta le corse coinvolte, non le anomalie", () => {
    const due = [
      ...rilevaAnomalie(conTransito(corsa({ tripId: "X" }), 1, at("07:56:00"))),
      ...rilevaAnomalie(conTransito(corsa({ tripId: "X" }), 1, at("07:55:00"))),
    ];
    expect(riepiloga(due).corseCoinvolte).toBe(1);
  });
});


/* ═══════════════════════════════════════════════════════════════════════════
 * FUORI PERCORSO: da cosa si misura la distanza
 * ───────────────────────────────────────────────────────────────────────────
 * Questa anomalia mette in discussione il lavoro di un conducente. Misurarla
 * dalla spezzata fra le fermate, che taglia le curve, significa accusare chi
 * sta semplicemente percorrendo una strada che curva — ed è quello che
 * facevamo su ogni extraurbana.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("fuori percorso: da cosa si misura la distanza", () => {
  /* Una extraurbana: due fermate a ~4 km, e in mezzo la strada fa un'ansa
   * larga. È la geometria delle valli marchigiane, non un caso di scuola. */
  const A = { lat: 43.6000, lon: 13.3000 };
  const B = { lat: 43.6000, lon: 13.3500 };
  /* Il mezzo segue l'ansa: ~600 m a nord della corda, perfettamente in linea. */
  const ANSA = [
    { lat: 43.6020, lon: 13.3100 },
    { lat: 43.6055, lon: 13.3250 },
    { lat: 43.6020, lon: 13.3400 },
  ];

  /** Le fermate sono OSSERVATE: senza, `rilevaAnomalie` esce subito come
   *  "corsa non effettuata" e ogni verifica sul fuori percorso passerebbe a
   *  vuoto senza aver mai eseguito il controllo. */
  function extraurbana(over: Partial<CorsaDaEsaminare> = {}): CorsaDaEsaminare {
    return {
      tripId: "E1", vehicleId: "448", routeShortName: "44", day: GIORNO,
      fermate: [
        { seq: 1, stopId: "A", stopName: "A", lat: A.lat, lon: A.lon,
          scheduledSec: sec(7, 0), actualTs: at("07:00:00"), osservato: true },
        { seq: 2, stopId: "B", stopName: "B", lat: B.lat, lon: B.lon,
          scheduledSec: sec(7, 10), actualTs: at("07:10:00"), osservato: true },
      ],
      ...over,
    };
  }

  const traccia = (punti: Array<{ lat: number; lon: number }>) =>
    punti.map((p, i) => ({ ts: at(`07:0${i + 1}:00`), ...p }));

  it("senza il percorso del feed, un mezzo che segue una curva non viene accusato", () => {
    const c = extraurbana({ posizioni: traccia(ANSA) });
    /* Il controllo viene eseguito davvero: la corsa risulta effettuata. */
    expect(rilevaAnomalie(c).some(a => a.tipo === "corsa_non_effettuata")).toBe(false);
    expect(rilevaAnomalie(c).some(a => a.tipo === "fuori_percorso")).toBe(false);
  });

  it("la soglia si allarga in proporzione alla distanza fra le fermate", () => {
    const s = sogliaFuoriPercorso(extraurbana());
    expect(s.riferimento).toBe("fermate");
    expect(s.allargata).toBe(true);
    expect(s.sogliaM).toBeGreaterThan(900);   // ~4 km × 0,25
  });

  /* In città la spezzata segue la strada da vicino: allargare lì sarebbe
   * perdere le deviazioni vere. */
  it("con fermate vicine la soglia resta quella nominale e la misura è buona", () => {
    const s = sogliaFuoriPercorso(corsa());
    expect(s.sogliaM).toBe(300);
    expect(s.allargata).toBe(false);
  });

  it("col percorso del feed riconosce la deviazione vera, misurata sulla strada", () => {
    const c = extraurbana({
      tracciato: [A, ...ANSA, B],
      posizioni: traccia([
        { lat: 43.6300, lon: 13.3100 },
        { lat: 43.6320, lon: 13.3250 },
        { lat: 43.6300, lon: 13.3400 },
      ]),
    });
    const a = rilevaAnomalie(c).find(x => x.tipo === "fuori_percorso")!;
    expect(a).toBeDefined();
    expect(a.confidenza).toBe("probabile");
    expect(a.misure.riferimento).toBe("tracciato");
    expect(a.misure.sogliaM).toBe(300);
  });

  /* Col tracciato, un mezzo SULL'ansa è dove deve essere: la stessa traccia
   * che senza tracciato era solo "sotto soglia" qui è esattamente in linea. */
  it("col percorso del feed il mezzo in curva risulta esattamente in linea", () => {
    const c = extraurbana({ tracciato: [A, ...ANSA, B], posizioni: traccia(ANSA) });
    expect(rilevaAnomalie(c).some(x => x.tipo === "fuori_percorso")).toBe(false);
  });

  it("senza tracciato una deviazione vera si vede lo stesso, dichiarata approssimata", () => {
    const c = extraurbana({
      posizioni: traccia([
        { lat: 43.6600, lon: 13.3100 },
        { lat: 43.6620, lon: 13.3250 },
        { lat: 43.6600, lon: 13.3400 },
      ]),
    });
    const a = rilevaAnomalie(c).find(x => x.tipo === "fuori_percorso")!;
    expect(a).toBeDefined();
    expect(a.confidenza).toBe("possibile");
    expect(a.dettaglio).toMatch(/spezzata fra le fermate/);
    expect(a.dettaglio).toMatch(/Guarda la mappa/);
  });
});
