/**
 * Le letture del traffico dentro la quota mensile di TomTom (tappa 7.30):
 * l'intervallo dai punti e dalla quota, la prima lettura dopo un riavvio, il
 * testo dei rifiuti senza la chiave, e la pianificazione con i tempi finti.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const stato = vi.hoisted(() => ({
  punti: 37,
  ultima: null as Date | null,
  esiti: [] as any[],
  letture: 0,
}));

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [{ ultima: stato.ultima }] })) },
}));
vi.mock("@workspace/db/contesto", () => ({
  inSistema: (_via: string, fn: () => unknown) => fn(),
}));
vi.mock("../lib/territorio", () => ({
  leggiLuoghi: vi.fn(async () => Array.from({ length: stato.punti }, (_, i) => ({ nome: `p${i}` }))),
}));
vi.mock("../routes/cron", () => ({
  syncTrafficFromTomTom: vi.fn(async () => {
    stato.letture++;
    return stato.esiti.shift() ?? { inserted: stato.punti, failed: 0, rifiuti: {}, puntiRifiutati: [] };
  }),
}));

import {
  avviaTraffico, intervalloTrafficoMin, primaLetturaTraMs, richiesteMese, RICHIESTE_MESE_PREDEFINITE,
} from "../lib/traffico-quota";

const MINUTI_MESE = 31 * 24 * 60;

describe("quanto spesso leggere il traffico", () => {
  it("la quota del mese viene da TRAFFICO_RICHIESTE_MESE; un valore storto vale la predefinita", () => {
    expect(RICHIESTE_MESE_PREDEFINITE).toBe(19_000);
    expect(richiesteMese(undefined)).toBe(19_000);
    expect(richiesteMese("")).toBe(19_000);
    expect(richiesteMese("abc")).toBe(19_000);
    expect(richiesteMese("50")).toBe(19_000);
    expect(richiesteMese("2500.5")).toBe(19_000);
    expect(richiesteMese("-4000")).toBe(19_000);
    expect(richiesteMese("40000")).toBe(40_000);
  });

  it("con 37 punti e 19.000 richieste: ogni 87 minuti, e un mese di 31 giorni sta nella quota", () => {
    const ogni = intervalloTrafficoMin(37, 19_000);
    expect(ogni).toBe(87);
    expect(37 * Math.floor(MINUTI_MESE / ogni)).toBeLessThanOrEqual(19_000);
    /* un minuto prima e la quota non basterebbe più */
    expect(37 * Math.floor(MINUTI_MESE / (ogni - 1))).toBeGreaterThan(19_000);
  });

  it("mai meno di 30 minuti, come prima; senza punti, ogni ora", () => {
    expect(intervalloTrafficoMin(5, 19_000)).toBe(30);
    expect(intervalloTrafficoMin(37, 1_000_000)).toBe(30);
    expect(intervalloTrafficoMin(0, 19_000)).toBe(60);
    expect(intervalloTrafficoMin(100, 19_000)).toBe(235);
  });

  it("la prima lettura arriva un intervallo dopo l'ultima registrata, almeno 10 secondi dopo l'avvio", () => {
    const ora = Date.UTC(2001, 0, 2, 12, 0, 0);
    expect(primaLetturaTraMs(null, 87, ora)).toBe(10_000);
    expect(primaLetturaTraMs(new Date(ora - 20 * 60_000), 87, ora)).toBe(67 * 60_000);
    expect(primaLetturaTraMs(new Date(ora - 200 * 60_000), 87, ora)).toBe(10_000);
    expect(primaLetturaTraMs(new Date(ora - 87 * 60_000 + 5_000), 87, ora)).toBe(10_000);
  });
});

describe("la pianificazione delle letture", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let ferma: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2001, 0, 2, 12, 0, 0));
    stato.punti = 37;
    stato.ultima = null;
    stato.esiti = [];
    stato.letture = 0;
    log.info.mockClear(); log.warn.mockClear(); log.error.mockClear();
    delete process.env.TRAFFICO_RICHIESTE_MESE;
  });
  afterEach(() => {
    ferma?.();
    ferma = null;
    vi.useRealTimers();
  });

  it("dopo un riavvio non legge subito se l'ultima lettura è recente, poi legge a intervallo", async () => {
    stato.ultima = new Date(Date.now() - 20 * 60_000);
    ferma = await avviaTraffico(log);
    expect(log.info.mock.calls[0][1]).toBe("Traffic auto-sync: ogni 87 min (37 punti, ~18981 richieste in un mese di 31 giorni, quota 19000)");
    expect(log.info.mock.calls[0][0]).toMatchObject({ punti: 37, quotaMese: 19_000, ogniMin: 87, primaTraMin: 67 });

    await vi.advanceTimersByTimeAsync(66 * 60_000);
    expect(stato.letture).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stato.letture).toBe(1);
    expect(log.info).toHaveBeenLastCalledWith(expect.objectContaining({ inserted: 37, prossimaTraMin: 87 }), "Traffic auto-sync: done");

    await vi.advanceTimersByTimeAsync(87 * 60_000);
    expect(stato.letture).toBe(2);
    /* in un giorno, 1 + 16 letture: non più le 48 di prima */
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 87 * 60_000 - 67 * 60_000);
    expect(stato.letture).toBeLessThanOrEqual(17);
  });

  it("senza letture registrate legge dopo 10 secondi", async () => {
    ferma = await avviaTraffico(log);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(stato.letture).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stato.letture).toBe(1);
  });

  it("se TomTom rifiuta tutto con 403, lo dice nel log con il motivo", async () => {
    stato.esiti = [{ inserted: 0, failed: 37, rifiuti: { 403: 37 }, puntiRifiutati: ["p0"], motivo: "403: Developer Over Qps" }];
    ferma = await avviaTraffico(log);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toEqual({ rifiuti: { 403: 37 }, motivo: "403: Developer Over Qps" });
    expect(log.warn.mock.calls[0][1]).toMatch(/quota del mese finita/);
  });

  it("un punto rifiutato con 400 non è l'avviso della quota", async () => {
    stato.esiti = [{ inserted: 36, failed: 1, rifiuti: { 400: 1 }, puntiRifiutati: ["p7"], motivo: "400: Point too far from nearest existing segment." }];
    ferma = await avviaTraffico(log);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenLastCalledWith(expect.objectContaining({ puntiRifiutati: ["p7"], rifiuti: { 400: 1 } }), "Traffic auto-sync: done");
  });

  it("la quota scritta nella variabile cambia l'intervallo", async () => {
    process.env.TRAFFICO_RICHIESTE_MESE = "60000";
    ferma = await avviaTraffico(log);
    expect(log.info.mock.calls[0][0]).toMatchObject({ quotaMese: 60_000, ogniMin: 30 });
  });

  it("una lettura che fallisce non ferma le successive", async () => {
    const { syncTrafficFromTomTom } = await import("../routes/cron");
    vi.mocked(syncTrafficFromTomTom).mockRejectedValueOnce(new Error("database giù"));
    ferma = await avviaTraffico(log);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log.error).toHaveBeenCalledWith(expect.any(Error), "Traffic auto-sync: failed");
    await vi.advanceTimersByTimeAsync(87 * 60_000);
    expect(stato.letture).toBe(1);
    expect(log.info).toHaveBeenLastCalledWith(expect.objectContaining({ inserted: 37 }), "Traffic auto-sync: done");
  });

  it("lo stop ferma le letture", async () => {
    ferma = await avviaTraffico(log);
    ferma();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(stato.letture).toBe(0);
  });
});

describe("il motivo di un rifiuto", () => {
  it("corto, senza tag e senza la chiave", async () => {
    const { motivoRifiuto } = await vi.importActual<typeof import("../routes/cron")>("../routes/cron");
    const testo = `<h1>Developer Inactive</h1>\n<p>key   chiave-segreta-123 not valid</p>`;
    const m = motivoRifiuto(403, testo, "chiave-segreta-123");
    expect(m).toBe("403: Developer Inactive key *** not valid");
    expect(m).not.toContain("chiave-segreta-123");
    expect(motivoRifiuto(400, "x".repeat(500), "k").length).toBe("400: ".length + 160);
  });
});
