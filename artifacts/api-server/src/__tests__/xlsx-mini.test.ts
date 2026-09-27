import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { scriviXlsx, Stili, zip, lettereColonna } from "../lib/xlsx-mini";
import { esportaDiarioXlsx } from "../lib/avm-diario-xlsx";
import { analizzaDiario, type RigaDiario } from "../lib/avm-diario";

/** Legge i nomi e i contenuti delle voci di uno zip scritto da noi. */
function voci(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const comp = buf.readUInt32LE(i + 18);
    const nomeLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nome = buf.subarray(i + 30, i + 30 + nomeLen).toString("utf8");
    const inizio = i + 30 + nomeLen + extraLen;
    out.set(nome, inflateRawSync(buf.subarray(inizio, inizio + comp)));
    i = inizio + comp;
  }
  return out;
}

describe("xlsx-mini — lo zip e le lettere di colonna", () => {
  it("numera le colonne come Excel", () => {
    expect(lettereColonna(0)).toBe("A");
    expect(lettereColonna(25)).toBe("Z");
    expect(lettereColonna(26)).toBe("AA");
    expect(lettereColonna(27 * 26 - 1)).toBe("ZZ");
  });

  it("lo zip si rilegge voce per voce, con il contenuto intatto", () => {
    const z = zip([{ name: "a.txt", data: Buffer.from("ciao") }, { name: "d/b.txt", data: Buffer.from("x".repeat(5000)) }]);
    const v = voci(z);
    expect([...v.keys()]).toEqual(["a.txt", "d/b.txt"]);
    expect(v.get("a.txt")!.toString()).toBe("ciao");
    expect(v.get("d/b.txt")!.length).toBe(5000);
    /* firma della fine dell'archivio */
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
  });
});

describe("xlsx-mini — un foglio con stili, unioni e immagine", () => {
  const st = new Stili();
  const bold = st.indice({ bold: true, fill: "0B1220", color: "FFFFFF" });
  const same = st.indice({ bold: true, fill: "0B1220", color: "FFFFFF" });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const buf = scriviXlsx([{
    nome: "Prova",
    righe: [[{ v: "Titolo", s: bold }, null, 3], [], ["a & b <c>", { v: 1.5, s: bold }]],
    larghezze: [20, 5, 5],
    unioni: ["A1:B1"],
    blocca: { righe: 1, colonne: 1 },
    immagine: { id: 1, cella: "A1", larghezzaPx: 10, altezzaPx: 10 },
  }], st, [{ id: 1, png }]);

  const v = voci(buf);

  it("lo stesso stile chiesto due volte è lo stesso indice", () => {
    expect(same).toBe(bold);
  });

  it("contiene tutte le parti che Excel si aspetta", () => {
    for (const parte of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
      "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/_rels/sheet1.xml.rels",
      "xl/drawings/drawing1.xml", "xl/drawings/_rels/drawing1.xml.rels", "xl/media/image1.png"]) {
      expect(v.has(parte), parte).toBe(true);
    }
  });

  it("scrive testo inline con l'escape XML, numeri come numeri, e salta le celle vuote", () => {
    const sheet = v.get("xl/worksheets/sheet1.xml")!.toString();
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Titolo</t></is></c>');
    expect(sheet).toContain('<c r="C1"><v>3</v></c>');
    expect(sheet).toContain("a &amp; b &lt;c&gt;");
    expect(sheet).not.toContain('r="B1"');
    expect(sheet).toContain('<mergeCell ref="A1:B1"/>');
    expect(sheet).toContain('xSplit="1" ySplit="1" topLeftCell="B2"');
    expect(sheet).toContain('<drawing r:id="rIdDrawing"/>');
  });

  it("gli stili hanno font, riempimento e xf coerenti", () => {
    const styles = v.get("xl/styles.xml")!.toString();
    expect(styles).toContain('<fgColor rgb="FF0B1220"/>');
    expect(styles).toContain('<color rgb="FFFFFFFF"/>');
    expect(styles).toMatch(/<cellXfs count="2">/);
  });
});

describe("il diario in un foglio", () => {
  function riga(giorno: string, vehicleRef: string, p: Partial<RigaDiario> = {}): RigaDiario {
    return {
      giorno, vehicleRef, letture: 700, lettureFresche: 0, lettureMonitorata: 0, letturePosizione: 0,
      lettureCorsa: 0, lettureErroreGps: 0, lettureErroreGprs: 0, lettureInRimessa: 0,
      primoContatto: null, ultimoContatto: null, linee: [], corse: [], ...p,
    };
  }
  const giorni = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
  const righe: RigaDiario[] = [];
  for (const g of giorni) {
    righe.push(riga(g, "263", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 4, corse: [g], linee: ["Linea 24"] }));
    righe.push(riga(g, "11096", { lettureFresche: 9, letturePosizione: 9, lettureCorsa: 1, corse: [g] }));
    righe.push(riga(g, "1372", { lettureFresche: 9, lettureErroreGps: 9 }));
    righe.push(riga(g, "229"));
  }
  const d = analizzaDiario(righe, giorni);
  const buf = esportaDiarioXlsx(d, { da: giorni[0], a: giorni[3] },
    [{ destinatario: "Officina", oggetto: "AVM — antenna", testo: "Matricole: 1372.", matricole: 1 }]);
  const v = voci(buf);

  it("ha tre fogli e il logo", () => {
    const wb = v.get("xl/workbook.xml")!.toString();
    expect(wb).toContain('name="Riepilogo"');
    expect(wb).toContain('name="Vetture"');
    expect(wb).toContain('name="Segnalazioni"');
    expect(v.get("xl/media/image1.png")!.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  });

  it("una riga per vettura, con un quadratino colorato per giornata", () => {
    const sheet = v.get("xl/worksheets/sheet2.xml")!.toString();
    const styles = v.get("xl/styles.xml")!.toString();
    expect(sheet).toContain(">263<");
    expect(sheet).toContain(">Funziona: ha fatto corse<");
    expect(sheet).toContain(">Parla ma non aggancia il GPS<");
    /* i quattro colori dei giorni ci sono tutti: verde, azzurro, giallo, grigio */
    for (const c of ["FF34D399", "FF7DD3FC", "FFFBBF24", "FF3F3F46"]) expect(styles).toContain(c);
    /* le colonne dei giorni: quattro intestazioni dd/mm dopo le quattordici fisse */
    expect(sheet).toContain(">21/09<");
    expect(sheet).toContain(">24/09<");
  });

  it("il perimetro ristretto esporta solo quelle vetture", () => {
    const solo = esportaDiarioXlsx(d, { da: giorni[0], a: giorni[3] }, [], d.vetture.filter(x => /^\d{1,4}$/.test(x.vehicleRef)));
    const sheet = voci(solo).get("xl/worksheets/sheet2.xml")!.toString();
    expect(sheet).toContain(">263<");
    expect(sheet).not.toContain(">11096<");
  });

  it("scrive un file da aprire con un lettore vero", () => {
    /* Il file resta nella scratchpad della sessione: la verifica con
     * openpyxl la fa chi lavora, non il test. */
    const dir = process.env.XLSX_PROVA_DIR;
    if (dir) writeFileSync(`${dir}/diario-prova.xlsx`, buf);
    expect(buf.length).toBeGreaterThan(80_000);
  });
});
