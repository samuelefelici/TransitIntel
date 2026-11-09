/**
 * Turni macchina (CP-SAT), VCSP e giri di Argos su un database vero
 * (TEST_DATABASE_URL, migrato: in CI il job migrazioni-postgres).
 *
 * È il metro del «comportamento identico» della PR 2.6: su una rete di prova
 * fissa, con Python finto (il solver non serve: si guarda cosa gli arriva e
 * cosa ne fa l'API) e senza OSRM (fallback Haversine), fissa per ogni caso
 * l'ingresso dato a Python e la risposta. Gli stessi casi girano col calcolo
 * dentro l'API (LAVORI_VEICOLI_IN_CODA=0) e, dalla 2.6, attraverso la coda con
 * un esecutore nel test: le istantanee devono essere le stesse.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { creaEsecutore } from "../lib/lavori/esecutore";
import { GESTORI } from "../lib/lavori/gestori";

/* niente rete: OSRM non risponde e la matrice fuorilinea ricade su Haversine × circuità */
vi.hoisted(() => { process.env.OSRM_URL = "http://127.0.0.1:1"; });

/** Python finto: registra cosa riceve e risponde come il solver, in modo deterministico. */
const py = vi.hoisted(() => ({ chiamate: [] as any[], crash: false, appeso: false }));

vi.mock("../lib/lavori/python", async (orig) => {
  const vero = await orig<typeof import("../lib/lavori/python")>();
  return {
    ...vero,
    eseguiPython: vi.fn(async (o: any) => {
      py.chiamate.push({ script: o.script, argv: o.argv ?? [], ingresso: JSON.parse(JSON.stringify(o.ingresso ?? null)) });
      const fase = o.script === "vcsp_orchestrator.py" ? "VCSP" : "VSP";
      if (o.suProgresso) o.suProgresso({ phase: fase, percentage: 50, detail: "a metà", timestamp: 0 });
      else o.suRigaStderr?.(`PROGRESS|${fase}|50|a metà`);
      if (py.appeso) {
        // un calcolo lungo: finisce solo con lo stop (SIGINT, come il lanciatore vero)
        await new Promise<void>(r => { if (o.segnale?.aborted) r(); else o.segnale?.addEventListener("abort", () => r(), { once: true }); });
        return { codice: null, segnaleUscita: "SIGINT", motivo: "fermato", stdout: "", stderrTesta: "", stderrCoda: "" };
      }
      if (py.crash) {
        return { codice: 1, segnaleUscita: null, motivo: "uscito", stdout: "", stderrTesta: "Traceback", stderrCoda: "Traceback (most recent call last): boom" };
      }
      return { codice: 0, segnaleUscita: null, motivo: "uscito", stdout: JSON.stringify(solverFinto(o.script, o.ingresso)), stderrTesta: "", stderrCoda: "" };
    }),
  };
});

/** Un turno macchina per linea, con tutte le corse della linea. */
function turniFinti(trips: any[]): any[] {
  const perLinea = new Map<string, any[]>();
  for (const t of trips) (perLinea.get(t.routeId) ?? perLinea.set(t.routeId, []).get(t.routeId)!).push(t);
  return [...perLinea.values()].map((ts, i) => {
    ts.sort((a, b) => a.departureMin - b.departureMin);
    const startMin = ts[0].departureMin - 10;
    const endMin = ts[ts.length - 1].arrivalMin + 10;
    return {
      vehicleId: `V${i + 1}`, vehicleType: ts[0].requiredVehicle, category: ts[0].category,
      trips: ts.map(t => ({
        type: "trip", tripId: t.tripId, routeId: t.routeId, routeName: t.routeName, headsign: t.headsign,
        departureTime: t.departureTime, arrivalTime: t.arrivalTime, departureMin: t.departureMin, arrivalMin: t.arrivalMin,
        firstStopName: t.firstStopName, lastStopName: t.lastStopName,
      })),
      startMin, endMin,
      totalServiceMin: ts.reduce((s, t) => s + (t.arrivalMin - t.departureMin), 0),
      totalDeadheadMin: 20, totalDeadheadKm: 7.5, depotReturns: 0, tripCount: ts.length,
      fifoOrder: i, firstOut: startMin, lastIn: endMin, shiftDuration: endMin - startMin, downsizedTrips: 0,
    };
  });
}

function solverFinto(script: string, ingresso: any): any {
  const vsp = script === "vcsp_orchestrator.py" ? ingresso.vsp : ingresso;
  const bloccati = vsp.lockedChains ?? [];
  if (bloccati.some((c: any) => c.tripIds.includes("NON-IN-ORARIO"))) {
    return { error: "Il turno bloccato V9 contiene una corsa che non è in orario: NON-IN-ORARIO", errorKind: "lucchetto" };
  }
  const vehicleShifts = turniFinti(vsp.trips);
  const base = {
    vehicleShifts,
    metrics: { costEur: 1234.5, solveTimeSec: 1.5, deadheadArchive: vsp.deadheadArchive ?? null },
    costBreakdown: { fisso: 1000, km: 234.5 },
  };
  if (script !== "vcsp_orchestrator.py") return base;
  return {
    ...base,
    vcsp: {
      bestRound: 1, roundsExecuted: ingresso.vcsp.rounds, elapsedSec: 12,
      rounds: [{ round: 1, vehicles: vehicleShifts.length, duties: 2, totalCostEur: 1600, vehicleCostEur: 1234.5, crewCostEur: 365.5 }],
      ciclo: { passo: 0.5, ancora: "best", seme: true, pazienza: 2, controllo: true },
      crew: {
        driverShifts: [{ driverId: "AG1", type: "intero", nastroMin: 400, workMin: 380, riprese: [] }],
        summary: { totalShifts: 1, totalDailyCost: 365.5 },
        handovers: [], clusters: [], metrics: { vehicleBlocks: 2 },
      },
    },
  };
}

const ADMIN = "e0000000-0000-0000-0000-0000000000a0";
const ALTRO = "e0000000-0000-0000-0000-0000000000b0";
const FEED = "e0000000-0000-0000-0000-0000000000f1";
const PS = "e0000000-0000-0000-0000-0000000000c1";
const DEPOSITO = "e0000000-0000-0000-0000-0000000000d1";
/** mercoledì: il calendario FER va dal lunedì al venerdì */
const GIORNO = "2026-11-04";
const DOMENICA = "2026-11-08";

/* importata dopo i mock */
const { default: router } = await import("../routes/service-program");
const admin = appDiProva(router, utenteDiProva(ADMIN, ["scheduling"], "admin"));
const altro = appDiProva(router, utenteDiProva(ALTRO, ["scheduling"]));

/** il corpo che manda la Fucina (OptimizerStep) a /cpsat */
const corpoFucina = (extra: Record<string, unknown> = {}) => ({
  date: GIORNO, feedId: FEED, psProjectId: PS,
  routes: [{ routeId: "R1", vehicleType: "12m" }, { routeId: "RC", vehicleType: "10m", forced: true }],
  depots: [{ id: DEPOSITO, maxVehicles: 4, fleet: { "12m": 3, "10m": 2 } }],
  timeLimit: 30, solverIntensity: "fast",
  excludedTripIds: ["T6"],
  vspNormativa: { maxCambiLinea: 2, vietaVuotiInterni: true },
  vehicleCosts: { "12m": { fixedDaily: 180 } },
  ...extra,
});

const corpoVcsp = (extra: Record<string, unknown> = {}) => corpoFucina({
  crewConfig: { companyCars: 2, bds: { serviceType: "urbano" } },
  vcsp: { rounds: 2, probes: 0, crewTimeLimit: 30 },
  ...extra,
});

/** Le istantanee fissano anche i dati globali che il solver legge: devono mancare, a parte i nostri. */
async function databaseDiProvaVuoto(): Promise<void> {
  const r = (await db.execute<any>(sql`
    SELECT (SELECT count(*) FROM depots WHERE id <> ${DEPOSITO}::uuid)::int AS depositi,
           (SELECT count(*) FROM stop_clusters)::int AS cluster,
           (SELECT count(*) FROM deadhead_arcs)::int AS archi,
           (SELECT count(*) FROM app_settings WHERE key = 'company_cars')::int AS autovetture,
           (SELECT count(*) FROM traffic_snapshots)::int AS traffico`)).rows[0];
  if (Object.values(r).some(n => Number(n) > 0)) {
    throw new Error(`veicoli-db.test.ts vuole un database migrato senza dati globali del solver (depositi, cluster, archi fuorilinea, autovetture, traffico): trovati ${JSON.stringify(r)}`);
  }
}

async function semina(): Promise<void> {
  await databaseDiProvaVuoto();
  await pulisci();
  await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active, owner_user_id, uploaded_at)
                       VALUES (${FEED}::uuid, 'prova-veicoli.zip', true, NULL, '2026-01-01T00:00:00Z')`);
  await db.execute(sql`INSERT INTO gtfs_routes (feed_id, route_id, route_short_name, route_long_name)
                       VALUES (${FEED}::uuid, 'R1', '1', 'Stazione - Torrette'), (${FEED}::uuid, 'RC', 'C', 'Ancona - Camerano')`);
  await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
    (${FEED}::uuid, 'S1', 'Stazione FS', 43.6075, 13.4977),
    (${FEED}::uuid, 'S2', 'Piazza Cavour', 43.6167, 13.5189),
    (${FEED}::uuid, 'S3', 'Ospedale Torrette', 43.6040, 13.4510),
    (${FEED}::uuid, 'S4', 'Camerano', 43.5262, 13.5530)`);
  await db.execute(sql`INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, start_date, end_date)
                       VALUES (${FEED}::uuid, 'FER', 1, 1, 1, 1, 1, '20260101', '20261231')`);
  const corse: Array<[string, string, string, string, string, string]> = [
    ["T1", "R1", "S1", "S3", "07:00:00", "07:25:00"],
    ["T2", "R1", "S3", "S1", "07:35:00", "08:00:00"],
    ["T3", "R1", "S1", "S3", "08:10:00", "08:35:00"],
    ["T4", "RC", "S2", "S4", "07:15:00", "07:55:00"],
    ["T5", "RC", "S4", "S2", "08:05:00", "08:45:00"],
    ["T6", "RC", "S2", "S4", "09:00:00", "09:40:00"],
  ];
  for (const [trip, route, da, a, parte, arriva] of corse) {
    await db.execute(sql`INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id, trip_headsign, direction_id, variant_code)
                         VALUES (${FEED}::uuid, ${trip}, ${route}, 'FER', ${`verso ${a}`}, ${da === "S1" || da === "S2" ? 0 : 1}, ${`${route}-${da}`})`);
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, departure_time, arrival_time) VALUES
      (${FEED}::uuid, ${trip}, ${da}, 1, ${parte}, ${parte}),
      (${FEED}::uuid, ${trip}, 'S2', 2, ${parte.replace(/:(\d\d):/, (_m, mm) => `:${String(Number(mm) + 10).padStart(2, "0")}:`)}, NULL),
      (${FEED}::uuid, ${trip}, ${a}, 3, ${arriva}, ${arriva})`);
  }
  await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name, materialized_feed_id)
                       VALUES (${PS}::uuid, ${ADMIN}::uuid, 'Rete di prova', ${FEED}::uuid)`);
  await db.execute(sql`INSERT INTO depots (id, name, lat, lon, color) VALUES (${DEPOSITO}::uuid, 'Deposito di prova', 43.5900, 13.5000, '#123456')`);
}

async function pulisci(): Promise<void> {
  await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE service_program_scenario_id IN
                         (SELECT id FROM service_program_scenarios WHERE feed_id = ${FEED}::uuid)`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE feed_id = ${FEED}::uuid`);
  await db.execute(sql`DELETE FROM agent_optimize_jobs WHERE ps_project_id = ${PS}::uuid`);
  await db.execute(sql`DELETE FROM coda.lavori WHERE metadati->>'psProjectId' = ${PS} OR richiesta->>'feedId' = ${FEED}`);
  for (const t of ["gtfs_stop_times", "gtfs_trips", "gtfs_calendar", "gtfs_stops", "gtfs_routes"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE feed_id = ${FEED}::uuid`);
  }
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${FEED}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${PS}::uuid`);
  await db.execute(sql`DELETE FROM depots WHERE id = ${DEPOSITO}::uuid`);
}

/** Un caso: rotta, corpo, utente; ritorna risposta e ingresso dato a Python. */
interface Caso { nome: string; rotta: string; corpo: unknown; app?: "admin" | "altro"; prima?: () => void }
const CASI: Caso[] = [
  { nome: "cpsat 200, il corpo della Fucina", rotta: "/api/service-program/cpsat", corpo: corpoFucina() },
  { nome: "vcsp 200, con i turni guida", rotta: "/api/service-program/vcsp", corpo: corpoVcsp() },
  {
    nome: "cpsat, turno bloccato impossibile: 422", rotta: "/api/service-program/cpsat",
    corpo: corpoFucina({ lockedChains: [{ vehicleId: "V9", tripIds: ["T1", "NON-IN-ORARIO"] }, { tripIds: [] }, null] }),
  },
  { nome: "cpsat, la fattibilità di Argos", rotta: "/api/service-program/cpsat", corpo: { date: GIORNO.replace(/-/g, ""), psProjectId: PS, feedId: FEED, routes: [{ routeId: "R1", vehicleType: "12m" }] } },
  { nome: "cpsat senza servizio quel giorno: NO_INPUT", rotta: "/api/service-program/cpsat", corpo: corpoFucina({ date: DOMENICA }) },
  { nome: "cpsat, linee senza corse: NO_INPUT", rotta: "/api/service-program/cpsat", corpo: corpoFucina({ routes: [{ routeId: "NESSUNA", vehicleType: "12m" }] }) },
  { nome: "cpsat senza progetto Planner Studio: 400", rotta: "/api/service-program/cpsat", corpo: corpoFucina({ psProjectId: undefined }) },
  { nome: "cpsat senza data: 400", rotta: "/api/service-program/cpsat", corpo: corpoFucina({ date: undefined }) },
  { nome: "cpsat con una data storta: 400", rotta: "/api/service-program/cpsat", corpo: corpoFucina({ date: "4 novembre" }) },
  { nome: "cpsat senza linee: 400", rotta: "/api/service-program/cpsat", corpo: corpoFucina({ routes: [] }) },
  { nome: "cpsat con un tipo di vettura sconosciuto: 400", rotta: "/api/service-program/vcsp", corpo: corpoVcsp({ routes: [{ routeId: "R1", vehicleType: "astronave" }] }) },
  { nome: "cpsat di chi non vede nessun feed: 404", rotta: "/api/service-program/cpsat", corpo: corpoFucina(), app: "altro" },
  { nome: "cpsat, Python si rompe: 500", rotta: "/api/service-program/cpsat", corpo: corpoFucina(), prima: () => { py.crash = true; } },
];

async function eseguiCaso(c: Caso): Promise<{ status: number; body: any; python: any[] }> {
  py.chiamate.length = 0;
  py.crash = false;
  py.appeso = false;
  c.prima?.();
  const r = await request(c.app === "altro" ? altro : admin).post(c.rotta).send(c.corpo as object);
  return { status: r.status, body: r.body, python: [...py.chiamate] };
}

/** Un giro VCSP di Argos dall'avvio allo scenario salvato: avvio, vista finale, ingresso a Python, righe salvate. */
async function giroCompleto(): Promise<Record<string, any>> {
  py.chiamate.length = 0;
  py.crash = false;
  py.appeso = false;
  const avvio = await request(admin).post("/api/service-program/agent-optimize").send({
    psProjectId: PS, date: GIORNO, mode: "vcsp",
    routes: [{ routeId: "R1", vehicleType: "12m" }, { routeId: "RC", vehicleType: "10m" }],
    depots: [{ id: DEPOSITO, maxVehicles: 3 }],
    intensity: "fast", rounds: 2, probes: 0, crewTimeLimit: 30, memoria: false, companyCars: 2,
    scenarioName: "Giro di prova",
  });
  expect(avvio.status, JSON.stringify(avvio.body)).toBe(200);
  const { jobId, ...restoAvvio } = avvio.body;

  let stato: any = null;
  for (let i = 0; i < 200; i++) {
    stato = (await request(admin).get(`/api/service-program/agent-optimize/${jobId}`)).body;
    if (stato.status !== "running") break;
    await new Promise(r => setTimeout(r, 100));
  }
  expect(stato.status, JSON.stringify(stato)).toBe("done");
  // jobId, tempi e id cambiano a ogni giro; psProjectId e persisted li dà solo la vista dal database
  const { scenarioId, dssId, elapsedSec: _e, jobId: _j, persisted: _p, psProjectId: _ps, ...vista } = stato;

  const scenario = (await db.execute<any>(sql`
    SELECT name, date, feed_id, input, result, owner_user_id, project_id, depots, config
      FROM service_program_scenarios WHERE id = ${scenarioId}::uuid`)).rows[0];
  expect(scenario.config.savedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  scenario.config.savedAt = "…";
  const turniGuida = (await db.execute<any>(sql`
    SELECT service_program_scenario_id, name, result, config, owner_user_id
      FROM driver_shift_scenarios WHERE id = ${dssId}::uuid`)).rows[0];
  expect(turniGuida.service_program_scenario_id).toBe(scenarioId);
  turniGuida.service_program_scenario_id = "…";
  const riga = (await db.execute<any>(sql`
    SELECT status, mode, scenario_id, dss_id, scenario_name, params, result_compact, error
      FROM agent_optimize_jobs WHERE id = ${jobId}::uuid`)).rows[0];
  expect(riga).toMatchObject({ status: "done", mode: "vcsp", scenario_id: scenarioId, dss_id: dssId, scenario_name: "Giro di prova", error: null });
  expect(riga.result_compact).toEqual(vista.result);

  // il giro di un altro: 403; l'elenco dell'altro non lo mostra; il proprio sì
  expect((await request(altro).get(`/api/service-program/agent-optimize/${jobId}`)).status).toBe(403);
  expect((await request(altro).get("/api/service-program/agent-optimize")).body.jobs.map((j: any) => j.jobId)).not.toContain(jobId);
  const mio = (await request(admin).get("/api/service-program/agent-optimize")).body.jobs.find((j: any) => j.jobId === jobId);
  expect(mio).toMatchObject({ status: "done", mode: "vcsp" });
  return { jobId, avvio: restoAvvio, vista, python: [...py.chiamate], scenario, turniGuida };
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("turni macchina e VCSP, sul database", () => {
  beforeAll(semina);
  afterAll(pulisci);
  beforeEach(() => { process.env.LAVORI_VEICOLI_IN_CODA = "0"; });

  for (const c of CASI) {
    it(c.nome, async () => {
      const r = await eseguiCaso(c);
      expect({ status: r.status, body: r.body }).toMatchSnapshot("risposta");
      expect(r.python).toMatchSnapshot("python");
    });
  }

  it("il giro VCSP di Argos fino allo scenario salvato, con i turni guida", async () => {
    const g = await giroCompleto();
    expect(g.avvio).toMatchSnapshot("avvio");
    expect(g.vista).toMatchSnapshot("vista del giro finito");
    expect(g.python).toMatchSnapshot("python");
    expect(g.scenario).toMatchSnapshot("scenario turni macchina");
    expect(g.turniGuida).toMatchSnapshot("turni guida");
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("turni macchina e VCSP in coda, sul database", () => {
  const log = { info() {}, warn() {}, error() {} };
  const esecutore = creaEsecutore({
    chi: "prova:veicoli", slot: { veloce: 1, lunga: 1 }, gestori: GESTORI, log, pollingMs: 50, battitoMs: 100,
  });
  const lavori = () => db.execute<any>(sql`
    SELECT id, tipo, corsia, stato, timeout_sec, http_codice, metadati, utente_id, oggetto_id
      FROM coda.lavori WHERE richiesta->>'feedId' = ${FEED} OR metadati->>'psProjectId' = ${PS} ORDER BY creato_il`);
  beforeAll(async () => {
    await semina();
    // l'esecutore del test prende qualunque lavoro: niente lavori estranei in coda
    await db.execute(sql`DELETE FROM coda.lavori WHERE stato IN ('in_coda', 'in_corso')`);
    esecutore.avvia();
  });
  afterAll(async () => { await esecutore.ferma(1_000); await pulisci(); });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM coda.lavori WHERE richiesta->>'feedId' = ${FEED} OR metadati->>'psProjectId' = ${PS}`);
  });

  it("gli stessi casi danno le stesse risposte e lo stesso ingresso a Python", async () => {
    for (const c of CASI) {
      process.env.LAVORI_VEICOLI_IN_CODA = "0";
      const dentro = await eseguiCaso(c);
      process.env.LAVORI_VEICOLI_IN_CODA = "1";
      const inCoda = await eseguiCaso(c);
      expect({ status: inCoda.status, body: inCoda.body }, c.nome).toEqual({ status: dentro.status, body: dentro.body });
      expect(inCoda.python, c.nome).toEqual(dentro.python);
    }
    // solo le richieste che arrivano al calcolo diventano lavori: 400 e 404 no
    const righe = (await lavori()).rows;
    expect(righe.length).toBe(CASI.filter(c => !/: 40[04]$/.test(c.nome)).length);
    expect(righe.every((r: any) => r.tipo === "ottimizza_veicoli" && r.utente_id === ADMIN && r.oggetto_id === PS)).toBe(true);
    // corsia e tempo massimo dal budget del VSP: fast (60 s) veloce, la fattibilità di Argos (normal, 180 s) veloce, il VCSP lunga
    const vcsp = righe.find((r: any) => r.metadati.mode === "vcsp");
    expect(vcsp).toMatchObject({ corsia: "lunga", timeout_sec: 7200, stato: "completato", http_codice: 200 });
    expect(righe.filter((r: any) => r.metadati.mode === "cpsat").every((r: any) => r.corsia === "veloce" && r.timeout_sec === 3600)).toBe(true);
    expect(righe.find((r: any) => r.http_codice === 422)).toMatchObject({ stato: "fallito" });
    expect(righe.find((r: any) => r.http_codice === 500)).toMatchObject({ stato: "fallito" });
  }, 120_000);

  it("asincrono: 202 e poi lo stato; un altro utente non lo vede; lo stop ferma il calcolo", async () => {
    process.env.LAVORI_VEICOLI_IN_CODA = "1";
    py.chiamate.length = 0;
    py.appeso = true;
    try {
      const avvio = await request(admin).post("/api/service-program/vcsp?asincrono=1").send(corpoVcsp());
      expect(avvio.status).toBe(202);
      const { jobId } = avvio.body;
      expect(avvio.body).toEqual({ jobId, status: "queued" });
      await vi.waitFor(async () => {
        const st = await request(admin).get(`/api/service-program/lavori/${jobId}`);
        expect(st.body).toMatchObject({ jobId, status: "running", mode: "vcsp" });
      }, { timeout: 5_000 });
      expect((await request(altro).get(`/api/service-program/lavori/${jobId}`)).status).toBe(404);
      expect((await request(altro).get(`/api/service-program/lavori/${jobId}?richiesta=1`)).status).toBe(404);
      // la Fucina che riapre il calcolo ricostruisce il contesto dalla richiesta, solo se la chiede
      const conRichiesta = await request(admin).get(`/api/service-program/lavori/${jobId}?richiesta=1`);
      expect(conRichiesta.body.request).toEqual(corpoVcsp());
      expect((await request(admin).get(`/api/service-program/lavori/${jobId}`)).body).not.toHaveProperty("request");
      expect((await request(altro).post(`/api/service-program/lavori/${jobId}/stop`)).status).toBe(404);
      expect((await request(admin).get("/api/service-program/lavori/non-un-uuid")).status).toBe(404);
      const stop = await request(admin).post(`/api/service-program/lavori/${jobId}/stop`);
      expect(stop.body).toEqual({ jobId, status: "stopping" });
      await vi.waitFor(async () => {
        const st = await request(admin).get(`/api/service-program/lavori/${jobId}`);
        expect(st.body).toMatchObject({ status: "stopped", httpStatus: 409 });
      }, { timeout: 5_000 });
      expect((await request(admin).post(`/api/service-program/lavori/${jobId}/stop`)).status).toBe(400);
    } finally {
      py.appeso = false;
    }
  });

  it("asincrono di un utente non admin: il progetto finisce nei metadati e la richiesta la rilegge il proprietario", async () => {
    process.env.LAVORI_VEICOLI_IN_CODA = "1";
    py.appeso = true;
    const PROGETTO = "e0000000-0000-0000-0000-0000000000e1";
    // il feed di prova non ha proprietario: per il tempo del test è quello di default, visibile a tutti
    await db.execute(sql`UPDATE gtfs_feeds SET is_default = true WHERE id = ${FEED}::uuid`);
    try {
      const avvio = await request(altro).post("/api/service-program/cpsat?asincrono=1").send(corpoFucina({ projectId: PROGETTO }));
      expect(avvio.status).toBe(202);
      const { jobId } = avvio.body;
      const riga = (await lavori()).rows.find((r: any) => r.id === jobId);
      expect(riga).toMatchObject({ utente_id: ALTRO, metadati: { ambito: "turni-macchina", mode: "cpsat", projectId: PROGETTO } });
      // il proprietario (non admin) riapre il calcolo: la richiesta è quella mandata
      const conRichiesta = await request(altro).get(`/api/service-program/lavori/${jobId}?richiesta=1`);
      expect(conRichiesta.status).toBe(200);
      expect(conRichiesta.body.request).toEqual(corpoFucina({ projectId: PROGETTO }));
      // un projectId che non è un uuid non entra nei metadati
      const strano = await request(altro).post("/api/service-program/cpsat?asincrono=1").send(corpoFucina({ projectId: "x' or 1=1" }));
      expect(strano.status).toBe(202);
      const rigaStrana = (await lavori()).rows.find((r: any) => r.id === strano.body.jobId);
      expect(rigaStrana.metadati).not.toHaveProperty("projectId");
      for (const j of [jobId, strano.body.jobId]) await request(altro).post(`/api/service-program/lavori/${j}/stop`);
      // si aspetta che siano chiusi: un lavoro ancora in volo chiamerebbe Python
      // durante il test dopo (che ne conta le chiamate)
      await vi.waitFor(async () => {
        const stati = (await lavori()).rows.filter((r: any) => r.id === jobId || r.id === strano.body.jobId).map((r: any) => r.stato);
        expect(stati).toEqual(["fermato", "fermato"]);
      }, { timeout: 5_000 });
    } finally {
      py.appeso = false;
      await db.execute(sql`UPDATE gtfs_feeds SET is_default = false WHERE id = ${FEED}::uuid`);
    }
  });

  it("chi aspetta si scollega: il calcolo si ferma", async () => {
    process.env.LAVORI_VEICOLI_IN_CODA = "1";
    py.chiamate.length = 0;
    py.appeso = true;
    try {
      await expect(request(admin).post("/api/service-program/cpsat").send(corpoFucina()).timeout(1_500)).rejects.toThrow();
      await vi.waitFor(async () => {
        const r = (await lavori()).rows;
        expect(r.map((x: any) => x.stato)).toEqual(["fermato"]);
      }, { timeout: 5_000 });
      // il calcolo era davvero partito: lo ha fermato lo scollegamento, non altro
      expect(py.chiamate.map(c => c.script)).toEqual(["vehicle_scheduler_cpsat.py"]);
    } finally {
      py.appeso = false;
    }
  });

  it("oltre 3 calcoli vivi dello stesso utente: 429, senza lavoro nuovo", async () => {
    process.env.LAVORI_VEICOLI_IN_CODA = "1";
    for (let i = 0; i < 3; i++) {
      await db.execute(sql`
        INSERT INTO coda.lavori (tipo, corsia, stato, utente_id, richiesta, metadati, timeout_sec, disponibile_dal)
        VALUES ('ottimizza_veicoli', 'lunga', 'in_coda', ${ADMIN}::uuid, ${JSON.stringify({ feedId: FEED })}::jsonb,
                ${JSON.stringify({ ambito: "turni-macchina", psProjectId: PS })}::jsonb, 3600, now() + interval '1 hour')`);
    }
    const r = await request(admin).post("/api/service-program/cpsat").send(corpoFucina());
    expect(r.status).toBe(429);
    expect(r.body.error).toContain("3 calcoli dei turni macchina");
    expect((await lavori()).rows.length).toBe(3);
  });

  it("il giro di Argos in coda: lo stesso scenario, gli stessi turni guida, la stessa vista", async () => {
    process.env.LAVORI_VEICOLI_IN_CODA = "0";
    const dentro = await giroCompleto();
    process.env.LAVORI_VEICOLI_IN_CODA = "1";
    const inCoda = await giroCompleto();
    for (const k of ["avvio", "vista", "python", "scenario", "turniGuida"]) expect(inCoda[k], k).toEqual(dentro[k]);
    const [l] = (await db.execute<any>(sql`SELECT tipo, corsia, stato, timeout_sec, chiave_unicita, utente_id, risultato FROM coda.lavori WHERE id = ${inCoda.jobId}::uuid`)).rows;
    expect(l).toMatchObject({ tipo: "giro_agente", corsia: "lunga", stato: "completato", timeout_sec: 7200, chiave_unicita: `giro:${PS}`, utente_id: ADMIN });
    expect(Object.keys(l.risultato).sort()).toEqual(["dssId", "scenarioId", "scenarioName"]);
  }, 60_000);

  it("un secondo giro sullo stesso progetto: 409 col giro vivo; lo stop lo chiude «fermato» per Argos", async () => {
    process.env.LAVORI_VEICOLI_IN_CODA = "1";
    py.chiamate.length = 0;
    py.appeso = true;
    try {
      const corpo = { psProjectId: PS, date: GIORNO, mode: "cpsat", routes: [{ routeId: "R1", vehicleType: "12m" }], depots: [{ id: DEPOSITO }], memoria: false };
      const primo = await request(admin).post("/api/service-program/agent-optimize").send(corpo);
      expect(primo.status).toBe(200);
      await vi.waitFor(async () => {
        const st = await request(admin).get(`/api/service-program/agent-optimize/${primo.body.jobId}`);
        expect(st.body).toMatchObject({ status: "running", mode: "cpsat", progress: { phase: "VSP", pct: 50, msg: "a metà" } });
      }, { timeout: 5_000 });
      const secondo = await request(admin).post("/api/service-program/agent-optimize").send(corpo);
      expect(secondo.status).toBe(409);
      expect(secondo.body).toEqual({ error: "Un giro è già in corso su questo progetto: attendi o interroga lo stato", jobId: primo.body.jobId });
      expect((await request(altro).post(`/api/service-program/agent-optimize/${primo.body.jobId}/stop`)).status).toBe(403);
      expect((await request(admin).post(`/api/service-program/agent-optimize/${primo.body.jobId}/stop`)).body).toEqual({ jobId: primo.body.jobId, status: "stopping" });
      await vi.waitFor(async () => {
        const st = await request(admin).get(`/api/service-program/agent-optimize/${primo.body.jobId}`);
        expect(st.body).toMatchObject({ status: "error", error: "Giro fermato" });
      }, { timeout: 5_000 });
      const riga = (await db.execute<any>(sql`SELECT status, error FROM agent_optimize_jobs WHERE id = ${primo.body.jobId}::uuid`)).rows[0];
      expect(riga).toEqual({ status: "error", error: "Giro fermato" });
      expect((await request(admin).post(`/api/service-program/agent-optimize/${primo.body.jobId}/stop`)).status).toBe(400);
    } finally {
      py.appeso = false;
    }
  });

  it("un giro vivo in coda dopo un riavvio dell'API resta «running», mai «interrotto»", async () => {
    // la riga com'è appena accodata, senza esecutore che la prenda (disponibile fra un'ora)
    const [{ id }] = (await db.execute<any>(sql`
      INSERT INTO coda.lavori (tipo, corsia, utente_id, chiave_unicita, richiesta, metadati, timeout_sec, disponibile_dal)
      VALUES ('giro_agente', 'lunga', ${ADMIN}::uuid, ${`giro:${PS}`}, '{}'::jsonb,
              ${JSON.stringify({ ambito: "giro-agente", mode: "vcsp", psProjectId: PS, params: { date: GIORNO } })}::jsonb, 7200, now() + interval '1 hour')
      RETURNING id`)).rows;
    await db.execute(sql`
      INSERT INTO agent_optimize_jobs (id, user_id, ps_project_id, mode, status, created_at, progress, params)
      VALUES (${id}::uuid, ${ADMIN}::uuid, ${PS}::uuid, 'vcsp', 'running', now(), '{"phase":"VCSP","pct":0,"msg":"Avvio…"}', '{"date":"2026-11-04"}')`);
    const st = (await request(admin).get(`/api/service-program/agent-optimize/${id}`)).body;
    expect(st).toMatchObject({ jobId: id, status: "running", mode: "vcsp", psProjectId: PS, progress: { phase: "VCSP", pct: 0, msg: "In coda…" }, params: { date: GIORNO } });
    expect(st.error).toBeUndefined();
    const elenco = (await request(admin).get("/api/service-program/agent-optimize")).body.jobs.find((j: any) => j.jobId === id);
    expect(elenco).toMatchObject({ status: "running" });
    // senza riga in coda (un giro di prima della 2.6): interrotto, con la richiesta per rilanciarlo
    await db.execute(sql`DELETE FROM coda.lavori WHERE id = ${id}::uuid`);
    expect((await request(admin).get(`/api/service-program/agent-optimize/${id}`)).body)
      .toMatchObject({ status: "error", error: expect.stringContaining("interrotto dal riavvio") });
    await db.execute(sql`DELETE FROM agent_optimize_jobs WHERE id = ${id}::uuid`);
  });
});

