/**
 * Gli elenchi di partenza delle tariffe e l'agenzia dei GTFS (tappa 6.10):
 * categorie, supporti, nodi e agenzia sono dati dell'azienda. Prima erano
 * tre elenchi e una riga di agency.txt nel codice.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agencyTxt, agenziaNelGtfs, aliasDaTesto, campoCsv, erroriCategorie, erroriSupporti, type CategoriaCatalogo } from "../lib/elenchi-tariffe";
import { Agenzia, Categorie, erroreElenco, Supporti } from "../lib/elenchi-tariffe-store";
import { AGENZIA_DI_PROVA, ELENCHI_DI_PRIMA } from "./helpers/elenchi-di-prova";

const AZIENDA = { gtfsAgencyId: "conerobus", ragioneSociale: "Conerobus S.p.A.", sito: "https://www.conerobus.it", telefono: "+39 071 2837411" };

describe("l'agenzia nel GTFS delle tariffe", () => {
  it("con il consorzio nei dati dell'azienda, agency.txt è la riga che era nel codice, byte per byte", () => {
    expect(agencyTxt(agenziaNelGtfs(AZIENDA, AGENZIA_DI_PROVA))).toBe(ELENCHI_DI_PRIMA.agencyTxt);
  });

  it("senza un'agenzia a parte figura l'azienda, e quello che non si sa resta vuoto", () => {
    const a = agenziaNelGtfs(AZIENDA, null);
    expect(a).toEqual({
      agency_id: "conerobus", agency_name: "Conerobus S.p.A.", agency_url: "https://www.conerobus.it", agency_timezone: "Europe/Rome",
      agency_lang: "it", agency_phone: "+39 071 2837411", agency_fare_url: "", agency_email: "", daAzienda: true,
    });
    expect(agencyTxt(a).split("\n")[1]).toBe('"conerobus","Conerobus S.p.A.","https://www.conerobus.it","Europe/Rome","it","+39 071 2837411","",""');
  });

  it("un'azienda non ancora compilata: niente sito né telefono inventati", () => {
    const a = agenziaNelGtfs({ gtfsAgencyId: "azienda", ragioneSociale: "Azienda di trasporto", sito: null, telefono: null }, null);
    expect([a.agency_url, a.agency_phone, a.agency_fare_url, a.agency_email]).toEqual(["", "", "", ""]);
  });

  it("un'agenzia senza telefono, posta e pagina delle tariffe", () => {
    const a = agenziaNelGtfs(AZIENDA, { agencyId: "CONS", nome: 'Consorzio "Uno"', sito: "https://cons.example", telefono: null, email: null, tariffeUrl: null });
    expect([a.agency_id, a.agency_phone, a.agency_fare_url, a.agency_email, a.daAzienda]).toEqual(["CONS", "", "", "", false]);
    /* le virgolette nel nome si raddoppiano */
    expect(agencyTxt(a).split("\n")[1]).toContain('"CONS","Consorzio ""Uno""","https://cons.example"');
  });
});

describe("un campo di un CSV", () => {
  it("fra virgolette solo se ha una virgola, una virgoletta o un a capo", () => {
    expect(campoCsv("Biglietto Cartaceo")).toBe("Biglietto Cartaceo");
    expect(campoCsv("Tessera Regionale (€5,00 primo abb.)")).toBe('"Tessera Regionale (€5,00 primo abb.)"');
    expect(campoCsv('detto "Argento"')).toBe('"detto ""Argento"""');
    expect(campoCsv("due\nrighe")).toBe('"due\nrighe"');
    expect([campoCsv(null), campoCsv(undefined), campoCsv(3)]).toEqual(["", "", "3"]);
  });

  it("due supporti di Conerobus hanno la virgola nel nome: senza virgolette la riga aveva un campo in più", () => {
    const conVirgola = ELENCHI_DI_PRIMA.supporti.filter((s) => s.nome.includes(","));
    expect(conVirgola.map((s) => s.supporto)).toEqual(["tessera_regionale", "tessera_agevolati"]);
    for (const s of conVirgola) {
      expect(`${s.supporto},${s.nome},${s.tipo}`.split(",").length).toBe(4);  // com'era
      expect(campoCsv(s.nome).startsWith('"')).toBe(true);
    }
  });
});

describe("le regole degli elenchi", () => {
  const cat = (categoria: string, predefinita = false): CategoriaCatalogo => ({ categoria, nome: categoria, predefinita, url: null });

  it("categorie: una sola predefinita, nessun doppione; un elenco vuoto va bene", () => {
    expect(erroriCategorie(ELENCHI_DI_PRIMA.categorie)).toEqual([]);
    expect(erroriCategorie([])).toEqual([]);
    expect(erroriCategorie([cat("ordinario"), cat("studente")])[0]).toMatch(/predefinita/);
    expect(erroriCategorie([cat("ordinario", true), cat("studente", true)])).toEqual(["La categoria predefinita è una sola."]);
    expect(erroriCategorie([cat("ordinario", true), cat("ordinario")])).toEqual(["La categoria «ordinario» compare due volte."]);
  });

  it("supporti: nessun doppione", () => {
    expect(erroriSupporti(ELENCHI_DI_PRIMA.supporti)).toEqual([]);
    expect(erroriSupporti([{ supporto: "app", nome: "App", tipo: 4 }, { supporto: "app", nome: "App 2", tipo: 4 }])).toEqual(["Il supporto «app» compare due volte."]);
  });

  it("gli altri nomi di un nodo si leggono da un testo separato da «;»", () => {
    expect(aliasDaTesto("ANCONA STAZIONE; ANCONA CENTRO;")).toEqual(["ANCONA STAZIONE", "ANCONA CENTRO"]);
    expect([aliasDaTesto(""), aliasDaTesto(null)]).toEqual([[], []]);
  });
});

describe("quello che l'amministratore può salvare", () => {
  it("gli elenchi di Conerobus passano, con i loro nomi con «<», «€» e la virgola", () => {
    expect(Categorie.safeParse({ categorie: ELENCHI_DI_PRIMA.categorie }).success).toBe(true);
    expect(Supporti.safeParse({ supporti: ELENCHI_DI_PRIMA.supporti }).success).toBe(true);
    expect(Agenzia.safeParse(AGENZIA_DI_PROVA).success).toBe(true);
  });

  it("i campi facoltativi vuoti diventano «nessuno»", () => {
    const a = Agenzia.parse({ agencyId: "CONS", nome: " Consorzio ", sito: "https://cons.example", telefono: " ", email: "", tariffeUrl: null });
    expect(a).toEqual({ agencyId: "CONS", nome: "Consorzio", sito: "https://cons.example", telefono: null, email: null, tariffeUrl: null });
    expect(Categorie.parse({ categorie: [{ categoria: "ordinario", nome: "Ordinario", predefinita: true, url: "" }] }).categorie[0]!.url).toBeNull();
  });

  it("quello che non va lo dice con la riga", () => {
    const messaggio = (schema: { safeParse: (x: unknown) => any }, corpo: unknown) => { const p = schema.safeParse(corpo); return p.success ? "" : erroreElenco(p.error); };
    expect(messaggio(Categorie, { categorie: [{ categoria: "ordinario", nome: "Ordinario", predefinita: true, url: null }, { categoria: "Studente", nome: "S", predefinita: false, url: null }] }))
      .toMatch(/^Riga 2: identificativo della categoria/);
    expect(messaggio(Supporti, { supporti: [{ supporto: "app", nome: "App", tipo: 7 }] })).toBe("Riga 1: il tipo va da 0 a 4");
    expect(messaggio(Supporti, { supporti: [{ supporto: "app", nome: 'App "nuova"', tipo: 4 }] })).toMatch(/virgolette/);
    expect(messaggio(Agenzia, { ...AGENZIA_DI_PROVA, sito: "atmaancona.it" })).toMatch(/http/);
    expect(messaggio(Agenzia, { ...AGENZIA_DI_PROVA, email: "info" })).toMatch(/posta/);
    expect(messaggio(Agenzia, { ...AGENZIA_DI_PROVA, altro: 1 })).toBe("Campo non previsto: altro");
    expect(messaggio(Categorie, { categorie: [], altro: 1 })).toBe("Campo non previsto: altro");
  });
});

describe("la migrazione 0043 carica nell'installazione di Conerobus gli elenchi di prima", () => {
  const sqlMigrazione = readFileSync(join(__dirname, "../../../../lib/db/migrations/0043_gli_elenchi_delle_tariffe.sql"), "utf8");
  /** Le righe di un blocco VALUES, lette dal testo: stringhe, NULL, veri e falsi, numeri. */
  const righe = (alias: string): unknown[][] => {
    const fine = sqlMigrazione.indexOf(`  ) AS ${alias}(`);
    const blocco = sqlMigrazione.slice(sqlMigrazione.lastIndexOf("  FROM (VALUES", fine) + 14, fine);
    return blocco.split("\n").map((r) => r.trim()).filter((r) => r.startsWith("(")).map((r) =>
      [...r.matchAll(/'((?:[^']|'')*)'|\b(NULL|true|false)\b|(-?\d+(?:\.\d+)?)/g)].map((m) =>
        m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] === "NULL" ? null : m[2] === "true" ? true : m[2] === "false" ? false : Number(m[3])));
  };

  it("le sette categorie, i sette supporti e i quattordici nodi, nell'ordine di prima", () => {
    expect(righe("c")).toEqual(ELENCHI_DI_PRIMA.categorie.map((c, i) => [c.categoria, c.nome, c.predefinita, c.url, (i + 1) * 10]));
    expect(righe("s")).toEqual(ELENCHI_DI_PRIMA.supporti.map((s, i) => [s.supporto, s.nome, s.tipo, (i + 1) * 10]));
    expect(righe("n")).toEqual(ELENCHI_DI_PRIMA.nodi.map((n, i) => [n.codice, n.nome, n.lat, n.lon, n.alias.join(";"), (i + 1) * 10]));
    expect([righe("c").length, righe("s").length, righe("n").length]).toEqual([7, 7, 14]);
  });

  it("l'agenzia è il consorzio, con i dati della riga di prima", () => {
    const a = AGENZIA_DI_PROVA;
    expect(sqlMigrazione).toContain(`SELECT '${a.agencyId}', '${a.nome}', '${a.sito}', '${a.telefono}', '${a.email}',\n       '${a.tariffeUrl}'`);
  });

  it("solo dove l'azienda è Conerobus e solo se l'elenco è vuoto; altrove la sola categoria «ordinario»", () => {
    for (const t of ["categorie_catalogo", "supporti_catalogo", "nodi_catalogo"]) {
      expect(sqlMigrazione, t).toContain(` WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')\n   AND NOT EXISTS (SELECT 1 FROM public.${t});`);
    }
    expect(sqlMigrazione).toContain(" WHERE EXISTS (SELECT 1 FROM public.azienda a WHERE a.gtfs_agency_id = 'conerobus')\nON CONFLICT (unica) DO NOTHING;");
    expect(sqlMigrazione).toContain("SELECT 'ordinario', 'Tariffa ordinaria', true, 10\n WHERE NOT EXISTS (SELECT 1 FROM public.categorie_catalogo);");
  });
});

describe("niente di un'azienda nel codice delle tariffe", () => {
  const SRC = join(__dirname, "..");
  const WEB = join(__dirname, "../../../transitintel/src");
  const sorgenti = (base: string, cartella: string): string[] => readdirSync(join(base, cartella), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__tests__" ? [] : sorgenti(base, join(cartella, e.name)))
      : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(cartella, e.name)] : []);
  const conSegni = (base: string, cartelle: string[], segni: RegExp) =>
    cartelle.flatMap((c) => sorgenti(base, c)).filter((f) => segni.test(readFileSync(join(base, f), "utf8")));

  it("API: né il sito o l'identificativo del consorzio, né gli elenchi di categorie, supporti e nodi", () => {
    const segni = /atmaancona|"ATMA"|"Atma Scpa"|"ATMA Scpa"|ATMA_2013|import-atma|DEFAULT_MEDIA|URBAN_HUB_COLORS|"studente_univpm"|"tessera_regionale"|"FALCONARA_M"/;
    expect(conSegni(SRC, ["lib", "routes"], segni)).toEqual([]);
  });

  it("web: la pagina Tariffe non propone più il sito e la posta del consorzio", () => {
    const segni = /atmaancona|"ATMA Scpa"|import-atma|Import ATMA/;
    expect(conSegni(WEB, ["pages", "components", "lib", "hooks"], segni)).toEqual([]);
  });
});
