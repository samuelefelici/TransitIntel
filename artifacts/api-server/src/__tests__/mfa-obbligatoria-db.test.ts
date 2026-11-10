/**
 * Per chi la verifica in due passaggi è obbligatoria (PR 2.12): lo dice il
 * database, con la colonna calcolata users.mfa_obbligatoria (migrazione 0008).
 * - Senza database: la colonna è nel catalogo atteso, calcolata da role e dai
 *   permessi personale e roster e da nient'altro; FleetCare la può leggere; il
 *   registro delle modifiche non la segna; l'API non ha più la regola scritta.
 * - Sul database (TEST_DATABASE_URL, migrato; in CI come cerbero_app): la
 *   tabella di verità, che segue i cambi di ruolo e permessi, e che non si
 *   scrive a mano.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { LETTORI } from "../../../../lib/db/scripts/ruoli-regole.mjs";

const leggi = (relativo: string) => readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), "utf8");
const CATALOGO = JSON.parse(leggi("../../../../lib/db/migrations/meta/catalogo.json"));
const MIGRAZIONE = leggi("../../../../lib/db/migrations/0008_mfa_obbligatoria.sql");

describe("users.mfa_obbligatoria: la regola sta nel database", () => {
  const colonna: string = CATALOGO.tabelle["public.users"].mfa_obbligatoria;

  it("una colonna calcolata e salvata, mai nulla", () => {
    const [tipo, nulla, espressione, identita, generata] = colonna.split(" | ");
    expect(tipo).toBe("boolean");
    expect(nulla).toBe("not null");
    expect(identita).toBe("");
    expect(generata).toBe("s");
    expect(espressione).toContain("role = 'admin'::text");
  });

  it("dipende da role e dai permessi personale e roster, e da nient'altro", () => {
    const espressione = colonna.split(" | ")[2]!;
    expect([...espressione.matchAll(/permissions -> '(\w+)'::text/g)].map((m) => m[1]).sort()).toEqual(["personale", "roster"]);
    // nessun'altra colonna: tolte le costanti e i nomi noti non resta un identificatore
    const resto = espressione.replace(/'[^']*'::\w+/g, "").replace(/\b(role|permissions|COALESCE|OR|ALL|ARRAY)\b/g, "");
    expect(resto.match(/[a-z_]{3,}/gi)).toBeNull();
    // solo operatori: nessuna chiamata di funzione (le espressioni delle tabelle di Cerbero, PR 2.8)
    expect(espressione.replace(/COALESCE\(/g, "").match(/\b[a-z_]+\(/gi)).toBeNull();
  });

  it("un permesso che non è false, null, 0 o vuoto conta come sì: come l'API, che lo leggeva con !!", () => {
    const elenchi = [...colonna.matchAll(/COALESCE\(\(permissions -> '\w+'::text\), 'false'::jsonb\) <> ALL \(ARRAY\[([^\]]+)\]\)/g)].map((m) => m[1]);
    expect(elenchi).toEqual(Array(2).fill("'false'::jsonb, 'null'::jsonb, '0'::jsonb, '\"\"'::jsonb"));
  });

  it("la migrazione: guardata dal catalogo, e la regola del registro è quella della 0006 più l'esclusione", () => {
    expect(MIGRAZIONE).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_attribute[\s\S]*attname = 'mfa_obbligatoria'[\s\S]*ALTER TABLE public\.users ADD COLUMN mfa_obbligatoria boolean NOT NULL GENERATED ALWAYS AS/);
    const regola = (sql: string) => {
      const m = /SELECT registro\.sorveglia\('public\.users',([\s\S]*?)\);/.exec(sql);
      expect(m).not.toBeNull();
      return m![1]!.replace(/\s+/g, " ").trim();
    };
    const prima = regola(leggi("../../../../lib/db/migrations/0006_registro_delle_modifiche.sql"));
    const dopo = regola(MIGRAZIONE);
    expect(dopo.replace("'mfa\\_obbligatoria', ", "")).toBe(prima);
    expect(dopo).toContain("'mfa\\_obbligatoria'");
  });

  it("FleetCare la legge, colonna per colonna, come le altre", () => {
    expect(LETTORI.fleetcare_legge_cerbero!["public.users"]).toContain("mfa_obbligatoria");
    for (const c of LETTORI.fleetcare_legge_cerbero!["public.users"]!) expect(Object.keys(CATALOGO.tabelle["public.users"])).toContain(c);
  });

  it("l'API la legge e non riscrive la regola", () => {
    const regole = leggi("../lib/accesso-regole.ts"), auth = leggi("../lib/auth.ts"), account = leggi("../lib/account.ts");
    expect(regole).not.toMatch(/function mfaObbligatoria/);
    expect(auth.match(/mfa_obbligatoria/g)!.length).toBeGreaterThanOrEqual(4);
    // né qui né altrove un «admin, oppure personale, oppure roster» che decide la verifica
    for (const sorgente of [regole, auth, account]) {
      expect(sorgente).not.toMatch(/permissions\?\.personale\s*\|\|\s*!!\w+\.permissions\?\.roster/);
    }
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("users.mfa_obbligatoria, sul database", () => {
  const EMAIL = (n: string) => `mfa-obbligatoria-${n}@prova.local`;
  const pulisci = () => pool.query("DELETE FROM users WHERE email LIKE 'mfa-obbligatoria-%@prova.local'");
  afterAll(pulisci);

  it("la tabella di verità: chi amministra, chi ha personale o roster", async () => {
    await pulisci();
    const casi: Array<[string, string, string, boolean]> = [
      ["admin", "admin", "{}", true],
      ["admin-con-permessi-spenti", "admin", '{"personale": false, "roster": false}', true],
      ["personale", "user", '{"personale": true}', true],
      ["roster", "user", '{"roster": true}', true],
      ["tutti-e-due", "user", '{"personale": true, "roster": true}', true],
      ["altri-permessi", "user", '{"fleetcare": true, "scheduling": true, "analytics": true, "personale": false, "roster": false}', false],
      ["nessuno", "user", "{}", false],
      // valori che l'API non scrive: contano come li leggeva l'API (!!)
      ["null", "user", '{"personale": null}', false],
      ["zero", "user", '{"roster": 0}', false],
      ["vuoto", "user", '{"personale": ""}', false],
      ["uno", "user", '{"roster": 1}', true],
      ["testo", "user", '{"personale": "si"}', true],
      ["lista", "user", "[]", false],
      // un ruolo che non è «admin» scritto così non amministra
      ["quasi-admin", "Admin", "{}", false],
    ];
    for (const [nome, ruolo, permessi, atteso] of casi) {
      const r = await pool.query(
        "INSERT INTO users (email, password_hash, role, permissions) VALUES ($1, 'x', $2, $3::jsonb) RETURNING mfa_obbligatoria",
        [EMAIL(nome), ruolo, permessi]);
      expect(r.rows[0].mfa_obbligatoria, nome).toBe(atteso);
    }
  });

  it("segue i cambi di ruolo e di permessi, nella stessa istruzione", async () => {
    const e = EMAIL("nessuno");
    const cambia = async (sql: string, ...p: unknown[]) => (await pool.query(`UPDATE users SET ${sql} WHERE email = $1 RETURNING mfa_obbligatoria`, [e, ...p])).rows[0].mfa_obbligatoria;
    expect(await cambia("permissions = $2::jsonb", '{"roster": true}')).toBe(true);
    expect(await cambia("permissions = $2::jsonb", '{"roster": false}')).toBe(false);
    expect(await cambia("role = 'admin'")).toBe(true);
    expect(await cambia("role = 'user'")).toBe(false);
    expect(await cambia("full_name = 'Non cambia niente'")).toBe(false);
  });

  it("non si scrive: né all'inserimento né dopo", async () => {
    await expect(pool.query("UPDATE users SET mfa_obbligatoria = false WHERE email = $1", [EMAIL("admin")]))
      .rejects.toMatchObject({ code: "428C9" });
    await expect(pool.query("INSERT INTO users (email, password_hash, role, mfa_obbligatoria) VALUES ($1, 'x', 'admin', false)", [EMAIL("forzato")]))
      .rejects.toMatchObject({ code: "428C9" });
    const r = await pool.query("SELECT mfa_obbligatoria FROM users WHERE email = $1", [EMAIL("admin")]);
    expect(r.rows[0].mfa_obbligatoria).toBe(true);
  });
});
