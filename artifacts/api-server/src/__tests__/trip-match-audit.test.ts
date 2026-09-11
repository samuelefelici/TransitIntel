/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifica dell'aggancio corsa — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questo verdetto decide se un passaggio finisce nello storico. Un falso
 * "verificato" ci fa scrivere dati sbagliati che nessuno correggerà più; un
 * falso "incoerente" ci fa buttare dati buoni. Le due cose non si pesano
 * uguale, ma nessuna delle due è accettabile per distrazione.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  verificaAggancio, riepilogaAgganci,
  type SchedaCorsa, type DichiarazioneAvm, type EsitoAggancio,
} from "../lib/trip-match-audit";
import type { TripStop } from "../lib/siri-vm";

const TZ = "Europe/Rome";

/** Un pezzo di percorso vero: la litoranea da Torrette al centro di Ancona. */
const PERCORSO: TripStop[] = [
  { stopId: "1", seq: 1, lat: 43.5975, lon: 13.4780, scheduled: "07:10:00" },
  { stopId: "2", seq: 2, lat: 43.6050, lon: 13.4950, scheduled: "07:18:00" },
  { stopId: "3", seq: 3, lat: 43.6140, lon: 13.5100, scheduled: "07:26:00" },
  { stopId: "4", seq: 4, lat: 43.6200, lon: 13.5180, scheduled: "07:35:00" },
];

const SCHEDA: SchedaCorsa = {
  tripId: "684_CodUdp:D1690_363283",
  routeId: "R44",
  partenza: "07:10:00",
  arrivo: "07:35:00",
  capolinea: "ANCONA STAZIONE FS",
  fermate: PERCORSO,
};

/** L'ora locale dell'azienda, non quella del server. */
const ore = (hhmm: string) => new Date(`2026-09-10T${hhmm}:00+02:00`);

function avm(over: Partial<DichiarazioneAvm> = {}): DichiarazioneAvm {
  return {
    vehicleRef: "268",
    journeyRef: "469179",
    routeIdDichiarato: "R44",
    destinationName: "ANCONA STAZ.",
    originAimedDeparture: ore("07:10"),
    destinationAimedArrival: ore("07:35"),
    lat: 43.6050, lon: 13.4950,
    ...over,
  };
}

describe("aggancio confermato", () => {
  it("quando linea, orari, capolinea e posizione tornano, l'aggancio è verificato", () => {
    const e = verificaAggancio(avm(), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("verificato");
    expect(e.indipendenti).toBe(5);
  });

  /* I due sistemi non scrivono i luoghi allo stesso modo, e non abbiamo un
   * dizionario di sinonimi: se ne accetta l'inclusione. */
  it("accetta un capolinea scritto diversamente ma riconoscibile", () => {
    const e = verificaAggancio(avm({ destinationName: "ANCONA STAZIONE FS CENTRALE" }), SCHEDA, "id", TZ);
    expect(e.riscontri.find(r => r.campo === "capolinea")?.esito).toBe("coerente");
  });

  it("un minuto di scarto sull'orario programmato è arrotondamento, non errore", () => {
    const e = verificaAggancio(avm({ originAimedDeparture: ore("07:11") }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("verificato");
  });
});

describe("aggancio smentito", () => {
  it("una linea diversa rende l'aggancio incoerente", () => {
    const e = verificaAggancio(avm({ routeIdDichiarato: "R31" }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("incoerente");
    expect(e.motivo).toMatch(/R31.*R44/);
  });

  /* Lo scarto sulla partenza è misurato e riportato, ma da solo non basta a
   * buttare il dato: i due sistemi possono far cominciare la corsa in punti
   * diversi, e quella non è una corsa sbagliata. */
  it("una partenza programmata lontana mezz'ora è misurata, ma da sola non condanna", () => {
    const e = verificaAggancio(avm({ originAimedDeparture: ore("07:40") }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("sospetto");
    const r = e.riscontri.find(x => x.campo === "partenza")!;
    expect(r.scostamento).toBe(1800);
    expect(r.nota).toMatch(/non è un ritardo/i);
  });

  /* Il caso che questo modulo esiste per prendere: l'identificativo esiste nel
   * feed, quindi l'aggancio "riesce", ma è un'altra corsa — e lo dicono due
   * campi indipendenti, non uno. Una differenza di convenzione non si presenta
   * mai due volte di fila su campi diversi. */
  it("partenza E arrivo entrambi lontani non sono una convenzione diversa: è un'altra corsa", () => {
    const e = verificaAggancio(avm({
      originAimedDeparture: ore("07:40"),
      destinationAimedArrival: ore("08:05"),
    }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("incoerente");
  });

  it("un capolinea diverso insospettisce ma non basta a dichiarare l'errore", () => {
    const e = verificaAggancio(avm({ destinationName: "FALCONARA MARITTIMA" }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("sospetto");
  });

  /* Lontano dal tracciato può voler dire corsa sbagliata o autista che devia:
   * due cose diverse, e il verdetto non deve fingere di saperlo. */
  it("una posizione lontana dal percorso resta un sospetto, non una certezza", () => {
    const e = verificaAggancio(avm({ lat: 43.7200, lon: 13.2200 }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("sospetto");
    expect(e.riscontri.find(r => r.campo === "posizione")?.nota).toMatch(/autista ha deviato/);
  });

  it("l'arrivo programmato smentisce anche quando la partenza torna", () => {
    const e = verificaAggancio(avm({ destinationAimedArrival: ore("08:20") }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("sospetto");
    expect(e.riscontri.find(r => r.campo === "arrivo")?.esito).toBe("discorde");
  });

  /* Due smentite che non toccano la partenza restano un sospetto: capolinea
   * diverso e mezzo fuori tracciato sono anche il ritratto di un autista che
   * ha fatto un'altra strada, e quello va registrato, non scartato. */
  it("capolinea e posizione discordi insieme non bastano a buttare il dato", () => {
    const e = verificaAggancio(avm({
      destinationName: "FALCONARA MARITTIMA", lat: 43.7200, lon: 13.2200,
    }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("sospetto");
  });

  /* La linea non ha convenzioni diverse fra i due sistemi: se dissente,
   * dissente e basta, senza bisogno di conferme. */
  it("la linea discorde condanna da sola, senza corroborazione", () => {
    const e = verificaAggancio(avm({ routeIdDichiarato: "R31" }), SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("incoerente");
    expect(e.riscontri.filter(r => r.esito === "discorde")).toHaveLength(1);
  });
});

describe("controlli che non dimostrano niente", () => {
  /* Se la corsa è stata scelta perché partiva a quell'ora, ritrovare
   * quell'ora è ritrovare la propria regola. */
  it("l'aggancio per orario non si conferma da solo su partenza e capolinea", () => {
    const soloOrari = avm({ routeIdDichiarato: null, lat: null, lon: null, destinationAimedArrival: null });
    const e = verificaAggancio(soloOrari, SCHEDA, "orario", TZ);
    expect(e.verdetto).toBe("non_verificabile");
    expect(e.indipendenti).toBe(0);
    expect(e.motivo).toMatch(/nessuna prova indipendente/i);
  });

  it("ma l'arrivo programmato resta una prova valida anche per l'aggancio a orario", () => {
    const e = verificaAggancio(avm({ routeIdDichiarato: null, lat: null, lon: null }), SCHEDA, "orario", TZ);
    expect(e.verdetto).toBe("verificato");
    expect(e.riscontri.find(r => r.campo === "arrivo")?.tautologico).toBeUndefined();
  });

  it("una linea dedotta dalla corsa non conferma la corsa", () => {
    const e = verificaAggancio(avm({ routeIdDichiarato: null }), SCHEDA, "id", TZ);
    expect(e.riscontri.find(r => r.campo === "linea")?.esito).toBe("non_verificabile");
  });

  /* Il caso più comune: 17 vetture su 368 mandano l'identificativo di corsa,
   * e su molte di quelle non arriva nient'altro. */
  it("quando l'AVM manda solo l'identificativo, lo dice invece di inventare un verdetto", () => {
    const muto = avm({
      routeIdDichiarato: null, destinationName: null,
      originAimedDeparture: null, destinationAimedArrival: null, lat: null, lon: null,
    });
    const e = verificaAggancio(muto, SCHEDA, "id", TZ);
    expect(e.verdetto).toBe("non_verificabile");
    expect(e.motivo).toMatch(/non dichiara/i);
  });

  it("una corsa del feed senza orari non rende sospetto l'aggancio", () => {
    const senzaOrari: SchedaCorsa = { ...SCHEDA, partenza: null, arrivo: null };
    const e = verificaAggancio(avm(), senzaOrari, "id", TZ);
    expect(e.verdetto).toBe("verificato");
    expect(e.riscontri.find(r => r.campo === "partenza")?.esito).toBe("non_verificabile");
  });
});

describe("corse a cavallo della mezzanotte", () => {
  /* Il feed scrive l'una di notte come "25:10". Chi non lo sa vede ventitré
   * ore di scarto e butta una corsa buona. */
  it("legge l'orario oltre le 24 del feed come l'ora di notte dell'AVM", () => {
    const notturna: SchedaCorsa = { ...SCHEDA, partenza: "25:10:00", arrivo: "25:40:00" };
    const e = verificaAggancio(
      avm({
        originAimedDeparture: new Date("2026-09-11T01:10:00+02:00"),
        destinationAimedArrival: new Date("2026-09-11T01:40:00+02:00"),
      }),
      notturna, "id", TZ);
    expect(e.riscontri.find(r => r.campo === "partenza")?.esito).toBe("coerente");
    expect(e.verdetto).toBe("verificato");
  });
});

describe("quadro d'insieme", () => {
  const esito = (verdetto: EsitoAggancio["verdetto"]): EsitoAggancio => ({
    vehicleRef: "1", tripId: "T", journeyRef: null, agganciatoCome: "id",
    verdetto, riscontri: [], indipendenti: 0, motivo: "",
  });

  it("conta i verdetti e misura quanti agganci sono controllabili", () => {
    const r = riepilogaAgganci([
      esito("verificato"), esito("verificato"), esito("sospetto"), esito("non_verificabile"),
    ]);
    expect(r.totale).toBe(4);
    expect(r.verificati).toBe(2);
    expect(r.quotaVerificabile).toBe(0.75);
  });

  it("quando qualcosa è incoerente lo mette davanti a tutto il resto", () => {
    const r = riepilogaAgganci([esito("verificato"), esito("incoerente")]);
    expect(r.incoerenti).toBe(1);
    expect(r.nota).toMatch(/non vengono scritti/);
  });

  it("se nessun aggancio è controllabile lo dice come limite del flusso", () => {
    const r = riepilogaAgganci([esito("non_verificabile"), esito("non_verificabile")]);
    expect(r.quotaVerificabile).toBe(0);
    expect(r.nota).toMatch(/limite del flusso/);
  });

  it("su elenco vuoto non inventa un quadro", () => {
    const r = riepilogaAgganci([]);
    expect(r.totale).toBe(0);
    expect(r.nota).toMatch(/niente da verificare/i);
  });
});
