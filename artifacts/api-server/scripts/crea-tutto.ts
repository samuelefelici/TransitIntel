/**
 * crea-tutto — esegue TUTTO il DDL che l'API fa da sola a runtime, su DATABASE_URL.
 *
 *   DATABASE_URL=postgresql://… pnpm --filter @workspace/api-server exec tsx scripts/crea-tutto.ts
 *     [--registro=istruzioni.json]   tutte le istruzioni eseguite, per unità
 *     [--anche-con-dati]             anche su un database con utenti (v. sotto)
 *
 * Serve a confrontare lo schema che il codice si aspetta con quello della
 * produzione (lib/db/scripts/catalogo.mjs): su un database nato dal baseline,
 * ogni differenza dopo questo script è qualcosa che il codice crea e la
 * produzione non ha. Tre parti, nell'ordine:
 *
 *  1. AVVIO — i 9 moduli che all'import lanciano il loro DDL con `void ensureX()`.
 *     Si importano uno alla volta e si aspetta che il database torni fermo
 *     (nessuna query in corso): solo dopo si richiama la loro funzione, che
 *     di solito non fa più niente (flag `bootstrapped`) e altrimenti riprova.
 *  2. PIGRE — le funzioni ensure…, assicura…, repairSchema che l'API chiama al
 *     primo uso, in un ordine che rispetta le dipendenze fra tabelle.
 *  3. RICHIESTA — il DDL eseguito dentro singole richieste (16 punti): non sta
 *     in una funzione richiamabile, quindi qui c'è la stessa istruzione copiata
 *     dal sorgente, con file:riga.
 *
 * Gli errori si leggono sotto drizzle, al livello del client `pg`: quasi tutte
 * le funzioni dell'API li inghiottono (try/catch con un console.error), quindi
 * una `await` riuscita non vuol dire che il DDL sia andato.
 *
 * Esce con 1 se una qualunque istruzione è fallita o se c'è un file con DDL che
 * l'elenco COPERTURA non nomina; con 0 altrimenti. Termina il processo da sé:
 * lib/planning-studio.ts all'import avvia un setInterval.
 *
 * Le preparazioni dell'API toccano anche i dati (permessi degli utenti,
 * proprietari dei feed, password pubblicate, festivi…): su un database con
 * utenti lo script si rifiuta, a meno di --anche-con-dati.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

/* ── Ambiente: prima di qualunque import dell'API (gli import qui sotto sono dinamici) ── */
if (!process.env.DATABASE_URL) {
  console.error("crea-tutto: DATABASE_URL obbligatoria");
  process.exit(2);
}
process.env.NODE_ENV ||= "development";
/* in sviluppo auth.ts e mfa-cifratura.ts ne ricavano una fissa; in produzione servono */
process.env.JWT_SECRET ||= `crea-tutto-${randomBytes(16).toString("hex")}`;
process.env.CERBERO_CHIAVE_MFA ||= randomBytes(32).toString("hex");
/* niente primo amministratore creato da qui */
for (const k of ["CERBERO_ADMIN_EMAIL", "CERBERO_ADMIN_PASSWORD", "CERBERO_ADMIN_RIPRISTINA"]) delete process.env[k];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ancheConDati = process.argv.includes("--anche-con-dati");
/* --registro=file.json: tutte le istruzioni eseguite, con unità ed eventuale errore */
const fileRegistro = process.argv.find(a => a.startsWith("--registro="))?.slice("--registro=".length);

/* ── Che cosa copre ogni file sorgente che contiene DDL ──────────────────────
 * Controllato alla fine contro i sorgenti veri: un file con DDL che manca qui
 * fa uscire con errore. */
const COPERTURA: Record<string, string[]> = {
  "lib/auth.ts": ["avvio: ensureUsersTable (preparaUtenti)"],
  "lib/tenant.ts": ["avvio: ensureTenantColumns"],
  "lib/scheduling-projects.ts": ["avvio: ensureSchedulingTables"],
  "lib/planning-studio.ts": ["avvio: ensurePsTables"],
  "routes/fares-polimetriche.ts": ["avvio: ensureTables (polim_*)"],
  "routes/planning.ts": ["avvio: ensureNewTables"],
  "routes/fares.ts": ["avvio: ensurePolimetricheSnapshotsTable"],
  "routes/gtfs-upload.ts": ["avvio: ensureFeedActiveColumn"],
  "routes/fares-node-assignment.ts": ["avvio: ensureNodeAssignmentTables"],
  "lib/caronte-schema.ts": ["pigra: repairSchema / ensureCaronteSchema"],
  "lib/avm-diario-store.ts": ["pigra: assicura (caronte.avm_diario)"],
  "lib/avm-controllo-store.ts": ["pigra: assicura (caronte.avm_controllo_settimanale)"],
  "lib/journey-codes-store.ts": ["pigra: assicura (caronte.journey_codes)"],
  "lib/stop-alias-overrides.ts": ["pigra: assicura (caronte.stop_alias_overrides)"],
  "lib/stop-predictions-store.ts": ["pigra: assicura (caronte.stop_predictions)"],
  "lib/anagrafica-store.ts": ["pigra: assicuraAnagrafica (crea, aggiungiColonne)", "pigra: verificaUnicitaMatricole"],
  "lib/roster-rotazioni.ts": ["pigra: ensureTable (rotazioni)"],
  "lib/roster-pubblicazione-db.ts": ["pigra: assicuraPubblicazione"],
  "lib/planning-studio-calendar.ts": ["pigra: ensureTable (ps_calendar_profiles)"],
  "lib/planning-studio-validity-categories.ts": ["pigra: ensureValidityCategoryCalendarSchema", "pigra: ensureTables (categorie)"],
  "lib/planning-studio-validity.ts": ["pigra: ensureValidityTables", "pigra: ensureSyncMarkerColumn"],
  "lib/planning-studio-validity-units.ts": ["pigra: ensureTables (UDP)"],
  "lib/planning-studio-zones.ts": ["pigra: ensureTables (zones)"],
  "lib/planning-studio-materialize.ts": ["pigra: ensureMaterializedColumn", "richiesta: :382 :386 :391 :487 :491 :607 :611"],
  "routes/argos-watch.ts": ["pigra: ensureWatchTable"],
  "routes/clusters.ts": ["pigra: ensureClusterFlagColumns", "richiesta: :343"],
  "routes/coincidence-zones.ts": ["pigra: ensureZoneScope"],
  "routes/deadhead-arcs.ts": ["pigra: ensureTable (deadhead_arcs)"],
  "routes/depots.ts": ["pigra: router.use anonimo (SQL copiato, depots.ts:31-32)"],
  "routes/fares-min-od.ts": ["pigra: ensureMinOdTables"],
  "routes/intermodal.ts": ["pigra: ensureSchedulesTable"],
  "routes/network-share.ts": ["pigra: ensureNetworkShareTable"],
  "routes/optimizer-rule-profiles.ts": ["pigra: ensureSchema"],
  "routes/process-report.ts": ["pigra: ensureTable (process_reports)"],
  "routes/service-program.ts": ["pigra: ensureVariantCodeColumn", "pigra: ensureAgentJobsTable", "richiesta: :2389 :3930 :3946 :4121 :4135 :4152"],
  "routes/timetable-map-share.ts": ["pigra: ensureTimetableMapShareTable"],
  "routes/planning-studio-timetables.ts": ["richiesta: :778 :784"],
};

/* ── Il DDL eseguito dentro singole richieste, copiato dal sorgente ───────── */
const PER_RICHIESTA: Array<{ rif: string; sql: string }> = [
  // materializePsToFeed (POST …/materialize): colonne del feed materializzato
  { rif: "lib/planning-studio-materialize.ts:382", sql: "ALTER TABLE gtfs_trips ADD COLUMN IF NOT EXISTS on_demand boolean DEFAULT false" },
  { rif: "lib/planning-studio-materialize.ts:386", sql: "ALTER TABLE gtfs_trips ADD COLUMN IF NOT EXISTS variant_code text" },
  { rif: "lib/planning-studio-materialize.ts:391", sql: "ALTER TABLE gtfs_trips ADD COLUMN IF NOT EXISTS block_id text" },
  { rif: "lib/planning-studio-materialize.ts:487", sql: "ALTER TABLE stop_clusters ADD COLUMN IF NOT EXISTS source_ps_project_id uuid" },
  { rif: "lib/planning-studio-materialize.ts:491", sql: "CREATE INDEX IF NOT EXISTS idx_stop_clusters_source_ps_project ON stop_clusters(source_ps_project_id)" },
  // mirrorPsClustersToLegacy (a ogni CRUD dei cluster PS): stesse due istruzioni
  { rif: "lib/planning-studio-materialize.ts:607", sql: "ALTER TABLE stop_clusters ADD COLUMN IF NOT EXISTS source_ps_project_id uuid" },
  { rif: "lib/planning-studio-materialize.ts:611", sql: "CREATE INDEX IF NOT EXISTS idx_stop_clusters_source_ps_project ON stop_clusters(source_ps_project_id)" },
  // handleVehicleOptimize
  { rif: "routes/service-program.ts:2389", sql: "ALTER TABLE stop_clusters ADD COLUMN IF NOT EXISTS source_ps_project_id uuid" },
  // POST /service-program/agent-optimize (salvataggio dello scenario)
  { rif: "routes/service-program.ts:3930", sql: "ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS config jsonb" },
  { rif: "routes/service-program.ts:3946", sql: "ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS depots jsonb" },
  // POST /service-program/scenarios
  { rif: "routes/service-program.ts:4121", sql: "ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS depot_id uuid" },
  { rif: "routes/service-program.ts:4135", sql: "ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS depots jsonb" },
  { rif: "routes/service-program.ts:4152", sql: "ALTER TABLE service_program_scenarios ADD COLUMN IF NOT EXISTS config jsonb" },
  // POST /clusters/by-routes con psScope
  { rif: "routes/clusters.ts:343", sql: "ALTER TABLE stop_clusters ADD COLUMN IF NOT EXISTS source_ps_project_id uuid" },
  // POST /planning-studio/:projectId/network-share
  {
    rif: "routes/planning-studio-timetables.ts:778",
    sql: `CREATE TABLE IF NOT EXISTS ps_network_shares (
        token text PRIMARY KEY, project_id uuid NOT NULL,
        route_ids jsonb NOT NULL DEFAULT '[]'::jsonb, title text,
        options jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
  },
  { rif: "routes/planning-studio-timetables.ts:784", sql: "ALTER TABLE ps_network_shares ADD COLUMN IF NOT EXISTS expires_at timestamptz" },
];

/* depots.ts: il DDL sta in un router.use anonimo, non richiamabile */
const DEPOTS: Array<{ rif: string; sql: string }> = [
  { rif: "routes/depots.ts:31", sql: "ALTER TABLE depots ADD COLUMN IF NOT EXISTS ps_project_id uuid" },
  { rif: "routes/depots.ts:32", sql: "CREATE INDEX IF NOT EXISTS idx_depots_ps_project ON depots(ps_project_id)" },
];

/* ── Registro: ogni query passa di qui (sotto drizzle) ────────────────────── */
type Voce = { unita: string; sql: string; ddl: boolean; errore?: string; codice?: string };
const registro: Voce[] = [];
const avvisi: Array<{ unita: string; testo: string }> = [];
let unitaCorrente = "(prima dell'avvio)";
let inCorso = 0;

const senzaCommenti = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
const eDdl = (s: string) => /^(CREATE|ALTER|DROP|COMMENT|DO\b)/i.test(senzaCommenti(s));
const corto = (s: string, n = 160) => senzaCommenti(s).replace(/\s+/g, " ").slice(0, n);

function strumenta(pool: any): void {
  const proto = pool.Client.prototype;
  const originale = proto.query;
  proto.query = function (this: unknown, config: any, values?: any, callback?: any) {
    const testo: string = typeof config === "string" ? config : (config?.text ?? "");
    if (!testo) return originale.call(this, config, values, callback); // Submittable o simili
    const voce: Voce = { unita: unitaCorrente, sql: testo, ddl: eDdl(testo) };
    registro.push(voce);
    inCorso++;
    let chiusa = false;
    const chiudi = (err: any) => {
      if (chiusa) return;
      chiusa = true;
      inCorso--;
      if (err) { voce.errore = String(err?.message ?? err); voce.codice = err?.code; }
    };
    if (typeof values === "function") { const cb = values; values = (e: any, r: any) => { chiudi(e); cb(e, r); }; }
    else if (typeof callback === "function") { const cb = callback; callback = (e: any, r: any) => { chiudi(e); cb(e, r); }; }
    const r = originale.call(this, config, values, callback);
    if (r && typeof r.then === "function") r.then(() => chiudi(null), (e: any) => chiudi(e));
    return r;
  };
  for (const livello of ["error", "warn"] as const) {
    const orig = console[livello].bind(console);
    console[livello] = (...a: unknown[]) => {
      avvisi.push({ unita: unitaCorrente, testo: a.map(x => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 300) });
      orig(...a);
    };
  }
}

const dorme = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Aspetta che nessuna query sia in corso per `fermo` ms di fila (i `void ensureX()` dell'import). */
async function quiete(pool: any, fermo = 500, massimo = 120_000): Promise<void> {
  const t0 = Date.now();
  let stabile = 0;
  while (stabile < fermo) {
    if (Date.now() - t0 > massimo) { avvisi.push({ unita: unitaCorrente, testo: `crea-tutto: database non fermo dopo ${massimo} ms` }); return; }
    await dorme(50);
    const occupato = inCorso > 0 || pool.waitingCount > 0 || pool.totalCount - pool.idleCount > 0;
    stabile = occupato ? 0 : stabile + 50;
  }
}

type Esito = { unita: string; tipo: string; istruzioni: number; ddl: number; errori: number; eccezione?: string };
const esiti: Esito[] = [];

async function esegui(tipo: string, nome: string, fai: () => Promise<unknown>, pool: any): Promise<void> {
  unitaCorrente = `${tipo}: ${nome}`;
  const da = registro.length;
  let eccezione: string | undefined;
  try { await fai(); } catch (e: any) { eccezione = String(e?.cause?.message ?? e?.message ?? e); }
  await quiete(pool, 100);
  const mie = registro.slice(da);
  esiti.push({ unita: unitaCorrente, tipo, istruzioni: mie.length, ddl: mie.filter(v => v.ddl).length, errori: mie.filter(v => v.errore).length, eccezione });
}

/* ── Controllo della copertura contro i sorgenti ──────────────────────────── */
const DDL_NEL_SORGENTE = /CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE|CREATE SCHEMA|CREATE (OR REPLACE )?VIEW|DROP (TABLE|INDEX|VIEW)/;
function fileConDdl(dir: string): string[] {
  const out: string[] = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) { if (nome !== "__tests__") out.push(...fileConDdl(p)); continue; }
    if (p.endsWith(".ts") && DDL_NEL_SORGENTE.test(readFileSync(p, "latin1"))) out.push(relative(SRC, p));
  }
  return out.sort();
}

async function main(): Promise<number> {
  const { db, pool } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  strumenta(pool);

  /* chi siamo e che cosa c'è già */
  unitaCorrente = "controllo iniziale";
  const info = (await pool.query(`SELECT current_database() AS db, to_regclass('public.users') IS NOT NULL AS ha_users`)).rows[0];
  if (info.ha_users) {
    const n = Number((await pool.query(`SELECT count(*) AS n FROM public.users`)).rows[0].n);
    if (n > 0 && !ancheConDati) {
      console.error(`crea-tutto: ${info.db} ha ${n} utenti. Le preparazioni dell'API toccano anche i dati: usa un database vuoto o appena migrato, o --anche-con-dati.`);
      return 2;
    }
  }
  console.log(`crea-tutto: database ${info.db}`);

  /* ═══ 1. AVVIO ═══ */
  const AVVIO: Array<[string, string, string]> = [
    // [modulo, funzione esportata, etichetta]
    ["lib/auth.ts", "ensureUsersTable", "lib/auth.ts ensureUsersTable"],
    ["lib/tenant.ts", "ensureTenantColumns", "lib/tenant.ts ensureTenantColumns"],
    ["lib/scheduling-projects.ts", "ensureSchedulingTables", "lib/scheduling-projects.ts ensureSchedulingTables"],
    ["lib/planning-studio.ts", "ensurePsTables", "lib/planning-studio.ts ensurePsTables"],
    ["routes/fares-polimetriche.ts", "ensureTables", "routes/fares-polimetriche.ts ensureTables"],
    ["routes/planning.ts", "ensureNewTables", "routes/planning.ts ensureNewTables"],
    ["routes/fares.ts", "ensurePolimetricheSnapshotsTable", "routes/fares.ts ensurePolimetricheSnapshotsTable"],
    ["routes/gtfs-upload.ts", "ensureFeedActiveColumn", "routes/gtfs-upload.ts ensureFeedActiveColumn"],
    ["routes/fares-node-assignment.ts", "ensureNodeAssignmentTables", "routes/fares-node-assignment.ts ensureNodeAssignmentTables"],
  ];
  const moduli: Record<string, any> = {};
  for (const [file, , etichetta] of AVVIO) {
    await esegui("avvio (import)", etichetta, async () => {
      moduli[file] = await import(pathToFileURL(join(SRC, file)).href);
      await quiete(pool);
    }, pool);
  }
  /* di nuovo, esplicitamente: no-op se l'import è riuscito, altrimenti riprova come farebbe l'API */
  for (const [file, fn, etichetta] of AVVIO) {
    await esegui("avvio (richiamo)", etichetta, () => moduli[file][fn](), pool);
  }

  /* ═══ 2. PIGRE ═══ (ordine: prima chi crea le tabelle a cui gli altri si appoggiano) */
  const m = async (file: string) => moduli[file] ??= await import(pathToFileURL(join(SRC, file)).href);
  const PIGRE: Array<[string, () => Promise<unknown>]> = [
    ["lib/caronte-schema.ts repairSchema", async () => (await m("lib/caronte-schema.ts")).repairSchema()],
    ["lib/caronte-schema.ts ensureCaronteSchema", async () => (await m("lib/caronte-schema.ts")).ensureCaronteSchema()],
    ["lib/avm-diario-store.ts assicura", async () => (await m("lib/avm-diario-store.ts")).assicura()],
    ["lib/avm-controllo-store.ts assicura", async () => (await m("lib/avm-controllo-store.ts")).assicura()],
    ["lib/journey-codes-store.ts assicura", async () => (await m("lib/journey-codes-store.ts")).assicura()],
    ["lib/stop-alias-overrides.ts assicura", async () => (await m("lib/stop-alias-overrides.ts")).assicura()],
    ["lib/stop-predictions-store.ts assicura", async () => (await m("lib/stop-predictions-store.ts")).assicura()],
    ["lib/anagrafica-store.ts assicuraAnagrafica", async () => (await m("lib/anagrafica-store.ts")).assicuraAnagrafica()],
    ["lib/anagrafica-store.ts verificaUnicitaMatricole", async () => (await m("lib/anagrafica-store.ts")).verificaUnicitaMatricole(db)],
    ["lib/roster-rotazioni.ts ensureTable", async () => (await m("lib/roster-rotazioni.ts")).ensureTable()],
    ["lib/roster-pubblicazione-db.ts assicuraPubblicazione", async () => (await m("lib/roster-pubblicazione-db.ts")).assicuraPubblicazione()],
    ["lib/planning-studio-materialize.ts ensureMaterializedColumn", async () => (await m("lib/planning-studio-materialize.ts")).ensureMaterializedColumn()],
    ["lib/planning-studio-calendar.ts ensureTable", async () => (await m("lib/planning-studio-calendar.ts")).ensureTable()],
    ["lib/planning-studio-validity-categories.ts ensureValidityCategoryCalendarSchema", async () => (await m("lib/planning-studio-validity-categories.ts")).ensureValidityCategoryCalendarSchema()],
    ["lib/planning-studio-validity-categories.ts ensureTables", async () => (await m("lib/planning-studio-validity-categories.ts")).ensureTables()],
    ["lib/planning-studio-validity.ts ensureValidityTables", async () => (await m("lib/planning-studio-validity.ts")).ensureValidityTables()],
    ["lib/planning-studio-validity.ts ensureSyncMarkerColumn", async () => (await m("lib/planning-studio-validity.ts")).ensureSyncMarkerColumn()],
    ["lib/planning-studio-validity-units.ts ensureTables", async () => (await m("lib/planning-studio-validity-units.ts")).ensureTables()],
    ["lib/planning-studio-zones.ts ensureTables", async () => (await m("lib/planning-studio-zones.ts")).ensureTables()],
    ["routes/argos-watch.ts ensureWatchTable", async () => (await m("routes/argos-watch.ts")).ensureWatchTable()],
    ["routes/clusters.ts ensureClusterFlagColumns", async () => (await m("routes/clusters.ts")).ensureClusterFlagColumns()],
    ["routes/coincidence-zones.ts ensureZoneScope", async () => (await m("routes/coincidence-zones.ts")).ensureZoneScope()],
    ["routes/deadhead-arcs.ts ensureTable", async () => (await m("routes/deadhead-arcs.ts")).ensureTable()],
    ["routes/depots.ts router.use (SQL copiato da :31-32)", async () => {
      await m("routes/depots.ts");
      for (const x of DEPOTS) await db.execute(sql.raw(x.sql)); // come nel sorgente: il primo errore ferma il secondo
    }],
    ["routes/fares-min-od.ts ensureMinOdTables", async () => (await m("routes/fares-min-od.ts")).ensureMinOdTables()],
    ["routes/intermodal.ts ensureSchedulesTable", async () => (await m("routes/intermodal.ts")).ensureSchedulesTable()],
    ["routes/network-share.ts ensureNetworkShareTable", async () => (await m("routes/network-share.ts")).ensureNetworkShareTable()],
    ["routes/optimizer-rule-profiles.ts ensureSchema", async () => (await m("routes/optimizer-rule-profiles.ts")).ensureSchema()],
    ["routes/process-report.ts ensureTable", async () => (await m("routes/process-report.ts")).ensureTable()],
    ["routes/service-program.ts ensureVariantCodeColumn", async () => (await m("routes/service-program.ts")).ensureVariantCodeColumn()],
    ["routes/service-program.ts ensureAgentJobsTable", async () => (await m("routes/service-program.ts")).ensureAgentJobsTable()],
    ["routes/timetable-map-share.ts ensureTimetableMapShareTable", async () => (await m("routes/timetable-map-share.ts")).ensureTimetableMapShareTable()],
  ];
  for (const [nome, fai] of PIGRE) await esegui("pigra", nome, fai, pool);

  /* ═══ 3. RICHIESTA ═══ (una istruzione per volta: nel sorgente ciascuna ha il suo try) */
  for (const x of PER_RICHIESTA) {
    await esegui("richiesta", x.rif, () => db.execute(sql.raw(x.sql)), pool);
  }

  unitaCorrente = "(fine)";
  await quiete(pool);

  /* ═══ Resoconto ═══ */
  const errori = registro.filter(v => v.errore);
  console.log("\n══ Unità chiamate ══");
  for (const e of esiti) {
    const stato = e.errori || e.eccezione ? "ERRORE" : "ok";
    console.log(`${stato.padEnd(6)} ${e.unita}  — ${e.ddl} DDL su ${e.istruzioni} istruzioni${e.errori ? `, ${e.errori} fallite` : ""}${e.eccezione ? `, eccezione: ${e.eccezione}` : ""}`);
  }
  console.log(`\n══ Istruzioni fallite: ${errori.length} ══`);
  for (const v of errori) console.log(`- [${v.unita}] ${v.codice ?? ""} ${v.errore}\n    ${corto(v.sql, 220)}`);
  const avvisiUnici = [...new Map(avvisi.map(a => [`${a.unita}|${a.testo}`, a])).values()];
  console.log(`\n══ Messaggi di errore/avviso scritti dal codice: ${avvisiUnici.length} ══`);
  for (const a of avvisiUnici) console.log(`- [${a.unita}] ${a.testo}`);

  const trovati = fileConDdl(SRC);
  const scoperti = trovati.filter(f => !COPERTURA[f]);
  const inutili = Object.keys(COPERTURA).filter(f => !trovati.includes(f));
  console.log(`\n══ Copertura: ${trovati.length} file sorgente con DDL ══`);
  for (const f of trovati) console.log(`${COPERTURA[f] ? "ok   " : "MANCA"} ${f}  ← ${(COPERTURA[f] ?? ["nessuna unità"]).join("; ")}`);
  for (const f of inutili) console.log(`?     ${f}: nell'elenco ma senza DDL nel sorgente`);
  if (fileRegistro) writeFileSync(fileRegistro, JSON.stringify(registro, null, 1) + "\n");
  const totDdl = registro.filter(v => v.ddl).length;
  const eccezioni = esiti.filter(e => e.eccezione).length;
  console.log(`\n${esiti.length} unità, ${totDdl} istruzioni DDL eseguite, ${errori.length} fallite, ${eccezioni} unità in errore, ${scoperti.length} file non coperti.`);
  // un'unità che lancia prima di arrivare al database (funzione non più
  // esportata, modulo che non si importa) è un errore come una query fallita
  return errori.length || scoperti.length || eccezioni ? 1 : 0;
}

main().then(
  (codice) => { process.stdout.write("", () => process.exit(codice)); },
  (e) => { console.error("crea-tutto:", e); process.exit(1); },
);
