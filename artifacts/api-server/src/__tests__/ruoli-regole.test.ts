/* I ruoli del database (PR 2.8): il piano puro di lib/db/scripts/ruoli-regole.mjs
 * e l'esecuzione con un client finto (un'istruzione per transazione, oggetti
 * occupati saltati, tetto di tempo). Sul database vero lo provano la CI
 * (migrazioni-postgres) e lo script locale della PR. */
import { describe, it, expect } from "vitest";
import {
  APP, CORPO_EVENTO_DDL, FUNZIONI_AMMESSE, PROPRIETARIO, allinea, elencoDalCatalogo, piano, sqlEspressioniVietate,
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
    database: { connette: true, temporanee: true },
    schemi: ["public", "caronte", "coda", "cerbero_migrazioni"].map((nome) => ({ nome, esiste: true, uso: true, crea: true })),
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
      ruoli: [], appartenenze: [], database: { connette: null, temporanee: null },
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
    expect(sql).toContain(`GRANT USAGE, CREATE ON SCHEMA "public" TO "${PROPRIETARIO}"`);
    expect(sql).toContain(`GRANT USAGE ON SCHEMA "cerbero_migrazioni" TO "${PROPRIETARIO}"`);
    expect(sql).toContain(`GRANT SELECT ON TABLE "cerbero_migrazioni"."__drizzle_migrations" TO "${PROPRIETARIO}"`);
    // niente CREATE su cerbero_migrazioni: il contratto di Argos lo scrive solo chi migra
    expect(sql.some((s) => /CREATE ON SCHEMA "cerbero_migrazioni"/.test(s))).toBe(false);
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

  it("senza il ruolo di sessione, CONNECT o TEMPORARY: si ridanno", () => {
    const p = piano(base({ ruoli: [ruolo(PROPRIETARIO), ruolo(APP, { col_ruolo: false })], database: { connette: false, temporanee: false } }));
    expect(p.azioni.map((a) => a.sql)).toEqual([
      `ALTER ROLE "${APP}" SET role = '${PROPRIETARIO}'`,
      `GRANT CONNECT ON DATABASE "postgres" TO "${APP}"`,
      `GRANT TEMPORARY ON DATABASE "postgres" TO "${PROPRIETARIO}"`,
    ]);
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
    } }));
    expect(manca.azioni.map((a) => a.sql.split(" ").slice(0, 6).join(" "))).toEqual([
      "CREATE OR REPLACE FUNCTION cerbero_migrazioni.ddl_dell_app() RETURNS",
      "REVOKE ALL ON FUNCTION cerbero_migrazioni.ddl_dell_app() FROM",
      'CREATE EVENT TRIGGER "cerbero_ddl_dell_app" ON ddl_command_start',
      'ALTER EVENT TRIGGER "cerbero_ddl_dell_app" ENABLE ALWAYS',
      'CREATE EVENT TRIGGER "cerbero_ddl_dell_app_fine" ON ddl_command_end',
      'ALTER EVENT TRIGGER "cerbero_ddl_dell_app_fine" ENABLE ALWAYS',
    ]);
    expect(manca.azioni[0]!.sql).toMatch(/tg_tag NOT IN \('CREATE TABLE', 'CREATE TABLE AS', 'CREATE INDEX', 'ALTER TABLE'\)/);
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
  });

  it("la funzione dei due event trigger: all'inizio i comandi, alla fine le espressioni con le funzioni ammesse", () => {
    expect(CORPO_EVENTO_DDL).toMatch(/IF tg_event = 'ddl_command_start' THEN/);
    expect(CORPO_EVENTO_DDL).toMatch(/tg_tag = 'CREATE INDEX' AND coalesce\(pg_catalog\.current_query\(\), ''\) ~\* '\\mconcurrently\\M'/);
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

  it("una relazione di un superutente fuori dal catalogo: avviso (l'app non la usa), con le due cure", () => {
    const p = piano(base({ estranee: [{ nome: "public.users_backup_20261108", tipo: "r", proprietario: "postgres" }] }));
    expect(p.azioni).toEqual([]);
    expect(p.errori).toEqual([]);
    expect(p.avvisi[0]).toMatch(/public\.users_backup_20261108 è di postgres \(superutente\) e non è nel catalogo/);
    expect(p.avvisi[0]).toMatch(/DROP TABLE "public"\."users_backup_20261108".*OWNER TO "cerbero_owner"/);
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
