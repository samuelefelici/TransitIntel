/**
 * La web non nomina l'azienda né i suoi luoghi (tappa 6.14): quello che si
 * vede viene dai dati scritti in Amministrazione › Azienda (nome, città,
 * regione, reti, territorio), o è un testo che vale per chiunque.
 *
 * Questo test legge i sorgenti, senza i commenti, e cerca i nomi del primo
 * cliente. I pochi posti dove un nome resta sono elencati qui sotto, ognuno
 * col suo motivo e col numero di righe: una riga in più fa fallire il test, e
 * anche una in meno, così l'elenco non resta indietro.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

/** I nomi che non si scrivono: l'azienda, il consorzio, la regione e le città; e gli identificativi delle reti scritti a mano. */
const NOMI = new RegExp([
  "ancona", "conerobus",
].join("|") + "|" + [
  "\\bATMA\\b", "\\bAtma\\b", "\\batma_", "\\bAdriabus\\b", "\\bMarche\\b",
  "\\b(Jesi|Falconara|Senigallia|Castelfidardo|Sassoferrato|Osimo|Fabriano|Torrette|Tavernelle)\\b",
  "_(jesi|falconara|senigallia|castelfidardo|sassoferrato|osimo)\\b",
].join("|"), "i");
/* «i» vale per tutto: le città si cercano anche in minuscolo. Le sigle corte hanno i confini di parola,
   perché «atma» sta dentro «heatmap» e «flatMap». */

/** Dove un nome resta, perché, e su quante righe. */
const AMMESSI: Record<string, { righe: number; perche: string }> = {
  "pages/admin-azienda.tsx": { righe: 4, perche: "gli esempi nelle caselle del modulo dove l'azienda scrive i suoi dati" },
  "lib/territorio.ts": { righe: 1, perche: "il file dei confini comunali incluso nell'app: dice di che provincia è" },
  "lib/elenchi-tariffe.ts": { righe: 1, perche: "«atma_2013»: il valore che i nodi copiati prima della 6.10 hanno nel database" },
  "pages/traffic.tsx": { righe: 2, perche: "le zone del traffico, con le loro coordinate: vanno in tabella con i punti stradali" },
};

/** Il sorgente senza commenti: quelli a blocco (anche dentro il JSX) e quelli a fine riga. Le righe restano dove sono. */
function senzaCommenti(testo: string): string {
  return testo
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[ \t])\/\/.*$/gm, "");
}

function sorgenti(cartella: string): string[] {
  return readdirSync(join(SRC, cartella), { withFileTypes: true }).flatMap((e) => {
    const qui = cartella ? `${cartella}/${e.name}` : e.name;
    if (e.isDirectory()) return sorgenti(qui);
    return /\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [qui] : [];
  });
}

describe("nessun nome dell'azienda o dei suoi luoghi nei sorgenti della web", () => {
  const trovati = new Map<string, string[]>();
  for (const f of sorgenti("")) {
    const righe = senzaCommenti(readFileSync(join(SRC, f), "utf8")).split("\n")
      .map((riga, i) => ({ riga, n: i + 1 })).filter((x) => NOMI.test(x.riga)).map((x) => `${f}:${x.n}: ${x.riga.trim().slice(0, 140)}`);
    if (righe.length) trovati.set(f, righe);
  }

  it("fuori dai posti ammessi non ce n'è nessuno", () => {
    const fuori = [...trovati].filter(([f]) => !(f in AMMESSI)).flatMap(([, righe]) => righe);
    expect(fuori).toEqual([]);
  });

  it("nei posti ammessi le righe sono quelle contate, né di più né di meno", () => {
    for (const [f, { righe, perche }] of Object.entries(AMMESSI)) {
      expect(trovati.get(f) ?? [], `${f} (${perche})`).toHaveLength(righe);
    }
  });

  it("ogni stampa delle polimetriche riceve dalla pagina il nome dell'azienda", () => {
    /* le stampe non hanno un nome loro: senza, scrivono «Trasporto Pubblico Locale» */
    const pagina = readFileSync(join(SRC, "pages/fares.tsx"), "utf8");
    const chiamate = [...pagina.matchAll(/await (?:export|create)Polimetriche\w+\(\{([^}]*)\}\)/g)];
    expect(chiamate).toHaveLength(10);
    for (const c of chiamate) expect(c[1], c[0]).toMatch(/agencyName: (intestazione|nomeAzienda)\b/);
    const stampe = readFileSync(join(SRC, "pages/fares-polimetriche-export.ts"), "utf8");
    expect(stampe.match(/agencyName \|\| SENZA_NOME|agencyName \?\? SENZA_NOME/g)).toHaveLength(4);
  });

  it("la ricerca trova davvero: un nome in una stringa sì, in un commento no", () => {
    expect(NOMI.test(senzaCommenti('const a = "rete Ancona"; // Jesi'))).toBe(true);
    expect(NOMI.test(senzaCommenti('const u = "https://esempio.it/x"; // Conerobus, ATMA'))).toBe(false);
    expect(NOMI.test(senzaCommenti("/* le Marche\n e Falconara */ const b = 1; {/* Osimo */}"))).toBe(false);
    expect(NOMI.test(senzaCommenti('const c = ["urbano_jesi", "heatmap", "flatMap"];'))).toBe(true);
    expect(NOMI.test(senzaCommenti('const d = ["heatmap", "flatMap", "marchetta"];'))).toBe(false);
  });
});
