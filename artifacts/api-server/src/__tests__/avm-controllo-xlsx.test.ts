/**
 * L'esportazione del controllo settimanale: il foglio Excel col marchio e il
 * CSV per chi deve incrociare i dati.
 */
import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { calcolaControllo, inizioFinestra, spostaGiorni, type InterventoAvm } from "../lib/avm-controllo";
import { esportaControlloXlsx, esportaControlloCsv, cellaCsv } from "../lib/avm-controllo-xlsx";
import { giornateDelPeriodo } from "../lib/fleet-trend";
import type { RigaDiario } from "../lib/avm-diario";

/** Le voci di uno zip scritto da xlsx-mini. */
function voci(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const comp = buf.readUInt32LE(i + 18);
    const nomeLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nome = buf.subarray(i + 30, i + 30 + nomeLen).toString("utf8");
    const inizio = i + 30 + nomeLen + extraLen;
    out.set(nome, inflateRawSync(buf.subarray(inizio, inizio + comp)).toString("utf8"));
    i = inizio + comp;
  }
  return out;
}

const LUNEDI = "2026-10-05";
function riga(giorno: string, vehicleRef: string, p: Partial<RigaDiario> = {}): RigaDiario {
  return {
    giorno, vehicleRef, letture: 700, lettureFresche: 0, lettureMonitorata: 0, letturePosizione: 0,
    lettureCorsa: 0, lettureErroreGps: 0, lettureErroreGprs: 0, lettureInRimessa: 0,
    primoContatto: null, ultimoContatto: null, linee: [], corse: [], ...p,
  };
}
const righe: RigaDiario[] = [];
for (const g of giornateDelPeriodo(inizioFinestra(LUNEDI), spostaGiorni(LUNEDI, 6))) {
  righe.push(riga(g, "430", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 3 }));
  righe.push(riga(g, "263", g >= "2026-10-07" ? { lettureFresche: 9, letturePosizione: 9 } : {}));
  righe.push(riga(g, "440", g <= "2026-10-02" ? { lettureFresche: 9, letturePosizione: 9 } : { lettureFresche: 9 }));
  righe.push(riga(g, "229"));
  if (g >= LUNEDI) righe.push(riga(g, "11108", { lettureFresche: 9, letturePosizione: 9 }));
}
const interventi: InterventoAvm[] = [{
  matricola: "263", fonte: "commessa", riferimento: "LEG-77", apertaIl: null, chiusaIl: "2026-10-06T15:00:00.000Z",
  descrizione: "Sostituzione antenna GPS", esito: "closed", commessa: "LEG-77",
}];
const c = calcolaControllo({ righe, lunedi: LUNEDI, oggi: "2026-10-12", interventi, generatoIl: "2026-10-12T03:15:00.000Z" });

describe("il foglio del controllo settimanale", () => {
  const buf = esportaControlloXlsx(c, c.vetture, { archiviato: true, perimetro: "solo Conerobus" });
  const v = voci(buf);
  const tutto = [...v.values()].join("\n");

  it("ha il riepilogo, i tre fogli delle notizie, gli interventi e tutte le vetture, col logo", () => {
    const wb = v.get("xl/workbook.xml")!;
    for (const nome of ["Riepilogo", "Si sono fermate", "Riprese", "Ancora guaste", "Interventi", "Tutte"]) {
      expect(wb).toContain(`name="${nome}"`);
    }
    expect(v.has("xl/media/image1.png")).toBe(true);
  });

  it("dice che è archiviato, quando, e il perimetro", () => {
    expect(tutto).toContain("Controllo settimanale AVM");
    expect(tutto).toContain("Settimana dal 05/10/2026 al 11/10/2026");
    expect(tutto).toContain("archiviato il 12/10/2026");
    expect(tutto).toContain("(solo Conerobus)");
  });

  it("le vetture finiscono nel foglio giusto, con la nota", () => {
    const fermate = v.get("xl/worksheets/sheet2.xml")!;
    const riprese = v.get("xl/worksheets/sheet3.xml")!;
    const guaste = v.get("xl/worksheets/sheet4.xml")!;
    expect(fermate).toContain(">440<");
    expect(fermate).not.toContain(">263<");
    expect(riprese).toContain(">263<");
    expect(riprese).toContain("Si localizza di nuovo dal 07/10");
    expect(guaste).toContain(">229<");
  });

  it("l'intervento ha il suo esito sull'apparato", () => {
    const fogliInterventi = v.get("xl/worksheets/sheet5.xml")!;
    expect(fogliInterventi).toContain(">LEG-77<");
    expect(fogliInterventi).toContain("Riuscito: prima non si localizzava, dopo sì");
  });

  it("i colori delle categorie, delle giornate e delle settimane ci sono", () => {
    const stili = v.get("xl/styles.xml")!;
    for (const colore of ["FFF87171", "FF34D399", "FFFB923C", "FF7DD3FC", "FFFBBF24", "FF3F3F46"]) {
      expect(stili).toContain(colore);
    }
  });

  it("il perimetro ristretto esporta solo quelle vetture", () => {
    const solo = esportaControlloXlsx(c, c.vetture.filter(x => /^\d{1,4}$/.test(x.vehicleRef)));
    expect(voci(solo).get("xl/worksheets/sheet6.xml")).not.toContain(">11108<");
  });

  it("scrive un file da aprire con un lettore vero", () => {
    const dir = process.env.XLSX_PROVA_DIR;
    if (dir) writeFileSync(`${dir}/controllo-prova.xlsx`, buf);
    expect(buf.length).toBeGreaterThan(80_000);
  });
});

describe("il CSV del controllo", () => {
  const csv = esportaControlloCsv(c);

  it("una riga per vettura, con le strisce", () => {
    const righeCsv = csv.split("\r\n");
    expect(righeCsv).toHaveLength(c.vetture.length + 1);
    expect(righeCsv[0]).toContain('"categoria"');
    expect(csv).toContain('"MMMMMMMMMTTTTT"');
  });

  it("una cella che comincia con un segno non diventa una formula", () => {
    expect(cellaCsv("-------TTTTTTT")).toBe("'-------TTTTTTT");
    expect(cellaCsv("=HYPERLINK(\"x\")")).toBe("'=HYPERLINK(\"x\")");
    expect(cellaCsv("+39")).toBe("'+39");
    expect(cellaCsv("@a")).toBe("'@a");
    expect(cellaCsv("263")).toBe("263");
    expect(csv).toContain(`"'-------TTTTTTT"`);
  });
});
