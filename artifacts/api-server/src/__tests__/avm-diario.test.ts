import { describe, it, expect } from "vitest";
import {
  esitoGiorno, classificaVettura, analizzaDiario, GIORNATE_MINIME, GIORNI_SMESSA,
  type RigaDiario,
} from "../lib/avm-diario";

/** Una giornata vuota su cui costruire i casi. */
function riga(giorno: string, vehicleRef: string, p: Partial<RigaDiario> = {}): RigaDiario {
  return {
    giorno, vehicleRef,
    letture: 700, lettureFresche: 0, lettureMonitorata: 0, letturePosizione: 0,
    lettureCorsa: 0, lettureErroreGps: 0, lettureErroreGprs: 0, lettureInRimessa: 0,
    primoContatto: null, ultimoContatto: null, linee: [], corse: [],
    ...p,
  };
}

const SETTIMANA = ["2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12",
  "2026-09-13", "2026-09-14", "2026-09-15"];

describe("esitoGiorno — la scala dei quattro anelli", () => {
  it("una corsa vince su tutto", () => {
    expect(esitoGiorno(riga("2026-09-15", "1", {
      lettureCorsa: 2, letturePosizione: 9, lettureFresche: 10,
    }))).toBe("in_servizio");
  });

  it("posizione senza corsa è 'traccia'", () => {
    expect(esitoGiorno(riga("2026-09-15", "1", {
      letturePosizione: 9, lettureFresche: 10,
    }))).toBe("traccia");
  });

  it("contatto senza posizione è 'collegata'", () => {
    expect(esitoGiorno(riga("2026-09-15", "1", { lettureFresche: 10 }))).toBe("collegata");
  });

  it("senza contatto è muta, anche se l'AVM la elenca dieci volte", () => {
    expect(esitoGiorno(riga("2026-09-15", "1", { letture: 10 }))).toBe("muta");
  });
});

describe("classificaVettura — ci si ferma al primo anello rotto", () => {
  it("una corsa sola in sette giorni basta a dire che funziona", () => {
    const v = classificaVettura("263", [
      ...SETTIMANA.slice(0, 6).map(g => riga(g, "263", { lettureFresche: 5, letturePosizione: 5 })),
      riga("2026-09-15", "263", {
        lettureFresche: 5, letturePosizione: 5, lettureCorsa: 3, corse: ["477162"],
      }),
    ], SETTIMANA);
    expect(v.esito).toBe("funziona");
    expect(v.destinatario).toBe("nessuno");
    expect(v.giorniConCorsa).toBe(1);
    /* Il dubbio sta nei numeri accanto, non in un verdetto più severo. */
    expect(v.nota).toContain("1 con corse");
  });

  it("si localizza ma non aggancia mai: è l'esercizio, non l'officina", () => {
    const v = classificaVettura("440", SETTIMANA.map(g => riga(g, "440", {
      lettureFresche: 8, lettureMonitorata: 8, letturePosizione: 8,
    })), SETTIMANA);
    expect(v.esito).toBe("senza_corsa");
    expect(v.destinatario).toBe("Esercizio");
  });

  it("parla e dichiara errore GPS senza mai localizzarsi: è l'antenna", () => {
    const v = classificaVettura("1314", SETTIMANA.map(g => riga(g, "1314", {
      lettureFresche: 8, lettureErroreGps: 8,
    })), SETTIMANA);
    expect(v.esito).toBe("senza_posizione");
    expect(v.destinatario).toBe("Officina");
    expect(v.avviso).toBe("antenna");
  });

  it("parla senza errori a bordo ma il centro non la localizza mai: è Mizar", () => {
    const v = classificaVettura("256", SETTIMANA.map(g => riga(g, "256", {
      lettureFresche: 4,
    })), SETTIMANA);
    expect(v.esito).toBe("non_attivata");
    expect(v.destinatario).toBe("Mizar");
    expect(v.avviso).toBe("da_attivare");
  });

  it("il flag Monitored non decide niente: è la negazione dell'errore, non l'attivazione", () => {
    /* Misurato il 15 settembre: Monitored=true su 76 vetture, esattamente
     * quelle senza MonitoringError. Un errore GPS su una vettura che parla è
     * l'antenna anche se Monitored è falso — e una vettura monitorata senza
     * errori né posizione non è "seguita", è non attivata. */
    const conGps = classificaVettura("999", SETTIMANA.map(g => riga(g, "999", {
      lettureFresche: 4, lettureErroreGps: 4, lettureMonitorata: 0,
    })), SETTIMANA);
    expect(conGps.esito).toBe("senza_posizione");
    const monitorata = classificaVettura("998", SETTIMANA.map(g => riga(g, "998", {
      lettureFresche: 4, lettureMonitorata: 4,
    })), SETTIMANA);
    expect(monitorata.esito).toBe("non_attivata");
  });

  it("muta tutta la settimana: SIM e verifica fisica", () => {
    const v = classificaVettura("229", SETTIMANA.map(g => riga(g, "229")), SETTIMANA);
    expect(v.esito).toBe("muta");
    expect(v.destinatario).toBe("Gestore SIM");
    expect(v.giorniDiSilenzio).toBe(SETTIMANA.length);
  });

  it("riconosce chi parla a sprazzi e conta i giorni di silenzio dalla fine", () => {
    const v = classificaVettura("1321", [
      riga("2026-09-09", "1321", { lettureFresche: 3 }),
      riga("2026-09-10", "1321", { lettureFresche: 2 }),
      ...SETTIMANA.slice(2).map(g => riga(g, "1321")),
    ], SETTIMANA);
    expect(v.intermittente).toBe(true);
    expect(v.giorniConContatto).toBe(2);
    expect(v.giorniDiSilenzio).toBe(5);
  });

  it("una vettura che funzionava e tace da tre giornate è 'smessa', ma il verdetto resta 'funziona'", () => {
    const v = classificaVettura("455", [
      ...SETTIMANA.slice(0, 3).map(g => riga(g, "455", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 4, corse: [g] })),
      ...SETTIMANA.slice(3).map(g => riga(g, "455")),
    ], SETTIMANA);
    expect(v.esito).toBe("funziona");
    expect(v.avviso).toBe("smessa");
    expect(v.ultimoGiornoBuono).toBe("2026-09-11");
    expect(v.giorniDaBuono).toBe(4);
    expect(v.nota).toContain("ultima posizione il 2026-09-11");
  });

  it("due giornate di silenzio non bastano: potrebbe essere un fine settimana", () => {
    const v = classificaVettura("455", [
      ...SETTIMANA.slice(0, 5).map(g => riga(g, "455", { lettureFresche: 9, letturePosizione: 9 })),
      ...SETTIMANA.slice(5).map(g => riga(g, "455")),
    ], SETTIMANA);
    expect(GIORNI_SMESSA).toBe(3);
    expect(v.giorniDaBuono).toBe(2);
    expect(v.avviso).toBeNull();
  });

  it("le giornate senza dati non contano come silenzio", () => {
    /* Buona il 9, poi il connettore fermo il 10, 11 e 12, poi muta il 13: una
     * sola giornata osservata di silenzio, non quattro. */
    const osservate = ["2026-09-09", "2026-09-13"];
    const v = classificaVettura("455", [
      riga("2026-09-09", "455", { lettureFresche: 9, letturePosizione: 9 }),
      riga("2026-09-13", "455"),
    ], osservate);
    expect(v.giorniDaBuono).toBe(1);
    expect(v.avviso).toBeNull();
  });

  it("conta le corse distinte, non i campioni", () => {
    const v = classificaVettura("292", [
      riga("2026-09-14", "292", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 6, corse: ["A", "B"] }),
      riga("2026-09-15", "292", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 4, corse: ["B", "C"] }),
    ], SETTIMANA);
    expect(v.corse).toBe(3);
    expect(v.giorniConCorsa).toBe(2);
  });
});

describe("analizzaDiario — il periodo intero", () => {
  const righe: RigaDiario[] = [];
  for (const g of SETTIMANA) {
    righe.push(riga(g, "263", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 5, corse: [`c-${g}`] }));
    righe.push(riga(g, "440", { lettureFresche: 9, lettureMonitorata: 9, letturePosizione: 9 }));
    righe.push(riga(g, "229"));
  }
  /* La 256 si attiva a metà settimana: è la prova che un'attivazione si vede. */
  for (const g of SETTIMANA.slice(0, 4)) righe.push(riga(g, "256"));
  for (const g of SETTIMANA.slice(4)) {
    righe.push(riga(g, "256", { lettureFresche: 9, lettureMonitorata: 9, letturePosizione: 9, lettureCorsa: 2, corse: ["x"] }));
  }

  const d = analizzaDiario(righe, SETTIMANA);

  it("ordina dalle sane alle mute", () => {
    expect(d.vetture.map(v => v.vehicleRef)).toEqual(["263", "256", "440", "229"]);
  });

  it("divide le segnalazioni per destinatario", () => {
    const dest = d.riepilogo.perDestinatario.map(x => x.destinatario).sort();
    expect(dest).toEqual(["Esercizio", "Gestore SIM"]);
    expect(d.riepilogo.funzionanti).toBe(2);
    expect(d.riepilogo.daSegnalare).toBe(2);
  });

  it("vede l'attivazione fatta a metà periodo", () => {
    expect(d.cambiamenti.migliorate.map(x => x.vehicleRef)).toEqual(["256"]);
    expect(d.cambiamenti.peggiorate).toEqual([]);
  });

  it("elenca gli avvisi dal più urgente, e misura la qualità della raccolta", () => {
    /* La 263 smette il 13; il diario dell'11 è a metà. */
    const r2 = righe
      .filter(r => !(r.vehicleRef === "263" && r.giorno >= "2026-09-13"))
      .map(r => r.giorno === "2026-09-11" ? { ...r, letture: 100 } : { ...r, letture: 700 });
    r2.push(riga("2026-09-13", "263"), riga("2026-09-14", "263"), riga("2026-09-15", "263"));
    const x = analizzaDiario(r2, SETTIMANA);
    /* L'11 è a un quarto e non conta: restano 6 giornate. La 256, attivata a
     * metà settimana, ha parlato 3 giornate su 6: metà esatta, non a sprazzi. */
    expect(x.avvisi.map(a => a.avviso)).toEqual(["smessa"]);
    expect(x.avvisi[0].matricole).toEqual(["263"]);
    expect(x.giornateOsservate).toBe(6);
    expect(x.qualita.giornateParziali).toEqual(["2026-09-11"]);
    expect(x.perGiorno.find(g => g.giorno === "2026-09-11")?.campioni).toBe(100);
  });

  it("dà una riga per giornata osservata", () => {
    expect(d.perGiorno).toHaveLength(SETTIMANA.length);
    expect(d.perGiorno[0]).toMatchObject({ giorno: "2026-09-09", inServizio: 1, muta: 2 });
    expect(d.perGiorno[6]).toMatchObject({ giorno: "2026-09-15", inServizio: 2, muta: 1 });
  });

  it("le giornate senza dati sono buchi del connettore, non vetture mute", () => {
    const senzaMercoledi = righe.filter(r => r.giorno !== "2026-09-11");
    const x = analizzaDiario(senzaMercoledi, SETTIMANA);
    expect(x.giornateSenzaDati).toEqual(["2026-09-11"]);
    expect(x.giornateOsservate).toBe(6);
    expect(x.perGiorno.map(p => p.giorno)).not.toContain("2026-09-11");
    /* E non devono abbassare la continuità di chi non ha saltato un giro. */
    expect(x.vetture.find(v => v.vehicleRef === "263")?.intermittente).toBe(false);
  });

  it("una giornata ascoltata a un quarto non conta come silenzio delle vetture", () => {
    /* Misurato sul vero: il 27 settembre alle 17 il diario aveva 26 campioni
     * e 118 vetture risultavano «peggiorate». Era il connettore ripartito da
     * un'ora, non il parco. */
    const r2 = righe.map(r => r.giorno === "2026-09-15"
      ? { ...r, letture: 26, lettureFresche: 0, letturePosizione: 0, lettureCorsa: 0, corse: [] }
      : r);
    const x = analizzaDiario(r2, SETTIMANA);
    expect(x.qualita.giornateParziali).toEqual(["2026-09-15"]);
    expect(x.giornateOsservate).toBe(6);
    expect(x.perGiorno.find(g => g.giorno === "2026-09-15")?.parziale).toBe(true);
    /* La 263 va a corse ogni giorno: il 15 a un quarto non la fa diventare
     * né peggiorata né smessa, e i suoi giorni con corsa restano sei. */
    expect(x.cambiamenti.peggiorate).toEqual([]);
    const v263 = x.vetture.find(v => v.vehicleRef === "263")!;
    expect(v263.avviso).toBeNull();
    expect(v263.giorniConCorsa).toBe(6);
    expect(v263.perGiorno.map(g => g.giorno)).not.toContain("2026-09-15");
  });

  it("con poche giornate avverte invece di dare un verdetto", () => {
    const corto = analizzaDiario(
      righe.filter(r => r.giorno <= "2026-09-10"),
      ["2026-09-09", "2026-09-10"],
    );
    expect(corto.giornateOsservate).toBeLessThan(GIORNATE_MINIME);
    expect(corto.nota).toContain("prima di segnalare");
  });

  it("un diario vuoto non diventa un parco tutto guasto", () => {
    const vuoto = analizzaDiario([], SETTIMANA);
    expect(vuoto.vetture).toEqual([]);
    expect(vuoto.segnalazioni).toEqual([]);
    expect(vuoto.nota).toContain("vuoto");
  });
});
