/**
 * I ruoli aziendali sugli utenti (PR 2.14a, migrazione 0009).
 * - Senza database: le colonne e i vincoli sono nel catalogo atteso; la
 *   migrazione passa i dati senza cambiare l'accesso a nessuno; il registro
 *   riporta i valori dei campi nuovi; FleetCare non li legge; la regola con
 *   cui Gestione utenti cambia i permessi (permessiDopo).
 * - Sul database (TEST_DATABASE_URL, migrato; in CI come cerbero_app): i
 *   vincoli, il passaggio dei dati della migrazione riga per riga, e il
 *   riallineamento della vista users.permissions con la verifica in due
 *   passaggi che la segue.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { LETTORI } from "../../../../lib/db/scripts/ruoli-regole.mjs";
import { RUOLI, INTERRUTTORI_DI_PRIMA, dirittiDi, interruttoriCompatibili } from "@workspace/permessi";
import { permessiDopo, profiloDaRiga } from "../lib/permessi";

const leggi = (relativo: string) => readFileSync(fileURLToPath(new URL(relativo, import.meta.url)), "utf8");
const CATALOGO = JSON.parse(leggi("../../../../lib/db/migrations/meta/catalogo.json"));
const MIGRAZIONE = leggi("../../../../lib/db/migrations/0009_ruoli_aziendali.sql");

describe("le colonne dei ruoli su public.users", () => {
  const colonne = CATALOGO.tabelle["public.users"];

  it("quattro colonne, mai nulle, con un default che non dà niente", () => {
    expect(colonne.ruoli).toBe("text[] | not null | '{}'::text[] |  | ");
    expect(colonne.accesso_di_prima).toBe("jsonb | not null | '{}'::jsonb |  | ");
    expect(colonne.dati_sanitari).toBe("boolean | not null | false |  | ");
    expect(colonne.analisi).toBe("boolean | not null | false |  | ");
  });

  it("il default di permissions è tutto spento: una riga senza permessi non ne ha", () => {
    const def = JSON.parse(/'(\{[^']+\})'::jsonb/.exec(colonne.permissions)![1]!);
    expect(Object.values(def).every(v => v === false)).toBe(true);
    expect(Object.keys(def).sort()).toEqual(["analytics", "centrale", "fares", "fleetcare", "network", "personale", "roster", "scheduling"]);
  });

  it("il vincolo ammette i ruoli del codice, tutti e solo quelli", () => {
    const vincolo: string = CATALOGO.vincoli["public.users.users_ruoli_validi"];
    expect([...vincolo.matchAll(/'(\w+)'::text/g)].map(m => m[1]).sort()).toEqual([...RUOLI].sort());
    expect(CATALOGO.vincoli["public.users.users_accesso_di_prima_oggetto"]).toBe("CHECK ((accesso_di_prima @> '{}'::jsonb))");
  });

  it("FleetCare non legge i campi nuovi: continua con permissions", () => {
    const colonneLette: string[] = [...(LETTORI as any).fleetcare_legge_cerbero["public.users"]];
    for (const c of ["ruoli", "accesso_di_prima", "dati_sanitari", "analisi"]) expect(colonneLette).not.toContain(c);
    expect(colonneLette).toContain("permissions");
  });

  it("il registro riporta i valori dei campi dei ruoli; il resto della regola è quella della 0008", () => {
    const regola = (sql: string) => /SELECT registro\.sorveglia\('public\.users',([\s\S]*?)\);/.exec(sql)![1]!.replace(/\s+/g, " ").trim();
    const prima = regola(leggi("../../../../lib/db/migrations/0008_mfa_obbligatoria.sql"));
    const dopo = regola(MIGRAZIONE);
    expect(dopo).toContain("ARRAY['role', 'permissions', 'ruoli', 'accesso_di_prima', 'dati_sanitari', 'analisi']");
    expect(dopo.replace("ARRAY['role', 'permissions', 'ruoli', 'accesso_di_prima', 'dati_sanitari', 'analisi']", "ARRAY['role', 'permissions']")).toBe(prima);
  });

  it("la migrazione passa i dati una volta sola: solo sulle righe che non hanno ancora niente", () => {
    expect(MIGRAZIONE).toMatch(/WHERE u\.ruoli = '\{\}'::text\[\] AND u\.accesso_di_prima = '\{\}'::jsonb AND NOT u\.dati_sanitari AND NOT u\.analisi;/);
    // gli interruttori copiati sono quelli che possono restare accesi: tutti tranne l'Analisi, che diventa una capacità
    const copiati = /unnest\(ARRAY\[([^\]]+)\]\) AS k\(nome\)/.exec(MIGRAZIONE)![1]!.replace(/'/g, "").split(",").map(s => s.trim());
    expect(copiati.sort()).toEqual([...INTERRUTTORI_DI_PRIMA].sort());
  });
});

describe("permessiDopo: come Gestione utenti cambia i permessi", () => {
  const prima = { role: "user", ruoli: ["ufficio_turni"], accesso_di_prima: { network: true, scheduling: true, roster: true }, dati_sanitari: true, analisi: false };

  it("senza richieste non cambia niente, e la vista segue i diritti", () => {
    const d = permessiDopo(prima, {});
    expect(d).toMatchObject({ role: "user", ruoli: ["ufficio_turni"], accesso_di_prima: { network: true, scheduling: true, roster: true }, dati_sanitari: true, analisi: false });
    expect(d.permissions).toEqual(interruttoriCompatibili(dirittiDi(profiloDaRiga(prima))));
  });

  it("i ruoli si sostituiscono con quelli chiesti", () => {
    expect(permessiDopo(prima, { ruoli: ["pianificatore", "capo_deposito"] }).ruoli).toEqual(["pianificatore", "capo_deposito"]);
    expect(permessiDopo(prima, { ruoli: [] }).ruoli).toEqual([]);
  });

  it("l'accesso di prima si può solo togliere", () => {
    expect(permessiDopo(prima, { accessoDiPrima: { network: true } }).accesso_di_prima).toEqual({ network: true });
    expect(permessiDopo(prima, { accessoDiPrima: {} }).accesso_di_prima).toEqual({});
    expect(permessiDopo(prima, { accessoDiPrima: { network: true, scheduling: true, roster: true, personale: true, fares: true } }).accesso_di_prima)
      .toEqual({ network: true, scheduling: true, roster: true });
    expect(permessiDopo({ ...prima, accesso_di_prima: {} }, { accessoDiPrima: { personale: true } }).accesso_di_prima).toEqual({});
  });

  it("spento l'accesso di prima restano i diritti dei ruoli, e la vista lo dice", () => {
    const d = permessiDopo(prima, { accessoDiPrima: {} });
    // Ufficio turni: turni in scrittura, rete e roster in lettura → i tre interruttori restano accesi nella vista
    expect(d.permissions).toEqual({ analytics: false, fares: false, scheduling: true, network: true, fleetcare: false, centrale: true, personale: false, roster: true });
    const senzaRuoli = permessiDopo({ ...prima, ruoli: [] }, { accessoDiPrima: {} });
    expect(Object.values(senzaRuoli.permissions).every(v => v === false)).toBe(true);
  });

  it("capacità e ruolo di sistema", () => {
    expect(permessiDopo(prima, { datiSanitari: false }).dati_sanitari).toBe(false);
    expect(permessiDopo(prima, { analisi: true })).toMatchObject({ analisi: true, permissions: { analytics: true } });
    const admin = permessiDopo(prima, { role: "admin" });
    expect(admin.role).toBe("admin");
    expect(Object.values(admin.permissions).every(v => v === true)).toBe(true);
    expect(permessiDopo({ ...prima, role: "admin" }, { role: "qualcosa" }).role).toBe("user");
    expect(permessiDopo({ ...prima, role: "admin" }, {}).role).toBe("admin");
  });

  it("i dati sanitari non restano accesi a chi non può più aprire il roster", () => {
    // spento l'accesso di prima col roster, e nessun ruolo col roster: la capacità si spegne
    const senzaRoster = permessiDopo({ ...prima, ruoli: [] }, { ruoli: ["pianificatore"], accessoDiPrima: {} });
    expect(senzaRoster.dati_sanitari).toBe(false);
    // con un ruolo che apre il roster resta
    expect(permessiDopo(prima, { accessoDiPrima: {} }).dati_sanitari).toBe(true);
    expect(permessiDopo({ ...prima, ruoli: [] }, { ruoli: ["capo_deposito"], accessoDiPrima: {} }).dati_sanitari).toBe(true);
    // non si può accendere a chi non ha il roster
    expect(permessiDopo({ role: "user", ruoli: ["pianificatore"] }, { datiSanitari: true }).dati_sanitari).toBe(false);
    expect(permessiDopo({ role: "user", ruoli: ["officina"] }, { datiSanitari: true }).dati_sanitari).toBe(false);
    expect(permessiDopo({ role: "user", ruoli: ["ufficio_turni"] }, { datiSanitari: true }).dati_sanitari).toBe(true);
    // un utente nuovo senza ruoli non ha niente, qualunque cosa si chieda
    expect(permessiDopo({ role: "user" }, { datiSanitari: true, analisi: false })).toMatchObject({ ruoli: [], accesso_di_prima: {}, dati_sanitari: false });
  });

  it("profiloDaRiga non crede a quello che non è scritto bene", () => {
    const p = profiloDaRiga({ role: "Admin", ruoli: ["officina", "direttore", 7], accesso_di_prima: { roster: "true", fares: true, analytics: true }, dati_sanitari: "true", analisi: 1 });
    expect(p).toEqual({ admin: false, ruoli: ["officina"], accessoDiPrima: { fares: true }, datiSanitari: false, analisi: false });
    expect(profiloDaRiga({})).toEqual({ admin: false, ruoli: [], accessoDiPrima: {}, datiSanitari: false, analisi: false });
  });
});

describe.runIf(process.env.TEST_DATABASE_URL)("sul database", () => {
  const PREFISSO = `prova-ruoli-${process.pid}-`;
  const crea = async (nome: string, colonne: Record<string, unknown>): Promise<string> => {
    const chiavi = Object.keys(colonne);
    const r = await pool.query(
      `INSERT INTO users (email, password_hash${chiavi.map(k => `, ${k}`).join("")}) VALUES ($1, 'x'${chiavi.map((_, i) => `, $${i + 2}`).join("")}) RETURNING id`,
      [`${PREFISSO}${nome}@prova.local`, ...Object.values(colonne)],
    );
    return r.rows[0].id;
  };
  const riga = async (id: string) => (await pool.query(
    "SELECT role, ruoli, accesso_di_prima, dati_sanitari, analisi, permissions, mfa_obbligatoria FROM users WHERE id = $1", [id])).rows[0];

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE email LIKE $1", [`${PREFISSO}%`]);
    await pool.end();
  });

  it("un ruolo che non è del codice non si scrive; l'accesso di prima è un oggetto", async () => {
    await expect(crea("vincolo-1", { ruoli: "{direttore}" })).rejects.toMatchObject({ code: "23514" });
    await expect(crea("vincolo-2", { accesso_di_prima: "[]" })).rejects.toMatchObject({ code: "23514" });
    await expect(crea("vincolo-3", { accesso_di_prima: "\"network\"" })).rejects.toMatchObject({ code: "23514" });
    const id = await crea("vincolo-ok", { ruoli: `{${RUOLI.join(",")}}`, accesso_di_prima: "{}" });
    expect((await riga(id)).ruoli).toEqual([...RUOLI]);
  });

  it("una riga inserita senza dire niente non ha nessun diritto", async () => {
    const r = await riga(await crea("vuota", {}));
    expect(r).toMatchObject({ role: "user", ruoli: [], accesso_di_prima: {}, dati_sanitari: false, analisi: false, mfa_obbligatoria: false });
    expect(Object.values(r.permissions).every(v => v === false)).toBe(true);
    expect(Object.values(dirittiDi(profiloDaRiga(r))).every(v => v === null)).toBe(true);
  });

  it("il passaggio della migrazione: ogni interruttore acceso resta, e nessuno cambia accesso", async () => {
    const casi: Array<[string, Record<string, unknown>]> = [
      ["tutti", { analytics: true, fares: true, scheduling: true, network: true, fleetcare: true, centrale: true, personale: true, roster: true }],
      ["turni", { analytics: false, fares: true, scheduling: true, network: true, fleetcare: false, centrale: false, personale: false, roster: false }],
      ["roster", { roster: true, fleetcare: true }],
      ["analisi", { analytics: true }],
      ["niente", {}],
      ["strano", { network: "si", roster: 0, centrale: null, fares: "", personale: 1 }],
    ];
    const id: Record<string, string> = {};
    for (const [nome, permissions] of casi) id[nome] = await crea(`passaggio-${nome}`, { permissions: JSON.stringify(permissions) });
    // l'istruzione della migrazione, così com'è, ristretta alle righe di questa prova
    const passaggio = /UPDATE public\.users u[\s\S]*?AND NOT u\.analisi;/.exec(MIGRAZIONE)![0].replace(/;$/, " AND u.email LIKE $1");
    await pool.query(passaggio, [`${PREFISSO}passaggio-%`]);

    const acceso = (v: unknown) => !(v === false || v === null || v === undefined || v === 0 || v === "");
    for (const [nome, permissions] of casi) {
      const r = await riga(id[nome]!);
      const attesi = INTERRUTTORI_DI_PRIMA.filter(i => acceso((permissions as any)[i]));
      expect(Object.keys(r.accesso_di_prima).sort(), nome).toEqual([...attesi].sort());
      expect(Object.values(r.accesso_di_prima).every(v => v === true), nome).toBe(true);
      expect(r.dati_sanitari, nome).toBe(acceso((permissions as any).roster));
      expect(r.analisi, nome).toBe(acceso((permissions as any).analytics));
      expect(r.ruoli, nome).toEqual([]);
      // nessuno cambia accesso: la vista ricavata dai campi nuovi accende gli stessi interruttori di prima
      const vista = interruttoriCompatibili(dirittiDi(profiloDaRiga(r)));
      for (const [k, v] of Object.entries(vista)) expect(v, `${nome}.${k}`).toBe(acceso((permissions as any)[k]));
    }
    // una seconda volta non tocca più niente (tranne chi non aveva niente, che resta senza niente)
    await pool.query("UPDATE users SET accesso_di_prima = '{}' WHERE id = $1", [id.roster]);
    await pool.query(passaggio, [`${PREFISSO}passaggio-%`]);
    expect((await riga(id.roster!)).accesso_di_prima).toEqual({});
    expect(Object.keys((await riga(id.tutti!)).accesso_di_prima)).toHaveLength(7);
  });

  it("il riallineamento rimette la vista permissions e la verifica in due passaggi la segue", async () => {
    const { riallineaVistaPermessi } = await import("../lib/auth");
    const spenti = JSON.stringify({ analytics: false, fares: false, scheduling: false, network: false, fleetcare: false, centrale: false, personale: false, roster: false });
    const officina = await crea("riallinea-officina", { ruoli: "{officina}", permissions: spenti });
    const capo = await crea("riallinea-capo", { ruoli: "{capo_deposito}", permissions: spenti });
    const giusto = await crea("riallinea-giusto", {
      accesso_di_prima: JSON.stringify({ fares: true }),
      permissions: JSON.stringify({ analytics: false, fares: true, scheduling: false, network: false, fleetcare: false, centrale: false, personale: false, roster: false }),
    });
    const admin = await crea("riallinea-admin", { role: "admin", permissions: spenti });
    expect((await riga(capo)).mfa_obbligatoria).toBe(false);

    expect(await riallineaVistaPermessi()).toBeGreaterThanOrEqual(2);
    expect((await riga(officina)).permissions).toEqual({ analytics: false, fares: false, scheduling: false, network: false, fleetcare: true, centrale: true, personale: false, roster: false });
    expect((await riga(officina)).mfa_obbligatoria).toBe(false);
    // il Capo deposito apre il roster: la verifica in due passaggi diventa obbligatoria
    expect((await riga(capo)).permissions).toMatchObject({ roster: true, fleetcare: true, personale: false });
    expect((await riga(capo)).mfa_obbligatoria).toBe(true);
    // chi era già a posto e gli amministratori non si toccano
    expect((await riga(giusto)).permissions.fares).toBe(true);
    expect((await riga(admin)).permissions).toEqual(JSON.parse(spenti));
    // una seconda volta non c'è più niente da fare per queste righe
    const prima = [await riga(officina), await riga(capo), await riga(giusto)];
    await riallineaVistaPermessi();
    expect([await riga(officina), await riga(capo), await riga(giusto)]).toEqual(prima);
  });
});
