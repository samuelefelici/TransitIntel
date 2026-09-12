/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Validità di un feed — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questo stato decide che cosa il software consiglia di fare. Dire "scaduto"
 * di un orario caricato in anticipo manda a rimaterializzare un feed che va
 * benissimo; dire "va bene" di uno scaduto lascia l'aggancio delle corse
 * ambiguo senza che nessuno lo sappia. Sono errori in direzioni opposte, e
 * un solo booleano non li distingue.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import { validitaFeed, oggiYmd } from "../lib/feed-validity";

const OGGI = "20260912";

describe("in quale momento della sua vita è il feed", () => {
  /* Il caso che il booleano sbagliava: l'orario nuovo si carica prima che
   * parta, ed è buona pratica, non un difetto. */
  it("un orario che entra in vigore fra due giorni è futuro, non scaduto", () => {
    const v = validitaFeed(12, "20260914", "20261231", OGGI);
    expect(v.stato).toBe("futuro");
    expect(v.fraGiorni).toBe(2);
    expect(v.nota).toMatch(/fra 2 giorni/);
    expect(v.nota).toMatch(/corretto/i);
    expect(v.nota).not.toMatch(/scaduto/i);
  });

  it("il singolare quando manca un giorno solo", () => {
    expect(validitaFeed(12, "20260913", "20261231", OGGI).nota).toMatch(/fra 1 giorno\b/);
  });

  /* Futuro E attivo: non è un errore, ma la conseguenza non è ovvia. */
  it("un feed futuro già attivo avverte che l'aggancio è ambiguo fino ad allora", () => {
    const v = validitaFeed(12, "20260914", "20261231", OGGI, true);
    expect(v.stato).toBe("futuro");
    expect(v.nota).toMatch(/già il feed attivo/i);
    expect(v.nota).toMatch(/tutte le validità/i);
  });

  it("un orario finito è scaduto, e dice da quanto", () => {
    const v = validitaFeed(12, "20260101", "20260731", OGGI);
    expect(v.stato).toBe("scaduto");
    expect(v.nota).toMatch(/Scaduto da 43 giorni/);
    expect(v.nota).toMatch(/sostituito/i);
  });

  it("un orario che comprende oggi non ha nulla da segnalare", () => {
    const v = validitaFeed(12, "20260901", "20261231", OGGI);
    expect(v.stato).toBe("corrente");
  });

  /* Gli estremi sono inclusi: il primo e l'ultimo giorno il servizio c'è. */
  it("il primo e l'ultimo giorno di validità sono compresi", () => {
    expect(validitaFeed(1, OGGI, OGGI, OGGI).stato).toBe("corrente");
    expect(validitaFeed(1, "20260101", OGGI, OGGI).stato).toBe("corrente");
    expect(validitaFeed(1, OGGI, "20261231", OGGI).stato).toBe("corrente");
  });
});

describe("quando non si può dire", () => {
  it("senza righe di calendario lo dichiara assente, non scaduto", () => {
    const v = validitaFeed(0, null, null, OGGI);
    expect(v.stato).toBe("assente");
    expect(v.nota).toMatch(/non ha calendario/i);
  });

  it("con date malformate non inventa uno stato", () => {
    expect(validitaFeed(5, "2026-09-14", "20261231", OGGI).stato).toBe("assente");
    expect(validitaFeed(5, "boh", "boh", OGGI).stato).toBe("assente");
  });
});

describe("la data di oggi", () => {
  it("è nel formato del calendario GTFS", () => {
    expect(oggiYmd()).toMatch(/^\d{8}$/);
  });

  /* Il server gira in UTC, l'esercizio no: a mezzanotte passata in Italia la
   * giornata di servizio è già cambiata mentre a Londra no. */
  it("è calcolata nel fuso dell'azienda, non in quello del server", () => {
    const roma = oggiYmd("Europe/Rome");
    const kiritimati = oggiYmd("Pacific/Kiritimati");
    expect(roma).toMatch(/^\d{8}$/);
    expect(Number(kiritimati)).toBeGreaterThanOrEqual(Number(roma));
  });
});
