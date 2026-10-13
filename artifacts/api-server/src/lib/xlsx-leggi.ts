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
 *   · XML: niente espressioni regolari che cercano la chiusura di un tag
 *     (`<si>([\s\S]*?)</si>`): con mille aperture e nessuna chiusura costano
 *     il quadrato della lunghezza, e un file di pochi KB ferma il processo.
 *     Gli elementi si scorrono con indexOf, in tempo lineare;
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

/**
 * Gli elementi `<tag …>…</tag>` e `<tag …/>` di un testo XML, in ordine, in
 * tempo lineare. Non gestisce lo stesso tag annidato in sé stesso, che negli
 * elementi letti qui (si, t, r, rPh, row, c, v, is, sheet, Relationship) non
 * c'è. Un tag aperto e mai chiuso è un file rotto.
 */
function* elementi(xml: string, tag: string): Generator<{ attr: string; corpo: string | null }> {
  const apri = `<${tag}`;
  const chiudi = `</${tag}>`;
  let i = 0;
  for (;;) {
    const a = xml.indexOf(apri, i);
    if (a < 0) return;
    const dopo = xml.charCodeAt(a + apri.length);
    /* "<c" non deve prendere "<cols", né "<row" "<rowBreaks" */
    if (!(dopo === 32 || dopo === 62 || dopo === 47 || dopo === 9 || dopo === 10 || dopo === 13)) {
      i = a + apri.length;
      continue;
    }
    const fine = xml.indexOf(">", a);
    if (fine < 0) throw new ErroreXlsx("Il file è danneggiato (tag non chiuso).");
    if (xml.charCodeAt(fine - 1) === 47) {
      yield { attr: xml.slice(a + apri.length, fine - 1), corpo: null };
      i = fine + 1;
      continue;
    }
    const c = xml.indexOf(chiudi, fine + 1);
    if (c < 0) throw new ErroreXlsx("Il file è danneggiato (elemento non chiuso).");
    yield { attr: xml.slice(a + apri.length, fine), corpo: xml.slice(fine + 1, c) };
    i = c + chiudi.length;
  }
}

/** Il contenuto del primo `<tag>` di un testo, o undefined. */
function primo(xml: string, tag: string): string | undefined {
  for (const e of elementi(xml, tag)) return e.corpo ?? "";
  return undefined;
}

/** Il valore di un attributo, letto da un testo di attributi già isolato. */
function attributo(attr: string, nome: string): string | undefined {
  const k = attr.indexOf(` ${nome}="`);
  const j = k >= 0 ? k : attr.search(new RegExp(`(^|\\s)${nome.replace(":", "\\:")}="`));
  if (j < 0) return undefined;
  const inizio = attr.indexOf('"', j) + 1;
  const fine = attr.indexOf('"', inizio);
  return fine < 0 ? undefined : attr.slice(inizio, fine);
}

/** Il testo di un <si> o di un <is>: i <t> diretti e quelli dei run, senza la fonetica. */
function testoRicco(xml: string): string {
  let senzaFonetica = "";
  let i = 0;
  for (;;) {
    const a = xml.indexOf("<rPh", i);
    if (a < 0) { senzaFonetica += xml.slice(i); break; }
    senzaFonetica += xml.slice(i, a);
    const c = xml.indexOf("</rPh>", a);
    if (c < 0) break;
    i = c + 6;
  }
  let out = "";
  for (const t of elementi(senzaFonetica, "t")) out += t.corpo ? decodifica(t.corpo) : "";
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
  let id: string | undefined;
  for (const f of elementi(wb, "sheet")) { id = attributo(f.attr, "r:id") ?? attributo(f.attr, "id"); break; }
  if (!id) return ripiego;
  for (const r of elementi(rels, "Relationship")) {
    const target = attributo(r.attr, "Target");
    if (attributo(r.attr, "Id") === id && target) {
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
  if (ss) for (const si of elementi(ss, "si")) condivise.push(testoRicco(si.corpo ?? ""));

  const foglio = leggiVoce(zip, percorsoPrimoFoglio(zip));
  if (!foglio) throw new ErroreXlsx("Il file non ha fogli.");

  const righe: Array<Array<string | null>> = [];
  let righeLette = 0;
  for (const r of elementi(foglio, "row")) {
    if (++righeLette > LIMITI_XLSX.righe) throw new ErroreXlsx(`Il foglio ha più di ${LIMITI_XLSX.righe} righe.`);
    const numero = Number(attributo(r.attr, "r") ?? righe.length + 1);
    /* un numero di riga enorme allocherebbe righe vuote fino a lì */
    if (!Number.isInteger(numero) || numero < 1 || numero > LIMITI_XLSX.righe) {
      throw new ErroreXlsx(`Il foglio ha più di ${LIMITI_XLSX.righe} righe.`);
    }
    const riga: Array<string | null> = [];
    let colonnaPrecedente = -1;
    for (const c of elementi(r.corpo ?? "", "c")) {
      const rif = attributo(c.attr, "r");
      const col = rif && /^[A-Z]{1,3}\d+$/.test(rif) ? indiceColonna(rif) : colonnaPrecedente + 1;
      colonnaPrecedente = col;
      if (col < 0 || col >= LIMITI_XLSX.colonne) continue;
      const corpo = c.corpo ?? "";
      const tipo = attributo(c.attr, "t") ?? "n";
      const v = corpo ? primo(corpo, "v") : undefined;
      let valore: string | null = null;
      switch (tipo) {
        case "s": valore = v !== undefined ? (condivise[Number(v)] ?? null) : null; break;
        case "inlineStr": valore = testoRicco(primo(corpo, "is") ?? ""); break;
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
