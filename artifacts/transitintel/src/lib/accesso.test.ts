import { describe, it, expect } from "vitest";
import {
  CICLO, LINGUE, TESTI, codiceCompleto, erroreInLingua, linguaIniziale, nomeDiBenvenuto, saluto,
  type Titolo,
} from "./accesso";
import { SEZIONI } from "./navigazione";

/** La forma di un oggetto: le chiavi e la lunghezza degli elenchi, senza i testi. */
function forma(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(forma);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "chiave" ? v : forma(v)]));
  }
  return typeof x;
}

function testi(x: unknown, dove = ""): Array<[string, string]> {
  if (typeof x === "string") return [[dove, x]];
  if (Array.isArray(x)) return x.flatMap((v, i) => testi(v, `${dove}[${i}]`));
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) => testi(v, `${dove}.${k}`));
  return [];
}

describe("la pagina di accesso, in italiano e in inglese", () => {
  it("le due lingue hanno la stessa forma: stesse chiavi, stessi elenchi, stessi moduli", () => {
    expect(forma(TESTI.en)).toEqual(forma(TESTI.it));
  });

  it("nessun testo vuoto", () => {
    for (const l of LINGUE) {
      for (const [dove, t] of testi(TESTI[l])) expect(t.trim(), `${l}${dove}`).not.toBe("");
    }
  });

  it("i titoli delle sezioni sono corti: niente citazioni lunghe sopra le animazioni", () => {
    for (const l of LINGUE) {
      const t = TESTI[l];
      const titoli: Titolo[] = [t.argos.titolo, t.ciclo.titolo, t.moduli.titolo, t.sicurezza.titolo, t.invito.titolo];
      for (const x of titoli) {
        expect(`${x.prima} ${x.evidenza}`.length).toBeLessThanOrEqual(48);
        expect(x.evidenza.endsWith(".")).toBe(true);
      }
      expect(t.eroe.testo.length).toBeLessThanOrEqual(170);
    }
  });

  it("i nomi dei sistemi sono in inglese, uguali nelle due lingue", () => {
    const nomi = (l: "it" | "en") => {
      const t = TESTI[l];
      return [t.eroe.sottotitolo, ...t.nastro, ...t.ciclo.tappe.map((x) => x.titolo), ...t.moduli.elenco.flatMap((m) => [m.titolo, m.sotto]),
        ...t.argos.pilastri.map((p) => p.titolo), ...t.sicurezza.elenco.map((v) => v.titolo)];
    };
    expect(nomi("it")).toEqual(nomi("en"));
    expect(TESTI.it.moduli.elenco.map((m) => m.titolo)).toContain("Operations");
  });

  it("i testi brevi restano brevi e finiscono col punto", () => {
    for (const l of LINGUE) {
      const t = TESTI[l];
      for (const v of [...t.ciclo.tappe, ...t.moduli.elenco, ...t.sicurezza.elenco, ...t.argos.pilastri]) {
        expect(v.titolo.length).toBeGreaterThan(2);
        expect(v.testo.length).toBeLessThanOrEqual(140);
        expect(v.testo.endsWith(".")).toBe(true);
      }
      expect(t.moduli.elenco).toHaveLength(8);
      expect(t.sicurezza.elenco).toHaveLength(4);
      expect(t.argos.pilastri).toHaveLength(4);
      expect(new Set(t.nastro).size).toBe(t.nastro.length);
    }
  });

  it("il ciclo ha sei tappe numerate in ordine", () => {
    expect(CICLO.map((t) => t.numero)).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("le tappe del ciclo sono le sezioni del menu, nello stesso ordine", () => {
    const sezioni = SEZIONI.map((s) => s.titolo.toLowerCase());
    const posizioni = CICLO.slice(0, 5).map((t) => sezioni.indexOf(t.menu.toLowerCase()));
    expect(posizioni.every((p) => p >= 0)).toBe(true);
    expect([...posizioni].sort((a, b) => a - b)).toEqual(posizioni);
    for (const l of LINGUE) expect(TESTI[l].ciclo.tappe.map((t) => t.menu)).toEqual(CICLO.map((t) => t.menu));
  });
});

describe("la lingua", () => {
  it("quella scelta l'ultima volta, se no quella del browser", () => {
    expect(linguaIniziale("en", "it-IT")).toBe("en");
    expect(linguaIniziale("it", "en-US")).toBe("it");
    expect(linguaIniziale(null, "it-IT")).toBe("it");
    expect(linguaIniziale(null, "de-DE")).toBe("en");
    expect(linguaIniziale("fr", "en-GB")).toBe("en");
    expect(linguaIniziale(undefined, undefined)).toBe("it");
  });

  it("in inglese i messaggi dell'accesso si traducono, gli altri restano", () => {
    expect(erroreInLingua("Credenziali non valide", "en")).toBe("Invalid credentials");
    expect(erroreInLingua("Credenziali non valide", "it")).toBe("Credenziali non valide");
    expect(erroreInLingua("Troppi tentativi sbagliati: riprova fra 15 minuti, o chiedi all'amministratore di sbloccare l'account.", "en"))
      .toBe("Too many failed attempts: try again in 15 minutes, or ask the administrator to unlock the account.");
    expect(erroreInLingua("Qualcosa di nuovo", "en")).toBe("Qualcosa di nuovo");
  });
});

describe("il saluto e il codice", () => {
  it("il nome di battesimo, senza le note fra parentesi", () => {
    expect(nomeDiBenvenuto("Ada Amministra", "ada@prova.local")).toBe("Ada");
    expect(nomeDiBenvenuto("Piero (admin) Pianifica", null)).toBe("Piero");
  });

  it("senza nome, la parte più lunga dell'email; senza niente, il saluto senza nome", () => {
    expect(nomeDiBenvenuto(null, "m.bianchini@prova.local")).toBe("Bianchini");
    expect(nomeDiBenvenuto("  ", "sala@prova.local")).toBe("Sala");
    expect(nomeDiBenvenuto(undefined, "")).toBe("");
    expect(saluto("Ada")).toBe("Buon lavoro, Ada");
    expect(saluto("")).toBe("Buon lavoro");
    expect(saluto("Ada", "en")).toBe("Welcome, Ada");
  });

  it("il codice dell'app: sei cifre, lo spazio in mezzo non conta", () => {
    expect(codiceCompleto("123456")).toBe(true);
    expect(codiceCompleto("123 456")).toBe(true);
    expect(codiceCompleto("12345")).toBe(false);
    expect(codiceCompleto("12a456")).toBe(false);
  });
});
