/**
 * ═══════════════════════════════════════════════════════════════════════════
 * XLSX SENZA DIPENDENZE — quel tanto di OOXML che serve a un foglio con stile
 * ───────────────────────────────────────────────────────────────────────────
 * Un file .xlsx è uno zip di XML. Per un export con intestazioni colorate,
 * un logo e qualche colonna larga non serve una libreria da tre megabyte:
 * servono un writer di zip (Node ha già la compressione in `zlib`) e cinque
 * XML scritti bene. Questo modulo fa esattamente quello e niente altro.
 *
 * Cosa sa fare: più fogli, testo e numeri, stili (grassetto, colore, sfondo,
 * allineamento, bordo sottile, a capo), larghezze di colonna, altezze di
 * riga, celle unite, riquadri bloccati, un'immagine PNG ancorata a una cella.
 * Cosa non sa fare, per scelta: formule, formati numerici, grafici, temi.
 *
 * I testi sono scritti come stringhe inline (`t="inlineStr"`): evita la
 * tabella delle stringhe condivise, che è un'ottimizzazione di cui un export
 * da qualche centinaio di righe non ha bisogno.
 *
 * Verificato aprendolo con openpyxl e con Excel: la struttura è quella che
 * Excel stesso produce, ridotta all'osso.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { deflateRawSync } from "node:zlib";

/* ── Stili ──────────────────────────────────────────────────────────────── */

export interface Stile {
  bold?: boolean;
  italic?: boolean;
  /** dimensione in punti */
  size?: number;
  /** colore del testo, "RRGGBB" */
  color?: string;
  /** sfondo pieno, "RRGGBB" */
  fill?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "center" | "bottom";
  wrap?: boolean;
  /** bordo sottile su tutti i lati */
  border?: boolean;
  /** colore del bordo, "RRGGBB" (predefinito grigio chiaro) */
  borderColor?: string;
}

/**
 * Registro degli stili: la stessa combinazione dà lo stesso indice, così il
 * foglio non si riempie di stili duplicati e `cellXfs` resta corto.
 */
export class Stili {
  private readonly chiavi = new Map<string, number>();
  private readonly lista: Stile[] = [{}];

  indice(s: Stile): number {
    const k = JSON.stringify([s.bold ?? false, s.italic ?? false, s.size ?? 0, s.color ?? "",
      s.fill ?? "", s.align ?? "", s.valign ?? "", s.wrap ?? false, s.border ?? false, s.borderColor ?? ""]);
    const esistente = this.chiavi.get(k);
    if (esistente != null) return esistente;
    const i = this.lista.length;
    this.lista.push(s);
    this.chiavi.set(k, i);
    return i;
  }

  /** xl/styles.xml */
  xml(): string {
    const fonts: string[] = [];
    const fills: string[] = ["<fill><patternFill patternType=\"none\"/></fill>",
      "<fill><patternFill patternType=\"gray125\"/></fill>"];
    const borders: string[] = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
    const fontIdx = new Map<string, number>();
    const fillIdx = new Map<string, number>();
    const borderIdx = new Map<string, number>();
    const xfs: string[] = [];

    for (const s of this.lista) {
      const fk = `${s.bold ? 1 : 0}|${s.italic ? 1 : 0}|${s.size ?? 11}|${s.color ?? "000000"}`;
      if (!fontIdx.has(fk)) {
        fontIdx.set(fk, fonts.length);
        fonts.push(`<font>${s.bold ? "<b/>" : ""}${s.italic ? "<i/>" : ""}<sz val="${s.size ?? 11}"/>`
          + `<color rgb="FF${(s.color ?? "000000").toUpperCase()}"/><name val="Calibri"/><family val="2"/></font>`);
      }
      let fi = 0;
      if (s.fill) {
        const key = s.fill.toUpperCase();
        if (!fillIdx.has(key)) {
          fillIdx.set(key, fills.length);
          fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${key}"/><bgColor indexed="64"/></patternFill></fill>`);
        }
        fi = fillIdx.get(key)!;
      }
      let bi = 0;
      if (s.border) {
        const c = (s.borderColor ?? "D4D4D8").toUpperCase();
        if (!borderIdx.has(c)) {
          borderIdx.set(c, borders.length);
          const lato = (n: string) => `<${n} style="thin"><color rgb="FF${c}"/></${n}>`;
          borders.push(`<border>${lato("left")}${lato("right")}${lato("top")}${lato("bottom")}<diagonal/></border>`);
        }
        bi = borderIdx.get(c)!;
      }
      const al = (s.align || s.valign || s.wrap)
        ? `<alignment${s.align ? ` horizontal="${s.align}"` : ""}${s.valign ? ` vertical="${s.valign}"` : ""}${s.wrap ? " wrapText=\"1\"" : ""}/>`
        : "";
      xfs.push(`<xf numFmtId="0" fontId="${fontIdx.get(fk)}" fillId="${fi}" borderId="${bi}" xfId="0"`
        + `${fi ? " applyFill=\"1\"" : ""}${bi ? " applyBorder=\"1\"" : ""} applyFont="1"${al ? " applyAlignment=\"1\"" : ""}>${al}</xf>`);
    }

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join("")}</fonts>
<fills count="${fills.length}">${fills.join("")}</fills>
<borders count="${borders.length}">${borders.join("")}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }
}

/* ── Fogli ──────────────────────────────────────────────────────────────── */

export interface Cella {
  v?: string | number | null;
  /** indice restituito da Stili.indice() */
  s?: number;
}
export type Valore = Cella | string | number | null | undefined;

export interface Immagine {
  /** indice nell'elenco passato a scriviXlsx */
  id: number;
  /** cella in alto a sinistra, per esempio "A1" */
  cella: string;
  larghezzaPx: number;
  altezzaPx: number;
  /** spostamento dentro la cella, in pixel */
  offsetPx?: { x: number; y: number };
}

export interface Foglio {
  nome: string;
  /** righe di celle; una riga vuota è un array vuoto */
  righe: Valore[][];
  /** larghezze di colonna in caratteri, in ordine */
  larghezze?: number[];
  /** altezze di riga in punti, per numero di riga (da 1) */
  altezze?: Record<number, number>;
  /** intervalli uniti, per esempio "A1:F1" */
  unioni?: string[];
  /** righe e colonne bloccate in alto a sinistra */
  blocca?: { righe: number; colonne: number };
  immagine?: Immagine;
}

export function lettereColonna(indice0: number): string {
  let n = indice0 + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    /* i caratteri di controllo non sono XML valido, e un nome linea li ha avuti */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function cellaXml(riga: number, col: number, v: Valore): string {
  const ref = `${lettereColonna(col)}${riga}`;
  const c: Cella = (v != null && typeof v === "object") ? v : { v: v as string | number | null };
  const s = c.s != null ? ` s="${c.s}"` : "";
  if (c.v == null || c.v === "") return c.s != null ? `<c r="${ref}"${s}/>` : "";
  if (typeof c.v === "number" && Number.isFinite(c.v)) return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(c.v))}</t></is></c>`;
}

function riferimentoACoordinate(ref: string): { col: number; riga: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) return { col: 0, riga: 0 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, riga: Number(m[2]) - 1 };
}

function foglioXml(f: Foglio, conDisegno: boolean): string {
  const righe: string[] = [];
  f.righe.forEach((r, i) => {
    const n = i + 1;
    const h = f.altezze?.[n];
    const celle = r.map((v, j) => cellaXml(n, j, v)).filter(Boolean).join("");
    if (!celle && h == null) return;
    righe.push(`<row r="${n}"${h != null ? ` ht="${h}" customHeight="1"` : ""}>${celle}</row>`);
  });

  const cols = f.larghezze?.length
    ? `<cols>${f.larghezze.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";

  let pane = "";
  if (f.blocca && (f.blocca.righe > 0 || f.blocca.colonne > 0)) {
    const top = `${lettereColonna(f.blocca.colonne)}${f.blocca.righe + 1}`;
    const attrs = [
      f.blocca.colonne > 0 ? `xSplit="${f.blocca.colonne}"` : "",
      f.blocca.righe > 0 ? `ySplit="${f.blocca.righe}"` : "",
      `topLeftCell="${top}"`, `activePane="bottomRight"`, `state="frozen"`,
    ].filter(Boolean).join(" ");
    pane = `<pane ${attrs}/>`;
  }

  const merges = f.unioni?.length
    ? `<mergeCells count="${f.unioni.length}">${f.unioni.map(u => `<mergeCell ref="${u}"/>`).join("")}</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}
<sheetData>${righe.join("")}</sheetData>
${merges}
${conDisegno ? "<drawing r:id=\"rIdDrawing\"/>" : ""}
</worksheet>`;
}

const EMU_PER_PX = 9525;

function disegnoXml(img: Immagine): string {
  const { col, riga } = riferimentoACoordinate(img.cella);
  const off = img.offsetPx ?? { x: 0, y: 0 };
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:oneCellAnchor>
<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${off.x * EMU_PER_PX}</xdr:colOff><xdr:row>${riga}</xdr:row><xdr:rowOff>${off.y * EMU_PER_PX}</xdr:rowOff></xdr:from>
<xdr:ext cx="${img.larghezzaPx * EMU_PER_PX}" cy="${img.altezzaPx * EMU_PER_PX}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="2" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.larghezzaPx * EMU_PER_PX}" cy="${img.altezzaPx * EMU_PER_PX}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>
</xdr:wsDr>`;
}

/* ── Zip ────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Uno zip con compressione deflate, una voce per file. */
export function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parti: Buffer[] = [];
  const centrale: Buffer[] = [];
  let offset = 0;
  /* Data e ora DOS fisse: un export identico deve dare byte identici. */
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | (1 << 5) | 1;

  for (const f of files) {
    const nome = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const comp = deflateRawSync(f.data, { level: 6 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);       // nomi in UTF-8
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    parti.push(local, nome, comp);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(nome.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE(0, 38);
    c.writeUInt32LE(offset, 42);
    centrale.push(c, nome);
    offset += local.length + nome.length + comp.length;
  }

  const cd = Buffer.concat(centrale);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parti, cd, eocd]);
}

/* ── Il file ────────────────────────────────────────────────────────────── */

export function scriviXlsx(
  fogli: Foglio[], stili: Stili, immagini: Array<{ id: number; png: Buffer }> = [],
): Buffer {
  const files: Array<{ name: string; data: Buffer }> = [];
  const put = (name: string, xml: string | Buffer) => files.push({ name, data: Buffer.isBuffer(xml) ? xml : Buffer.from(xml, "utf8") });

  const overrides: string[] = [];
  const wbRels: string[] = [];
  const sheetsXml: string[] = [];
  let disegni = 0;

  fogli.forEach((f, i) => {
    const n = i + 1;
    const conDisegno = !!f.immagine;
    put(`xl/worksheets/sheet${n}.xml`, foglioXml(f, conDisegno));
    overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbRels.push(`<Relationship Id="rIdSheet${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);
    sheetsXml.push(`<sheet name="${xmlEscape(f.nome.slice(0, 31))}" sheetId="${n}" r:id="rIdSheet${n}"/>`);
    if (f.immagine) {
      disegni++;
      const img = immagini.find(x => x.id === f.immagine!.id);
      if (!img) throw new Error(`immagine ${f.immagine.id} non fornita`);
      put(`xl/worksheets/_rels/sheet${n}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${disegni}.xml"/></Relationships>`);
      put(`xl/drawings/drawing${disegni}.xml`, disegnoXml(f.immagine));
      put(`xl/drawings/_rels/drawing${disegni}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${f.immagine.id}.png"/></Relationships>`);
      overrides.push(`<Override PartName="/xl/drawings/drawing${disegni}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    }
  });
  for (const img of immagini) put(`xl/media/image${img.id}.png`, img.png);

  put("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides.join("\n")}
</Types>`);
  put("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews>
<sheets>${sheetsXml.join("")}</sheets>
</workbook>`);
  put("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${wbRels.join("\n")}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  put("xl/styles.xml", stili.xml());

  return zip(files);
}
