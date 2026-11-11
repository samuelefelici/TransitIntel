/* I ruoli del database (PR 2.8): il piano puro di lib/db/scripts/ruoli-regole.mjs
 * e l'esecuzione con un client finto (un'istruzione per transazione, oggetti
 * occupati saltati, tetto di tempo). Sul database vero lo provano la CI
 * (migrazioni-postgres) e lo script locale della PR. */
import { describe, it, expect } from "vitest";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GIRI_SCRAM, improntaScram, nuovaPassword, urlDellApp } from "../../../../lib/db/scripts/ruoli-password.mjs";
import {
  APP, COMANDI_DELL_APP, COMANDI_DEL_REGISTRO, CORPO_EVENTO_DDL, DA_ESEGUIRE, DA_LEGGERE, FUNZIONI_AMMESSE, PROPRIETARIO, allinea, calcolateDaControllare, calcolateDalCatalogo,
  elencoDalCatalogo, piano, sqlEspressioniVietate,
} from "../../../../lib/db/scripts/ruoli-regole.mjs";
import type { StatoRuoli, Relazione } from "../../../../lib/db/scripts/ruoli-regole.mjs";

const ruolo = (nome: string, extra: Partial<StatoRuoli["ruoli"][number]> = {}) => ({
  nome, login: false, superutente: false, bypassrls: false, crearuoli: false, creadb: false, replica: false,
  col_ruolo: nome === APP, ...extra,
});
const rel = (voce: string, extra: Partial<Relazione> = {}): Relazione => {
  const [schema, nome] = voce.split(".");
  return {
    schema, nome, tipo: "r", proprietario: PROPRIETARIO, di_superutente: false, estensione: false, legata: false, basi: [],
    ...extra,
  };
};
/** Un database in regola: ruoli, appartenenza, diritti, tabelle di cerbero_owner. */
function base(extra: Partial<StatoRuoli> = {}): StatoRuoli {
  return {
    io: { utente: "postgres", sessione: "postgres", database: "postgres", superutente: true },
    ruoli: [ruolo(PROPRIETARIO), ruolo(APP, { login: true })],
    appartenenze: [{ ruolo: PROPRIETARIO, membro: APP, admin: false, eredita: false, imposta: true }],
    database: { connette: true },
    schemi: ["public", "caronte", "coda", "cerbero_migrazioni"].map((nome) => ({ nome, esiste: true, uso: true, crea: false, crea_diretta: [], di: null })),
    lettura: ["cerbero_migrazioni.__drizzle_migrations", "cerbero_migrazioni.contratti"].map((voce) => ({ voce, esiste: true, legge: true })),
    relazioni: [
      rel("public.users"), rel("public.ps_route_variants"),
      rel("public.ps_variants", { tipo: "v", basi: [{ nome: "public.ps_route_variants", proprietario: PROPRIETARIO }] }),
      rel("public.accessi_log_id_seq", { tipo: "S", legata: true }),
    ],
    fleetcare: [
      { firma: "fleetcare.parco_per_avm()", esiste: true, chiama: true },
      { firma: "fleetcare.interventi_avm(timestamp with time zone)", esiste: true, chiama: true },
    ],
    evento: {
      funzione: true, corpo: CORPO_EVENTO_DDL, di_superutente: true, di_tutti: false, acceso: "A", momento: "ddl_command_start", sua: true,
      fine_acceso: "A", fine_momento: "ddl_command_end", fine_sua: true,
      riscrive_acceso: "A", riscrive_momento: "table_rewrite", riscrive_sua: true,
    },
    espressioni: [],
    estranee: [],
    ...extra,
  };
}
const daPostgres = (r: Relazione): Relazione => ({ ...r, proprietario: "postgres", di_superutente: true });

describe("ruoli del database: il piano", () => {
  it("un database in regola non chiede niente", () => {
    expect(piano(base())).toEqual({ azioni: [], attese: [], avvisi: [], errori: [] });
  });

  it("chi non è superutente non tocca niente e lo dice", () => {
    const p = piano(base({ io: { utente: "pippo", sessione: "pippo", database: "postgres", superutente: false } }));
    expect(p.azioni).toEqual([]);
    expect(p.errori[0]).toMatch(/pippo non è un superutente/);
  });

  it("database nuovo: crea i ruoli NOLOGIN, l'appartenenza senza eredità, il ruolo di sessione e i diritti", () => {
    const st = base({
      ruoli: [], appartenenze: [], database: { connette: null },
      schemi: base().schemi.map((s) => ({ ...s, uso: null, crea: null })),
      lettura: base().lettura.map((t) => ({ ...t, legge: null })),
      relazioni: base().relazioni.map(daPostgres),
    });
    const sql = piano(st).azioni.map((a) => a.sql);
    expect(sql.slice(0, 4)).toEqual([
      `CREATE ROLE "${PROPRIETARIO}" NOLOGIN`,
      `CREATE ROLE "${APP}" NOLOGIN`,
      `GRANT "${PROPRIETARIO}" TO "${APP}" WITH INHERIT FALSE, SET TRUE`,
      `ALTER ROLE "${APP}" SET role = '${PROPRIETARIO}'`,
    ]);
    for (const s of ["public", "caronte", "coda", "cerbero_migrazioni"]) expect(sql).toContain(`GRANT USAGE ON SCHEMA "${s}" TO "${PROPRIETARIO}"`);
    expect(sql).toContain(`GRANT SELECT ON TABLE "cerbero_migrazioni"."__drizzle_migrations" TO "${PROPRIETARIO}"`);
    // PR 2.16b: CREATE non si dà più su nessuno schema, nemmeno su quelli dei dati
    expect(sql.some((s) => /GRANT [^;]*\bCREATE\b[^;]* ON SCHEMA/.test(s))).toBe(false);
    expect(sql).toContain(`ALTER TABLE "public"."users" OWNER TO "${PROPRIETARIO}"`);
    // mai una password, mai LOGIN
    expect(sql.some((s) => /PASSWORD|\bLOGIN\b(?! *$)/.test(s.replace("NOLOGIN", "")))).toBe(false);
  });

  it("le fasi: ruoli e diritti, poi tabelle, poi le viste solo con le tabelle già passate", () => {
    const relazioni = base().relazioni.map(daPostgres).map((r) =>
      r.tipo === "v" ? { ...r, basi: [{ nome: "public.ps_route_variants", proprietario: "postgres" }] } : r);
    const p = piano(base({ relazioni }));
    expect(p.azioni.map((a) => [a.fase, a.oggetto])).toEqual([[2, "public.users"], [2, "public.ps_route_variants"]]);
    expect(p.attese).toEqual(["public.ps_variants: aspetta public.ps_route_variants"]);
    // giro dopo: la tabella è passata, la vista sì
    const dopo = piano(base({ relazioni: relazioni.map((r) =>
      r.tipo === "v" ? { ...r, basi: [{ nome: "public.ps_route_variants", proprietario: PROPRIETARIO }] }
        : { ...r, proprietario: PROPRIETARIO, di_superutente: false }) }));
    expect(dopo.azioni).toEqual([expect.objectContaining({ fase: 3, sql: `ALTER VIEW "public"."ps_variants" OWNER TO "${PROPRIETARIO}"` })]);
  });

  it("le sequenze legate a una tabella non si toccano; quelle libere sì", () => {
    const p = piano(base({ relazioni: [
      daPostgres(rel("public.accessi_log_id_seq", { tipo: "S", legata: true })),
      daPostgres(rel("public.contatore", { tipo: "S" })),
    ] }));
    expect(p.azioni.map((a) => a.sql)).toEqual([`ALTER SEQUENCE "public"."contatore" OWNER TO "${PROPRIETARIO}"`]);
  });

  it("estensioni, caronte.app_users e cerbero_migrazioni restano dove sono", () => {
    const p = piano(base({ relazioni: [
      daPostgres(rel("public.spatial_ref_sys", { estensione: true })),
      daPostgres(rel("caronte.app_users")),
      daPostgres(rel("cerbero_migrazioni.contratti")),
    ] }));
    expect(p).toEqual({ azioni: [], attese: [], avvisi: [], errori: [] });
  });

  it("un oggetto di un ruolo terzo è un errore con la cura, non un'azione", () => {
    const p = piano(base({ relazioni: [rel("caronte.stop_predictions", { proprietario: "avm_esterno" })] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori[0]).toMatch(/caronte\.stop_predictions è di avm_esterno.*ALTER TABLE "caronte"\."stop_predictions" OWNER TO "cerbero_owner"/);
  });

  it("gli oggetti nati di cerbero_app si spostano", () => {
    const p = piano(base({ relazioni: [rel("public.nuova", { proprietario: APP })] }));
    expect(p.azioni.map((a) => a.sql)).toEqual([`ALTER TABLE "public"."nuova" OWNER TO "${PROPRIETARIO}"`]);
  });

  it("appartenenza con le opzioni sbagliate o con ADMIN: si corregge", () => {
    const p = piano(base({ appartenenze: [{ ruolo: PROPRIETARIO, membro: APP, admin: true, eredita: true, imposta: true }] }));
    expect(p.azioni.map((a) => a.sql)).toEqual([
      `GRANT "${PROPRIETARIO}" TO "${APP}" WITH INHERIT FALSE, SET TRUE`,
      `REVOKE ADMIN OPTION FOR "${PROPRIETARIO}" FROM "${APP}"`,
    ]);
  });

  it("altri membri dei ruoli: errore, non si tocca", () => {
    const p = piano(base({ appartenenze: [...base().appartenenze,
      { ruolo: PROPRIETARIO, membro: "argos_ro", admin: false, eredita: true, imposta: true }] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori[0]).toMatch(/argos_ro è membro di cerbero_owner/);
  });

  it("attributi da superutente o LOGIN sul proprietario: si tolgono", () => {
    const p = piano(base({ ruoli: [ruolo(PROPRIETARIO, { login: true }), ruolo(APP, { superutente: true, bypassrls: true })] }));
    expect(p.azioni.map((a) => a.sql)).toEqual([
      `ALTER ROLE "${APP}" NOSUPERUSER NOBYPASSRLS`,
      `ALTER ROLE "${PROPRIETARIO}" NOLOGIN`,
    ]);
  });

  it("senza il ruolo di sessione o CONNECT: si ridanno; TEMPORARY non si dà più", () => {
    const p = piano(base({ ruoli: [ruolo(PROPRIETARIO), ruolo(APP, { col_ruolo: false })], database: { connette: false } }));
    expect(p.azioni.map((a) => a.sql)).toEqual([
      `ALTER ROLE "${APP}" SET role = '${PROPRIETARIO}'`,
      `GRANT CONNECT ON DATABASE "postgres" TO "${APP}"`,
    ]);
  });

  /* PR 2.16b: l'app non cambia la struttura del database. Il CREATE sugli
   * schemi dei dati serviva alle unità pigre: chi lo ha ancora (un database
   * che ha visto la 2.8) lo perde al primo avvio. */
  it("CREATE sugli schemi: si toglie a cerbero_owner e a cerbero_app, dovunque sia stato dato a loro", () => {
    const schemi = base().schemi.map((s) => s.nome === "cerbero_migrazioni" ? { ...s, crea: true, crea_diretta: [APP] }
      : { ...s, crea: true, crea_diretta: [PROPRIETARIO] });
    const p = piano(base({ schemi }));
    expect(p.azioni.map((a) => a.sql)).toEqual([
      `REVOKE CREATE ON SCHEMA "public" FROM "${PROPRIETARIO}"`,
      `REVOKE CREATE ON SCHEMA "caronte" FROM "${PROPRIETARIO}"`,
      `REVOKE CREATE ON SCHEMA "coda" FROM "${PROPRIETARIO}"`,
      `REVOKE CREATE ON SCHEMA "cerbero_migrazioni" FROM "${APP}"`,
    ]);
    expect(p.azioni.every((a) => a.fase === 1)).toBe(true);
    expect(p.errori).toEqual([]);
    // dopo la revoca non resta niente da fare: il piano converge
    expect(piano(base()).azioni).toEqual([]);
  });

  it("CREATE che viene da PUBLIC non si revoca a cerbero_owner (non cambierebbe niente): lo dice l'avviso su PUBLIC", () => {
    const schemi = base().schemi.map((s) => s.nome === "public" ? { ...s, crea: true, crea_diretta: [] } : s);
    const p = piano(base({ schemi, creatori: [{ schema: "public", ruolo: "PUBLIC", come: "diretto" }] }));
    expect(p.azioni).toEqual([]);
    expect(p.avvisi[0]).toContain('REVOKE CREATE ON SCHEMA "public" FROM PUBLIC');
  });

  it("uno schema posseduto da un ruolo dell'app: errore con la cura (chi lo possiede ci crea comunque)", () => {
    const schemi = base().schemi.map((s) => s.nome === "coda" ? { ...s, crea: true, di: PROPRIETARIO } : s);
    const p = piano(base({ schemi }));
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([expect.stringMatching(/lo schema coda è di cerbero_owner.*ALTER SCHEMA "coda" OWNER TO postgres/)]);
  });

  it("FleetCare senza la 0089: avviso con i GRANT esatti", () => {
    const p = piano(base({ fleetcare: base().fleetcare.map((f) => ({ ...f, chiama: false })) }));
    expect(p.azioni).toEqual([]);
    expect(p.avvisi[0]).toMatch(/migrazione 0089.*GRANT USAGE ON SCHEMA fleetcare TO "cerbero_owner".*GRANT EXECUTE ON FUNCTION fleetcare\.interventi_avm\(timestamp with time zone\)/);
    // senza FleetCare (sviluppo) nessun avviso
    expect(piano(base({ fleetcare: base().fleetcare.map((f) => ({ ...f, esiste: false, chiama: null })) })).avvisi).toEqual([]);
  });

  it("chi altro legge dati di Cerbero (FleetCare): USAGE e solo le colonne dell'elenco", () => {
    const p = piano(base({ lettori: [
      { ruolo: "fleetcare_legge_cerbero", tabella: "public.users", colonna: "email", uso: false, legge: false },
      { ruolo: "fleetcare_legge_cerbero", tabella: "public.users", colonna: "active", uso: false, legge: false },
      { ruolo: "fleetcare_legge_cerbero", tabella: "public.depots", colonna: "name", uso: false, legge: true },
    ] }));
    expect(p.azioni.map((a) => a.sql)).toEqual([
      `GRANT USAGE ON SCHEMA "public" TO "fleetcare_legge_cerbero"`,
      `GRANT SELECT ("email", "active") ON TABLE "public"."users" TO "fleetcare_legge_cerbero"`,
    ]);
  });

  it("una SECURITY DEFINER di un superutente che legge Cerbero: errore, cerbero_app non va usato", () => {
    const p = piano(base({ fughe: [{ funzione: "fleetcare.cerbero_stato_utente(uuid)", proprietario: "postgres" }] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori[0]).toMatch(/fleetcare\.cerbero_stato_utente\(uuid\) è SECURITY DEFINER di postgres.*0089.*cerbero_app non va usato/);
  });

  it("gli event trigger che fermano il DDL dell'app: si creano, si accendono sempre, si riallineano", () => {
    const manca = piano(base({ evento: {
      funzione: false, corpo: null, di_superutente: null, di_tutti: null, acceso: null, momento: null, sua: null,
      fine_acceso: null, fine_momento: null, fine_sua: null,
      riscrive_acceso: null, riscrive_momento: null, riscrive_sua: null,
    } }));
    expect(manca.azioni.map((a) => a.sql.split(" ").slice(0, 6).join(" "))).toEqual([
      "CREATE OR REPLACE FUNCTION cerbero_migrazioni.ddl_dell_app() RETURNS",
      "REVOKE ALL ON FUNCTION cerbero_migrazioni.ddl_dell_app() FROM",
      'CREATE EVENT TRIGGER "cerbero_ddl_dell_app" ON ddl_command_start',
      'ALTER EVENT TRIGGER "cerbero_ddl_dell_app" ENABLE ALWAYS',
      'CREATE EVENT TRIGGER "cerbero_ddl_dell_app_fine" ON ddl_command_end',
      'ALTER EVENT TRIGGER "cerbero_ddl_dell_app_fine" ENABLE ALWAYS',
      'CREATE EVENT TRIGGER "cerbero_ddl_dell_app_riscrive" ON table_rewrite',
      'ALTER EVENT TRIGGER "cerbero_ddl_dell_app_riscrive" ENABLE ALWAYS',
    ]);
    expect(manca.azioni[0]!.sql).toMatch(/tg_tag NOT IN \('CREATE TABLE', 'ALTER TABLE'\)/);
    expect(manca.azioni[0]!.sql).toMatch(/SET search_path = pg_catalog, pg_temp/);
    const ev = base().evento!;
    expect(piano(base({ evento: { ...ev, acceso: "D" } })).azioni.map((a) => a.sql)).toEqual(['ALTER EVENT TRIGGER "cerbero_ddl_dell_app" ENABLE ALWAYS']);
    expect(piano(base({ evento: { ...ev, corpo: "BEGIN NULL; END" } })).azioni.map((a) => a.sql.slice(0, 26))).toEqual(["CREATE OR REPLACE FUNCTION"]);
    // spazi diversi non contano
    expect(piano(base({ evento: { ...ev, corpo: CORPO_EVENTO_DDL.replace(/\n/g, "\n\n  ") } })).azioni).toEqual([]);
    expect(piano(base({ evento: { ...ev, sua: false } })).azioni.map((a) => a.sql.split(" ").slice(0, 3).join(" ")))
      .toEqual(["DROP EVENT TRIGGER", "CREATE EVENT TRIGGER", "ALTER EVENT TRIGGER"]);
    const diAltri = piano(base({ evento: { ...ev, di_superutente: false } }));
    expect(diAltri.errori[0]).toMatch(/non è di un superutente/);
    // il secondo, a fine comando
    expect(piano(base({ evento: { ...ev, fine_acceso: "D" } })).azioni.map((a) => a.sql))
      .toEqual(['ALTER EVENT TRIGGER "cerbero_ddl_dell_app_fine" ENABLE ALWAYS']);
    expect(piano(base({ evento: { ...ev, fine_momento: "ddl_command_start" } })).azioni.map((a) => a.sql.split(" ").slice(0, 6).join(" ")))
      .toEqual([
        'DROP EVENT TRIGGER "cerbero_ddl_dell_app_fine"',
        'CREATE EVENT TRIGGER "cerbero_ddl_dell_app_fine" ON ddl_command_end',
        'ALTER EVENT TRIGGER "cerbero_ddl_dell_app_fine" ENABLE ALWAYS',
      ]);
    // il terzo, sulla riscrittura delle tabelle (il registro delle modifiche, 2.10)
    expect(piano(base({ evento: { ...ev, riscrive_acceso: "R" } })).azioni.map((a) => a.sql))
      .toEqual(['ALTER EVENT TRIGGER "cerbero_ddl_dell_app_riscrive" ENABLE ALWAYS']);
    expect(piano(base({ evento: { ...ev, riscrive_momento: "ddl_command_end" } })).azioni.map((a) => a.sql.split(" ").slice(0, 3).join(" ")))
      .toEqual(["DROP EVENT TRIGGER", "CREATE EVENT TRIGGER", "ALTER EVENT TRIGGER"]);
  });

  it("PR 2.16b: all'inizio del comando l'app non passa mai; dentro le funzioni del registro solo i due comandi della manutenzione", () => {
    expect(COMANDI_DELL_APP).toEqual([]);
    expect(COMANDI_DEL_REGISTRO).toEqual(["CREATE TABLE", "ALTER TABLE"]);
    const inizio = CORPO_EVENTO_DDL.slice(CORPO_EVENTO_DDL.indexOf("IF tg_event = 'ddl_command_start' THEN"));
    const blocco = inizio.slice(0, inizio.indexOf("RETURN;"));
    // prima il rifiuto per chiunque non sia dentro una funzione del registro, poi l'elenco
    expect(blocco).toMatch(/^IF tg_event = 'ddl_command_start' THEN\s+IF current_user <> 'cerbero_registro' THEN\s+RAISE EXCEPTION 'cerbero_app non può eseguire %: lo schema lo cambiano solo le migrazioni/);
    expect(blocco).toMatch(/IF tg_tag NOT IN \('CREATE TABLE', 'ALTER TABLE'\) THEN\s+RAISE EXCEPTION/);
    expect(blocco.match(/USING ERRCODE = '42501'/g)).toHaveLength(2);
    // nessun altro comando nominato: né indici, né tabelle da una SELECT
    expect(CORPO_EVENTO_DDL).not.toMatch(/CREATE INDEX|CREATE TABLE AS|SELECT INTO/);
    // chi è «l'app» non è cambiato: la sessione di cerbero_app, o chi lavora come uno dei due ruoli
    expect(CORPO_EVENTO_DDL).toMatch(/IF NOT \(session_user = 'cerbero_app' OR current_user IN \('cerbero_owner', 'cerbero_app'\)\) THEN\s+RETURN;/);
  });

  it("la funzione degli event trigger: alla fine le espressioni con le funzioni ammesse", () => {
    expect(CORPO_EVENTO_DDL).toMatch(/IF tg_event = 'ddl_command_start' THEN/);
    expect(CORPO_EVENTO_DDL).toMatch(/pg_event_trigger_ddl_commands\(\)/);
    expect(CORPO_EVENTO_DDL).toMatch(/relpersistence <> 't'/);
    expect(CORPO_EVENTO_DDL).toMatch(/cerbero_app non può usare queste funzioni o tipi in colonne, default, vincoli o indici/);
    for (const f of FUNZIONI_AMMESSE) expect(CORPO_EVENTO_DDL).toContain(`'${f}'`);
    // niente che esegua SQL, legga file o cambi impostazioni
    for (const f of ["query_to_xml", "table_to_xml", "ts_stat", "set_config", "pg_read_file", "lo_export", "current_setting"]) {
      expect(FUNZIONI_AMMESSE.some((a) => a.startsWith(`${f}(`))).toBe(false);
    }
    // l'albero dell'espressione: funzioni, funzioni degli operatori e operatori di un confronto fra righe
    const q = sqlEspressioniVietate("$1::oid[]");
    expect(q).toMatch(/:\(\?:funcid\|opfuncid\|hashfuncid\|negfuncid\|aggfnoid\|winfnoid\)/);
    expect(q).toMatch(/:opno \(\[0-9\]\+\)/);
    expect(q).toMatch(/:opnos \[\(\]o/);
    for (const t of ["pg_attrdef", "pg_constraint", "pg_index", "pg_statistic_ext", "pg_partitioned_table"]) expect(q).toContain(`pg_catalog.${t}`);
    // e le funzioni chiamate attraverso un tipo: colonne e tipi nominati nelle espressioni, domini, array, composti, range
    expect(q).toMatch(/WITH RECURSIVE/);
    expect(q).toContain(":[a-z_]*typ(?:e|id|eid)? ([0-9]+)");
    for (const c of ["typbasetype", "typelem", "typrelid", "rngsubtype", "typinput", "typoutput", "typsubscript", "rngcanonical"]) expect(q).toContain(c);
    expect(q).toMatch(/'pg_catalog'::pg_catalog\.regnamespace,\s+'information_schema'::pg_catalog\.regnamespace/);
  });

  it("un default, un vincolo o un indice con una funzione non ammessa: errore con la cura", () => {
    const p = piano(base({ espressioni: [{
      tabella: "public.depots", oggetto: "il vincolo depots_nome_ok", funzioni: "query_to_xml(text,boolean,boolean,text)",
      cura: "ALTER TABLE public.depots DROP CONSTRAINT depots_nome_ok",
    }] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori).toHaveLength(1);
    expect(p.errori[0]).toMatch(/^public\.depots: il vincolo depots_nome_ok usa query_to_xml\(text,boolean,boolean,text\), fuori da quello che è ammesso/);
    expect(p.errori[0]).toMatch(/ALTER TABLE public\.depots DROP CONSTRAINT depots_nome_ok; finché c'è, il migratore non migra$/);
  });

  it("del registro l'app esegue quattro funzioni e legge solo le regole, mai le righe (PR 2.11)", () => {
    // scritte come le stampa regprocedure (senza spazi): leggiRegistro confronta il testo,
    // e una firma scritta in un altro modo verrebbe revocata a ogni avvio
    expect([...DA_ESEGUIRE]).toEqual([
      "registro.manutenzione()", "registro.verifica()", "registro.leggi(jsonb,integer)", "registro.stato()",
    ]);
    expect(DA_LEGGERE.filter((v) => v.startsWith("registro."))).toEqual(["registro.sorvegliate"]);
    // una funzione che non è nell'elenco (la somma dei riepiloghi) data all'app: si revoca
    const stato = base({
      ruoli: [...base().ruoli, ruolo("cerbero_registro")],
      registro: { problemi: [], diritti: [{ tipo: "FUNCTION", oggetto: "registro.somma(xid8)", a_chi: "cerbero_owner", diritto: "EXECUTE" }] },
    });
    expect(piano(stato).azioni.map((a) => a.sql)).toEqual(['REVOKE EXECUTE ON FUNCTION registro.somma(xid8) FROM "cerbero_owner"']);
  });

  it("il registro delle modifiche: diritti di cerbero_owner, nient'altro, il suo ruolo, i problemi come errori", () => {
    const reg = ruolo("cerbero_registro");
    const conRegistro = (extra: Partial<StatoRuoli> = {}) => base({
      ruoli: [...base().ruoli, reg],
      esecuzione: [
        { firma: "registro.manutenzione()", esiste: true, esegue: true },
        { firma: "registro.verifica()", esiste: true, esegue: true },
      ],
      registro: { diritti: [], problemi: [] },
      ...extra,
    });
    expect(piano(conRegistro())).toEqual({ azioni: [], attese: [], avvisi: [], errori: [] });
    // EXECUTE mancante (server nuovo: la migrazione gira prima che cerbero_owner esista)
    const senza = piano(conRegistro({ esecuzione: [{ firma: "registro.manutenzione()", esiste: true, esegue: false }] }));
    expect(senza.azioni.map((a) => a.sql)).toEqual([`GRANT EXECUTE ON FUNCTION registro.manutenzione() TO "${PROPRIETARIO}"`]);
    // diritti in più: si tolgono
    const troppi = piano(conRegistro({ registro: { problemi: [], diritti: [
      { tipo: "TABLE", oggetto: "registro.modifiche", a_chi: "cerbero_owner", diritto: "DELETE" },
      { tipo: "FUNCTION", oggetto: "registro.cattura()", a_chi: "PUBLIC", diritto: "EXECUTE" },
    ] } }));
    expect(troppi.azioni.map((a) => a.sql)).toEqual([
      'REVOKE DELETE ON TABLE registro.modifiche FROM "cerbero_owner"',
      "REVOKE EXECUTE ON FUNCTION registro.cattura() FROM PUBLIC",
    ]);
    // il ruolo: manca, o può entrare
    expect(piano(conRegistro({ ruoli: base().ruoli })).azioni.map((a) => a.sql)).toEqual(['CREATE ROLE "cerbero_registro" NOLOGIN']);
    expect(piano(conRegistro({ ruoli: [...base().ruoli, { ...reg, login: true, superutente: true }] })).azioni.map((a) => a.sql))
      .toEqual(['ALTER ROLE "cerbero_registro" NOSUPERUSER NOLOGIN']);
    // i problemi di registro.verifica(): errori
    const spento = piano(conRegistro({ registro: { diritti: [], problemi: ["public.users: il trigger registro_cambia del registro non è acceso sempre (D)"] } }));
    expect(spento.errori).toEqual(["registro delle modifiche: public.users: il trigger registro_cambia del registro non è acceso sempre (D)"]);
    // un'appartenenza al ruolo del registro: errore
    const membro = piano(conRegistro({ appartenenze: [...base().appartenenze,
      { ruolo: "cerbero_registro", membro: APP, admin: false, eredita: true, imposta: true }] }));
    expect(membro.errori[0]).toMatch(/cerbero_app è membro di cerbero_registro: non previsto/);
    // senza registro (prima della 0006) non si chiede niente
    expect(piano(base({ registro: null })).azioni).toEqual([]);
  });

  it("l'event trigger: l'app non spegne i trigger del registro e non sostituisce una tabella sorvegliata", () => {
    expect(CORPO_EVENTO_DDL).toContain("pg_catalog.to_regclass('registro.sorvegliate') IS NOT NULL");
    expect(CORPO_EVENTO_DDL).toContain("t.tgname LIKE 'registro\\_%' AND t.tgenabled <> 'A'");
    expect(CORPO_EVENTO_DDL).toContain("<> EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'registro_inserisce')");
    expect(CORPO_EVENTO_DDL).toContain("x.object_type = 'table column'");
    expect(CORPO_EVENTO_DDL).toMatch(/non può rinominare le colonne di una tabella del registro delle modifiche/);
    expect(CORPO_EVENTO_DDL).toMatch(/IF tg_event = 'table_rewrite' THEN/);
    expect(CORPO_EVENTO_DDL).toContain("pg_event_trigger_table_rewrite_oid()");
    expect(CORPO_EVENTO_DDL).toMatch(/non può legare per ereditarietà o come partizione una tabella del registro/);
    expect(CORPO_EVENTO_DDL).toContain("(i.inhrelid = ANY (tabelle) OR i.inhparent = ANY (tabelle))");
  });

  it("una relazione di un superutente fuori dal catalogo: avviso (l'app non la usa), con le due cure", () => {
    const p = piano(base({ estranee: [{ nome: "public.users_backup_20261108", tipo: "r", proprietario: "postgres" }] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([]);
    expect(p.avvisi[0]).toMatch(/public\.users_backup_20261108 è di postgres \(superutente\) e non è nel catalogo/);
    expect(p.avvisi[0]).toMatch(/DROP TABLE "public"\."users_backup_20261108".*OWNER TO "cerbero_owner"/);
  });

  it("un altro ruolo che può creare negli schemi dei dati: avviso con la cura, non un errore", () => {
    // caronte_app, finché Caronte crea la sua tabella a ogni login (caronte_setup.sql)
    const p = piano(base({ creatori: [{ schema: "caronte", ruolo: "caronte_app" }, { schema: "public", ruolo: "PUBLIC" }] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([]);
    expect(p.avvisi).toHaveLength(2);
    expect(p.avvisi[0]).toMatch(/^caronte_app può creare tabelle e funzioni nello schema caronte/);
    expect(p.avvisi[0]).toContain('REVOKE CREATE ON SCHEMA "caronte" FROM "caronte_app"');
    expect(p.avvisi[1]).toMatch(/^tutti i ruoli \(PUBLIC\) possono creare/);
    expect(p.avvisi[1]).toContain('REVOKE CREATE ON SCHEMA "public" FROM PUBLIC');
    // il nome di un ruolo finisce in un'istruzione da copiare: sempre fra virgolette
    expect(piano(base({ creatori: [{ schema: "caronte", ruolo: 'x"; DROP' }] })).avvisi[0]).toContain('FROM "x""; DROP"');
  });

  it("chi può creare senza un diritto dato a lui: la revoca non servirebbe, la cura è un'altra", () => {
    const p = piano(base({ creatori: [
      { schema: "caronte", ruolo: "caronte_app", come: "diretto" },
      { schema: "caronte", ruolo: "erede", come: "ereditato" },
      { schema: "coda", ruolo: "padrone", come: "proprietario" },
    ] }));
    expect(p.errori).toEqual([]);
    expect(p.avvisi[0]).toContain('REVOKE CREATE ON SCHEMA "caronte" FROM "caronte_app"');
    expect(p.avvisi[1]).toMatch(/^erede può creare .*gli viene da un ruolo di cui è membro/);
    expect(p.avvisi[1]).not.toContain("REVOKE");
    expect(p.avvisi[2]).toMatch(/^padrone può creare .*è il proprietario dello schema: ALTER SCHEMA "coda" OWNER TO postgres/);
    expect(p.avvisi[2]).not.toContain("REVOKE");
  });

  it("un'espressione non ammessa su una tabella di un altro programma (caronte.app_users): avviso, con chi la eseguirebbe", () => {
    const p = piano(base({ espressioniDiAltri: [{
      tabella: "caronte.app_users", proprietario: "caronte_app", oggetto: "il vincolo rv_pin",
      cura: "ALTER TABLE caronte.app_users DROP CONSTRAINT rv_pin", funzioni: "query_to_xml(text,boolean,boolean,text)",
    }] }));
    // non un errore: le funzioni ammesse sono quelle delle tabelle di Cerbero, e la verifica non deve fermare il rilascio
    expect(p.errori).toEqual([]);
    expect(p.azioni).toEqual([]);
    expect(p.avvisi).toHaveLength(1);
    expect(p.avvisi[0]).toMatch(/^caronte\.app_users \(di caronte_app, non di Cerbero\): il vincolo rv_pin usa query_to_xml/);
    expect(p.avvisi[0]).toMatch(/come superutente chi scrive in quella tabella da superutente o ripristina un backup/);
    expect(p.avvisi[0]).toContain("ALTER TABLE caronte.app_users DROP CONSTRAINT rv_pin");
  });

  /* Una colonna calcolata è una regola (users.mfa_obbligatoria, PR 2.12). L'app
   * possiede la tabella: non può riscriverla, ma può togliere l'espressione
   * alla colonna (DROP EXPRESSION) e scriverci, o togliere la colonna. */
  const attesa = { tabella: "public.users", colonna: "mfa_obbligatoria", tipo: "boolean", nonNulla: true, espressione: "(role = 'admin'::text)" };
  it("una colonna calcolata com'è nel catalogo: niente da dire", () => {
    expect(piano(base({ calcolate: [{ ...attesa, esiste: true, calcolata: true, viva: attesa.espressione }] })))
      .toEqual({ azioni: [], attese: [], avvisi: [], errori: [] });
  });

  it("una colonna calcolata che non lo è più, che manca o con un'altra espressione: errore con l'istruzione per rifarla", () => {
    const p = piano(base({ calcolate: [
      { ...attesa, esiste: true, calcolata: false, viva: null },
      { ...attesa, colonna: "tolta", esiste: false, calcolata: false, viva: null },
      { ...attesa, colonna: "cambiata", nonNulla: false, esiste: true, calcolata: true, viva: "false" },
    ] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori).toHaveLength(3);
    expect(p.errori[0]).toMatch(/^public\.users\.mfa_obbligatoria non è più calcolata dal database/);
    expect(p.errori[0]).toContain('ALTER TABLE "public"."users" DROP COLUMN "mfa_obbligatoria", '
      + 'ADD COLUMN "mfa_obbligatoria" boolean NOT NULL GENERATED ALWAYS AS ((role = \'admin\'::text)) STORED');
    expect(p.errori[1]).toMatch(/^public\.users\.tolta manca/);
    expect(p.errori[1]).toContain('ALTER TABLE "public"."users" ADD COLUMN "tolta" boolean NOT NULL GENERATED');
    expect(p.errori[1]).not.toContain("DROP COLUMN");
    expect(p.errori[2]).toMatch(/^public\.users\.cambiata è calcolata con un'espressione diversa/);
    expect(p.errori[2]).toContain('ADD COLUMN "cambiata" boolean GENERATED ALWAYS AS');
  });

  it("le colonne calcolate dal catalogo: tabella, colonna, tipo ed espressione, anche con « | » dentro", () => {
    expect(calcolateDalCatalogo({ tabelle: {
      "public.users": { id: "uuid | not null | gen_random_uuid() |  | ", mfa_obbligatoria: "boolean | not null | (role = 'admin'::text) |  | s" },
      "public.a": { bit: "integer | null | (x | y) |  | s", identita: "bigint | not null |  | a | " },
    } })).toEqual([
      { tabella: "public.a", colonna: "bit", tipo: "integer", nonNulla: false, espressione: "(x | y)" },
      { tabella: "public.users", colonna: "mfa_obbligatoria", tipo: "boolean", nonNulla: true, espressione: "(role = 'admin'::text)" },
    ]);
    expect(calcolateDalCatalogo({})).toEqual([]);
    // nel catalogo vero c'è, ed è l'unica
    const vero = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../lib/db/migrations/meta/catalogo.json", import.meta.url)), "utf8"));
    expect(calcolateDalCatalogo(vero).map((c) => `${c.tabella}.${c.colonna}`)).toEqual(["public.users.mfa_obbligatoria"]);
  });

  it("le colonne calcolate si controllano solo se il database è alla migrazione di questo codice", () => {
    const catalogo = { tabelle: { "public.users": { mfa_obbligatoria: "boolean | not null | (role = 'admin'::text) |  | s" } } };
    const diario = [{ tag: "0007_x", when: 7 }, { tag: "0008_mfa_obbligatoria", when: 8 }];
    const alla = (...quando: number[]) => quando.map((created_at) => ({ created_at }));
    // alla stessa migrazione: si controllano
    expect(calcolateDaControllare(catalogo, diario, alla(7, 8))).toEqual({
      calcolate: [{ tabella: "public.users", colonna: "mfa_obbligatoria", tipo: "boolean", nonNulla: true, espressione: "(role = 'admin'::text)" }],
      avviso: null,
    });
    // avanti (un'immagine precedente dopo un rollback): l'espressione può essere più nuova. Dirla «diversa»
    // e stampare l'istruzione per rifarla riporterebbe la regola a quella vecchia
    const avanti = calcolateDaControllare(catalogo, diario, alla(7, 8, 9));
    expect(avanti.calcolate).toEqual([]);
    expect(avanti.avviso).toMatch(/una migrazione più nuova di questo codice.*non vanno toccate da qui/);
    expect(calcolateDaControllare(catalogo, diario, alla(7, 8, 9, 10)).avviso).toMatch(/2 migrazioni più nuove/);
    // indietro: la colonna manca perché manca la migrazione. Si migra, non si aggiunge a mano
    const indietro = calcolateDaControllare(catalogo, diario, alla(7));
    expect(indietro.calcolate).toEqual([]);
    expect(indietro.avviso).toMatch(/mancano migrazioni \(0008_mfa_obbligatoria\).*Prima il migratore/);
    expect(calcolateDaControllare(catalogo, diario, []).avviso).toMatch(/mancano migrazioni \(0007_x, 0008_mfa_obbligatoria\)/);
    // in nessuno dei due casi un'istruzione da eseguire
    for (const a of [avanti.avviso, indietro.avviso]) expect(a).not.toMatch(/ALTER TABLE/);
  });

  it("una vista che dipende da una relazione di un altro ruolo: errore, non un'attesa infinita", () => {
    const p = piano(base({ relazioni: [
      rel("caronte.stop_predictions", { proprietario: "avm_esterno" }),
      daPostgres(rel("public.v_avm", { tipo: "v", basi: [{ nome: "caronte.stop_predictions", proprietario: "avm_esterno" }] })),
    ] }));
    expect(p.attese).toEqual([]);
    expect(p.errori.join(" ")).toMatch(/public\.v_avm dipende da caronte\.stop_predictions \(di avm_esterno\)/);
  });

  it("le relazioni dal catalogo: tabelle, viste e sequenze, senza le escluse", () => {
    expect(elencoDalCatalogo({
      tabelle: { "public.users": {}, "caronte.app_users": {} }, viste: { "public.ps_variants": "…" },
      sequenze: { "public.accessi_log_id_seq": {} }, indici: { "public.x_pkey": "…" },
    } as any)).toEqual(["public.accessi_log_id_seq", "public.ps_variants", "public.users"]);
  });
});

describe("ruoli del database: esecuzione", () => {
  /** Client finto: risponde allo stato leggendo `stato` e applica gli ALTER ... OWNER. */
  function finto(stato: StatoRuoli, { occupate = new Set<string>(), ritardo = 0 } = {}) {
    const eseguite: string[] = [];
    let ora = 0;
    const client = {
      eseguite,
      adesso: () => ora,
      async query(sql: string) {
        if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }] };
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql) || /pg_advisory_unlock/.test(sql)) return { rows: [] };
        const m = /^ALTER (TABLE|VIEW|SEQUENCE) "(\w+)"\."(\w+)" OWNER TO/.exec(sql);
        if (m) {
          ora += ritardo;
          const voce = `${m[2]}.${m[3]}`;
          if (occupate.has(voce)) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
          eseguite.push(sql);
          stato.relazioni = stato.relazioni.map((r) => (`${r.schema}.${r.nome}` === voce
            ? { ...r, proprietario: PROPRIETARIO, di_superutente: false }
            : { ...r, basi: r.basi.map((b) => (b.nome === voce ? { ...b, proprietario: PROPRIETARIO } : b)) }));
          return { rows: [] };
        }
        // le letture di leggiStato, dallo stato corrente (le più specifiche prima)
        if (/to_regnamespace\(\$1\) IS NOT NULL AS c/.test(sql)) return { rows: [{ c: !!stato.registro }] };
        if (/aclexplode/.test(sql)) return { rows: stato.registro?.diritti ?? [] };
        if (/to_regprocedure\(\$1\) IS NOT NULL AS c/.test(sql)) return { rows: [{ c: true }] };
        if (/verifica\(\) AS v/.test(sql)) return { rows: (stato.registro?.problemi ?? []).map((problema) => ({ problema })) };
        if (/AS esegue/.test(sql)) return { rows: stato.esecuzione ?? [] };
        if (/AS funzioni/.test(sql)) return { rows: stato.espressioni ?? [] };
        if (/<> ALL \(\$2::text\[\]\)/.test(sql)) return { rows: stato.estranee ?? [] };
        if (/has_column_privilege/.test(sql)) return { rows: stato.lettori ?? [] };
        if (/pg_event_trigger/.test(sql)) return { rows: [stato.evento] };
        if (/AS funzione/.test(sql)) return { rows: stato.fughe ?? [] };
        if (/current_user AS utente/.test(sql)) return { rows: [stato.io] };
        if (/FROM pg_catalog.pg_roles r WHERE rolname/.test(sql)) return { rows: stato.ruoli };
        if (/pg_auth_members/.test(sql)) return { rows: stato.appartenenze };
        if (/AS connette/.test(sql)) return { rows: [stato.database] };
        if (/pg_namespace n ON n.nspname = s.nome/.test(sql)) return { rows: stato.schemi };
        if (/AS legge/.test(sql)) return { rows: stato.lettura };
        if (/AS legata/.test(sql)) return { rows: stato.relazioni.map((r) => ({ ...r, basi: r.basi.map((b) => `${b.nome}|${b.proprietario}`) })) };
        if (/AS chiama/.test(sql)) return { rows: stato.fleetcare };

        throw new Error(`query inattesa: ${sql.slice(0, 60)}`);
      },
    };
    return client;
  }
  const daSpostare = () => base({ relazioni: [
    daPostgres(rel("public.users")), daPostgres(rel("public.ps_route_variants")),
    daPostgres(rel("public.ps_variants", { tipo: "v", basi: [{ nome: "public.ps_route_variants", proprietario: "postgres" }] })),
  ] });

  it("tabelle, poi la vista nel secondo giro; poi è tutto in regola", async () => {
    const c = finto(daSpostare());
    const e = await allinea(c, [], { adesso: c.adesso });
    expect(c.eseguite).toEqual([
      `ALTER TABLE "public"."users" OWNER TO "${PROPRIETARIO}"`,
      `ALTER TABLE "public"."ps_route_variants" OWNER TO "${PROPRIETARIO}"`,
      `ALTER VIEW "public"."ps_variants" OWNER TO "${PROPRIETARIO}"`,
    ]);
    expect(e).toMatchObject({ errori: [], daFare: [], occupate: [], rimandate: [] });
  });

  it("una tabella occupata si salta, e la vista che dipende da lei aspetta", async () => {
    const c = finto(daSpostare(), { occupate: new Set(["public.ps_route_variants"]) });
    const e = await allinea(c, [], { adesso: c.adesso });
    expect(c.eseguite).toEqual([`ALTER TABLE "public"."users" OWNER TO "${PROPRIETARIO}"`]);
    expect(e.errori).toEqual([]);
    expect(e.avvisi.join(" ")).toMatch(/oggetti occupati.*public\.ps_route_variants/);
    expect(e.avvisi.join(" ")).toMatch(/in attesa: public\.ps_variants/);
  });

  it("oltre il tetto di tempo non comincia altre istruzioni", async () => {
    const c = finto(daSpostare(), { ritardo: 20_000 });
    const e = await allinea(c, [], { tettoMs: 25_000, adesso: c.adesso });
    // 20 s a istruzione: le due tabelle sì (cominciate entro 25 s), la vista del secondo giro no
    expect(c.eseguite).toHaveLength(2);
    expect(e.rimandate.map((a) => a.oggetto)).toEqual(["public.ps_variants"]);
    const c2 = finto(daSpostare(), { ritardo: 30_000 });
    const e2 = await allinea(c2, [], { tettoMs: 25_000, adesso: c2.adesso });
    expect(c2.eseguite).toHaveLength(1);
    expect(e2.rimandate.map((a) => a.oggetto)).toEqual(["public.ps_route_variants"]);
    expect(e2.avvisi.join(" ")).toMatch(/tempo finito/);
  });
});

describe("la password di cerbero_app (ruoli.mjs --imposta-password)", () => {
  it("una password nuova: 48 cifre e lettere da a a f, niente da codificare in un URL", () => {
    const a = nuovaPassword(), b = nuovaPassword();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(b).not.toBe(a);
    expect(encodeURIComponent(a)).toBe(a);
  });

  it("l'impronta SCRAM-SHA-256 è quella dello standard (vettore della RFC 7677)", () => {
    // utente «user», password «pencil», sale e scambio della RFC 7677, sezione 3
    const sale = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
    const impronta = improntaScram("pencil00", sale);
    expect(impronta).toMatch(/^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(GIRI_SCRAM).toBe(4096);

    // «pencil» ha 6 caratteri, meno del minimo: il vettore si prova a mano con le stesse operazioni
    const vettore = (() => {
      const salata = pbkdf2Sync("pencil", sale, 4096, 32, "sha256");
      const firma = (chiave: Buffer, testo: string) => createHmac("sha256", chiave).update(testo).digest();
      const chiaveCliente = firma(salata, "Client Key");
      const chiaveSalvata = createHash("sha256").update(chiaveCliente).digest();
      const messaggio = "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,"
        + "s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
      const firmaCliente = firma(chiaveSalvata, messaggio);
      const prova = Buffer.from(chiaveCliente.map((b, i) => b ^ firmaCliente[i]!));
      return { prova: prova.toString("base64"), server: firma(firma(salata, "Server Key"), messaggio).toString("base64") };
    })();
    expect(vettore.prova).toBe("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
    expect(vettore.server).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
  });

  it("l'impronta: stessa password e stesso sale danno lo stesso risultato, un sale nuovo a ogni chiamata", () => {
    const sale = Buffer.alloc(16, 7);
    expect(improntaScram("0123456789abcdef", sale)).toBe(improntaScram("0123456789abcdef", sale));
    expect(improntaScram("0123456789abcdef", sale)).not.toBe(improntaScram("0123456789abcdeg", sale));
    expect(improntaScram("0123456789abcdef")).not.toBe(improntaScram("0123456789abcdef"));
    // la chiave salvata e quella del server di un'impronta sono quelle che PostgreSQL ricalcola al login
    const [, resto] = improntaScram("0123456789abcdef", sale).split("$4096:");
    const [saleB64, chiavi] = resto!.split("$");
    expect(saleB64).toBe(sale.toString("base64"));
    expect(chiavi!.split(":")).toHaveLength(2);
  });

  it("l'impronta rifiuta ciò che PostgreSQL normalizzerebbe: caratteri non ASCII, spazi, password corte", () => {
    for (const p of ["", "corta", "con uno spazio", "perché-no-1234", "tab\tdentro12"]) {
      expect(() => improntaScram(p)).toThrow(/almeno 8 caratteri ASCII/);
    }
    expect(() => improntaScram(undefined as unknown as string)).toThrow();
    // un sale vuoto, corto o che non è un Buffer, o meno iterazioni: PostgreSQL salverebbe un'impronta con cui non si entra, o debole
    for (const sale of [Buffer.alloc(0), Buffer.alloc(8, 1), "W22ZaJ0SNY7soEsUEjb6gQ==" as unknown as Buffer]) {
      expect(() => improntaScram("0123456789abcdef", sale)).toThrow(/sale deve essere un Buffer di almeno 16 byte/);
    }
    for (const giri of [0, 1000, 4096.5, Number.NaN]) {
      expect(() => improntaScram("0123456789abcdef", Buffer.alloc(16, 1), giri)).toThrow(/iterazioni devono essere almeno 4096/);
    }
    expect(improntaScram("0123456789abcdef", Buffer.alloc(16, 1), 8192)).toMatch(/^SCRAM-SHA-256\$8192:/);
  });

  it("l'URL dell'app è quello del migratore con utente e password cambiati, il resto uguale", () => {
    expect(urlDellApp("postgres://postgres:vecchia@db-interno:5432/postgres", "cerbero_app", "abc123"))
      .toBe("postgres://cerbero_app:abc123@db-interno:5432/postgres");
    // una password vecchia con caratteri codificati, i parametri, lo schema lungo, un host IPv6
    expect(urlDellApp("postgresql://postgres:p%40ss%3Aw%2Frd@db:6543/cerbero?sslmode=require", "cerbero_app", "abc123"))
      .toBe("postgresql://cerbero_app:abc123@db:6543/cerbero?sslmode=require");
    expect(urlDellApp("postgres://postgres:x@[fd07::11]:5432/postgres", "cerbero_app", "abc123"))
      .toBe("postgres://cerbero_app:abc123@[fd07::11]:5432/postgres");
    // senza password nell'URL del migratore
    expect(urlDellApp("postgres://postgres@db/postgres", "cerbero_app", "abc123")).toBe("postgres://cerbero_app:abc123@db/postgres");
  });

  it("l'URL dell'app non si inventa: senza host, con un altro schema o illeggibile è un errore", () => {
    expect(() => urlDellApp("postgres:///postgres?host=/var/run/postgresql", "cerbero_app", "abc123")).toThrow(/non ha un host/);
    expect(() => urlDellApp("mysql://root:x@db/app", "cerbero_app", "abc123")).toThrow(/postgres:\/\/ o postgresql:\/\//);
    expect(() => urlDellApp("non un url", "cerbero_app", "abc123")).toThrow(/non si legge come URL/);
    // l'errore non ripete l'URL, che contiene la password del superutente
    try { urlDellApp("mysql://root:segretissima@db/app", "cerbero_app", "abc123"); } catch (e) { expect(String(e)).not.toContain("segretissima"); }
  });
});

describe("caronte_setup.sql: il ruolo di Caronte", () => {
  const sql = readFileSync(fileURLToPath(new URL("../../../../caronte_setup.sql", import.meta.url)), "utf8");
  const senzaCommenti = sql.replace(/^\s*--.*$/gm, "");
  /** L'elenco di tabelle del ciclo che esegue quel GRANT (l'ARRAY che lo precede). */
  const elenco = (grant: string) => {
    const fine = senzaCommenti.indexOf(grant);
    const inizio = senzaCommenti.lastIndexOf("ARRAY ARRAY[", fine);
    expect(fine).toBeGreaterThan(0);
    expect(inizio).toBeGreaterThan(0);
    return senzaCommenti.slice(inizio + "ARRAY ARRAY[".length, senzaCommenti.indexOf("]", inizio))
      .split(",").map((v) => v.trim().replace(/'/g, "")).filter(Boolean);
  };
  const catalogo = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../lib/db/migrations/meta/catalogo.json", import.meta.url)), "utf8"));

  it("tutto in una transazione: fra il REVOKE e i GRANT Caronte non resta senza permessi", () => {
    const istruzioni = senzaCommenti.split(/;\s*$/m).map((i) => i.trim()).filter(Boolean);
    expect(istruzioni[0]).toMatch(/^SET search_path = pg_catalog, pg_temp$/);
    expect(istruzioni[1]).toBe("BEGIN");
    expect(istruzioni.at(-1)).toBe("COMMIT");
    expect(senzaCommenti.match(/\bCOMMIT\b/g)).toHaveLength(1);
  });

  it("scrive solo le tabelle del validatore, legge le altre di caronte e le GTFS: tutte nel catalogo", () => {
    const scrive = elenco("GRANT SELECT, INSERT, UPDATE, DELETE ON caronte.%I"), legge = elenco("GRANT SELECT ON caronte.%I");
    const gtfs = elenco("GRANT SELECT ON public.%I");
    expect(legge).toContain("avm_diario");
    expect(legge.filter((t) => scrive.includes(t))).toEqual([]);
    expect(scrive).toEqual(["tap_events", "journeys", "vehicle_positions", "active_trips", "stop_transits"]);
    for (const t of [...scrive, ...legge]) expect(Object.keys(catalogo.tabelle)).toContain(`caronte.${t}`);
    for (const t of gtfs) {
      expect(t).toMatch(/^gtfs_/);
      expect(Object.keys(catalogo.tabelle)).toContain(`public.${t}`);
    }
    // niente utenti, anagrafica, roster, registro: né per nome né con un GRANT su tutto lo schema
    expect(senzaCommenti).not.toMatch(/GRANT[^;]*ON ALL TABLES/i);
    expect(senzaCommenti).not.toMatch(/GRANT[^;]*\b(users|roster_|accessi_|registro)\b/i);
  });

  it("app_users è di Caronte: ne diventa proprietario, e a ciò che è suo si ridanno i diritti dopo il REVOKE", () => {
    const fine = senzaCommenti.slice(senzaCommenti.indexOf("REVOKE ALL ON ALL TABLES IN SCHEMA caronte"));
    // solo se la tabella c'è: su un database nuovo la crea Caronte al primo login
    expect(fine).toMatch(/IF to_regclass\('caronte\.app_users'\) IS NOT NULL THEN\s*ALTER TABLE caronte\.app_users OWNER TO caronte_app;\s*END IF;/);
    // tutte le relazioni di caronte_app nello schema, non solo app_users: il REVOKE toglie i diritti anche al proprietario
    expect(fine).toMatch(/n\.nspname = 'caronte' AND c\.relowner = 'caronte_app'::regrole/);
    expect(fine).toMatch(/GRANT ALL ON %s %s TO caronte_app/);
    expect(fine.indexOf("GRANT ALL ON %s %s TO caronte_app")).toBeGreaterThan(fine.indexOf("ALTER TABLE caronte.app_users OWNER TO caronte_app"));
    // e solo a ciò che è suo: nessun GRANT ALL su una tabella nominata
    expect(senzaCommenti).not.toMatch(/GRANT ALL ON (TABLE )?(caronte|public)\./);
  });

  it("può creare in caronte (Caronte crea la sua tabella a ogni login), e solo lì", () => {
    const revoca = senzaCommenti.indexOf("REVOKE CREATE ON SCHEMA caronte FROM caronte_app");
    const concede = senzaCommenti.indexOf("GRANT CREATE ON SCHEMA caronte TO caronte_app");
    expect(revoca).toBeGreaterThan(0);
    expect(concede).toBeGreaterThan(revoca);
    expect(senzaCommenti).not.toMatch(/GRANT[^;]*CREATE[^;]*ON SCHEMA public/i);
    expect(senzaCommenti).not.toMatch(/SUPERUSER|CREATEROLE|BYPASSRLS/i);
    // come si toglie è scritto nel file
    expect(sql).toContain("REVOKE CREATE ON SCHEMA caronte FROM caronte_app;");
  });
});
