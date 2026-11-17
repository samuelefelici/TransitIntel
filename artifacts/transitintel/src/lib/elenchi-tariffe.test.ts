import { describe, it, expect } from "vitest";
import {
  bozzaCategorie, bozzaSupporti, cambiato, categoriaNuova, corpoAgenzia, corpoCategorie, corpoSupporti,
  erroriAgenzia, erroriCategorie, erroriSupporti, fonteDelNodo, fraseAgenzia, moduloAgenzia, partenzaFeedInfo,
  supportoNuovo, type AgenziaGtfs, type AgenziaNelGtfs, type CategoriaCatalogo, type SupportoCatalogo,
} from "./elenchi-tariffe";

const CATEGORIE: CategoriaCatalogo[] = [
  { categoria: "ordinario", nome: "Tariffa Ordinaria", predefinita: true, url: null },
  { categoria: "studente", nome: "Studente (14+ anni)", predefinita: false, url: "https://esempio.example/studenti" },
];
const SUPPORTI: SupportoCatalogo[] = [
  { supporto: "contanti", nome: "Pagamento a bordo (contanti/bancomat)", tipo: 0 },
  { supporto: "tessera_regionale", nome: "Tessera Regionale (€5,00 primo abb.)", tipo: 1 },
];
const CONSORZIO: AgenziaGtfs = { agencyId: "CONS", nome: "Consorzio di prova", sito: "https://cons.example", telefono: null, email: "info@cons.example", tariffeUrl: null };
const IN_VIGORE: AgenziaNelGtfs = {
  agency_id: "CONS", agency_name: "Consorzio di prova", agency_url: "https://cons.example", agency_timezone: "Europe/Rome", agency_lang: "it",
  agency_phone: "", agency_fare_url: "", agency_email: "info@cons.example", daAzienda: false,
};

describe("le bozze degli elenchi", () => {
  it("andata e ritorno: quello che è salvato torna uguale", () => {
    expect(corpoCategorie(bozzaCategorie(CATEGORIE))).toEqual({ categorie: CATEGORIE });
    expect(corpoSupporti(bozzaSupporti(SUPPORTI))).toEqual({ supporti: SUPPORTI });
    expect(corpoAgenzia(moduloAgenzia(CONSORZIO))).toEqual(CONSORZIO);
  });

  it("le righe nuove: la prima categoria è la predefinita, e si vede che sono nuove", () => {
    expect(categoriaNuova([])).toEqual({ categoria: "", nome: "", predefinita: true, url: "", nuova: true });
    expect(categoriaNuova(bozzaCategorie(CATEGORIE)).predefinita).toBe(false);
    expect([supportoNuovo().tipo, supportoNuovo().nuova]).toEqual(["1", true]);
    /* la riga nuova non manda «nuova» all'API */
    expect(corpoSupporti([{ ...supportoNuovo(), supporto: "app", nome: "App", tipo: "4" }])).toEqual({ supporti: [{ supporto: "app", nome: "App", tipo: 4 }] });
  });

  it("cambiato: solo se la bozza dice un'altra cosa", () => {
    const b = bozzaCategorie(CATEGORIE);
    expect(cambiato(b, bozzaCategorie(CATEGORIE))).toBe(false);
    expect(cambiato(b.map((r, i) => (i === 1 ? { ...r, nome: "Studente" } : r)), bozzaCategorie(CATEGORIE))).toBe(true);
    expect(cambiato([...b, categoriaNuova(b)], bozzaCategorie(CATEGORIE))).toBe(true);
  });
});

describe("che cosa non va, prima di salvare", () => {
  it("gli elenchi buoni non hanno errori, nemmeno con «<», «€» e la virgola nei nomi", () => {
    expect(erroriCategorie(bozzaCategorie([...CATEGORIE, { categoria: "agevolato", nome: "ISEE < €18.000 (tariffa agevolata)", predefinita: false, url: null }]))).toEqual([]);
    expect(erroriSupporti(bozzaSupporti(SUPPORTI))).toEqual([]);
    expect(erroriAgenzia(moduloAgenzia(CONSORZIO))).toEqual([]);
    expect([erroriCategorie([]), erroriSupporti([])]).toEqual([[], []]);
  });

  it("categorie: identificativo, nome, pagina, doppioni e la predefinita", () => {
    const b = bozzaCategorie(CATEGORIE);
    expect(erroriCategorie([{ ...b[0]!, categoria: "Ordinario" }, b[1]!])[0]).toMatch(/^Riga 1: l'identificativo/);
    expect(erroriCategorie([{ ...b[0]!, nome: " " }, b[1]!])).toEqual(["Riga 1: manca il nome."]);
    expect(erroriCategorie([b[0]!, { ...b[1]!, url: "esempio.example" }])).toEqual(["Riga 2: la pagina comincia con http:// o https://."]);
    expect(erroriCategorie([b[0]!, { ...b[1]!, categoria: "ordinario" }])).toEqual(["La categoria «ordinario» compare due volte."]);
    expect(erroriCategorie(b.map((r) => ({ ...r, predefinita: false })))[0]).toMatch(/^Scegli la categoria predefinita/);
    expect(erroriCategorie(b.map((r) => ({ ...r, predefinita: true })))).toEqual(["La categoria predefinita è una sola."]);
  });

  it("supporti: nome, tipo e doppioni", () => {
    expect(erroriSupporti([{ supporto: "app", nome: 'App "nuova"', tipo: "9" }])).toEqual(["Riga 1: il nome non può contenere virgolette.", "Riga 1: scegli il tipo."]);
    expect(erroriSupporti([{ supporto: "app", nome: "App", tipo: "4" }, { supporto: "app", nome: "App 2", tipo: "4" }])).toEqual(["Il supporto «app» compare due volte."]);
  });

  it("l'agenzia: identificativo, nome e sito ci vogliono; il resto è facoltativo", () => {
    expect(erroriAgenzia(moduloAgenzia(null)).length).toBe(3);
    const m = moduloAgenzia(CONSORZIO);
    expect(erroriAgenzia({ ...m, sito: "cons.example" })).toEqual(["Il sito comincia con http:// o https://."]);
    expect(erroriAgenzia({ ...m, email: "info" })).toEqual(["L'indirizzo di posta non è valido."]);
    expect(erroriAgenzia({ ...m, telefono: "zero71" })).toEqual(["Il telefono ha solo cifre, spazi e + ( ) . / -."]);
    expect(erroriAgenzia({ ...m, tariffeUrl: "tariffe" })).toEqual(["La pagina delle tariffe comincia con http:// o https://."]);
    expect(corpoAgenzia({ ...m, telefono: " ", email: "" })).toEqual({ ...CONSORZIO, telefono: null, email: null });
  });
});

describe("le frasi", () => {
  it("chi figura come agenzia", () => {
    expect(fraseAgenzia(IN_VIGORE)).toBe("Nel GTFS delle tariffe l'agenzia è Consorzio di prova (CONS), non l'azienda.");
    expect(fraseAgenzia({ ...IN_VIGORE, agency_id: "azienda", agency_name: "Azienda S.p.A.", daAzienda: true }))
      .toBe("Nel GTFS delle tariffe l'agenzia è l'azienda: Azienda S.p.A. (azienda).");
  });

  it("i valori di partenza di «Feed Info»: quelli dell'agenzia, vuoti se non si sa", () => {
    expect(partenzaFeedInfo(IN_VIGORE)).toEqual({
      feedPublisherName: "Consorzio di prova", feedPublisherUrl: "https://cons.example", feedContactEmail: "info@cons.example", feedContactUrl: "https://cons.example",
    });
    expect(partenzaFeedInfo(null)).toEqual({ feedPublisherName: "", feedPublisherUrl: "", feedContactEmail: "", feedContactUrl: "" });
  });

  it("da dove viene un nodo del catalogo di un feed", () => {
    expect(["manual", "catalogo", "atma_2013", "regione", null, undefined].map(fonteDelNodo))
      .toEqual(["a mano", "elenco dell'azienda", "elenco dell'azienda", "regione", "—", "—"]);
  });
});
