/**
 * ═══════════════════════════════════════════════════════════════════════════
 * XLSX IN LETTURA, SENZA DIPENDENZE NUOVE — il primo foglio come tabella
 * ───────────────────────────────────────────────────────────────────────────
 * Il rovescio di xlsx-mini: legge un .xlsx (uno zip di XML) e restituisce il
 * primo foglio come righe di testo. Serve all'import dell'anagrafica, dove
 * il file arriva dal gestionale o da un foglio aziendale.
 *
 * Che cosa legge: stringhe condivise (anche a più «run» di formattazione),
 * stringhe inline, numeri, booleani, risultati testuali delle formule, date
 * ISO (t="d"). Le date salvate come numero seriale restano numeri: le
 * converte chi sa che quella colonna è una data (anagrafica-import.ts), perché
 * senza leggere gli stili un numero non dice se è una data.
 *
 * Difese, perché il file arriva da fuori:
 *   · zip: tetto al numero di voci e alla dimensione DECOMPRESSA dichiarata
 *     (lo «zip bomb» si ferma prima di decomprimere);
 *   · XML: nessun parser con DTD. Si leggono solo le entità predefinite e
 *     quelle numeriche, quindi un'entità dichiarata nel file non si espande;
 *   · tetto alle righe e alle colonne.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import AdmZip from "adm-zip";
import { inflateRawSync } from "node:zlib";

export const LIMITI_XLSX = {
  /** voci dello zip */
  voci: 2_000,
  /** byte decompressi, in tutto */
  byteTotali: 80 * 1024 * 1024,
  /** byte decompressi del singolo XML letto */
  byteVoce: 40 * 1024 * 1024,
  righe: 20_000,
  colonne: 400,
};

export class ErroreXlsx extends Error {}

/** Le entità XML: solo le cinque predefinite e i riferimenti numerici. */
function decodifica(s: string): string {
  return s
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
      switch (e) {
        case "lt": return "<";
        case "gt": return ">";
        case "amp": return "&";
        case "quot": return '"';
        case "apos": return "'";
      }
      const n = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    /* Excel scrive i caratteri di controllo come _xHHHH_ */
    .replace(/_x([0-9a-fA-F]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Il testo di un <si> o di un <is>: i <t> diretti e quelli dei run, senza la fonetica. */
function testoRicco(xml: string): string {
  const senzaFonetica = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of senzaFonetica.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += m[1] !== undefined ? decodifica(m[1]) : "";
  }
  return out;
}

/** "AB12" → indice di colonna 0-based (27). */
export function indiceColonna(rif: string): number {
  const lettere = /^[A-Z]+/.exec(rif.toUpperCase())?.[0] ?? "";
  let n = 0;
  for (const ch of lettere) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function leggiVoce(zip: AdmZip, nome: string): string | null {
  const voce = zip.getEntry(nome);
  if (!voce) return null;
  if (voce.header.size > LIMITI_XLSX.byteVoce) {
    throw new ErroreXlsx(`Il file contiene una parte troppo grande (${nome}).`);
  }
  /* Si decomprime qui, con un tetto all'uscita: la dimensione dichiarata
   * nell'intestazione dello zip la scrive chi ha fatto il file. */
  const compressi = voce.getCompressedData();
  if (voce.header.method === 0) return compressi.toString("utf8");
  if (voce.header.method !== 8) throw new ErroreXlsx(`Compressione non supportata (${nome}).`);
  try {
    return inflateRawSync(compressi, { maxOutputLength: LIMITI_XLSX.byteVoce }).toString("utf8");
  } catch (e: any) {
    throw new ErroreXlsx(e?.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError
      ? `Il file contiene una parte troppo grande (${nome}).`
      : `Il file è danneggiato (${nome}).`);
  }
}

/** Il percorso del primo foglio, seguendo workbook.xml e le sue relazioni. */
function percorsoPrimoFoglio(zip: AdmZip): string {
  const ripiego = "xl/worksheets/sheet1.xml";
  const wb = leggiVoce(zip, "xl/workbook.xml");
  const rels = leggiVoce(zip, "xl/_rels/workbook.xml.rels");
  if (!wb || !rels) return ripiego;
  const primo = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1]
    ?? /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb)?.[1];
  if (!primo) return ripiego;
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attr = m[1];
    const id = /\bId="([^"]+)"/.exec(attr)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attr)?.[1];
    if (id === primo && target) {
      const t = decodifica(target);
      return t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`;
    }
  }
  return ripiego;
}

/**
 * Il primo foglio di un .xlsx come matrice di testi. Le celle vuote sono
 * null; le righe vuote in mezzo restano (righe di null), quelle in coda no.
 */
export function leggiXlsx(buf: Buffer): Array<Array<string | null>> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    throw new ErroreXlsx("Il file non è un .xlsx leggibile.");
  }
  const voci = zip.getEntries();
  if (voci.length > LIMITI_XLSX.voci) throw new ErroreXlsx("Il file contiene troppe parti.");
  const totale = voci.reduce((s, v) => s + (v.header.size || 0), 0);
  if (totale > LIMITI_XLSX.byteTotali) throw new ErroreXlsx("Il file decompresso è troppo grande.");

  const condivise: string[] = [];
  const ss = leggiVoce(zip, "xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) condivise.push(testoRicco(m[1] ?? ""));

  const foglio = leggiVoce(zip, percorsoPrimoFoglio(zip));
  if (!foglio) throw new ErroreXlsx("Il file non ha fogli.");

  const righe: Array<Array<string | null>> = [];
  let righeLette = 0;
  for (const r of foglio.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    if (++righeLette > LIMITI_XLSX.righe) throw new ErroreXlsx(`Il foglio ha più di ${LIMITI_XLSX.righe} righe.`);
    const attrRiga = r[1] ?? r[3] ?? "";
    const numero = Number(/\br="(\d+)"/.exec(attrRiga)?.[1] ?? righe.length + 1);
    /* un numero di riga enorme allocherebbe righe vuote fino a lì */
    if (numero > LIMITI_XLSX.righe) throw new ErroreXlsx(`Il foglio ha più di ${LIMITI_XLSX.righe} righe.`);
    const riga: Array<string | null> = [];
    let colonnaPrecedente = -1;
    for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = c[1];
      const corpo = c[2] ?? "";
      const rif = /\br="([A-Z]+\d+)"/.exec(attr)?.[1];
      const col = rif ? indiceColonna(rif) : colonnaPrecedente + 1;
      colonnaPrecedente = col;
      if (col < 0 || col >= LIMITI_XLSX.colonne) continue;
      const tipo = /\bt="([a-zA-Z]+)"/.exec(attr)?.[1] ?? "n";
      const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
      let valore: string | null = null;
      switch (tipo) {
        case "s": valore = v !== undefined ? (condivise[Number(v)] ?? null) : null; break;
        case "inlineStr": valore = testoRicco(/<is>([\s\S]*?)<\/is>/.exec(corpo)?.[1] ?? ""); break;
        case "b": valore = v === "1" ? "VERO" : v === "0" ? "FALSO" : null; break;
        case "e": valore = null; break;
        default: valore = v !== undefined ? decodifica(v) : null;
      }
      if (valore !== null && valore.trim() === "") valore = null;
      while (riga.length < col) riga.push(null);
      riga[col] = valore;
    }
    while (righe.length < numero - 1) righe.push([]);
    righe[numero - 1] = riga;
  }
  while (righe.length && righe[righe.length - 1].every(x => x === null)) righe.pop();
  return righe;
}
