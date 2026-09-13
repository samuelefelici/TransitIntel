/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Lettura dei file GTFS — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Due difetti che non danno errore: un file con il BOM in testa importa un
 * feed vuoto "con successo", e un orario "5:30:00" salvato com'è non si
 * aggancia mai. Qui si fissano entrambi con il caso che li produce.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import { parseCsv, normalizzaOrarioGtfs } from "../routes/gtfs-helpers";

describe("parseCsv", () => {
  /* Excel e gli esportatori Windows mettono U+FEFF davanti alla prima
   * colonna: senza gestirlo la chiave diventa "﻿stop_id" e ogni
   * `r["stop_id"]` è undefined. L'importazione riusciva, vuota. */
  it("ignora il BOM UTF-8 in testa al file", () => {
    const righe = parseCsv("﻿stop_id,stop_name\n1,Stazione\n");
    expect(righe).toHaveLength(1);
    expect(righe[0]["stop_id"]).toBe("1");
    expect(Object.keys(righe[0])).toEqual(["stop_id", "stop_name"]);
  });

  it("legge un file senza BOM come prima", () => {
    const righe = parseCsv("trip_id,route_id\nC1,R3\n\n");
    expect(righe).toEqual([{ trip_id: "C1", route_id: "R3" }]);
  });

  it("su contenuto non CSV restituisce vuoto invece di esplodere", () => {
    expect(parseCsv('"aperta,senza,chiusura\n1,2')).toEqual([]);
  });
});

describe("normalizzaOrarioGtfs", () => {
  it("riempie l'ora a due cifre, come la specifica ammette di omettere", () => {
    expect(normalizzaOrarioGtfs("5:30:00")).toBe("05:30:00");
    expect(normalizzaOrarioGtfs("7:05")).toBe("07:05:00");
  });

  it("lascia intatte le ore oltre le 24, che sono la corsa dopo mezzanotte", () => {
    expect(normalizzaOrarioGtfs("25:10:00")).toBe("25:10:00");
    expect(normalizzaOrarioGtfs("24:00:00")).toBe("24:00:00");
  });

  it("non tocca un orario già canonico", () => {
    expect(normalizzaOrarioGtfs("08:30:00")).toBe("08:30:00");
  });

  /* Normalizzato, il confronto testuale torna a essere un confronto di
   * orari: era il motivo per cui MIN() sceglieva "10:02:00" al posto di
   * "9:55:00". */
  it("rende corretto l'ordinamento testuale", () => {
    const a = normalizzaOrarioGtfs("9:55:00")!, b = normalizzaOrarioGtfs("10:02:00")!;
    expect(a < b).toBe(true);
  });

  it("vuoto e nullo restano nulli; un testo strano passa com'è, ripulito", () => {
    expect(normalizzaOrarioGtfs(null)).toBeNull();
    expect(normalizzaOrarioGtfs("")).toBeNull();
    expect(normalizzaOrarioGtfs("   ")).toBeNull();
    expect(normalizzaOrarioGtfs(" boh ")).toBe("boh");
  });
});
