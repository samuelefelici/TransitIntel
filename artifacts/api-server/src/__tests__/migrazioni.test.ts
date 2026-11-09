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
  CHIAVE_LUCCHETTO, TRACCIAMENTO, controllaApplicate, daApplicare, descriviErrore, leggiDiario, ritentabile, statoSchema,
} from "../../../../lib/db/scripts/migrazioni-regole.mjs";
import { DIARIO } from "../../../../lib/db/scripts/diario-incluso.mjs";
import { confronta } from "../../../../lib/db/scripts/catalogo.mjs";
import { ARGOS_LETTURA, ARGOS_VERSIONE, RUOLO_ARGOS } from "../../../../lib/db/contratti/argos-lettura.mjs";
import {
  CONTRATTO, FORMATO, contrattoEffettivo, eseguiAzioni, piano,
  type Effettivo, type StatoPermessi, type Voce,
} from "../../../../lib/db/scripts/argos-permessi-regole.mjs";

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

/* Dalla 0006 (PR 2.8) chi migra è un superutente ma le tabelle sono di
 * cerbero_owner: ogni oggetto nuovo passa subito a lui, e i dati delle tabelle
 * di Cerbero si toccano come lui (lib/db/migrations/README.md, «Chi possiede cosa»).
 * Il registro delle modifiche (schema registro, PR 2.10) è invece di
 * cerbero_registro: tabelle e funzioni passano a lui, ogni sua funzione è tolta
 * a PUBLIC e ogni SECURITY DEFINER ha il search_path fisso. I corpi delle
 * funzioni non contano (un CREATE TABLE lì dentro lo fa la funzione, non la migrazione). */
function controllaProprieta(testo: string): string[] {
  const conCorpi = testo.replace(/--.*$/gm, "");
  const sql = conCorpi.replace(/\bAS\s+\$(\w*)\$[\s\S]*?\$\1\$/g, "AS $corpo$$corpo$");
  const problemi: string[] = [];
  const nome = (n: string) => n.replace(/"/g, "").toLowerCase();
  const proprietarioDi = (o: string) => (o.startsWith("registro.") ? "cerbero_registro" : "cerbero_owner");
  const creati = [...sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi)];
  for (const [, tipo, oggetto] of creati) {
    const o = nome(oggetto!);
    const chi = proprietarioDi(o);
    const passa = [...sql.matchAll(/\bALTER\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?([\w."]+)\s+OWNER\s+TO\s+"?(\w+)"?/gi)]
      .some(([, n, a]) => nome(n!) === o && a!.toLowerCase() === chi);
    if (!passa) problemi.push(`${tipo!.toUpperCase()} ${o} non passa a ${chi}`);
  }
  for (const [, f] of sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(registro\.\w+)\s*\(/gi)) {
    const o = nome(f!);
    if (!new RegExp(`ALTER\\s+FUNCTION\\s+${o.replace(".", "\\.")}\\s*\\([^)]*\\)\\s+OWNER\\s+TO\\s+cerbero_registro`, "i").test(sql)) {
      problemi.push(`FUNCTION ${o} non passa a cerbero_registro`);
    }
    if (!new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${o.replace(".", "\\.")}\\s*\\([^)]*\\)\\s+FROM\\s+PUBLIC`, "i").test(sql)) {
      problemi.push(`FUNCTION ${o} resta eseguibile da PUBLIC`);
    }
  }
  for (const m of conCorpi.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)[\s\S]*?\bAS\s+\$/gi)) {
    if (/SECURITY\s+DEFINER/i.test(m[0]) && !/SET\s+search_path\s*=\s*pg_catalog/i.test(m[0])) {
      problemi.push(`FUNCTION ${nome(m[1]!)} è SECURITY DEFINER senza search_path fisso`);
    }
  }
  if (/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(public|caronte|coda)"?\./i.test(sql)) {
    // come cerbero_owner, guardato dall'esistenza del ruolo, e di nuovo chi migra prima della fine
    // (drizzle registra la migrazione nella stessa transazione, in una tabella che cerbero_owner non scrive)
    const come = /to_regrole\('cerbero_owner'\)\s+IS\s+NOT\s+NULL\s+THEN\s+EXECUTE\s+'SET\s+LOCAL\s+ROLE\s+cerbero_owner'/i.test(sql);
    if (!come) problemi.push("tocca i dati delle tabelle di Cerbero senza passare a cerbero_owner (README, «Chi possiede cosa»)");
    else if (!/RESET\s+ROLE\s*;?\s*$/i.test(sql.trim())) problemi.push("passa a cerbero_owner ma non torna a chi migra con RESET ROLE alla fine");
  }
  return problemi;
}

describe("dalla 0006 gli oggetti nuovi sono di cerbero_owner", () => {
  it("il registro è di cerbero_registro, le sue funzioni non sono di PUBLIC, i corpi non contano", () => {
    const funzione = (corpo = "", extra = "") => `CREATE OR REPLACE FUNCTION registro.f() RETURNS void LANGUAGE plpgsql ${extra} AS $f$
      BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS registro.%I (x int)', 'p'); ${corpo} END $f$;`;
    expect(controllaProprieta(`CREATE TABLE registro.t (x int); ALTER TABLE registro.t OWNER TO cerbero_owner;`))
      .toEqual(["TABLE registro.t non passa a cerbero_registro"]);
    expect(controllaProprieta(`CREATE TABLE registro.t (x int); ALTER TABLE registro.t OWNER TO cerbero_registro;`)).toEqual([]);
    expect(controllaProprieta(funzione())).toEqual(["FUNCTION registro.f non passa a cerbero_registro", "FUNCTION registro.f resta eseguibile da PUBLIC"]);
    const regolare = `${funzione()} ALTER FUNCTION registro.f() OWNER TO cerbero_registro; REVOKE ALL ON FUNCTION registro.f() FROM PUBLIC;`;
    expect(controllaProprieta(regolare)).toEqual([]);
    expect(controllaProprieta(regolare.replace("LANGUAGE plpgsql", "LANGUAGE plpgsql SECURITY DEFINER")))
      .toEqual(["FUNCTION registro.f è SECURITY DEFINER senza search_path fisso"]);
    expect(controllaProprieta(regolare.replace("LANGUAGE plpgsql", "LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp"))).toEqual([]);
  });
  it("la regola riconosce le forme giuste e quelle sbagliate", () => {
    expect(controllaProprieta(`CREATE TABLE IF NOT EXISTS public.nuova (id int);`)).toEqual(["TABLE public.nuova non passa a cerbero_owner"]);
    expect(controllaProprieta(`CREATE TABLE public.nuova (id int);
      DO $$ BEGIN IF to_regrole('cerbero_owner') IS NOT NULL THEN ALTER TABLE public.nuova OWNER TO cerbero_owner; END IF; END $$;`)).toEqual([]);
    expect(controllaProprieta(`DROP VIEW public.ps_variants; CREATE VIEW public.ps_variants AS SELECT 1;`))
      .toEqual(["VIEW public.ps_variants non passa a cerbero_owner"]);
    expect(controllaProprieta(`UPDATE public.users SET x = 1;`)).toEqual(["tocca i dati delle tabelle di Cerbero senza passare a cerbero_owner (README, «Chi possiede cosa»)"]);
    // la forma semplice fa fallire il migratore: drizzle non potrebbe registrare la migrazione
    expect(controllaProprieta(`SET LOCAL ROLE cerbero_owner; UPDATE public.users SET x = 1;`)).toHaveLength(1);
    const giusta = `DO $$ BEGIN
      IF pg_catalog.to_regrole('cerbero_owner') IS NOT NULL THEN EXECUTE 'SET LOCAL ROLE cerbero_owner'; END IF;
    END $$;
    UPDATE public.users SET x = 1;`;
    expect(controllaProprieta(giusta)).toEqual(["passa a cerbero_owner ma non torna a chi migra con RESET ROLE alla fine"]);
    expect(controllaProprieta(`${giusta}\n    RESET ROLE;`)).toEqual([]);
  });
  it.each(diario.filter(e => e.idx >= 6).map(e => e.tag))("%s", (tag) => {
    expect(controllaProprieta(readFileSync(path.join(CARTELLA, `${tag}.sql`), "utf8"))).toEqual([]);
  });
  it("(la regola vale dalla 0006 in poi)", () => {
    expect(diario.length).toBeGreaterThanOrEqual(7);
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

  it("si riprova solo se una tabella è occupata, c'è uno stallo o due GRANT si incrociano", () => {
    expect(ritentabile({ code: "55P03" })).toBe(true);
    // com'è davvero: drizzle avvolge l'errore di pg e il codice sta in cause
    expect(ritentabile(Object.assign(new Error("Failed query"), { cause: { code: "55P03" } }))).toBe(true);
    expect(ritentabile({ code: "40P01" })).toBe(true);
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

describe("la guardia di versione (lo schema rispetto al codice)", () => {
  const d = [{ tag: "0000_a", when: 100 }, { tag: "0001_b", when: 200 }];

  it("ok con esattamente le migrazioni del diario, created_at come testo o numero", () => {
    expect(statoSchema(d, [{ created_at: "100" }, { created_at: 200 }]))
      .toEqual({ stato: "ok", mancanti: [], sconosciute: 0, ultimaDelCodice: "0001_b" });
  });

  it("indietro se ne manca una, anche vecchia, o se il tracciamento è vuoto", () => {
    expect(statoSchema(d, [{ created_at: 100 }])).toMatchObject({ stato: "indietro", mancanti: ["0001_b"] });
    expect(statoSchema(d, [{ created_at: 200 }])).toMatchObject({ stato: "indietro", mancanti: ["0000_a"] });
    expect(statoSchema(d, [])).toMatchObject({ stato: "indietro", mancanti: ["0000_a", "0001_b"] });
    // ne manca una anche se ce n'è una più nuova: resta indietro, non avanti
    expect(statoSchema(d, [{ created_at: 100 }, { created_at: 300 }])).toMatchObject({ stato: "indietro", sconosciute: 1 });
  });

  it("avanti se il database ne ha di più nuove (codice N-1)", () => {
    expect(statoSchema(d, [{ created_at: 100 }, { created_at: 200 }, { created_at: 300 }]))
      .toMatchObject({ stato: "avanti", mancanti: [], sconosciute: 1 });
  });

  it("il diario incorporato nel bundle è quello dei file", () => {
    expect(DIARIO.map(e => ({ idx: e.idx, tag: e.tag, when: e.when })))
      .toEqual(diario.map(e => ({ idx: e.idx, tag: e.tag, when: e.when })));
    expect(statoSchema(DIARIO, diario.map(e => ({ created_at: e.when }))).stato).toBe("ok");
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
  const TETTO = { "CREATE TABLE": 46, "ALTER TABLE": 26, "CREATE INDEX": 45 };
  const testo = sorgentiApi().map(f => senzaCommenti(readFileSync(f, "latin1"))).join("\n");
  const conta = (re: RegExp) => (testo.match(re) ?? []).length;

  it("CREATE TABLE, ALTER TABLE e CREATE INDEX: esattamente il tetto", () => {
    const ora = {
      "CREATE TABLE": conta(/CREATE\s+TABLE/gi),
      "ALTER TABLE": conta(/ALTER\s+TABLE/gi),
      "CREATE INDEX": conta(/CREATE\s+(UNIQUE\s+)?INDEX/gi),
    };
    for (const [k, v] of Object.entries(ora)) {
      const tetto = TETTO[k as keyof typeof TETTO];
      expect(v, v > tetto
        ? `${k}: ${v} contro ${tetto}. Lo schema si cambia con una migrazione in lib/db/migrations, non dall'API`
        : `${k}: ${v} contro ${tetto}. Hai tolto DDL dall'API: abbassa il tetto a ${v}`).toBe(tetto);
    }
  });

  /* PR 2.4: l'avvio e le richieste non toccano più lo schema. Questi file
   * avevano il DDL d'avvio (o, l'ultimo, quello di una richiesta): non deve
   * tornarci. Restano solo le unità pigre (ensure…/assicura…) fino alla 2.16. */
  const SENZA_DDL = [
    "lib/auth.ts", "lib/tenant.ts", "lib/scheduling-projects.ts", "lib/planning-studio.ts",
    "routes/fares-polimetriche.ts", "routes/planning.ts", "routes/fares.ts", "routes/gtfs-upload.ts",
    "routes/fares-node-assignment.ts", "routes/planning-studio-timetables.ts",
  ];
  const DDL = /\b(CREATE|ALTER|DROP)\s+(UNIQUE\s+|UNLOGGED\s+|MATERIALIZED\s+|OR\s+REPLACE\s+)?(TABLE|INDEX|SCHEMA|VIEW|SEQUENCE|TYPE|EXTENSION|FUNCTION|PROCEDURE|TRIGGER|RULE|POLICY)\b|\b(ADD|ALTER|DROP)\s+(COLUMN|CONSTRAINT)\b/gi;
  const ddlNel = (file: string) =>
    senzaCommenti(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", file), "latin1")).match(DDL) ?? [];
  it.each(SENZA_DDL)("%s: senza DDL", (file) => {
    const trovati = ddlNel(file);
    expect(trovati, `${file} cambia lo schema (${trovati.join(", ")}): si fa con una migrazione in lib/db/migrations`).toEqual([]);
  });
  /* I file da cui la PR 2.4 ha tolto il DDL per richiesta hanno ancora un'unità
   * pigra: il loro DDL resta esattamente quello dell'unità (conteggio per file),
   * così non ne torna dentro una richiesta. */
  const SOLO_UNITA_PIGRE: Record<string, number> = {
    "lib/planning-studio-materialize.ts": 3, // ensureMaterializedColumn
    "routes/service-program.ts": 3, // ensureVariantCodeColumn, ensureAgentJobsTable
    "routes/clusters.ts": 3, // ensureClusterFlagColumns
  };
  it.each(Object.entries(SOLO_UNITA_PIGRE))("%s: solo il DDL della sua unità pigra (%i)", (file, n) => {
    const trovati = ddlNel(file);
    expect(trovati.length, `${file}: ${trovati.join(", ")}. Lo schema si cambia con una migrazione in lib/db/migrations`).toBe(n);
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
      // registro: le funzioni del registro delle modifiche (2.10); le sue tabelle l'app non le legge
      for (const m of t.matchAll(/\b(?:FROM|JOIN)\s+(?:(public|caronte|coda|registro)\.)?([a-z_][a-z0-9_]*)\b(\s*\()?/g)) {
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

  it("le tabelle con chi ha fatto che cosa restano fuori: richieste a Mizar, coda dei lavori", () => {
    expect(contratto).not.toContain("caronte.avm_richieste_mizar");
    expect(contratto.filter(t => t.startsWith("coda."))).toEqual([]);
  });

  it("23 tabelle schema.tabella, nessun doppione", () => {
    expect(contratto).toHaveLength(23);
    expect(new Set(contratto).size).toBe(contratto.length);
    expect(contratto.filter(t => !FORMATO.test(t))).toEqual([]);
    expect(RUOLO_ARGOS).toBe("argos_ro");
  });

  it("se cambia l'elenco cambia la versione (argos-lettura.versioni.json)", () => {
    const versioni: Record<string, string> = JSON.parse(
      readFileSync(path.join(LIB_DB, "contratti/argos-lettura.versioni.json"), "utf8"));
    const sha = createHash("sha256").update(contratto.join("\n")).digest("hex");
    expect(Object.keys(versioni), "versioni da 1 ad ARGOS_VERSIONE, senza buchi")
      .toEqual(Array.from({ length: ARGOS_VERSIONE }, (_, i) => String(i + 1)));
    expect(versioni[String(ARGOS_VERSIONE)],
      `l'elenco è cambiato: alza ARGOS_VERSIONE a ${ARGOS_VERSIONE + 1} e aggiungi "${ARGOS_VERSIONE + 1}": "${sha}"`).toBe(sha);
    expect(CONTRATTO).toMatchObject({ nome: "argos_lettura", versione: ARGOS_VERSIONE });
  });

  it("ogni tabella del contratto esiste nello schema delle migrazioni", () => {
    expect(contratto.filter(t => !catalogo.tabelle[t])).toEqual([]);
  });

  it("niente dati personali: né tabelle note (utenti, accessi, anagrafica, roster, passeggeri, audit), né colonne personali", () => {
    const tabelle = /\.(users|accessi_|roster_|app_users|anagrafica|tap_events|journeys$|journey_|gtfs_fare_audit_log|planning_scenario_edits)/;
    expect(contratto.filter(t => tabelle.test(t))).toEqual([]);
    const personale = /(password|mfa|email|phone|telefono|cellulare|fiscale|^cf$|matricola|cognome|first_name|last_name|user_agent|segret|secret|token|^pin|_pin|^ip$|_ip$|nascita|birth|indirizzo|address|residenza|patente|badge|visita|sanitar|driver|conducente|autista|user|ticket_uid|raw_nfc|^actor$|_by$)/i;
    const personali = (t: string) => Object.keys(catalogo.tabelle[t] ?? {}).filter(c => personale.test(c));
    // la regola vede davvero i dati personali che ci sono nello schema
    for (const t of ["public.roster_drivers", "caronte.tap_events", "caronte.journeys", "public.gtfs_fare_audit_log", "public.planning_scenario_edits"]) {
      expect(personali(t).length, t).toBeGreaterThan(0);
    }
    // owner_user_id è un uuid, senza nome né email. Argos non lo usa, ma i
    // permessi sono per tabella e gtfs_feeds e ps_projects gli servono
    expect(contratto.flatMap(t => personali(t).map(c => `${t}.${c}`)))
      .toEqual(["public.gtfs_feeds.owner_user_id", "public.ps_projects.owner_user_id"]);
  });
});

/* piano(): da quello che il catalogo dice di argos_ro a cosa fare. Lo stato
 * di partenza è quello di produzione: SELECT su tutto e tabelle future. */
describe("permessi di Argos: il piano", () => {
  const C = ["public.gtfs_stops", "public.ps_trips", "caronte.stop_transits"];
  const rel = (nome: string) => {
    const i = nome.indexOf(".");
    return { schema: nome.slice(0, i), tabella: nome.slice(i + 1) };
  };
  const voce = (nome: string, extra: Partial<Voce> = {}): Voce => ({
    ...rel(nome), tipo: "r", a_tutti: false, privilegio: "SELECT", con_opzione: false,
    dato_da: null, colonna: false, estensione: false, ...extra,
  });
  const eff = (nome: string, extra: Partial<Effettivo> = {}): Effettivo => ({
    ...rel(nome), tipo: "r", cerbero: true, estensione: false, legge: true, scrive: false, opzione: false, ...extra,
  });
  type Schema = NonNullable<StatoPermessi["schemi"]>[number];
  const schema = (nome: string, extra: Partial<Schema> = {}): Schema => ({
    schema: nome, cerbero: true, uso: true, voci: [], tutti_creano: false,
    crea_eff: false, opzione_eff: false, possiede_via: null, ...extra,
  });
  const acl = (privilegio: string, extra = {}) => ({ privilegio, con_opzione: false, dato_da: null, ...extra });
  const db = (extra = {}) => ({
    nome: "postgres", possiede_via: null, crea_eff: false, connette: true, opzione_eff: false, voci: [], tutti_creano: false, ...extra,
  });
  const def = (extra = {}) => ({ proprietario: "postgres", schema: null, tipo: "r", suo: true, a_tutti: false, del_ruolo: false, a_chi: null, gestibile: true, ...extra });
  const base = (): Required<StatoPermessi> => ({
    ruolo: "argos_ro", esiste: true,
    attributi: { superutente: false, replica: false, bypassrls: false, crearuoli: false, creadb: false, login: true },
    voci: C.map(t => voce(t)), routine: [], concessiDaLui: [], possiede: [], predefiniti: [],
    schemi: [schema("caronte"), schema("public")], database: db(),
    effettivi: C.map(t => eff(t)), altrove: [], definer: [], sistema: [], sistemaScrive: [], esterni: [], esterniUsabili: [],
    mappature: [], parametri: [], largeObject: [], loCompat: { acceso: false, dove: null }, membroDi: [], esistenti: [...C],
  });
  const sqls = (s: StatoPermessi) => piano(s, C).azioni.map(a => a.sql);

  it("ruolo assente: niente da fare", () => {
    expect(piano({ ruolo: "argos_ro", esiste: false }, C)).toEqual({ assente: true, azioni: [], avvisi: [], errori: [] });
  });

  it("già in regola: niente da fare, nessuna scrittura", () => {
    expect(piano(base(), C)).toEqual({ assente: false, azioni: [], avvisi: [], errori: [] });
  });

  it("come in produzione: toglie le tabelle in più e le future, lascia quelle del contratto", () => {
    const s = base();
    for (const t of ["public.users", "public.accessi_log", "caronte.app_users"]) { s.voci.push(voce(t)); s.effettivi.push(eff(t)); }
    s.predefiniti = [def({ schema: "public" }), def({ schema: "caronte" })];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'REVOKE ALL ON TABLE "caronte"."app_users" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."accessi_log" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."users" FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "caronte" REVOKE ALL ON TABLES FROM "argos_ro"',
    ]);
    expect(p.errori).toEqual([]);
  });

  it("scrittura, MAINTAIN o grant option su una tabella del contratto: torna alla sola lettura", () => {
    const s = base();
    s.voci.push(voce("public.gtfs_stops", { privilegio: "MAINTAIN" }));
    s.voci[1] = voce("public.ps_trips", { con_opzione: true });
    s.effettivi[0] = eff("public.gtfs_stops", { scrive: true });
    s.effettivi[1] = eff("public.ps_trips", { opzione: true });
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'REVOKE ALL ON TABLE "public"."gtfs_stops" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."ps_trips" FROM "argos_ro"',
      'GRANT SELECT ON TABLE "public"."gtfs_stops" TO "argos_ro"',
      'GRANT SELECT ON TABLE "public"."ps_trips" TO "argos_ro"',
    ]);
    expect(p.azioni[2]!.perche).toMatch(/rimessa la sola lettura/);
    expect(p.errori).toEqual([]);
  });

  it("permessi su colonne e sequenze: si tolgono; il SELECT su colonne di una tabella del contratto non allarga niente", () => {
    const s = base();
    s.voci.push(voce("public.users", { colonna: true }), voce("public.users_id_seq", { tipo: "S", privilegio: "USAGE" }),
      voce("public.gtfs_stops", { colonna: true }));
    expect(sqls(s)).toEqual([
      'REVOKE ALL ON TABLE "public"."users" FROM "argos_ro"',
      'REVOKE ALL ON SEQUENCE "public"."users_id_seq" FROM "argos_ro"',
    ]);
    // solo SELECT su colonne: si dà quello sulla tabella, una volta sola
    s.voci = s.voci.filter(v => !(v.tabella === "gtfs_stops" && !v.colonna));
    expect(sqls(s)).toContain('GRANT SELECT ON TABLE "public"."gtfs_stops" TO "argos_ro"');
  });

  it("manca la lettura o lo schema: la dà; una tabella del contratto che non c'è (o non è una tabella) è un avviso", () => {
    const s = base();
    // gtfs_stops c'è ma non è leggibile; stop_transits non c'è (quindi nemmeno i suoi permessi)
    s.voci = s.voci.filter(v => v.tabella !== "gtfs_stops" && v.tabella !== "stop_transits");
    s.esistenti = ["public.gtfs_stops", "public.ps_trips"];
    s.schemi[0] = schema("caronte", { uso: false, voci: [acl("CREATE")], crea_eff: true });
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'GRANT SELECT ON TABLE "public"."gtfs_stops" TO "argos_ro"',
      'GRANT USAGE ON SCHEMA "caronte" TO "argos_ro"',
      'REVOKE CREATE ON SCHEMA "caronte" FROM "argos_ro"',
    ]);
    expect(p.avvisi).toEqual(["caronte.stop_transits è nel contratto ma non esiste, o non è una tabella"]);
  });

  it("permessi di default: di ogni tipo e globali sì; non gestibili è errore; in altri schemi si tolgono; a PUBLIC errore", () => {
    const s = base();
    s.predefiniti = [
      def(), def({ schema: "public", tipo: "S" }), def({ tipo: "T" }), def({ schema: "fleetcare" }),
      def({ proprietario: "altro", schema: "public", tipo: "f", gestibile: false }),
      def({ proprietario: "altro", suo: false, a_tutti: true }), def({ tipo: "T", suo: false, a_tutti: true }),
    ];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON TABLES FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON TYPES FROM "argos_ro"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "fleetcare" REVOKE ALL ON TABLES FROM "argos_ro"',
    ]);
    expect(p.errori).toEqual([
      expect.stringMatching(/servono i diritti di altro/),
      expect.stringMatching(/di altro in tutti gli schemi \(TABLES\).*PUBLIC.*FOR ROLE "altro" REVOKE ALL ON TABLES FROM PUBLIC/),
    ]);
  });

  it("permessi di default del ruolo stesso: errore col comando giusto, nessun REVOKE inutile", () => {
    const s = base();
    s.predefiniti = [def({ proprietario: "argos_ro", del_ruolo: true, suo: true, a_chi: ["terzo"] })];
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([expect.stringContaining('ALTER DEFAULT PRIVILEGES FOR ROLE "argos_ro" REVOKE ALL ON TABLES FROM "terzo"')]);
  });

  it("PUBLIC: errore col REVOKE esatto, mai un'azione; il SELECT su una tabella del contratto va bene; estensioni avviso", () => {
    const s = base();
    s.voci.push(
      voce("public.users", { a_tutti: true, colonna: true }),
      voce("public.zones", { a_tutti: true, dato_da: "argos_ro" }),
      voce("public.gtfs_stops", { a_tutti: true }),
      voce("public.gtfs_stops", { a_tutti: true, privilegio: "INSERT" }),
      voce("public.accessi_log_id_seq", { a_tutti: true, tipo: "S", privilegio: "USAGE" }),
      voce("public.spatial_ref_sys", { a_tutti: true, estensione: true }),
    );
    s.effettivi.push(eff("public.users"), eff("public.accessi_log_id_seq", { tipo: "S" }), eff("public.spatial_ref_sys", { estensione: true }));
    s.effettivi[0] = eff("public.gtfs_stops", { scrive: true });
    s.schemi[1] = schema("public", { tutti_creano: true, crea_eff: true });
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([
      expect.stringContaining('REVOKE ALL ON SEQUENCE "public"."accessi_log_id_seq" FROM PUBLIC'),
      expect.stringContaining('REVOKE INSERT ON TABLE "public"."gtfs_stops" FROM PUBLIC'),
      expect.stringContaining('REVOKE ALL ON TABLE "public"."users" FROM PUBLIC'),
      expect.stringContaining('REVOKE CREATE ON SCHEMA "public" FROM PUBLIC'),
    ]);
    expect(p.avvisi).toEqual([expect.stringMatching(/spatial_ref_sys.*estensione/)]);
  });

  it("permessi passati ad altri, su tabelle, routine e schemi: non si toccano (REVOKE fallirebbe), errore col CASCADE", () => {
    const s = base();
    s.voci.push(voce("public.users", { con_opzione: true }));
    s.effettivi.push(eff("public.users", { opzione: true }));
    s.schemi[0] = schema("caronte", { voci: [acl("USAGE", { con_opzione: true })], opzione_eff: true });
    s.concessiDaLui = [
      { genere: "relazione", tipo: "r", schema: "public", tabella: "users", argomenti: null, a_chi: "terzo" },
      { genere: "relazione", tipo: "r", schema: "public", tabella: "users", argomenti: null, a_chi: "PUBLIC" },
      { genere: "schema", tipo: null, schema: "caronte", tabella: null, argomenti: null, a_chi: "terzo" },
      { genere: "routine", tipo: null, schema: "public", tabella: "conta", argomenti: "integer", a_chi: "terzo" },
      { genere: "database", tipo: null, schema: "postgres", tabella: null, argomenti: null, a_chi: "terzo" },
      { genere: "parametro", tipo: null, schema: "work_mem", tabella: null, argomenti: null, a_chi: "terzo" },
      { genere: "largeobject", tipo: null, schema: null, tabella: "4242", argomenti: null, a_chi: "terzo" },
    ];
    s.routine = [{ schema: "public", nome: "conta", argomenti: "integer", privilegio: "EXECUTE", con_opzione: true, dato_da: null }];
    s.database = db({ voci: [acl("TEMPORARY", { con_opzione: true })], opzione_eff: true });
    s.parametri = [{ nome: "work_mem", a_tutti: false, privilegio: "SET", dato_da: null }];
    s.largeObject = [{ oid: "4242", a_tutti: false, privilegio: "SELECT", con_opzione: true, dato_da: null }];
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([
      expect.stringContaining('a terzo, PUBLIC permessi su public.users: toglili insieme ai suoi (REVOKE GRANT OPTION FOR ALL ON TABLE "public"."users" FROM "argos_ro" CASCADE)'),
      expect.stringContaining('REVOKE GRANT OPTION FOR ALL ON SCHEMA "caronte" FROM "argos_ro" CASCADE'),
      expect.stringContaining('REVOKE GRANT OPTION FOR ALL ON ROUTINE "public"."conta"(integer) FROM "argos_ro" CASCADE'),
      expect.stringContaining('REVOKE GRANT OPTION FOR ALL ON DATABASE "postgres" FROM "argos_ro" CASCADE'),
      expect.stringContaining('REVOKE GRANT OPTION FOR ALL ON PARAMETER "work_mem" FROM "argos_ro" CASCADE'),
      expect.stringContaining('REVOKE GRANT OPTION FOR ALL ON LARGE OBJECT 4242 FROM "argos_ro" CASCADE'),
    ]);
  });

  it("permessi dati da un ruolo diverso dal proprietario, su tabelle, schemi e database: errore con SET ROLE, nessun REVOKE inutile", () => {
    const s = base();
    s.voci.push(voce("public.depots", { dato_da: "terzo" }));
    s.effettivi.push(eff("public.depots"));
    s.schemi[0] = schema("caronte", { voci: [acl("USAGE"), acl("CREATE", { dato_da: "terzo" })], crea_eff: true });
    s.database = db({ voci: [acl("CREATE", { dato_da: "terzo" })], crea_eff: true });
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([
      expect.stringContaining('SET ROLE "terzo"; REVOKE ALL ON TABLE "public"."depots" FROM "argos_ro"; RESET ROLE;'),
      expect.stringContaining('SET ROLE "terzo"; REVOKE ALL ON SCHEMA "caronte" FROM "argos_ro"; RESET ROLE;'),
      expect.stringContaining('SET ROLE "terzo"; REVOKE ALL ON DATABASE "postgres" FROM "argos_ro"; RESET ROLE;'),
    ]);
  });

  it("superutente, attributi, proprietà, appartenenze: errori; quello che ne deriva in una riga sola", () => {
    const s = base();
    s.attributi = { superutente: true, replica: true, bypassrls: false, crearuoli: false, creadb: true, login: false };
    s.possiede = [{ oggetto: "table public.zones", schema: "public", tabella: "zones" }];
    s.membroDi = [{ ruolo: "pg_read_all_data", da: "postgres", da_superutente: true }];
    s.effettivi.push(eff("public.zones", { scrive: true }), eff("public.users"), eff("public.roster_entries"));
    s.sistema = [{ genere: "relazione", schema: "pg_catalog", nome: "pg_authid", argomenti: null }];
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([
      expect.stringMatching(/superutente/),
      expect.stringMatching(/REPLICATION.*NOREPLICATION/),
      expect.stringMatching(/CREATEDB.*NOCREATEDB/),
      expect.stringMatching(/proprietario di table public\.zones.*REASSIGN OWNED BY "argos_ro"/),
      'argos_ro è membro di pg_read_all_data: può tutto quello che può quel ruolo, fuori dal contratto (REVOKE "pg_read_all_data" FROM "argos_ro")',
      "per i motivi qui sopra argos_ro può anche: public.users (legge), public.roster_entries (legge)",
    ]);
    expect(p.avvisi).toEqual([expect.stringMatching(/NOLOGIN/)]);
  });

  it("appartenenza concessa da un ruolo che non è superutente: REVOKE … GRANTED BY", () => {
    const s = base();
    s.membroDi = [{ ruolo: "pg_read_all_data", da: "amministra", da_superutente: false }];
    expect(piano(s, C).errori).toEqual([expect.stringContaining('REVOKE "pg_read_all_data" FROM "argos_ro" GRANTED BY "amministra"')]);
  });

  it("proprietario di uno schema, del database o di una tabella: errore, e niente REVOKE né CASCADE su quello che possiede", () => {
    const s = base();
    s.schemi[0] = schema("caronte", { possiede_via: "argos_ro", voci: [acl("CREATE")], crea_eff: true });
    s.possiede = [{ oggetto: "schema caronte", schema: null, tabella: null }, { oggetto: "table public.depots", schema: "public", tabella: "depots" }];
    s.concessiDaLui = [{ genere: "relazione", tipo: "r", schema: "public", tabella: "depots", argomenti: null, a_chi: "fleetcare_app" }];
    expect(sqls(s)).toEqual([]);
    expect(piano(s, C).errori).toEqual([expect.stringMatching(/proprietario di schema caronte, table public\.depots/)]);
    const d = base();
    d.database = db({ nome: "prod", possiede_via: "argos_ro", crea_eff: true, voci: [acl("CREATE")] });
    d.possiede = [{ oggetto: "database prod", schema: null, tabella: null }];
    d.schemi[1] = schema("public", { possiede_via: "pg_database_owner", crea_eff: true });
    expect(sqls(d)).toEqual([]);
    expect(piano(d, C).errori).toEqual([expect.stringMatching(/proprietario di database prod/)]);
  });

  it("routine: i permessi dati dal proprietario si tolgono, quelli di un terzo sono un errore", () => {
    const s = base();
    s.routine = [
      { schema: "pg_catalog", nome: "pg_read_binary_file", argomenti: "text", privilegio: "EXECUTE", con_opzione: false, dato_da: null },
      { schema: "public", nome: "conta", argomenti: "a integer", privilegio: "EXECUTE", con_opzione: false, dato_da: "terzo" },
    ];
    s.sistema = [{ genere: "routine", schema: "pg_catalog", nome: "pg_read_binary_file", argomenti: "text" }];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual(['REVOKE ALL ON ROUTINE "pg_catalog"."pg_read_binary_file"(text) FROM "argos_ro"']);
    expect(p.errori).toEqual([expect.stringContaining('SET ROLE "terzo"; REVOKE ALL ON ROUTINE "public"."conta"(a integer) FROM "argos_ro"; RESET ROLE;')]);
  });

  it("SECURITY DEFINER che argos_ro fa girare (EXECUTE, aggregato, event trigger): errore; di un'estensione: avviso", () => {
    const s = base();
    type Definer = NonNullable<StatoPermessi["definer"]>[number];
    const def2 = (extra: Partial<Definer> & { nome: string }): Definer => ({
      schema: "public", argomenti: "", estensione: false, di_tutti: true, eseguibile: true, via_aggregati: null, via_eventi: null,
      via_oggetti: null, via_cast: false, ...extra,
    });
    s.definer = [
      def2({ nome: "svuota" }),
      def2({ nome: "di_postgis", estensione: true }),
      def2({ nome: "passo", argomenti: "text, text", di_tutti: false, eseguibile: false, via_aggregati: "public.agg(text)" }),
      def2({ nome: "registra", di_tutti: false, eseguibile: false, via_eventi: "registra_ddl" }),
      def2({ nome: "confronta", argomenti: "integer, integer", di_tutti: false, eseguibile: false, via_oggetti: "function 1 (integer, integer) of operator family x for access method btree" }),
      def2({ nome: "firma", argomenti: "record", di_tutti: false, eseguibile: false, via_cast: true }),
    ];
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([
      expect.stringContaining('REVOKE EXECUTE ON ROUTINE "public"."svuota"() FROM PUBLIC'),
      expect.stringMatching(/public\.passo\(text, text\).*aggregato public\.agg\(text\).*togliere l'EXECUTE alla funzione non basta/),
      expect.stringMatching(/public\.registra\(\).*event trigger registra_ddl/),
      expect.stringMatching(/public\.confronta\(integer, integer\).*operator family x.*senza controllare l'EXECUTE.*SECURITY INVOKER/),
      expect.stringMatching(/public\.firma\(record\).*cast creato da lui.*SECURITY INVOKER/),
    ]);
    expect(p.avvisi).toEqual([expect.stringMatching(/di_postgis.*estensione/)]);
  });

  it("oggetti di sistema riservati usabili senza un permesso diretto: errore", () => {
    const s = base();
    s.sistema = [{ genere: "relazione", schema: "pg_catalog", nome: "pg_authid", argomenti: null }];
    expect(piano(s, C).errori).toEqual([expect.stringMatching(/oggetti di sistema riservati.*pg_catalog\.pg_authid/)]);
  });

  it("parametri: quelli dati al ruolo si tolgono, quelli dati a tutti sono un errore", () => {
    const s = base();
    s.parametri = [
      { nome: "session_replication_role", a_tutti: false, privilegio: "SET", dato_da: null },
      { nome: "log_min_messages", a_tutti: true, privilegio: "ALTER SYSTEM", dato_da: null },
    ];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual(['REVOKE ALL ON PARAMETER "session_replication_role" FROM "argos_ro"']);
    expect(p.errori).toEqual([expect.stringContaining('REVOKE ALTER SYSTEM ON PARAMETER "log_min_messages" FROM PUBLIC')]);
  });

  it("parametro concesso da un terzo: errore con SET ROLE, nessun REVOKE inutile", () => {
    const s = base();
    s.parametri = [{ nome: "work_mem", a_tutti: false, privilegio: "SET", dato_da: "terzo" }];
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([expect.stringContaining('SET ROLE "terzo"; REVOKE ALL ON PARAMETER "work_mem" FROM "argos_ro"; RESET ROLE;')]);
  });

  it("schemi non di Cerbero: i permessi diretti si tolgono; scrivere è un errore, e anche leggere quello che è di tutti", () => {
    const s = base();
    s.schemi.push(schema("fleetcare", { cerbero: false, uso: true, voci: [acl("USAGE"), acl("CREATE")], crea_eff: true }));
    s.voci.push(voce("fleetcare.profiles", { privilegio: "INSERT" }));
    s.schemi.push(schema("rep", { cerbero: false, uso: true }));
    s.altrove = [
      eff("fleetcare.profiles", { cerbero: false, legge: false, scrive: true }),
      // anche senza USAGE sullo schema, pg_stats mostra i valori: conta comunque
      eff("fleetcare.letta", { cerbero: false }),
      eff("fleetcare.scrivibile", { cerbero: false, legge: false, scrive: true }),
      // lette grazie a PUBLIC (USAGE e SELECT di tutti)
      eff("rep.pubblica", { cerbero: false }),
      eff("rep.vista_utenti", { cerbero: false, tipo: "v" }),
      eff("postgis.spatial_ref_sys", { cerbero: false, estensione: true }),
    ];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'REVOKE ALL ON TABLE "fleetcare"."profiles" FROM "argos_ro"',
      'REVOKE ALL ON SCHEMA "fleetcare" FROM "argos_ro"',
    ]);
    expect(p.errori).toEqual([
      expect.stringMatching(/^fleetcare\.scrivibile: argos_ro scrive/),
      expect.stringMatching(/^schema fleetcare: argos_ro legge letta, perché sono date a tutti/),
      expect.stringMatching(/^schema rep: argos_ro legge pubblica, vista_utenti, perché sono date a tutti i ruoli \(PUBLIC\).*pg_stats.*REVOKE SELECT ON ALL TABLES IN SCHEMA "rep" FROM PUBLIC\..*SET ROLE <ruolo>; REVOKE SELECT ON … FROM PUBLIC; RESET ROLE;$/),
    ]);
    expect(p.avvisi).toEqual([expect.stringMatching(/postgis\.spatial_ref_sys.*estensione/)]);
  });

  it("letture date a tutti in uno schema di sistema: la cura è per oggetto, mai «ALL TABLES»", () => {
    const s = base();
    s.altrove = [eff("information_schema.sql_parts", { cerbero: false }), eff("pg_catalog.pg_class_copia", { cerbero: false })];
    const err = piano(s, C).errori;
    expect(err).toEqual([
      expect.stringContaining('REVOKE SELECT ON TABLE "information_schema"."sql_parts" FROM PUBLIC'),
      expect.stringContaining('REVOKE SELECT ON TABLE "pg_catalog"."pg_class_copia" FROM PUBLIC'),
    ]);
    expect(err.join(" ")).not.toMatch(/ALL TABLES IN SCHEMA/);
    // information_schema ricreato: le viste standard non si tolgono, solo gli oggetti in più
    expect(err[0]).toMatch(/togli solo gli oggetti che information_schema\.sql non crea/);
    expect(err[1]).not.toMatch(/information_schema\.sql/);
  });

  it("permessi effettivi che nessuna voce spiega: errore (il riallineamento non può dire «in regola»)", () => {
    const s = base();
    s.effettivi.push(eff("public.users"), eff("public.zones", { legge: false, scrive: true }));
    s.schemi[1] = schema("public", { crea_eff: true });
    s.database = db({ crea_eff: true });
    const p = piano(s, C);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([
      expect.stringMatching(/schema public: argos_ro ci può creare oggetti, e non lo spiegano/),
      expect.stringMatching(/database postgres: argos_ro ci può creare schemi, e non lo spiegano/),
      expect.stringMatching(/^public\.users: argos_ro legge, e non lo spiegano/),
      expect.stringMatching(/^public\.zones: argos_ro scrive, e non lo spiegano/),
    ]);
  });

  it("CREATE e grant option sul database dati dal proprietario: si tolgono", () => {
    const s = base();
    s.database = db({ voci: [acl("CREATE"), acl("CONNECT", { con_opzione: true })], crea_eff: true, opzione_eff: true });
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual([
      'REVOKE CREATE ON DATABASE "postgres" FROM "argos_ro"',
      'REVOKE GRANT OPTION FOR ALL ON DATABASE "postgres" FROM "argos_ro"',
    ]);
    expect(p.errori).toEqual([]);
  });

  it("large object: quelli dati dal proprietario si tolgono, da un terzo o a tutti sono errori; lo_compat_privileges errore", () => {
    const s = base();
    s.largeObject = [
      { oid: "101", a_tutti: false, privilegio: "SELECT", con_opzione: false, dato_da: null },
      { oid: "101", a_tutti: false, privilegio: "UPDATE", con_opzione: false, dato_da: null },
      { oid: "102", a_tutti: false, privilegio: "SELECT", con_opzione: false, dato_da: "terzo" },
      { oid: "103", a_tutti: true, privilegio: "SELECT", con_opzione: false, dato_da: null },
    ];
    s.loCompat = { acceso: true, dove: 2 };
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual(['REVOKE ALL ON LARGE OBJECT 101 FROM "argos_ro"']);
    expect(p.errori).toEqual([
      expect.stringMatching(/lo_compat_privileges.*ALTER ROLE "argos_ro" SET lo_compat_privileges = off/),
      expect.stringContaining('SET ROLE "terzo"; REVOKE ALL ON LARGE OBJECT 102 FROM "argos_ro"; RESET ROLE;'),
      expect.stringMatching(/da tutti i ruoli \(PUBLIC\).*: 103\./),
    ]);
  });

  it("una voce del contratto che è una vista: il SELECT si toglie (una vista legge quello che vuole)", () => {
    const s = base();
    s.voci[0] = voce("public.gtfs_stops", { tipo: "v" });
    s.esistenti = ["public.ps_trips", "caronte.stop_transits"];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual(['REVOKE ALL ON TABLE "public"."gtfs_stops" FROM "argos_ro"']);
    expect(p.avvisi).toEqual(["public.gtfs_stops è nel contratto ma non esiste, o non è una tabella"]);
  });

  it("scrittura e MAINTAIN sui cataloghi di sistema oltre all'installazione: errore; con una causa globale, in una riga", () => {
    const s = base();
    s.sistemaScrive = [{ schema: "pg_catalog", nome: "pg_class", privilegi: "MAINTAIN" }];
    expect(piano(s, C).errori).toEqual([expect.stringContaining('REVOKE MAINTAIN ON TABLE "pg_catalog"."pg_class" FROM PUBLIC')]);
    s.membroDi = [{ ruolo: "pg_maintain", da: "postgres", da_superutente: true }];
    expect(piano(s, C).errori[1]).toMatch(/per i motivi qui sopra argos_ro può anche: pg_catalog\.pg_class \(MAINTAIN\)/);
  });

  it("server esterni: l'USAGE dato dal proprietario si toglie; di un terzo, di tutti o non spiegato è errore; le user mapping errore", () => {
    const s = base();
    s.esterni = [
      { genere: "server", nome: "remoto", a_tutti: false, privilegio: "USAGE", dato_da: null },
      { genere: "server", nome: "altro", a_tutti: false, privilegio: "USAGE", dato_da: "terzo" },
      { genere: "wrapper", nome: "postgres_fdw", a_tutti: true, privilegio: "USAGE", dato_da: null },
      { genere: "server", nome: "di_tutti", a_tutti: true, privilegio: "USAGE", dato_da: "terzo" },
    ];
    s.esterniUsabili = [{ genere: "server", nome: "remoto" }, { genere: "server", nome: "nascosto" }];
    s.mappature = ["remoto"];
    const p = piano(s, C);
    expect(p.azioni.map(a => a.sql)).toEqual(['REVOKE ALL ON FOREIGN SERVER "remoto" FROM "argos_ro"']);
    expect(p.errori).toEqual([
      expect.stringContaining('SET ROLE "terzo"; REVOKE ALL ON FOREIGN SERVER "altro" FROM "argos_ro"; RESET ROLE;'),
      expect.stringContaining('REVOKE ALL ON FOREIGN DATA WRAPPER "postgres_fdw" FROM PUBLIC'),
      expect.stringMatching(/^server di_tutti: .*per concessione di terzo.*SET ROLE "terzo"; REVOKE ALL ON FOREIGN SERVER "di_tutti" FROM PUBLIC; RESET ROLE;$/),
      expect.stringMatching(/^server nascosto: argos_ro lo può usare, e non lo spiegano/),
      expect.stringContaining('DROP USER MAPPING FOR "argos_ro" SERVER "remoto"'),
    ]);
  });

  it("lo_compat_privileges: il comando dipende da dove è acceso", () => {
    const s = base();
    s.loCompat = { acceso: true, dove: 1 };
    expect(piano(s, C).errori).toEqual([expect.stringContaining('ALTER ROLE "argos_ro" IN DATABASE "postgres" SET lo_compat_privileges = off')]);
    s.loCompat = { acceso: true, dove: 3 };
    expect(piano(s, C).errori).toEqual([expect.stringContaining('ALTER DATABASE "postgres" SET lo_compat_privileges = off')]);
    s.loCompat = { acceso: true, dove: null };
    expect(piano(s, C).errori).toEqual([expect.stringContaining("ALTER SYSTEM SET lo_compat_privileges = off")]);
  });

  it("i nomi vanno tra virgolette, anche con un punto dentro", () => {
    const s = base();
    s.voci.push(voce('public.a"b'), { ...voce("public.x"), tabella: "report.2026" });
    expect(sqls(s)).toEqual([
      'REVOKE ALL ON TABLE "public"."a""b" FROM "argos_ro"',
      'REVOKE ALL ON TABLE "public"."report.2026" FROM "argos_ro"',
    ]);
  });

  it("una voce del contratto non valida (dal database) si ignora con un errore", () => {
    const p = piano(base(), [...C, "public.x; DROP TABLE users"]);
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([expect.stringMatching(/voce del contratto non valida/)]);
  });
});

describe("permessi di Argos: quale contratto vale", () => {
  const codice = { nome: "argos_lettura", versione: 2, elenco: ["public.a", "public.b"] };
  const salvato = (versione: number, elenco: string[]) => ({ disponibile: true, riga: { versione, elenco } });

  it("niente nel database: vale il codice e si registra", () => {
    expect(contrattoEffettivo(codice, { disponibile: true, riga: null })).toMatchObject({ versione: 2, fonte: "codice", scrivi: true, salvata: null });
  });

  it("il database è più vecchio: vale il codice e si aggiorna", () => {
    expect(contrattoEffettivo(codice, salvato(1, ["public.a"]))).toMatchObject({ versione: 2, fonte: "codice", scrivi: true, salvata: 1 });
  });

  it("stessa versione e stesso elenco: niente da scrivere", () => {
    expect(contrattoEffettivo(codice, salvato(2, ["public.b", "public.a"]))).toMatchObject({ fonte: "codice", scrivi: false, errori: [], avvisi: [] });
  });

  it("il database è più nuovo (rollback o revert): vale il suo elenco, non si scrive, lo si dice; voci strane ignorate", () => {
    const e = contrattoEffettivo(codice, salvato(3, ["public.a", "public.b", "public.c", "x.y"]));
    expect(e).toMatchObject({ versione: 3, fonte: "database", scrivi: false, elenco: ["public.a", "public.b", "public.c"] });
    expect(e.avvisi).toEqual([expect.stringMatching(/v3 salvato nel database: questo codice ha la v2.*si alza la versione/)]);
    expect(e.errori).toEqual([expect.stringMatching(/non valida.*x\.y/)]);
  });

  it("stessa versione ma elenco diverso: vale il database, con un errore", () => {
    const e = contrattoEffettivo(codice, salvato(2, ["public.a"]));
    expect(e).toMatchObject({ fonte: "database", elenco: ["public.a"], scrivi: false });
    expect(e.errori).toEqual([expect.stringMatching(/alza ARGOS_VERSIONE/)]);
  });

  it("--forza: vale e si scrive il codice anche se il database è più nuovo", () => {
    const e = contrattoEffettivo(codice, salvato(3, ["public.c"]), { forza: true });
    expect(e).toMatchObject({ versione: 2, fonte: "codice", scrivi: true, elenco: ["public.a", "public.b"] });
  });

  it("tabella dei contratti non leggibile: il codice, con un avviso, senza scrivere", () => {
    const e = contrattoEffettivo(codice, { disponibile: false, motivo: "non leggibile" });
    expect(e).toMatchObject({ fonte: "codice", scrivi: false });
    expect(e.avvisi).toEqual([expect.stringMatching(/non disponibile \(non leggibile\)/)]);
  });

  it("contratto salvato non fidato: il codice, con un errore; --forza riscrive solo se è la riga a non essere fidata", () => {
    const sospetto = { disponibile: false, sospetto: true, motivo: "modificabile da altri" };
    expect(contrattoEffettivo(codice, sospetto)).toMatchObject({ fonte: "codice", scrivi: false, avvisi: [], errori: [expect.stringMatching(/modificabile da altri/)] });
    expect(contrattoEffettivo(codice, sospetto, { forza: true })).toMatchObject({ scrivi: false });
    const riga = { ...sospetto, rigaNonFidata: true, motivo: "scritto da argos_ro" };
    expect(contrattoEffettivo(codice, riga)).toMatchObject({ scrivi: false, errori: [expect.stringMatching(/scritto da argos_ro/)] });
    expect(contrattoEffettivo(codice, riga, { forza: true })).toMatchObject({ fonte: "codice", scrivi: true, errori: [] });
    // la versione della riga non fidata resta visibile, per i messaggi
    expect(contrattoEffettivo(codice, { ...riga, versioneNonFidata: 3 })).toMatchObject({ salvata: 3, nonFidata: true });
  });
});

describe("permessi di Argos: esecuzione", () => {
  const finto = (fallisce: Record<string, object>) => {
    const fatte: string[] = [];
    return {
      fatte,
      query: async (sql: string) => {
        fatte.push(sql);
        if (fallisce[sql]) throw Object.assign(new Error("no"), fallisce[sql]);
        return { rows: [] };
      },
    };
  };
  const az = (sql: string) => ({ sql, perche: sql, oggetto: null });

  it("un'azione che fallisce si annulla da sola e le altre vanno avanti", async () => {
    const c = finto({ B: { code: "2BP01", message: "dependent privileges exist" } });
    const fallite = await eseguiAzioni(c, [az("A"), az("B"), az("C")]);
    expect(c.fatte).toEqual([
      "SAVEPOINT argos_azione", "A", "RELEASE SAVEPOINT argos_azione",
      "SAVEPOINT argos_azione", "B", "ROLLBACK TO SAVEPOINT argos_azione", "RELEASE SAVEPOINT argos_azione",
      "SAVEPOINT argos_azione", "C", "RELEASE SAVEPOINT argos_azione",
    ]);
    expect(fallite).toEqual([expect.objectContaining({ sql: "B", motivo: expect.stringMatching(/dependent privileges exist \(codice 2BP01\)/) })]);
  });

  it("uno stallo o un lucchetto annulla tutto e risale (si riprova da capo)", async () => {
    await expect(eseguiAzioni(finto({ B: { code: "40P01" } }), [az("A"), az("B"), az("C")])).rejects.toMatchObject({ code: "40P01" });
  });
});

/* Il registro delle modifiche (0006, PR 2.10) e le regole decise il 25/10:
 * valori prima/dopo solo per programmi, orari, turni e tariffe; per utenti,
 * roster e anagrafica solo i nomi dei campi (degli utenti, ruolo e permessi
 * col valore); mai la verifica in due passaggi né l'ultimo accesso; nasce spento. */
describe("0006: il registro delle modifiche", () => {
  const sql = readFileSync(path.join(CARTELLA, "0006_registro_delle_modifiche.sql"), "utf8");
  const regole = new Map([...sql.matchAll(
    /SELECT registro\.sorveglia\('public\.(\w+)',\s*ARRAY\[([^\]]*)\],\s*(NULL|'\w+'),\s*(NULL|'\w+'),\s*(true|false)(?:,\s*(ARRAY\[[^\]]*\]|'\{\}'))?(?:,\s*(ARRAY\[[^\]]*\]|'\{\}'))?\);/g)]
    .map(([, t, chiave, , ambito, valori, valoriDi, escluse]) => [t!, {
      chiave: chiave!, ambito: ambito!, conValori: valori === "true", valoriDi: valoriDi ?? "", escluse: escluse ?? "",
    }]));
  const catalogo = JSON.parse(readFileSync(path.join(CARTELLA, "meta/catalogo.json"), "utf8"));

  it("le 21 tabelle della prima ondata, tutte esistenti", () => {
    expect([...regole.keys()].sort()).toEqual([
      "app_settings", "depots", "driver_shift_scenarios", "gtfs_fare_products", "gtfs_feeds", "ps_calendars",
      "ps_project_members", "ps_projects", "ps_route_variants", "ps_routes", "ps_stops", "ps_trips", "ps_validity_units",
      "roster_assignments", "roster_driver_history", "roster_drivers", "roster_entries", "roster_pubblicazioni",
      "scheduling_projects", "service_program_scenarios", "users",
    ]);
    for (const [t, r] of regole) {
      const colonne = catalogo.tabelle[`public.${t}`];
      expect(colonne, t).toBeTruthy();
      for (const c of r.chiave.replace(/'/g, "").split(",").map((x) => x.trim())) expect(colonne, `${t}.${c}`).toHaveProperty(c);
      if (r.ambito !== "NULL") expect(colonne, `${t}.${r.ambito}`).toHaveProperty(r.ambito.replace(/'/g, ""));
    }
  });

  it("utenti: solo i nomi dei campi, valori solo di ruolo e permessi, mai la verifica, l'ultimo accesso e i contatori", () => {
    const u = regole.get("users")!;
    expect(u.conValori).toBe(false);
    expect(u.valoriDi).toBe("ARRAY['role', 'permissions']");
    for (const e of ["'mfa\\_%'", "'last_login_at'", "'sessione_versione'", "'dispositivi_versione'", "'password_controllata'"]) {
      expect(u.escluse).toContain(e);
    }
    expect(u.valoriDi).not.toMatch(/password/);
  });

  it("roster e anagrafica: mai un valore (i codici sanitari stanno in roster_entries.code)", () => {
    for (const t of ["roster_drivers", "roster_driver_history", "roster_assignments", "roster_entries", "roster_pubblicazioni"]) {
      expect(regole.get(t)!.conValori, t).toBe(false);
      expect(regole.get(t)!.valoriDi, t).toMatch(/^(|'\{\}')$/);
      expect(regole.get(t)!.chiave, t).toBe("'id'");
    }
  });

  it("programmi, orari, turni e tariffe con i valori", () => {
    for (const t of ["ps_projects", "ps_routes", "ps_trips", "ps_stops", "scheduling_projects", "service_program_scenarios",
      "driver_shift_scenarios", "gtfs_feeds", "gtfs_fare_products", "depots"]) {
      expect(regole.get(t)!.conValori, t).toBe(true);
    }
  });

  it("nasce spento, e si accende solo con una base giuridica scritta; anonimizzazione mai prima di 6 mesi", () => {
    expect(sql).toMatch(/attivo\s+boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/CHECK \(NOT attivo OR base_giuridica <> ''\)/);
    expect(sql).toMatch(/anonimizza_dopo_mesi >= 6/);
    expect(sql).toMatch(/anonimizza_dopo_mesi\s+integer NOT NULL DEFAULT 12/);
  });

  it("all'app solo la lettura delle regole e manutenzione() e verifica(); niente sul registro né ad argos_ro", () => {
    const grant = [...sql.matchAll(/GRANT\s+([^;]+?)\s+TO\s+(\w+)/g)].map(([, cosa, a]) => `${cosa} → ${a}`);
    expect(grant).toEqual([
      "USAGE ON SCHEMA registro → cerbero_owner",
      "SELECT ON TABLE registro.sorvegliate → cerbero_owner",
      "EXECUTE ON FUNCTION registro.manutenzione() → cerbero_owner",
      "EXECUTE ON FUNCTION registro.verifica() → cerbero_owner",
    ]);
    expect(sql).not.toMatch(/argos_ro/);
  });
});
