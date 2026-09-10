/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Completamento dei transiti — collaudo dell'algoritmo
 * ───────────────────────────────────────────────────────────────────────────
 * L'algoritmo produce orari che NON sono stati misurati. Un errore qui non si
 * presenta come un guasto: si presenta come un tempo di percorrenza
 * plausibile e sbagliato, su cui qualcuno ritara un orario. Perciò i casi che
 * lo possono ingannare vanno fissati uno per uno.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  completeTransits,
  type FermataProgrammata, type PassaggioOsservato,
} from "../lib/transit-completion";

const TZ = "Europe/Rome";
/** 2026-09-10 è ora legale a Roma: UTC+2. */
const at = (hhmmss: string) => new Date(`2026-09-10T${hhmmss}+02:00`);

/* Una corsa con tratte di durata DIVERSA: è il punto dell'algoritmo. Fra la
 * 1 e la 2 ci vogliono 2 minuti, fra la 2 e la 3 otto, fra la 3 e la 4 due.
 * Interpolare gli orari in parti uguali sbaglierebbe di minuti. */
const CORSA: FermataProgrammata[] = [
  { seq: 1, stopId: "S1", stopName: "Capolinea",  scheduled: "08:00:00" },
  { seq: 2, stopId: "S2", stopName: "Via Roma",   scheduled: "08:02:00" },
  { seq: 3, stopId: "S3", stopName: "Ospedale",   scheduled: "08:10:00" },
  { seq: 4, stopId: "S4", stopName: "Stazione",   scheduled: "08:12:00" },
];

describe("completamento dei transiti", () => {
  it("lascia intatte le fermate realmente osservate", () => {
    const oss: PassaggioOsservato[] = [
      { stopId: "S1", actualTs: at("08:00:00") },
      { stopId: "S4", actualTs: at("08:12:00") },
    ];
    const r = completeTransits(CORSA, oss, TZ);
    expect(r.fermate[0]).toMatchObject({ origine: "osservato", delaySeconds: 0 });
    expect(r.fermate[3]).toMatchObject({ origine: "osservato", delaySeconds: 0 });
    expect(r.osservate).toBe(2);
  });

  /* IL CUORE DELL'ALGORITMO. Il mezzo parte in orario e arriva con 4 minuti
   * di ritardo. Le due fermate intermedie non sono state viste.
   *
   * Interpolando gli ORARI in parti uguali si otterrebbe 08:04 e 08:08 —
   * come se le tre tratte durassero uguale. Interpolando lo SCARTO in
   * proporzione al programmato si ottiene il ritardo che il mezzo aveva
   * davvero quando è passato di lì. */
  it("interpola lo scarto in proporzione al tempo programmato, non l'orario", () => {
    const oss: PassaggioOsservato[] = [
      { stopId: "S1", actualTs: at("08:00:00") },   // in orario
      { stopId: "S4", actualTs: at("08:16:00") },   // +4 minuti
    ];
    const r = completeTransits(CORSA, oss, TZ);

    // 12 minuti di corsa programmata; S2 è al minuto 2 → 2/12 del ritardo
    expect(r.fermate[1].delaySeconds).toBe(Math.round(240 * (2 / 12)));   // 40 s
    // S3 è al minuto 10 → 10/12
    expect(r.fermate[2].delaySeconds).toBe(Math.round(240 * (10 / 12)));  // 200 s

    // e l'orario ricostruito è programmato + scarto
    expect(r.fermate[1].actualTs!.toISOString()).toBe(at("08:02:40").toISOString());
    expect(r.fermate[2].actualTs!.toISOString()).toBe(at("08:13:20").toISOString());
    expect(r.interpolate).toBe(2);
  });

  /* La differenza si vede meglio così: interpolare gli orari in parti uguali
   * darebbe 08:05:20 alla fermata 2, cinque minuti dopo il programmato, su
   * una tratta che ne dura due. L'algoritmo non deve farlo. */
  it("non distribuisce il tempo in parti uguali fra le fermate", () => {
    const oss: PassaggioOsservato[] = [
      { stopId: "S1", actualTs: at("08:00:00") },
      { stopId: "S4", actualTs: at("08:16:00") },
    ];
    const r = completeTransits(CORSA, oss, TZ);
    const perParti = at("08:05:20").getTime();       // 16 min / 3 tratte
    expect(r.fermate[1].actualTs!.getTime()).not.toBe(perParti);
    expect(r.fermate[1].actualTs!.getTime()).toBeLessThan(perParti);
  });

  /* IL CAPOLINEA DI PARTENZA non letto: non c'è uno scarto precedente con cui
   * fare la media, quindi si mantiene quello della prima fermata osservata. */
  it("estrapola il capolinea di partenza dallo scarto più vicino", () => {
    const oss: PassaggioOsservato[] = [
      { stopId: "S2", actualTs: at("08:03:00") },   // +60 s
      { stopId: "S3", actualTs: at("08:11:00") },   // +60 s
    ];
    const r = completeTransits(CORSA, oss, TZ);
    expect(r.fermate[0]).toMatchObject({ origine: "estrapolato", delaySeconds: 60 });
    expect(r.fermate[0].actualTs!.toISOString()).toBe(at("08:01:00").toISOString());
  });

  it("estrapola il capolinea di arrivo dall'ultima osservazione", () => {
    const oss: PassaggioOsservato[] = [
      { stopId: "S1", actualTs: at("08:00:00") },
      { stopId: "S2", actualTs: at("08:05:00") },   // +180 s
    ];
    const r = completeTransits(CORSA, oss, TZ);
    expect(r.fermate[3]).toMatchObject({ origine: "estrapolato", delaySeconds: 180 });
    expect(r.fermate[3].actualTs!.toISOString()).toBe(at("08:15:00").toISOString());
    expect(r.estrapolate).toBe(2);                  // S3 e S4
  });

  it("con un solo passaggio osservato estrapola su tutta la corsa", () => {
    const r = completeTransits(CORSA, [{ stopId: "S3", actualTs: at("08:12:00") }], TZ);
    expect(r.osservate).toBe(1);
    expect(r.estrapolate).toBe(3);
    // scarto costante di 120 s ovunque
    expect(r.fermate.map(f => f.delaySeconds)).toEqual([120, 120, 120, 120]);
  });

  /* Lo scarto DICHIARATO dall'AVM è la sua misura e ha la precedenza su
   * quella che calcoliamo noi. */
  it("preferisce lo scarto dichiarato dall'AVM dove c'è", () => {
    const oss: PassaggioOsservato[] = [
      { stopId: "S1", actualTs: at("08:00:30"), delaySeconds: 45 },
    ];
    const r = completeTransits(CORSA, oss, TZ);
    expect(r.fermate[0].delaySeconds).toBe(45);     // non 30, che sarebbe il calcolo
  });

  it("senza alcun passaggio osservato non inventa niente", () => {
    const r = completeTransits(CORSA, [], TZ);
    expect(r.fermate.every(f => f.actualTs === null)).toBe(true);
    expect(r.fermate.every(f => f.origine === null)).toBe(true);
    expect(r.nota).toMatch(/nessun passaggio osservato/i);
  });

  /* Una fermata senza orario programmato non ha uno scarto definito: non si
   * può dedurre, e va detto invece di riempirla con un numero qualsiasi. */
  it("lascia scoperta la fermata priva di orario programmato", () => {
    const corsa: FermataProgrammata[] = [
      { seq: 1, stopId: "A", scheduled: "08:00:00" },
      { seq: 2, stopId: "B", scheduled: null },
      { seq: 3, stopId: "C", scheduled: "08:10:00" },
    ];
    const r = completeTransits(corsa, [
      { stopId: "A", actualTs: at("08:00:00") },
      { stopId: "C", actualTs: at("08:11:00") },
    ], TZ);
    expect(r.fermate[1].actualTs).toBeNull();
    expect(r.fermate[1].origine).toBeNull();
    expect(r.scoperte).toBe(1);
    expect(r.nota).toMatch(/non ricostruibili/i);
  });

  /* Due fermate con lo stesso orario previsto (arrotondamenti al minuto): la
   * proporzione non è definita e non deve produrre NaN. */
  it("regge due fermate con lo stesso orario programmato", () => {
    const corsa: FermataProgrammata[] = [
      { seq: 1, stopId: "A", scheduled: "08:00:00" },
      { seq: 2, stopId: "B", scheduled: "08:05:00" },
      { seq: 3, stopId: "C", scheduled: "08:05:00" },
      { seq: 4, stopId: "D", scheduled: "08:05:00" },
    ];
    const r = completeTransits(corsa, [
      { stopId: "A", actualTs: at("08:00:00") },
      { stopId: "D", actualTs: at("08:07:00") },
    ], TZ);
    for (const f of r.fermate) {
      expect(Number.isFinite(f.delaySeconds!)).toBe(true);
    }
  });

  /* Il GTFS scrive "25:10" per l'01:10 del giorno dopo, stessa giornata di
   * servizio: le differenze devono restare monotone. */
  it("gestisce una corsa che scavalca la mezzanotte", () => {
    const notturna: FermataProgrammata[] = [
      { seq: 1, stopId: "A", scheduled: "23:50:00" },
      { seq: 2, stopId: "B", scheduled: "24:00:00" },
      { seq: 3, stopId: "C", scheduled: "25:10:00" },
    ];
    const r = completeTransits(notturna, [
      { stopId: "A", actualTs: new Date("2026-09-10T23:50:00+02:00") },
      { stopId: "C", actualTs: new Date("2026-09-11T01:20:00+02:00") },  // +10 min
    ], TZ);
    // B è a 10 min dei 80 programmati → 10/80 del ritardo
    expect(r.fermate[1].delaySeconds).toBe(Math.round(600 * (10 / 80)));   // 75 s
    expect(r.fermate[1].actualTs!.toISOString())
      .toBe(new Date("2026-09-11T00:01:15+02:00").toISOString());
  });

  it("misura la copertura e avverte quando è troppo bassa", () => {
    const lunga: FermataProgrammata[] = Array.from({ length: 20 }, (_, i) => ({
      seq: i + 1, stopId: `S${i + 1}`,
      scheduled: `08:${String(i * 2).padStart(2, "0")}:00`,
    }));
    const r = completeTransits(lunga, [
      { stopId: "S1", actualTs: at("08:00:00") },
      { stopId: "S20", actualTs: at("08:38:00") },
    ], TZ);
    expect(r.coperturaOsservata).toBe(0.1);
    expect(r.nota).toMatch(/copertura bassa/i);
  });

  it("quando è tutto misurato non ha nulla da segnalare", () => {
    const r = completeTransits(CORSA, [
      { stopId: "S1", actualTs: at("08:00:00") },
      { stopId: "S2", actualTs: at("08:02:00") },
      { stopId: "S3", actualTs: at("08:10:00") },
      { stopId: "S4", actualTs: at("08:12:00") },
    ], TZ);
    expect(r.nota).toBeNull();
    expect(r.coperturaOsservata).toBe(1);
  });

  /* Se la stessa fermata è stata rilevata due volte si tiene la prima, che è
   * l'arrivo: la seconda è il mezzo ancora fermo lì al giro dopo. */
  it("su due rilevazioni della stessa fermata tiene l'arrivo", () => {
    const r = completeTransits(CORSA, [
      { stopId: "S1", actualTs: at("08:00:30") },
      { stopId: "S1", actualTs: at("08:01:40") },
    ], TZ);
    expect(r.fermate[0].actualTs!.toISOString()).toBe(at("08:00:30").toISOString());
  });

  it("su una corsa senza fermate non esplode", () => {
    const r = completeTransits([], [{ stopId: "X", actualTs: at("08:00:00") }], TZ);
    expect(r.fermate).toEqual([]);
    expect(r.nota).toMatch(/non ha fermate programmate/i);
  });

  /* Gli orari ricostruiti devono restare in ordine: una corsa che "torna
   * indietro" nel tempo renderebbe negativi i tempi di tratta. */
  it("produce orari monotoni lungo la corsa", () => {
    const r = completeTransits(CORSA, [
      { stopId: "S1", actualTs: at("08:01:00") },
      { stopId: "S4", actualTs: at("08:20:00") },
    ], TZ);
    const t = r.fermate.map(f => f.actualTs!.getTime());
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });
});
