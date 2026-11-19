/**
 * L'API non nomina l'azienda né i suoi luoghi (tappa 6.17; per la web c'è lo
 * stesso test dalla 6.14, artifacts/transitintel/src/lib/nomi-di-luogo.test.ts).
 * Quello che decide un calcolo viene dai dati dell'azienda: reti, territorio,
 * nodi di scambio, punti di cambio, impostazioni.
 *
 * Questo test legge i sorgenti dell'API, senza i commenti e senza i test, e
 * cerca i nomi del primo cliente. I pochi posti dove un nome resta sono
 * elencati qui sotto, ognuno col suo motivo e col numero di righe: una riga in
 * più fa fallire il test, e anche una in meno, così l'elenco non resta indietro.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

const NOMI = new RegExp([
  "ancona", "conerobus",
].join("|") + "|" + [
  "\\bATMA\\b", "\\bAtma\\b", "\\batma_", "\\bAdriabus\\b", "\\bMarche\\b",
  "\\b(Jesi|Falconara|Senigallia|Castelfidardo|Sassoferrato|Osimo|Fabriano|Torrette|Tavernelle)\\b",
  "_(jesi|falconara|senigallia|castelfidardo|sassoferrato|osimo)\\b",
].join("|"), "i");

/** Dove un nome resta, perché, e su quante righe. */
const AMMESSI: Record<string, { righe: number; perche: string }> = {
  "lib/anagrafica-prova.ts": { righe: 14, perche: "il generatore dei conducenti di prova, per le demo: comuni e CAP veri della zona" },
  "lib/vetture-azienda.ts": { righe: 1, perche: "perimetro=conerobus nei link salvati prima della tappa 6.5: vale come perimetro=azienda" },
};

function senzaCommenti(testo: string): string {
  return testo
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[ \t])\/\/.*$/gm, "");
}

function sorgenti(cartella: string): string[] {
  return readdirSync(join(SRC, cartella), { withFileTypes: true }).flatMap((e) => {
    const qui = cartella ? `${cartella}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sorgenti(qui);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [qui] : [];
  });
}

describe("nessun nome dell'azienda o dei suoi luoghi nei sorgenti dell'API", () => {
  const trovati = new Map<string, string[]>();
  for (const f of sorgenti("")) {
    const righe = senzaCommenti(readFileSync(join(SRC, f), "utf8")).split("\n")
      .map((riga, i) => ({ riga, n: i + 1 })).filter((x) => NOMI.test(x.riga)).map((x) => `${f}:${x.n}: ${x.riga.trim().slice(0, 140)}`);
    if (righe.length) trovati.set(f, righe);
  }

  it("fuori dai posti ammessi non ce n'è nessuno", () => {
    expect([...trovati].filter(([f]) => !(f in AMMESSI)).flatMap(([, righe]) => righe)).toEqual([]);
  });

  it("nei posti ammessi le righe sono quelle contate, né di più né di meno", () => {
    for (const [f, { righe, perche }] of Object.entries(AMMESSI)) {
      expect(trovati.get(f) ?? [], `${f} (${perche})`).toHaveLength(righe);
    }
  });

  it("la ricerca trova davvero: un nome in una stringa sì, in un commento no", () => {
    expect(NOMI.test(senzaCommenti('const a = "rete Ancona"; // Jesi'))).toBe(true);
    expect(NOMI.test(senzaCommenti("/* le Marche e Falconara */ const b = 1;"))).toBe(false);
    expect(NOMI.test(senzaCommenti('const c = ["urbano_jesi", "flatMap"];'))).toBe(true);
    expect(NOMI.test(senzaCommenti('const d = ["heatmap", "flatMap", "marchetta"];'))).toBe(false);
  });
});

/**
 * Né i nomi dei fornitori del primo cliente (tappa 6.27): il fornitore
 * dell'AVM è un dato dell'azienda (fornitoreAvm, lib/vetture-azienda.ts),
 * l'officina si chiama «officina»; e così il sistema di bigliettazione della
 * regione (tappa 6.28, azienda.bigliettazioneSistema). Maiuscole e confini di parola: i nomi
 * interni come mizarRef o nomeMizar restano, sono codice e non testo.
 */
const FORNITORI = /\b(Mizar|FlashNet|Flashnet|Telemaco)\b/;

describe("nessun nome dei fornitori del primo cliente nei testi dell'API", () => {
  it("fuori dai commenti non ce n'è nessuno", () => {
    const trovati = sorgenti("").flatMap((f) => senzaCommenti(readFileSync(join(SRC, f), "utf8")).split("\n")
      .map((riga, i) => ({ riga, n: i + 1 })).filter((x) => FORNITORI.test(x.riga)).map((x) => `${f}:${x.n}: ${x.riga.trim().slice(0, 140)}`));
    expect(trovati).toEqual([]);
  });

  it("la ricerca trova davvero il nome, non gli identificativi", () => {
    expect(FORNITORI.test('out.push("va chiesto a Mizar")')).toBe(true);
    expect(FORNITORI.test('error: "nodo assente nel catalogo Telemaco"')).toBe(true);
    expect(FORNITORI.test("const { mizarRef, nomeMizar } = x;")).toBe(false);
  });
});

/**
 * Né i suoi luoghi scritti come coordinate (tappa 6.32, come nella web dalla
 * 6.22): l'area di un'azienda si ricava dai luoghi che ha scritto in
 * Amministrazione › Azienda (riquadroDeiCerchi, centroDeiPunti). Resta solo
 * il centro dell'Italia di un'installazione ancora da compilare.
 */
const COORDINATE = /\b(longitude|latitude|lat|lng|lon)\w*\s*(:|[<>]=?|={1,3})\s*-?\d{1,3}\.\d+|["'`]\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+/i;
const COORDINATE_AMMESSE: Record<string, { righe: number; perche: string }> = {
  "lib/azienda.ts": { righe: 1, perche: "il centro dell'Italia, per un'installazione che non ha ancora scritto il suo" },
};

describe("nessuna coordinata scritta a mano nei sorgenti dell'API", () => {
  const trovate = new Map<string, string[]>();
  for (const f of sorgenti("")) {
    const righe = senzaCommenti(readFileSync(join(SRC, f), "utf8")).split("\n")
      .map((riga, i) => ({ riga, n: i + 1 })).filter((x) => COORDINATE.test(x.riga)).map((x) => `${f}:${x.n}: ${x.riga.trim().slice(0, 140)}`);
    if (righe.length) trovate.set(f, righe);
  }

  it("fuori dai posti ammessi non ce n'è nessuna", () => {
    expect([...trovate].filter(([f]) => !(f in COORDINATE_AMMESSE)).flatMap(([, righe]) => righe)).toEqual([]);
  });

  it("nei posti ammessi le righe sono quelle contate", () => {
    for (const [f, { righe, perche }] of Object.entries(COORDINATE_AMMESSE)) {
      expect(trovate.get(f) ?? [], `${f} (${perche})`).toHaveLength(righe);
    }
  });

  it("la ricerca trova un punto, un confronto e un riquadro; non i calcoli", () => {
    expect(COORDINATE.test("const centro = { lat: 44.5, lng: 11.3 };")).toBe(true);
    expect(COORDINATE.test("if (lng < 10.7 || lat > 45.95) continue;")).toBe(true);
    expect(COORDINATE.test('const BBOX = "44.2,10.8,44.95,11.65";')).toBe(true);
    expect(COORDINATE.test("const dLat = km / KM_PER_GRADO_LAT; const lat = a.lat + t * (b.lat - a.lat);")).toBe(false);
    expect(COORDINATE.test("if (lat < riquadro.sud || lng > riquadro.est) continue;")).toBe(false);
  });
});
