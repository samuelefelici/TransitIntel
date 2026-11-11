/* Il lavoratore (src/lavoratore.ts) non deve tirarsi dietro l'API: niente
 * app.ts, rotte, lib/auth.ts (che senza JWT_SECRET in produzione lancia
 * un'eccezione e all'import prepara gli utenti), lib/planning-studio.ts (che
 * all'import avvia dei timer), Express, la materializzazione dei feed. Lo si
 * controlla sul grafo vero di esbuild. Nel grafo non c'è DDL (lo schema lo
 * fanno le migrazioni, applicate dall'API), e le Watch Paths del lavoratore
 * in DEPLOY.md coprono ogni file del grafo: un file che manca vorrebbe dire
 * un lavoratore che non si ridistribuisce quando il suo codice cambia. */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = path.resolve(API, "../..");

let moduli: string[] = [];
let esterni: string[] = [];

beforeAll(async () => {
  /* come build.ts: le dipendenze npm restano fuori, i pacchetti del workspace (lib/db, …) entrano nel bundle */
  const pkg = JSON.parse(readFileSync(path.join(API, "package.json"), "utf8"));
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  const externals = Object.keys(deps).filter(d => !String(deps[d]).startsWith("workspace:"));
  const r = await build({
    entryPoints: [path.join(API, "src/lavoratore.ts")],
    absWorkingDir: API,
    bundle: true, platform: "node", format: "cjs", write: false, metafile: true,
    external: externals, logLevel: "silent",
  });
  const meta = r.metafile as Metafile;
  moduli = Object.keys(meta.inputs)
    .map(m => path.relative(REPO, path.resolve(API, m)).replace(/\\/g, "/"))
    .filter(m => !m.includes("node_modules/"));
  esterni = [...new Set(Object.values(meta.inputs).flatMap(i => i.imports.filter(x => x.external).map(x => x.path)))];
});

/** Le Watch Paths del lavoratore, dal blocco di DEPLOY.md. */
function watchPaths(): string[] {
  const testo = readFileSync(path.join(REPO, "DEPLOY.md"), "utf8");
  const da = testo.indexOf("**Watch Paths**: il lavoratore si ridistribuisce");
  expect(da, "sezione Watch Paths del lavoratore in DEPLOY.md").toBeGreaterThan(0);
  const blocco = testo.slice(da).split("```")[1];
  return blocco.split("\n").map(r => r.trim()).filter(Boolean);
}

const comeRegex = (glob: string) =>
  new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + "$");

describe("il lavoratore non importa l'API", () => {
  it("nel suo grafo non ci sono app, rotte, auth, planning-studio né Express", () => {
    const vietati = moduli.filter(m =>
      /src\/app\.ts$/.test(m) || /src\/routes\//.test(m) || /src\/lib\/auth\.ts$/.test(m) ||
      /src\/lib\/planning-studio\.ts$/.test(m) || /src\/lib\/planning-studio-materialize\.ts$/.test(m) ||
      /src\/middlewares\//.test(m) || /src\/lib\/mfa-cifratura\.ts$/.test(m));
    expect(vietati).toEqual([]);
    expect(esterni.filter(e => e === "express" || e.startsWith("express/"))).toEqual([]);
    // e c'è quello che serve
    expect(moduli.some(m => m.endsWith("src/lib/lavori/esecutore.ts"))).toBe(true);
    expect(moduli.some(m => m.endsWith("src/lib/guardia-schema.ts"))).toBe(true);
    expect(moduli.some(m => m.endsWith("src/lib/ottimizza-veicoli/gestori.ts"))).toBe(true);
    // i pacchetti del workspace sono nel grafo (come nel bundle vero)
    expect(moduli.some(m => m.startsWith("lib/db/"))).toBe(true);
  });

  it("nel suo grafo non c'è DDL", () => {
    const OGGETTI = "TABLE|INDEX|SCHEMA|VIEW|EXTENSION|TYPE|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE|ROLE|POLICY|DOMAIN|RULE";
    const ddl = new RegExp(
      `\\b(CREATE\\s+(OR\\s+REPLACE\\s+)?((UNIQUE|TEMP|TEMPORARY|UNLOGGED|MATERIALIZED)\\s+)*(${OGGETTI})`
      + `|(ALTER|DROP)\\s+((MATERIALIZED)\\s+)?(${OGGETTI}|DEFAULT\\s+PRIVILEGES)`
      + `|TRUNCATE\\s+(TABLE\\s+)?\\w|COMMENT\\s+ON|GRANT\\s+\\w+\\s+ON|REVOKE\\s+\\w+\\s+ON)\\b`, "i");
    // la regola stessa: deve riconoscere le forme che le unità pigre usavano davvero
    for (const q of ["CREATE UNIQUE INDEX IF NOT EXISTS x ON t (a)", "create or replace view v as select 1", "TRUNCATE t",
                     "ALTER TABLE t ADD COLUMN IF NOT EXISTS c text", "GRANT SELECT ON t TO r", "COMMENT ON TABLE t IS 'x'"]) {
      expect(ddl.test(q), q).toBe(true);
    }
    // il catalogo atteso (meta/catalogo.json) è un dato, non codice: descrive
    // lo schema (anche gli indici, col loro CREATE INDEX) e il lavoratore ne
    // legge solo i nomi delle relazioni (lib/db/scripts/catalogo-incluso.mjs)
    const DATI = new Set(["lib/db/migrations/meta/catalogo.json"]);
    expect(moduli.filter(m => m.endsWith(".json") && !m.endsWith("_journal.json") && !DATI.has(m))).toEqual([]);
    const conDdl = moduli.filter(m => !DATI.has(m)).filter(m => {
      const codice = readFileSync(path.join(REPO, m), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      return ddl.test(codice);
    });
    expect(conDdl).toEqual([]);
  });

  it("le Watch Paths del lavoratore in DEPLOY.md coprono ogni file del suo grafo", () => {
    const regole = watchPaths().map(comeRegex);
    const scoperti = moduli.filter(m => !regole.some(r => r.test(m)));
    expect(scoperti).toEqual([]);
  });
});
