/**
 * Il lettore di .xlsx dell'import dell'anagrafica: legge quello che scrive
 * xlsx-mini, quello che scrive Excel (stringhe condivise, run di
 * formattazione, celle saltate) e si ferma davanti ai file ostili.
 */
import { describe, it, expect } from "vitest";
import { Stili, scriviXlsx, zip } from "../lib/xlsx-mini";
import { leggiXlsx, indiceColonna, ErroreXlsx, LIMITI_XLSX } from "../lib/xlsx-leggi";

function xlsxDaXml(foglio: string, condivise?: string, extra: Array<{ name: string; data: Buffer }> = []): Buffer {
  const f = (name: string, s: string) => ({ name, data: Buffer.from(s, "utf8") });
  return zip([
    f("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    f("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Dipendenti" sheetId="1" r:id="rId7"/></sheets></workbook>`),
    f("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/foglio.xml"/></Relationships>`),
    f("xl/worksheets/foglio.xml", foglio),
    ...(condivise ? [f("xl/sharedStrings.xml", condivise)] : []),
    ...extra,
  ]);
}

describe("il lettore di .xlsx", () => {
  it("rilegge quello che scrive xlsx-mini", () => {
    const buf = scriviXlsx([{
      nome: "Prova",
      righe: [["Matricola", "Cognome", "Orario"], ["00123", "D'Angelo & figli", 2310], [], ["7", null, "38:30"]],
    }], new Stili());
    expect(leggiXlsx(buf)).toEqual([
      ["Matricola", "Cognome", "Orario"],
      ["00123", "D'Angelo & figli", "2310"],
      [],
      ["7", null, "38:30"],
    ]);
  });

  it("legge le stringhe condivise, i run, le celle saltate e il primo foglio vero", () => {
    const ss = `<sst><si><t>Cognome</t></si><si><r><t>Ros</t></r><r><rPr><b/></rPr><t xml:space="preserve">si</t></r><rPh><t>ロッシ</t></rPh></si><si><t>Città_x000D_</t></si></sst>`;
    const sh = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>45321</v></c><c r="C3" t="inlineStr"><is><t>Ancona &amp; dintorni</t></is></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="e"><v>#N/A</v></c><c r="F3" s="2"/></row>
    </sheetData></worksheet>`;
    expect(leggiXlsx(xlsxDaXml(sh, ss))).toEqual([
      ["Cognome", null, "Città\r"],
      [],
      ["Rossi", "45321", "Ancona & dintorni", "VERO", null, null],
    ]);
  });

  it("le colonne oltre la Z", () => {
    expect(indiceColonna("A1")).toBe(0);
    expect(indiceColonna("Z9")).toBe(25);
    expect(indiceColonna("AA2")).toBe(26);
    expect(indiceColonna("EJ3")).toBe(139);
  });

  it("un'entità dichiarata nel file non si espande", () => {
    const sh = `<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&a;&#65;&#x42;</t></is></c></row></sheetData></worksheet>`;
    expect(leggiXlsx(xlsxDaXml(sh))).toEqual([["&a;AB"]]);
  });

  it("si ferma davanti a un numero di riga enorme e a un file che non è uno zip", () => {
    const sh = `<worksheet><sheetData><row r="${LIMITI_XLSX.righe + 1}"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`;
    expect(() => leggiXlsx(xlsxDaXml(sh))).toThrow(ErroreXlsx);
    expect(() => leggiXlsx(Buffer.from("matricola;cognome\n1;Rossi"))).toThrow(ErroreXlsx);
  });

  it("si ferma prima di decomprimere uno zip bomb", () => {
    const grande = Buffer.alloc(LIMITI_XLSX.byteVoce + 1, 0x20);
    const sh = `<worksheet><sheetData/></worksheet>`;
    expect(() => leggiXlsx(xlsxDaXml(sh, undefined, [{ name: "xl/media/zero.bin", data: grande }, { name: "xl/media/zero2.bin", data: grande }])))
      .toThrow(/troppo grande/);
  });
});

describe("una dimensione dichiarata falsa", () => {
  it("non basta a far decomprimere oltre il tetto", async () => {
    const buf = xlsxDaXml(`<worksheet><sheetData/></worksheet>`);
    /* si sostituisce il foglio con uno enorme che dichiara 10 byte */
    const AdmZip = (await import("adm-zip")).default;
    const z = new AdmZip(buf);
    const enorme = Buffer.alloc(LIMITI_XLSX.byteVoce + 10, 0x20);
    z.addFile("xl/worksheets/foglio.xml", enorme);
    const truccato = z.toBuffer();
    /* la dimensione decompressa sta nell'intestazione locale e in quella centrale: si falsificano tutte e due */
    const firma = Buffer.from("xl/worksheets/foglio.xml");
    let i = -1;
    while ((i = truccato.indexOf(firma, i + 1)) !== -1) {
      const loc = truccato.readUInt32LE(i - 30) === 0x04034b50 ? i - 30 : truccato.readUInt32LE(i - 46) === 0x02014b50 ? i - 46 : -1;
      if (loc < 0) continue;
      const off = truccato.readUInt32LE(loc) === 0x04034b50 ? 22 : 24;
      truccato.writeUInt32LE(10, loc + off);
    }
    expect(() => leggiXlsx(truccato)).toThrow(/troppo grande/);
  });
});
