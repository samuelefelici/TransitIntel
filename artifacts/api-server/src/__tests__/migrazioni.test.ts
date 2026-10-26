/* Migrazioni versionate (lib/db/migrations): diario, impronte, baseline e
 * regole del runner. Senza database: le prove su Postgres le fa il job CI
 * migrazioni-postgres. */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESCLUSE, blocchiDelDump, generaBaseline, guardia } from "../../../../lib/db/scripts/baseline.mjs";
import {
  CHIAVE_LUCCHETTO, TRACCIAMENTO, controllaApplicate, daApplicare, descriviErrore, leggiDiario, ritentabile,
} from "../../../../lib/db/scripts/migrazioni-regole.mjs";
import { confronta } from "../../../../lib/db/scripts/catalogo.mjs";
import { ARGOS_LETTURA, RUOLO_ARGOS } from "../../../../lib/db/contratti/argos-lettura.mjs";
import { piano, type StatoPermessi } from "../../../../lib/db/scripts/argos-permessi-regole.mjs";

const LIB_DB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../lib/db");
const CARTELLA = path.join(LIB_DB, "migrations");
const DUMP = path.join(LIB_DB, "schema-produzione/2026-10-25.sql");
const diario = leggiDiario(CARTELLA);
const impronte: Record<string, string> = JSON.parse(readFileSync(path.join(CARTELLA, "meta/impronte.json"), "utf8"));

describe("il diario delle migrazioni", () => {
  it("ogni file .sql ha la sua voce e ogni voce il suo file", () => {
    const file = readdirSync(CARTELLA).filter(f => f.endsWith(".sql")).map(f => f.replace(/\.sql$/, "")).sort();
    expect(diario.map(e => e.tag).sort()).toEqual(file);
  });

  it("idx in sequenza da 0, when crescenti, nomi NNNN_nome, separatori di drizzle", () => {
    diario.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i);
      expect(e.tag).toMatch(/^\d{4}_[a-z0-9_]+$/);
      expect(e.tag.slice(0, 4)).toBe(String(i).padStart(4, "0"));
      expect(e.breakpoints, e.tag).toBe(true);
      if (i > 0) expect(e.when, e.tag).toBeGreaterThan(diario[i - 1]!.when);
    });
  });

  it("le migrazioni rilasciate non cambiano: ognuna ha la sua impronta in meta/impronte.json", () => {
    for (const e of diario) {
      expect(impronte[e.tag], `${e.tag}: aggiungi l'impronta (sha256 del file) in meta/impronte.json`).toBeDefined();
      expect(e.impronta, `${e.tag} è cambiata dopo il rilascio: scrivi una migrazione nuova`).toBe(impronte[e.tag]);
    }
    expect(Object.keys(impronte).sort()).toEqual(diario.map(e => e.tag).sort());
  });

  it("il tracciamento non usa lo schema di default di drizzle, che è di FleetCare", () => {
    expect(TRACCIAMENTO.migrationsSchema).not.toBe("drizzle");
    expect(TRACCIAMENTO.migrationsSchema).toBe("cerbero_migrazioni");
    expect(CHIAVE_LUCCHETTO).not.toBe(7_331_015); // il lucchetto dell'anagrafica
  });
});

describe("0000_baseline", () => {
  const dump = readFileSync(DUMP, "utf8");
  const baseline = readFileSync(path.join(CARTELLA, "0000_baseline.sql"), "utf8");

  it("coincide con quello che genera lo script dal dump: non si modifica a mano", () => {
    expect(baseline).toBe(generaBaseline(dump));
  });

  it("ogni istruzione è dentro un blocco DO che guarda prima il catalogo", () => {
    const parti = baseline.split("--> statement-breakpoint\n");
    expect(parti.length).toBeGreaterThan(500);
    parti.forEach((p, i) => {
      const codice = p.split("\n").filter(r => !r.startsWith("--")).join("\n").trim();
      expect(codice.startsWith("DO $baseline$\nBEGIN\n  IF "), `parte ${i}`).toBe(true);
    });
  });

  it("niente GRANT, OWNER, SET, né le tabelle che non sono di Cerbero", () => {
    const codice = baseline.split("\n").filter(r => !r.startsWith("--")).join("\n");
    expect(codice).not.toMatch(/^\s*(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b/m);
    expect(codice).not.toMatch(/OWNER TO/);
    expect(codice).not.toMatch(/^\s*SET /m);
    for (const t of ESCLUSE) expect(codice).not.toContain(t);
  });

  it("copre tutte le tabelle del dump tranne quelle escluse", () => {
    const tabelle = blocchiDelDump(dump).filter(b => b.tipo === "TABLE").map(b => `${b.schema}.${b.nome}`);
    // il dump del repository è ripulito: niente permessi né tabelle non di Cerbero
    expect(tabelle.length).toBe(133);
    expect(dump).not.toMatch(/^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)\b/m);
    for (const t of ESCLUSE) expect(dump.split("\n").filter(r => !r.startsWith("--")).join("\n")).not.toContain(t);
    for (const t of tabelle.filter(t => !ESCLUSE.includes(t))) {
      expect(baseline, t).toContain(`to_regclass('${t}') IS NULL`);
    }
  });

  it("indici unici e chiavi esterne che i dati non permettono diventano un WARNING", () => {
    const unico = guardia({ nome: "x_uq", tipo: "INDEX", schema: "public", sql: "CREATE UNIQUE INDEX x_uq ON public.x USING btree (a);" })!;
    expect(unico).toContain("to_regclass('public.x_uq') IS NULL");
    expect(unico).toContain("EXCEPTION WHEN unique_violation OR foreign_key_violation");
    const fk = guardia({ nome: "x x_fk", tipo: "FK CONSTRAINT", schema: "public", sql: "ALTER TABLE ONLY public.x\n    ADD CONSTRAINT x_fk FOREIGN KEY (a) REFERENCES public.y(id);" })!;
    expect(fk).toContain("conname = 'x_fk'");
    expect(fk).toContain("EXCEPTION WHEN");
    const semplice = guardia({ nome: "x_i", tipo: "INDEX", schema: "public", sql: "CREATE INDEX x_i ON public.x USING btree (a);" })!;
    expect(semplice).not.toContain("EXCEPTION");
  });

  it("nomi quotati e ON ONLY fermano il generatore: le guardie non li riconoscerebbero", () => {
    expect(() => guardia({ nome: "t c", tipo: "CONSTRAINT", schema: "public", sql: 'ALTER TABLE ONLY public.t\n    ADD CONSTRAINT "T_pkey" PRIMARY KEY (id);' })).toThrow(/quotati/);
    expect(() => guardia({ nome: "i", tipo: "INDEX", schema: "public", sql: "CREATE INDEX i ON ONLY public.p USING btree (a);" })).toThrow(/ON ONLY/);
    // le virgolette dentro un default jsonb non contano
    expect(guardia({ nome: "u", tipo: "TABLE", schema: "public", sql: "CREATE TABLE public.u (\n p jsonb DEFAULT '{\"a\": true}'::jsonb\n);" })).toContain("to_regclass('public.u') IS NULL");
  });

  it("le guardie usano to_regclass(), che non dà errore se la tabella manca", () => {
    const g = guardia({ nome: "t c", tipo: "CONSTRAINT", schema: "public", sql: "ALTER TABLE ONLY public.t\n    ADD CONSTRAINT t_pkey PRIMARY KEY (id);" })!;
    expect(g).toContain("conrelid = to_regclass('public.t')");
    expect(g).not.toContain("::regclass");
  });

  it("un tipo di istruzione che non conosce lo ferma invece di saltarlo", () => {
    expect(() => guardia({ nome: "f", tipo: "FUNCTION", schema: "public", sql: "CREATE FUNCTION f() …" })).toThrow(/non previsto/);
  });
});

describe("le regole del runner", () => {
  const voce = (tag: string, when: number, impronta = "h-" + tag) =>
    ({ idx: 0, version: "7", when, tag, breakpoints: true, impronta });
  const d = [voce("0000_a", 100), voce("0001_b", 200)];

  it("applica solo le voci più recenti dell'ultima riga", () => {
    expect(daApplicare(d, []).map(e => e.tag)).toEqual(["0000_a", "0001_b"]);
    expect(daApplicare(d, [{ hash: "h-0000_a", created_at: "100" }]).map(e => e.tag)).toEqual(["0001_b"]);
    expect(daApplicare(d, [{ hash: "h-0000_a", created_at: 100 }, { hash: "h-0001_b", created_at: 200 }])).toEqual([]);
  });

  it("un file applicato e poi cambiato è un errore", () => {
    const r = controllaApplicate(d, [{ hash: "altro", created_at: 100 }]);
    expect(r.errori).toEqual(["0000_a: il file è cambiato dopo essere stato applicato"]);
  });

  it("una voce non applicata ma più vecchia dell'ultima applicata ferma il migratore (drizzle la salterebbe)", () => {
    const conHotfix = [voce("0000_a", 100), voce("0001_b", 200), voce("0002_hotfix", 300)];
    const r = controllaApplicate(conHotfix, [
      { hash: "h-0000_a", created_at: 100 }, { hash: "h-0001_b", created_at: 200 }, { hash: "h-feature", created_at: 400 },
    ]);
    expect(r.errori).toHaveLength(1);
    expect(r.errori[0]).toMatch(/^0002_hotfix: non è applicata/);
  });

  it("righe più nuove del codice (codice N-1) sono solo un avviso", () => {
    // il database ha già la 0002 di un rilascio successivo, il codice si ferma alla 0001
    const r = controllaApplicate(d, [{ hash: "h-0000_a", created_at: 100 }, { hash: "h-0001_b", created_at: 200 }, { hash: "x", created_at: 300 }]);
    expect(r.errori).toEqual([]);
    expect(r.sconosciute).toEqual([300]);
  });

  it("si riprova solo se una tabella è occupata o due GRANT si incrociano", () => {
    expect(ritentabile({ code: "55P03" })).toBe(true);
    // com'è davvero: drizzle avvolge l'errore di pg e il codice sta in cause
    expect(ritentabile(Object.assign(new Error("Failed query"), { cause: { code: "55P03" } }))).toBe(true);
    expect(ritentabile({ code: "XX000", message: "tuple concurrently updated" })).toBe(true);
    expect(ritentabile({ cause: { code: "XX000", message: "tuple concurrently updated" } })).toBe(true);
    expect(ritentabile({ code: "XX000", message: "could not open file" })).toBe(false);
    expect(ritentabile({ code: "42P01" })).toBe(false);
    expect(ritentabile(null)).toBe(false);
  });

  it("il log di un errore dice il motivo di Postgres, non il testo SQL di drizzle", () => {
    const err = Object.assign(new Error("Failed query: DO $baseline$ … params:"), {
      query: "DO $baseline$\nBEGIN\n  IF to_regclass('caronte.x') IS NULL THEN …",
      cause: { message: 'column "ts" does not exist', code: "42703", hint: "Forse intendevi tsx" },
    });
    const d = descriviErrore(err);
    expect(d.motivo).toBe('column "ts" does not exist (codice 42703) — suggerimento: Forse intendevi tsx');
    expect(d.query.startsWith("DO $baseline$ BEGIN IF to_regclass")).toBe(true);
    expect(descriviErrore(new Error("connect ECONNREFUSED 127.0.0.1:1")).motivo).toBe("connect ECONNREFUSED 127.0.0.1:1");
  });
});

describe("il confronto dei cataloghi", () => {
  it("trova colonne, indici e tabelle diversi", () => {
    const a = { tabelle: { "public.t": { a: "int", b: "text" } }, indici: { "public.i": "CREATE INDEX i" } };
    const b = { tabelle: { "public.t": { a: "int", b: "uuid" }, "public.u": { x: "int" } }, indici: {} };
    expect(confronta(a, b).map(x => x.chiave).sort()).toEqual(["public.i", "public.t.b", "public.u"]);
    expect(confronta(a, a)).toEqual([]);
  });
});

/* Il DDL che l'API esegue da sola deve solo diminuire: ogni modifica nuova
 * dello schema passa da una migrazione in lib/db/migrations. Il conteggio è
 * esatto, commenti esclusi: chi aggiunge DDL fa fallire il test, chi lo toglie
 * abbassa il tetto nella stessa PR. */
const senzaCommenti = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/--[^\n`]*/g, " ");

function sorgentiApi(): string[] {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file: string[] = [];
  const visita = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === "__tests__") continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) visita(p);
      else if (/\.ts$/.test(d.name)) file.push(p);
    }
  };
  visita(src);
  return file;
}

describe("il DDL a runtime può solo scendere", () => {
  const TETTO = { "CREATE TABLE": 85, "ALTER TABLE": 80, "CREATE INDEX": 105 };
  const testo = sorgentiApi().map(f => senzaCommenti(readFileSync(f, "latin1"))).join("\n");
  const conta = (re: RegExp) => (testo.match(re) ?? []).length;

  it("CREATE TABLE, ALTER TABLE e CREATE INDEX: esattamente il tetto", () => {
    const ora = {
      "CREATE TABLE": conta(/CREATE TABLE/g),
      "ALTER TABLE": conta(/ALTER TABLE/g),
      "CREATE INDEX": conta(/CREATE (UNIQUE )?INDEX/g),
    };
    for (const [k, v] of Object.entries(ora)) {
      const tetto = TETTO[k as keyof typeof TETTO];
      expect(v, v > tetto
        ? `${k}: ${v} contro ${tetto}. Lo schema si cambia con una migrazione in lib/db/migrations, non dall'API`
        : `${k}: ${v} contro ${tetto}. Hai tolto DDL dall'API: abbassa il tetto a ${v}`).toBe(tetto);
    }
  });

  it("l'impronta del baseline nel test coincide col file (controllo incrociato)", () => {
    const f = readFileSync(path.join(CARTELLA, "0000_baseline.sql"), "utf8");
    expect(createHash("sha256").update(f).digest("hex")).toBe(impronte["0000_baseline"]);
  });
});

/* Ogni tabella che il codice legge deve esistere nello schema finale delle
 * migrazioni (meta/catalogo.json, eliminazioni comprese), con lo schema giusto
 * (public per i nomi senza schema). È il controllo che avrebbe trovato
 * `ps_clusters`, una tabella rinominata in ps_stop_clusters che una query
 * cercava ancora (500 sul dettaglio fermata di Planning Studio). Guarda i
 * FROM/JOIN maiuscoli, come si scrive l'SQL in questo codice. */
describe("ogni tabella letta dal codice esiste nello schema", () => {
  /** Nomi dopo FROM/JOIN che non sono tabelle: tabelle temporanee, alias, lettere dei template. */
  const NON_TABELLE = new Set(["a", "d", "f", "first_stop", "m_dt", "m_trp"]);
  const catalogo = JSON.parse(readFileSync(path.join(CARTELLA, "meta/catalogo.json"), "utf8"));
  const schema = new Set([...Object.keys(catalogo.tabelle), ...Object.keys(catalogo.viste)]);

  it("nessun FROM/JOIN verso una tabella che non c'è, o nello schema sbagliato", () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const ignote: string[] = [];
    for (const f of sorgentiApi()) {
      const t = senzaCommenti(readFileSync(f, "latin1"));
      const cte = new Set([...t.matchAll(/(?:WITH(?: RECURSIVE)?|,)\s+([a-z_][a-z0-9_]*)\s+AS\s*(?:MATERIALIZED\s*)?\(/g)].map(m => m[1]!));
      for (const m of t.matchAll(/\b(?:FROM|JOIN)\s+(?:(public|caronte)\.)?([a-z_][a-z0-9_]*)\b(\s*\()?/g)) {
        const nome = m[2]!;
        if (m[3] || cte.has(nome) || NON_TABELLE.has(nome) || /^pg_|^information_schema$/.test(nome)) continue;
        if (/(EXTRACT|SUBSTRING|TRIM|OVERLAY|POSITION)\s*\([^()]*$/i.test(t.slice(Math.max(0, m.index! - 40), m.index))) continue;
        const completo = `${m[1] ?? "public"}.${nome}`;
        if (!schema.has(completo)) ignote.push(`${completo} (${path.relative(SRC, f)})`);
      }
    }
    expect(schema.size).toBeGreaterThan(130);
    expect(ignote, "tabella che non esiste nello schema delle migrazioni; se non è una tabella, aggiungila a NON_TABELLE").toEqual([]);
  });
});

/* Argos legge solo le tabelle del contratto (lib/db/contratti/argos-lettura.mjs):
 * il migratore ci riporta i permessi di argos_ro a ogni avvio. */
describe("il contratto di lettura di Argos", () => {
  const contratto = [...ARGOS_LETTURA].sort();
  const catalogo = JSON.parse(readFileSync(path.join(CARTELLA, "meta/catalogo.json"), "utf8"));

  it("23 tabelle schema.tabella, nessun doppione", () => {
    expect(contratto).toHaveLength(23);
    expect(new Set(contratto).size).toBe(contratto.length);
    expect(contratto.filter(t => !/^(public|caronte)\.[a-z0-9_]+$/.test(t))).toEqual([]);
    expect(RUOLO_ARGOS).toBe("argos_ro");
  });

  it("ogni tabella del contratto esiste nello schema delle migrazioni", () => {
    expect(contratto.filter(t => !catalogo.tabelle[t])).toEqual([]);
  });

  it("niente dati personali: né tabelle di utenti, accessi, anagrafica, roster, né colonne personali", () => {
    expect(contratto.filter(t => /\.(users|accessi_|roster_|app_users|anagrafica)/.test(t))).toEqual([]);
    const personale = /(password|mfa|email|phone|telefono|fiscale|matricola|cognome|first_name|last_name|user_agent|segret|secret|token|^pin|_pin|^ip$|_ip$|nascita|birth|indirizzo|address|driver|conducente|autista|user)/i;
    const colonne = contratto.flatMap(t => Object.keys(catalogo.tabelle[t] ?? {}).filter(c => personale.test(c)).map(c => `${t}.${c}`));
    // owner_user_id è un uuid, senza nome né email: serve ad Argos per i programmi di chi chiede
    expect(colonne).toEqual(["public.gtfs_feeds.owner_user_id", "public.ps_projects.owner_user_id"]);
  });
});

/* piano(): da quello che il catalogo dice di argos_ro a cosa fare. Lo stato
 * di partenza è quello di produzione: SELECT su tutto e tabelle future. */
describe("permessi di Argos: il piano", () => {
  const C = ["public.gtfs_stops", "public.ps_trips", "caronte.stop_transits"];
  const sel = (nome: string, extra: Partial<{ tipo: string; privilegio: string; con_opzione: boolean; dato_da: string | null }> = {}) =>
    ({ nome, tipo: "r", privilegio: "SELECT", con_opzione: false, dato_da: null, ...extra });
  const base = (): Required<StatoPermessi> => ({
    ruolo: "argos_ro", esiste: true, superutente: false,
    relazioni: [], colonne: [], concessiDaLui: [], possiede: [], aTutti: [], predefiniti: [],
    schemi: [{ schema: "caronte", uso: true, crea: false, con_opzione: false, tutti_creano: false },
      { schema: "public", uso: true, crea: false, con_opzione: false, tutti_creano: false }],
    membroDi: [], esistenti: [...C],
  });
  const sqls = (s: StatoPermessi) => piano(s, C).azioni.map(a => a.sql);

  it("ruolo assente: niente da fare", () => {
    expect(piano({ ruolo: "argos_ro", esiste: false }, C)).toEqual({ assente: true, azioni: [], avvisi: [], errori: [] });
  });

  it("già in regola: niente da fare, nessuna scrittura", () => {
    const s = base();
    s.relazioni = C.map(t => sel(t));
    expect(piano(s, C)).toEqual({ assente: false, azioni: [], avvisi: [], errori: [] });
  });

  it("come in produzione: toglie le tabelle in più e le future, lascia quelle del contratto", () => {
    const s = base();
    s.relazioni = [...C, "public.users", "public.accessi_log", "caronte.app_users"].map(t => sel(t));
    s.predefiniti = [
      { proprietario: "postgres", schema: "public", tipo: "r", gestibile: true },
      { proprietario: "postgres", schema: "caronte", tipo: "r", gestibile: true },
    ];
    expect(sqls(s)).toEqual([
      'REVOKE ALL ON TABLE "caronte"."app_users" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."accessi_log" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."users" FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "caronte" REVOKE ALL ON TABLES FROM "argos_ro"',
    ]);
  });

  it("permessi di scrittura o con opzione su una tabella del contratto: torna alla sola lettura", () => {
    const s = base();
    s.relazioni = [sel("public.gtfs_stops"), sel("public.gtfs_stops", { privilegio: "INSERT" }),
      sel("public.ps_trips", { con_opzione: true }), sel("caronte.stop_transits")];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'REVOKE ALL ON TABLE "public"."gtfs_stops" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."ps_trips" FROM "argos_ro"',
      'GRANT SELECT ON TABLE "public"."gtfs_stops" TO "argos_ro"',
      'GRANT SELECT ON TABLE "public"."ps_trips" TO "argos_ro"',
    ]);
    expect(p.azioni[2]!.perche).toMatch(/rimessa la sola lettura/);
  });

  it("permessi su colonne e sequenze: si tolgono, anche su una tabella del contratto", () => {
    const s = base();
    s.relazioni = [...C.map(t => sel(t)), sel("public.users_id_seq", { tipo: "S", privilegio: "USAGE" })];
    s.colonne = ["public.users", "public.gtfs_stops"];
    expect(sqls(s)).toEqual([
      'REVOKE ALL ON TABLE "public"."gtfs_stops" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."users" FROM "argos_ro"',
      'REVOKE ALL ON SEQUENCE "public"."users_id_seq" FROM "argos_ro"',
      'GRANT SELECT ON TABLE "public"."gtfs_stops" TO "argos_ro"',
    ]);
  });

  it("manca la lettura o lo schema: la dà; una tabella del contratto che non c'è è un avviso", () => {
    const s = base();
    s.esistenti = ["public.gtfs_stops", "public.ps_trips"];
    s.schemi[0] = { schema: "caronte", uso: false, crea: true, con_opzione: false, tutti_creano: true };
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'GRANT SELECT ON TABLE "public"."gtfs_stops" TO "argos_ro"',
      'GRANT SELECT ON TABLE "public"."ps_trips" TO "argos_ro"',
      'REVOKE CREATE ON SCHEMA "caronte" FROM "argos_ro"',
      'GRANT USAGE ON SCHEMA "caronte" TO "argos_ro"',
    ]);
    expect(p.avvisi).toEqual([
      "caronte.stop_transits è nel contratto ma non esiste",
      "schema caronte: tutti i ruoli ci possono creare tabelle (REVOKE CREATE ON SCHEMA caronte FROM PUBLIC)",
    ]);
  });

  it("permessi di default: di ogni tipo e globali sì; di altri schemi o di ruoli che non posso gestire, solo avviso", () => {
    const s = base();
    s.relazioni = C.map(t => sel(t));
    s.predefiniti = [
      { proprietario: "postgres", schema: null, tipo: "r", gestibile: true },
      { proprietario: "postgres", schema: "public", tipo: "S", gestibile: true },
      { proprietario: "postgres", schema: null, tipo: "T", gestibile: true },
      { proprietario: "postgres", schema: "fleetcare", tipo: "r", gestibile: true },
      { proprietario: "altro", schema: "public", tipo: "f", gestibile: false },
    ];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON TABLES FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON TYPES FROM "argos_ro"',
    ]);
    expect(p.avvisi).toHaveLength(2);
    expect(p.avvisi[0]).toMatch(/fleetcare.*non è di Cerbero/);
    expect(p.avvisi[1]).toMatch(/serve altro o un superutente/);
  });

  it("permessi passati ad altri: quella tabella non si tocca (REVOKE fallirebbe) ed è un errore", () => {
    const s = base();
    s.relazioni = [...C.map(t => sel(t)), sel("public.users", { con_opzione: true })];
    s.concessiDaLui = [{ nome: "public.users", a_chi: "terzo" }];
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([expect.stringMatching(/argos_ro ha passato a terzo permessi su public\.users/)]);
  });

  it("superutente, proprietario, membro di un altro ruolo: errori da sistemare a mano", () => {
    const s = base();
    s.relazioni = C.map(t => sel(t));
    s.superutente = true;
    s.possiede = ["public.zones"];
    s.membroDi = ["pg_read_all_data"];
    s.aTutti = ["public.users", "public.gtfs_stops"];
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toHaveLength(3);
    expect(p.errori.join("\n")).toMatch(/superutente[\s\S]*proprietario di public\.zones[\s\S]*membro di pg_read_all_data/);
    expect(p.avvisi).toEqual([expect.stringMatching(/tutti i ruoli \(GRANT … TO PUBLIC\).*public\.users$/)]);
  });

  it("i nomi vanno tra virgolette", () => {
    const s = base();
    s.relazioni = [...C.map(t => sel(t)), sel('public.a"b')];
    expect(sqls(s)).toEqual(['REVOKE ALL ON TABLE "public"."a""b" FROM "argos_ro"']);
  });
});
