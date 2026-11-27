/**
 * Pronto per lo scheduler: le regole dei controlli prima del giro (senza
 * database). Il caso vero: l'UDP festiva di Ancona aveva 13 linee su 20 —
 * la 1/4, la 2, la 22/24, la 81 circolavano la domenica ma non erano
 * nell'UDP, e il riallineamento al lancio non le avrebbe mai prese; la 22/24
 * e la 81 senza tipo di mezzo; la 22/24 ripartiva da Brecce Bianche nello
 * stesso minuto in cui arrivava.
 */
import { describe, it, expect } from "vitest";
import {
  controlloUdp, controlloTipiMezzo, controlloDepositi, controlloArchi, capolineaSenzaArco,
  controlloMargini, controlloMarginiReali, controlloDatiReali, esito, messaggioRifiuto, conteggi, chiaveCoord,
  margineDaSegnalare, margineMin,
  type Arco, type Capolinea, type Deposito,
} from "../lib/pronto-scheduler";

const linee = new Map([["L14", "1/4"], ["L2", "2"], ["L3", "3"]]);
const lineaDi = new Map([["a1", "L3"], ["a2", "L3"], ["a3", "L3"], ["b1", "L14"], ["b2", "L14"], ["c1", "L2"]]);

describe("l'UDP allineata", () => {
  it("una linea che circola nei giorni dell'UDP ma non è nell'UDP: errore, con le linee e quante corse", () => {
    const c = controlloUdp({ salvate: ["a1", "a2"], attive: new Set(["a1", "a2", "b1", "b2", "c1"]), lineaDi, etichetta: linee, inAltreUdp: new Set() });
    expect(c).toMatchObject({ livello: "errore", numero: 3, campioni: ["1/4 (2)", "2 (1)"] });
    expect(c.dettaglio).toMatch(/riallineamento al lancio guarda solo le linee/);
    expect(c.rimedio).toMatch(/riallinea/);
  });

  it("se quelle corse sono in un'altra UDP degli stessi giorni, non è un errore", () => {
    const c = controlloUdp({ salvate: ["a1", "a2"], attive: new Set(["a1", "a2", "b1", "b2"]), lineaDi, etichetta: linee, inAltreUdp: new Set(["b1", "b2"]) });
    expect(c.livello).toBe("ok");
  });

  it("corse in più o in meno sulle stesse linee: avviso (le riallinea il lancio)", () => {
    const c = controlloUdp({ salvate: ["a1", "a2"], attive: new Set(["a1", "a3"]), lineaDi, etichetta: linee, inAltreUdp: new Set() });
    expect(c).toMatchObject({ livello: "avviso", numero: 2 });
    expect(c.dettaglio).toMatch(/1 corse da aggiungere e 1 da togliere/);
  });

  it("tutto allineato", () => {
    expect(controlloUdp({ salvate: ["a1"], attive: new Set(["a1"]), lineaDi, etichetta: linee, inAltreUdp: new Set() }).livello).toBe("ok");
  });
});

describe("i tipi di mezzo e i depositi", () => {
  it("una linea senza tipo di mezzo ferma il giro", () => {
    const c = controlloTipiMezzo([{ routeId: "L1", etichetta: "81", tipo: null }, { routeId: "L2", etichetta: "22/24", tipo: null }, { routeId: "L3", etichetta: "3", tipo: "12m" }]);
    expect(c).toMatchObject({ livello: "errore", numero: 2, campioni: ["22/24", "81"] });
    expect(controlloTipiMezzo([{ routeId: "L3", etichetta: "3", tipo: "12m" }]).livello).toBe("ok");
  });

  it("depositi: nessuno del progetto è un errore, nessuno indicato un avviso, uno sconosciuto un errore", () => {
    const dep = [{ id: "d1", nome: "Ancona" }, { id: "d2", nome: "Jesi" }];
    expect(controlloDepositi(null, []).livello).toBe("errore");
    expect(controlloDepositi(null, dep)).toMatchObject({ livello: "avviso", numero: 2 });
    expect(controlloDepositi(["dX"], dep)).toMatchObject({ livello: "errore", campioni: ["dX"] });
    expect(controlloDepositi(["d1"], dep)).toMatchObject({ livello: "ok", dettaglio: "Ancona." });
  });
});

describe("i fuorilinea dei capolinea", () => {
  const ancona: Deposito = { id: "d1", nome: "Ancona", lat: 43.6056, lon: 13.5171 };
  const jesi: Deposito = { id: "d2", nome: "Jesi", lat: 43.52, lon: 13.24 };
  const cap = (stopId: string, clusterId: string | null = null, lat = 43.6, lon = 13.5): Capolinea => ({ stopId, nome: `cap ${stopId}`, clusterId, lat, lon });
  const arco = (from: [string, string, number, number], to: [string, string, number, number]): Arco => ({
    fromKey: from[0], fromType: from[1], fromLat: from[2], fromLon: from[3], toKey: to[0], toType: to[1], toLat: to[2], toLon: to[3],
  });

  it("per fermata, per nodo o per coordinate, in un verso o nell'altro", () => {
    const archi = [
      arco(["stop:s1", "terminus", 43.6, 13.5], ["depot:d1", "depot", ancona.lat, ancona.lon]),           // rientro da s1
      arco(["depot:d1", "depot", ancona.lat, ancona.lon], ["cluster:k2", "cluster", 43.61, 13.51]),       // uscita verso il nodo di s2
      arco(["x", "terminus", 43.5, 13.4], ["y", "depot", ancona.lat, ancona.lon]),                         // per coordinate (s3)
      arco(["stop:s4", "terminus", 43.6, 13.5], ["depot:d2", "depot", jesi.lat, jesi.lon]),               // solo con Jesi
    ];
    const capolinea = [cap("s1"), cap("s2", "k2", 43.62, 13.52), cap("s3", null, 43.5, 13.4), cap("s4", null, 43.7, 13.6), cap("s5", null, 43.8, 13.7)];
    expect(capolineaSenzaArco(capolinea, [ancona], archi).map(c => c.stopId)).toEqual(["s4", "s5"]);
    expect(capolineaSenzaArco(capolinea, [ancona, jesi], archi).map(c => c.stopId)).toEqual(["s5"]);
    const c = controlloArchi(capolinea, [ancona], archi);
    expect(c).toMatchObject({ livello: "errore", numero: 2, campioni: ["cap s4", "cap s5"] });
  });

  it("un arco fra due capolinea non vale come fuorilinea dal deposito", () => {
    const archi = [arco(["stop:s1", "terminus", 43.6, 13.5], ["stop:s9", "terminus", 43.65, 13.55])];
    expect(capolineaSenzaArco([cap("s1")], [ancona], archi)).toHaveLength(1);
  });

  it("senza depositi non si controlla, ed è un errore", () => {
    expect(controlloArchi([cap("s1")], [], []).livello).toBe("errore");
    expect(chiaveCoord(43.123456, 13.1)).toBe("43.12346,13.10000");
  });
});

describe("andata e ritorno ai capolinea", () => {
  it("il ritorno che riparte nel minuto in cui l'andata arriva ferma il giro", () => {
    const c = controlloMargini([
      { tipo: "tooTight", linea: "22/24", capolinea: "B.BIANCHE CAPOLINEA", arrivo: "08:10", ritorno: "08:10" },
      { tipo: "tooTight", linea: "3", capolinea: "POSATORA", arrivo: "09:00", ritorno: "09:01" },
      { tipo: "missingReturn", linea: "41", capolinea: "PALOMBARE", arrivo: "20:30", ritorno: null },
    ]);
    expect(c).toMatchObject({ livello: "errore", numero: 1 });
    expect(c.campioni[0]).toBe("22/24 a B.BIANCHE CAPOLINEA: arriva 08:10, riparte 08:10");
    expect(c.dettaglio).toMatch(/altre 2 anomalie/);
  });

  it("margine scarso e corse senza la loro coppia: avviso; il codice percorso e il ritorno tardi non contano", () => {
    expect(controlloMargini([{ tipo: "tooTight", linea: "3", capolinea: "POSATORA", arrivo: "09:00", ritorno: "09:01" }]))
      .toMatchObject({ livello: "avviso", numero: 1 });
    expect(controlloMargini([{ tipo: "noVariantCode", linea: "93", capolinea: "MASSIGNANO", arrivo: "20:30", ritorno: null },
      { tipo: "lateReturn", linea: "40", capolinea: "CIMITERO", arrivo: "10:00", ritorno: "11:00" }]).livello).toBe("ok");
    // oltre la mezzanotte del GTFS
    expect(controlloMargini([{ tipo: "tooTight", linea: "1/4", capolinea: "TAVERNELLE", arrivo: "24:50", ritorno: "24:50" }]).livello).toBe("errore");
  });
});

describe("la sosta minima del capolinea nei margini", () => {
  it("si segnala sotto i 2′ o sotto la sosta dichiarata", () => {
    expect(margineMin({ arrivo: "08:10", ritorno: "08:13" })).toBe(3);
    expect(margineDaSegnalare({ arrivo: "08:10", ritorno: "08:13", sostaMinima: null })).toBe(false);
    expect(margineDaSegnalare({ arrivo: "08:10", ritorno: "08:13", sostaMinima: 5 })).toBe(true);
    expect(margineDaSegnalare({ arrivo: "08:10", ritorno: "08:11", sostaMinima: null })).toBe(true);
    expect(margineDaSegnalare({ arrivo: "08:10", ritorno: "08:16", sostaMinima: 5 })).toBe(false);
  });

  it("l'avviso dice quanti ritorni il giro non darà allo stesso bus", () => {
    const c = controlloMargini([{ tipo: "tooTight", linea: "1/4", capolinea: "TAVERNELLE", arrivo: "09:00", ritorno: "09:03", sostaMinima: 5 }]);
    expect(c.livello).toBe("avviso");
    expect(c.dettaglio).toMatch(/1 ritorni sono sotto la sosta minima del capolinea/);
  });
});

describe("i dati reali", () => {
  it("margini reali: le corse che non assorbono il ritardo all'85°, per linea", () => {
    const c = controlloMarginiReali([
      { linea: "1/5", partenza: "08:00", capolinea: "P.ZZA D'ARMI", coperturaPct: 90, giudizio: "insufficiente" },
      { linea: "1/5", partenza: "09:00", capolinea: "P.ZZA D'ARMI", coperturaPct: 90, giudizio: "insufficiente" },
      { linea: "2", partenza: "09:00", capolinea: "PINOCCHIO", coperturaPct: 90, giudizio: "ok" },
    ]);
    expect(c).toMatchObject({ livello: "avviso", numero: 2, campioni: ["1/5 (2)"] });
    expect(controlloMarginiReali([{ linea: "40", partenza: "10:00", capolinea: "x", coperturaPct: 0, giudizio: "senza_dati" }]).dettaglio)
      .toMatch(/Nessun dato SIRI/);
  });

  it("copertura: sotto la metà del tempo osservato è un avviso, mai un errore", () => {
    const c = controlloDatiReali([{ etichetta: "11", coperturaPct: 0 }, { etichetta: "40", coperturaPct: 12 }, { etichetta: "2", coperturaPct: 95 }]);
    expect(c).toMatchObject({ livello: "avviso", numero: 2, campioni: ["11 (0%)", "40 (12%)"] });
  });
});

describe("l'esito", () => {
  it("pronto solo senza errori; il rifiuto elenca gli errori", () => {
    const e = esito([
      controlloTipiMezzo([{ routeId: "L1", etichetta: "81", tipo: null }]),
      controlloDatiReali([{ etichetta: "11", coperturaPct: 0 }]),
      controlloDepositi(["d1"], [{ id: "d1", nome: "Ancona" }]),
    ]);
    expect(e).toMatchObject({ pronto: false, errori: 1, avvisi: 1 });
    expect(messaggioRifiuto(e)).toMatch(/^Il giro non parte: ogni linea ha il tipo di mezzo — .*\(81\)$/);
    expect(esito([controlloDepositi(["d1"], [{ id: "d1", nome: "Ancona" }])]).pronto).toBe(true);
  });

  it("i conteggi: i più numerosi prima, poi in ordine di linea", () => {
    expect(conteggi(["2", "10", "2", "1/4", "10", "10"])).toEqual(["10 (3)", "2 (2)", "1/4 (1)"]);
  });
});
