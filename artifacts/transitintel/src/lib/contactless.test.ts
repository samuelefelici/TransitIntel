/**
 * Il pagamento con carta a bordo (tappa 6.38) nella pagina Azienda: il
 * modulo dalle regole salvate, i controlli prima di salvare, il corpo della
 * richiesta e le frasi. Dati inventati.
 */
import { describe, it, expect } from "vitest";
import { bozzaCambiata, bozzaDa, corpoDa, erroriBozza, riassunto, tariffaInBreve, type Contactless, type ElencoContactless } from "./contactless";

const SALVATE: Contactless = {
  massimaleUnico: 10, finestraOre: 24, supporto: "carta_banca",
  tariffe: [
    { tipo: "urbano", primo: 2, secondo: 2, terzo: 1, validitaMinuti: 60, massimale: 5 },
    { tipo: "extraurbano", primo: 4, secondo: 4, terzo: 2, validitaMinuti: 60, massimale: 10 },
  ],
  reti: ["urbano_lago"],
};
const ELENCO: Pick<ElencoContactless, "retiDisponibili" | "limiti"> = {
  retiDisponibili: [{ rete: "urbano_lago", nome: "Urbano del Lago", tipo: "urbano" }, { rete: "extraurbano", nome: "Extraurbano", tipo: "extraurbano" }],
  limiti: { prezzo: 999.99, validitaMinuti: 1440, finestraOre: 72, reti: 200 },
};
const VUOTE: Contactless = { massimaleUnico: null, finestraOre: 24, supporto: null, tariffe: [], reti: [] };

describe("il pagamento con carta nella pagina Azienda", () => {
  it("il modulo dalle regole salvate torna uguale, e non risulta cambiato", () => {
    const b = bozzaDa(SALVATE);
    expect(b.tariffe.urbano).toEqual({ attiva: true, primo: "2,00", secondo: "2,00", terzo: "1,00", validita: "60", massimale: "5,00" });
    expect(b.massimaleUnico).toBe("10,00");
    expect(erroriBozza(b, ELENCO)).toEqual([]);
    expect(corpoDa(b)).toEqual(SALVATE);
    expect(bozzaCambiata(b, SALVATE)).toBe(false);
    /* «2» e «2,00» sono lo stesso prezzo */
    expect(bozzaCambiata({ ...b, tariffe: { ...b.tariffe, urbano: { ...b.tariffe.urbano, primo: "2" } } }, SALVATE)).toBe(false);
    expect(bozzaCambiata({ ...b, reti: ["urbano_lago", "extraurbano"] }, SALVATE)).toBe(true);
  });

  it("un'installazione nuova: niente tariffe, validità proposta 60 minuti, nessun supporto", () => {
    const b = bozzaDa(VUOTE);
    expect(b.tariffe.extraurbano).toEqual({ attiva: false, primo: "", secondo: "", terzo: "", validita: "60", massimale: "" });
    expect(erroriBozza(b, ELENCO)).toEqual([]);
    expect(corpoDa(b)).toEqual(VUOTE);
    expect(riassunto(VUOTE, ELENCO)).toBe("Il pagamento con carta non è attivo: nel GTFS non c'è.");
  });

  it("quello che non torna si dice prima di salvare", () => {
    const b = bozzaDa(SALVATE);
    const con = (tipo: "urbano" | "extraurbano", parte: object) => erroriBozza({ ...b, tariffe: { ...b.tariffe, [tipo]: { ...b.tariffe[tipo], ...parte } } }, ELENCO);
    expect(con("urbano", { primo: "due" })).toEqual(["Tariffa urbana, primo viaggio: scrivi un prezzo, come «2,00»"]);
    expect(con("urbano", { primo: "0" })).toContain("Tariffa urbana, primo viaggio: maggiore di zero");
    expect(con("urbano", { terzo: "0" })).toEqual([]);
    expect(con("urbano", { secondo: "1,234" })).toEqual(["Tariffa urbana, secondo viaggio: al più due decimali"]);
    expect(con("urbano", { validita: "45,5" })).toEqual(["Tariffa urbana, validità: minuti interi da 1 a 1440"]);
    expect(con("urbano", { massimale: "1,50" })).toEqual(["Tariffa urbana: il massimale è più basso del primo viaggio"]);
    expect(con("urbano", { attiva: false })).toEqual(["La carta è attiva su «Urbano del Lago»: serve la tariffa urbana"]);
    expect(erroriBozza({ ...b, massimaleUnico: "8" }, ELENCO)).toEqual(["Il massimale unico è più basso del massimale della tariffa extraurbana"]);
    expect(erroriBozza({ ...b, massimaleUnico: "" }, ELENCO)).toEqual([]);
    expect(erroriBozza({ ...b, finestraOre: "0" }, ELENCO)).toEqual(["Finestra: ore intere da 1 a 72"]);
    expect(erroriBozza({ ...b, reti: ["urbano_sparito"] }, ELENCO)).toEqual(["La rete «urbano_sparito» non c'è più: ricarica la pagina"]);
    /* una tariffa spenta non si controlla e non si manda */
    const spenta = { ...b, tariffe: { ...b.tariffe, extraurbano: { ...b.tariffe.extraurbano, attiva: false, primo: "x" } } };
    expect(erroriBozza({ ...spenta, massimaleUnico: "" }, ELENCO)).toEqual([]);
    expect(corpoDa(spenta).tariffe.map((t) => t.tipo)).toEqual(["urbano"]);
  });

  it("le frasi: dove vale e la tariffa in una riga", () => {
    expect(riassunto(SALVATE, ELENCO)).toBe("Attivo su Urbano del Lago.");
    expect(riassunto({ ...SALVATE, reti: ["extraurbano", "urbano_lago"] }, ELENCO)).toBe("Attivo su Extraurbano e Urbano del Lago.");
    expect(tariffaInBreve(SALVATE.tariffe[0]!, 24)).toBe("1° viaggio 2,00 € (vale 60 minuti) · 2° 2,00 € · 3° 1,00 € · al massimo 5,00 € in 24 ore");
  });
});
