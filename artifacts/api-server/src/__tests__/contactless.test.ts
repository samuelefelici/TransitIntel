/**
 * Il pagamento con carta a bordo (tappa 6.38): le regole che l'amministratore
 * salva. Dati inventati.
 */
import { describe, it, expect } from "vitest";
import { contactlessAttivo, contactlessPulito, DatiContactless, erroreContactless, erroriContactless, type Contactless } from "../lib/contactless";

const URBANO = { tipo: "urbano" as const, primo: 2, secondo: 2, terzo: 1, validitaMinuti: 60, massimale: 5 };
const EXTRA = { tipo: "extraurbano" as const, primo: 4, secondo: 4, terzo: 2, validitaMinuti: 60, massimale: 10 };
const BUONI = { massimaleUnico: 10, finestraOre: 24, supporto: "carta_banca", tariffe: [EXTRA, URBANO], reti: ["urbano_lago", "extraurbano", "urbano_lago"] };
const RETI: Record<string, { tipo: "urbano" | "extraurbano"; nome: string }> = {
  urbano_lago: { tipo: "urbano", nome: "Urbano del Lago" },
  urbano_colle: { tipo: "urbano", nome: "Urbano del Colle" },
  extraurbano: { tipo: "extraurbano", nome: "Extraurbano" },
};
const reteDi = (r: string) => RETI[r] ?? null;

describe("le regole del pagamento con carta", () => {
  it("si leggono, si puliscono e tornano", () => {
    const p = DatiContactless.safeParse(BUONI);
    expect(p.success).toBe(true);
    const c = contactlessPulito(p.data!);
    expect(c.tariffe.map((t) => t.tipo)).toEqual(["urbano", "extraurbano"]);
    expect(c.reti).toEqual(["extraurbano", "urbano_lago"]);
    expect(erroriContactless(c, reteDi)).toEqual([]);
    expect(contactlessAttivo(c)).toBe(true);
    expect(contactlessAttivo({ ...c, reti: [] })).toBe(false);
    expect(contactlessAttivo(null)).toBe(false);
  });

  it("i prezzi a due decimali, la validità in minuti interi, la finestra fino a 72 ore; niente campi in più", () => {
    const prova = (cambia: Record<string, unknown>) => {
      const p = DatiContactless.safeParse({ ...BUONI, ...cambia });
      return p.success ? "ok" : erroreContactless(p.error);
    };
    expect(prova({ tariffe: [{ ...URBANO, primo: 2.005 }] })).toMatch(/tariffa n\. 1: primo viaggio: al più due decimali/);
    expect(prova({ tariffe: [{ ...URBANO, primo: 0 }] })).toMatch(/primo viaggio: maggiore di zero/);
    expect(prova({ tariffe: [{ ...URBANO, terzo: 0 }] })).toBe("ok");
    expect(prova({ tariffe: [{ ...URBANO, validitaMinuti: 60.5 }] })).toMatch(/validità: un numero intero/);
    expect(prova({ tariffe: [{ ...URBANO, validitaMinuti: 2000 }] })).toMatch(/al più un giorno/);
    expect(prova({ tariffe: [{ ...URBANO, tipo: "metro" }] })).toMatch(/tipo: urbano o extraurbano/);
    expect(prova({ finestraOre: 73 })).toMatch(/finestra: al più 72 ore/);
    expect(prova({ massimaleUnico: null })).toBe("ok");
    expect(prova({ supporto: "Carta Banca" })).toMatch(/supporto/);
    expect(prova({ reti: ["urbano lago"] })).toMatch(/reti/);
    expect(prova({ tariffe: [URBANO, EXTRA, URBANO] })).toMatch(/al più una tariffa per tipo/);
    expect(prova({ colore: "rosso" })).toBe("Campo non previsto: colore");
  });

  it("quello che non torna fra le regole", () => {
    const c = (x: Partial<Contactless>): Contactless => ({ ...contactlessPulito(DatiContactless.parse(BUONI)), ...x });
    expect(erroriContactless(c({ tariffe: [URBANO, URBANO] }), reteDi)[0]).toBe("C'è due volte la tariffa urbana");
    expect(erroriContactless(c({ tariffe: [{ ...URBANO, massimale: 1.5 }, EXTRA] }), reteDi)[0])
      .toBe("Tariffa urbana: il massimale (1,50 €) è più basso del primo viaggio (2,00 €)");
    expect(erroriContactless(c({ massimaleUnico: 8 }), reteDi)[0]).toMatch(/^Il massimale unico \(8,00 €\) è più basso del massimale della tariffa extraurbana \(10,00 €\)/);
    expect(erroriContactless(c({ tariffe: [EXTRA] }), reteDi)).toEqual(["La carta è attiva su «Urbano del Lago», ma manca la tariffa urbana"]);
    expect(erroriContactless(c({ reti: ["urbano_sparito"] }), reteDi)).toEqual(["La rete «urbano_sparito» non c'è più: ricarica la pagina"]);
    /* nessuna rete: la carta non vale da nessuna parte, ed è una scelta ammessa */
    expect(erroriContactless(c({ reti: [], tariffe: [] }), reteDi)).toEqual([]);
  });

  it("i prezzi si arrotondano al centesimo (gli errori della virgola mobile non restano)", () => {
    const c = contactlessPulito(DatiContactless.parse({ ...BUONI, massimaleUnico: 0.1 + 0.2 + 9.7, tariffe: [{ ...URBANO, primo: 1.1 + 0.9000000001 }] }));
    expect([c.massimaleUnico, c.tariffe[0]!.primo]).toEqual([10, 2]);
  });
});
