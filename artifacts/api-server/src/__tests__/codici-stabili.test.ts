/**
 * Codici stabili (PR 3.1): le regole che l'import applica senza database
 * (lib/codici-stabili.ts), e le istruzioni che non devono perdersi il codice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CodiciDelProgetto, codiceDalFile, LUNGHEZZA_MASSIMA_DEL_CODICE } from "../lib/codici-stabili";

const sorgente = (file: string) => readFileSync(join(__dirname, "..", "lib", file), "utf8");

describe("l'id di un file come codice", () => {
  it("resta com'è, senza spazi ai lati", () => {
    expect(codiceDalFile("623_CodUdp:D1333_363485")).toBe("623_CodUdp:D1333_363485");
    expect(codiceDalFile("  1/3 ")).toBe("1/3");
    expect(codiceDalFile(42)).toBe("42");
  });
  it("perde i caratteri di controllo e non supera la lunghezza del vincolo", () => {
    expect(codiceDalFile("a\tb\nc\u0000d\u007f")).toBe("abcd");
    expect(codiceDalFile("x".repeat(500))).toHaveLength(LUNGHEZZA_MASSIMA_DEL_CODICE);
    // tagliando non restano spazi in fondo: il vincolo li rifiuterebbe
    expect(codiceDalFile(`${"x".repeat(199)} y`)).toBe("x".repeat(199));
  });
  it("vuoto se non resta niente", () => {
    for (const v of ["", "   ", "\n\t", null, undefined]) expect(codiceDalFile(v)).toBe("");
  });
});

describe("i codici di un progetto durante un import", () => {
  it("l'id del file, se è libero", () => {
    const c = new CodiciDelProgetto();
    expect(c.prendi("10")).toBe("10");
    expect(c.prendi("11")).toBe("11");
  });
  it("già preso (dal progetto o da una riga prima nel file): ~2, ~3…", () => {
    const c = new CodiciDelProgetto(["10", "10~2"]);
    expect(c.prendi("10")).toBe("10~3");
    expect(c.prendi("10")).toBe("10~4");
    expect(c.prendi("11")).toBe("11");
    expect(c.prendi(" 11 ")).toBe("11~2");
  });
  it("mai più lungo del vincolo, nemmeno con la coda", () => {
    const c = new CodiciDelProgetto();
    const lungo = "x".repeat(300);
    const primo = c.prendi(lungo), secondo = c.prendi(lungo);
    expect(primo).toHaveLength(LUNGHEZZA_MASSIMA_DEL_CODICE);
    expect(secondo).toHaveLength(LUNGHEZZA_MASSIMA_DEL_CODICE);
    expect(secondo.endsWith("~2")).toBe(true);
    expect(secondo).not.toBe(primo);
  });
  it("un id che non lascia niente ha comunque un codice, diverso per ogni riga", () => {
    const c = new CodiciDelProgetto();
    expect(c.prendi("  ")).toBe("senza-id");
    expect(c.prendi("\n")).toBe("senza-id~2");
  });
  it("ricorda il numero più alto dei codici con la forma di quelli generati", () => {
    const c = new CodiciDelProgetto(["CB-C900"]); // quelli già nel progetto non contano: la sequenza li ha già passati
    expect(c.numeroPiuAlto).toBe(0);
    c.prendi("CB-F12"); c.prendi("CB-C7"); c.prendi("CB-X99"); c.prendi("cb-c500"); c.prendi("CB-C7b");
    expect(c.numeroPiuAlto).toBe(12);
    c.prendi("CB-L40");
    expect(c.numeroPiuAlto).toBe(40);
  });
});

describe("le istruzioni che scrivono corse, fermate e linee", () => {
  it("l'import scrive il codice in ogni INSERT di ps_stops, ps_routes e ps_trips", () => {
    const testo = sorgente("planning-studio-import.ts");
    const inserimenti = [...testo.matchAll(/bulkInsert\(\s*"(ps_stops|ps_routes|ps_trips)",\s*\[([^\]]*)\]/g)];
    expect(inserimenti).toHaveLength(6); // tre tabelle, import completo e reimport
    for (const [, tabella, colonne] of inserimenti) expect(colonne, tabella).toContain('"codice"');
  });
  it("«sdoppia» copia la corsa senza il codice: ne riceve uno nuovo", () => {
    const testo = sorgente("planning-studio-trips-ext.ts");
    expect(testo).toMatch(/column_name NOT IN \('id','created_at','codice'\)/);
  });
  it("l'export consegna i codici, non gli id interni", () => {
    const testo = sorgente("planning-studio-export.ts");
    expect(testo).toContain("s.codice ?? s.id");
    expect(testo).toContain("r.codice ?? r.id");
    expect(testo).toContain("t.codice ?? t.id");
    expect(testo).toContain("codiceCorsa.get(s.trip_id) ?? s.trip_id");
    expect(testo).toContain("codiceFermata.get(s.stop_id) ?? s.stop_id");
    expect(testo).toContain("codiceLinea.get(t.route_id) ?? t.route_id");
  });
});
