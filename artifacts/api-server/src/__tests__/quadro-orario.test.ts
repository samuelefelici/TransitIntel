/**
 * Il ciclo chiuso: il giudizio «il quadro orario è cambiato dopo il calcolo».
 *
 * Il difetto che copre: `psLastChangeAt` confrontava il feed con
 * `ps_trips.updated_at`, che per scelta si aggiorna solo per il calendario.
 * Uno spostamento di corsa nell'orario grafico, un ritocco d'orario, una
 * cancellazione non lo muovevano: «Dati superati» non compariva e i turni
 * restavano calcolati su un quadro che non esisteva più. Il registro
 * attività riceve ogni scrittura: qui si prova che venga letto bene.
 */
import { describe, it, expect } from "vitest";
import { quadroDiScenario, eModificaDelQuadro, famigliaDi, piuRecente } from "../lib/quadro-orario";

const T0 = "2026-09-27T10:00:00.000Z";
const prima = (min: number) => new Date(Date.parse(T0) - min * 60_000).toISOString();
const dopo = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

describe("quale azione tocca il quadro orario", () => {
  it("le scritture sulle corse, sui calendari, sui percorsi e sulle validità contano", () => {
    for (const a of ["trip.shift", "ps.trip.create", "ps.trip.delete", "ps.trips.stop-times-bulk",
                     "trip.batch_create", "trip.bulk_delete", "ps.calendar.dates", "ps.variant.sequence",
                     "validity.bulk.date-column", "ps.shape.save", "ps.route.delete", "trip.exception.add"]) {
      expect(eModificaDelQuadro(a), a).toBe(true);
    }
  });
  it("membri, scenari, fermate e progetto non sono il quadro orario", () => {
    for (const a of ["ps.member.add", "scenario.attach", "ps.stop.update", "ps.project.update",
                     "ps.nogo_zone.create", "cluster", "ps.route.update"]) {
      expect(eModificaDelQuadro(a), a).toBe(false);
    }
  });
  it("le famiglie parlano la lingua dell'operatore", () => {
    expect(famigliaDi("trip.shift")).toBe("spostamenti");
    expect(famigliaDi("ps.trip.stop-times")).toBe("ritocchi d'orario");
    expect(famigliaDi("trip.batch_create")).toBe("corse nuove");
    expect(famigliaDi("ps.trip.delete")).toBe("cancellazioni");
    expect(famigliaDi("ps.calendar.dates")).toBe("validità e calendari");
    expect(famigliaDi("ps.variant.sequence")).toBe("percorsi");
    expect(famigliaDi("qualcosa.di.nuovo")).toBe("altre modifiche");
  });
});

describe("il giudizio sullo scenario", () => {
  it("senza modifiche il piano è allineato", () => {
    expect(quadroDiScenario([], T0)).toEqual({ superato: false, modificheDopo: 0, ultimaModificaIl: null, riassunto: "" });
  });

  it("le modifiche PRIMA del calcolo non contano: il solver le ha viste", () => {
    const q = quadroDiScenario([{ action: "trip.shift", at: prima(5) }, { action: "ps.trip.delete", at: prima(60) }], T0);
    expect(q.superato).toBe(false);
    expect(q.modificheDopo).toBe(0);
  });

  it("una modifica nello stesso istante del calcolo è la stessa transazione", () => {
    expect(quadroDiScenario([{ action: "trip.shift", at: T0 }], T0).superato).toBe(false);
  });

  it("le modifiche DOPO il calcolo lo superano, e il riassunto dice che cosa", () => {
    const q = quadroDiScenario([
      { action: "trip.shift", at: dopo(1) },
      { action: "trip.shift", at: dopo(2) },
      { action: "trip.shift", at: dopo(3) },
      { action: "ps.trip.stop-times", at: dopo(4) },
      { action: "ps.trip.stop-times", at: dopo(5) },
      { action: "ps.trip.delete", at: dopo(6) },
      { action: "ps.member.add", at: dopo(7) },          // non è il quadro
      { action: "trip.shift", at: prima(10) },           // prima del calcolo
    ], T0);
    expect(q.superato).toBe(true);
    expect(q.modificheDopo).toBe(6);
    expect(q.ultimaModificaIl).toBe(dopo(6));
    expect(q.riassunto).toBe("3 spostamenti · 2 ritocchi d'orario · 1 cancellazione");
  });

  it("il singolare è un singolare", () => {
    expect(quadroDiScenario([{ action: "trip.batch_create", at: dopo(1) }], T0).riassunto).toBe("1 corsa nuova");
    // un'azione del quadro di famiglia ignota (una rotta nuova, domani) si
    // conta comunque; una che NON è del quadro («boh») no
    expect(quadroDiScenario([{ action: "trip.qualcosa_di_nuovo", at: dopo(1) }], T0).riassunto).toBe("1 altra modifica");
    expect(quadroDiScenario([{ action: "boh", at: dopo(1) }], T0).superato).toBe(false);
  });

  it("oltre tre famiglie il riassunto lo dice con i puntini, non tace", () => {
    const q = quadroDiScenario([
      { action: "trip.shift", at: dopo(1) }, { action: "ps.trip.stop-times", at: dopo(2) },
      { action: "ps.trip.create", at: dopo(3) }, { action: "ps.trip.delete", at: dopo(4) },
    ], T0);
    expect(q.riassunto.endsWith(" · …")).toBe(true);
    expect(q.riassunto.split(" · ")).toHaveLength(4);
  });

  it("l'ordine di arrivo non conta (il registro è DESC, il test lo mescola)", () => {
    const mods = [{ action: "ps.trip.delete", at: dopo(9) }, { action: "trip.shift", at: dopo(1) }, { action: "trip.shift", at: dopo(5) }];
    const a = quadroDiScenario(mods, T0), b = quadroDiScenario([...mods].reverse(), T0);
    expect(a).toEqual(b);
    expect(a.ultimaModificaIl).toBe(dopo(9));
  });

  it("senza data di calcolo non si giudica", () => {
    expect(quadroDiScenario([{ action: "trip.shift", at: dopo(1) }], null).superato).toBe(false);
    expect(quadroDiScenario([{ action: "trip.shift", at: dopo(1) }], "non-una-data").superato).toBe(false);
  });

  it("accetta la data del calcolo anche come Date (il driver pg la dà così)", () => {
    expect(quadroDiScenario([{ action: "trip.shift", at: dopo(1) }], new Date(T0)).superato).toBe(true);
  });
});

describe("il più recente fra più istanti", () => {
  it("ignora i vuoti e i non validi", () => {
    expect(piuRecente(null, undefined, "boh")).toBeNull();
    expect(piuRecente(prima(1), null, dopo(3), dopo(2))).toBe(dopo(3));
  });
});
