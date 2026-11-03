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

/* niente rete: OSRM non risponde e la matrice fuorilinea ricade su Haversine × circuità */
vi.hoisted(() => { process.env.OSRM_URL = "http://127.0.0.1:1"; });

/** Python finto: registra cosa riceve e risponde come il solver, in modo deterministico. */
const py = vi.hoisted(() => ({ chiamate: [] as any[], crash: false }));

vi.mock("../lib/lavori/python", async (orig) => {
  const vero = await orig<typeof import("../lib/lavori/python")>();
  return {
    ...vero,
    eseguiPython: vi.fn(async (o: any) => {
      py.chiamate.push({ script: o.script, argv: o.argv ?? [], ingresso: JSON.parse(JSON.stringify(o.ingresso ?? null)) });
      const fase = o.script === "vcsp_orchestrator.py" ? "VCSP" : "VSP";
      if (o.suProgresso) o.suProgresso({ phase: fase, percentage: 50, detail: "a metà", timestamp: 0 });
      else o.suRigaStderr?.(`PROGRESS|${fase}|50|a metà`);
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

async function semina(): Promise<void> {
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
  c.prima?.();
  const r = await request(c.app === "altro" ? altro : admin).post(c.rotta).send(c.corpo as object);
  return { status: r.status, body: r.body, python: [...py.chiamate] };
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
    py.chiamate.length = 0;
    py.crash = false;
    const avvio = await request(admin).post("/api/service-program/agent-optimize").send({
      psProjectId: PS, date: GIORNO, mode: "vcsp",
      routes: [{ routeId: "R1", vehicleType: "12m" }, { routeId: "RC", vehicleType: "10m" }],
      depots: [{ id: DEPOSITO, maxVehicles: 3 }],
      intensity: "fast", rounds: 2, probes: 0, crewTimeLimit: 30, memoria: false, companyCars: 2,
      scenarioName: "Giro di prova",
    });
    expect(avvio.status, JSON.stringify(avvio.body)).toBe(200);
    const { jobId, ...restoAvvio } = avvio.body;
    expect(restoAvvio).toMatchSnapshot("avvio");

    let stato: any = null;
    for (let i = 0; i < 100; i++) {
      stato = (await request(admin).get(`/api/service-program/agent-optimize/${jobId}`)).body;
      if (stato.status !== "running") break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(stato.status, JSON.stringify(stato)).toBe("done");
    const { scenarioId, dssId, elapsedSec: _e, jobId: _j, persisted: _p, ...vista } = stato;
    expect(vista).toMatchSnapshot("vista del giro finito");
    expect(py.chiamate).toMatchSnapshot("python");

    const sc = (await db.execute<any>(sql`
      SELECT name, date, feed_id, input, result, owner_user_id, project_id, depots, config
        FROM service_program_scenarios WHERE id = ${scenarioId}::uuid`)).rows[0];
    expect(sc.config.savedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    sc.config.savedAt = "…";
    expect(sc).toMatchSnapshot("scenario turni macchina");
    const dss = (await db.execute<any>(sql`
      SELECT service_program_scenario_id, name, result, config, owner_user_id
        FROM driver_shift_scenarios WHERE id = ${dssId}::uuid`)).rows[0];
    expect(dss.service_program_scenario_id).toBe(scenarioId);
    dss.service_program_scenario_id = "…";
    expect(dss).toMatchSnapshot("turni guida");
    const riga = (await db.execute<any>(sql`
      SELECT status, mode, scenario_id, dss_id, scenario_name, params, result_compact, error
        FROM agent_optimize_jobs WHERE id = ${jobId}::uuid`)).rows[0];
    expect(riga).toMatchObject({ status: "done", mode: "vcsp", scenario_id: scenarioId, dss_id: dssId, scenario_name: "Giro di prova", error: null });
    expect(riga.result_compact).toEqual(vista.result);

    // il giro di un altro: 403; l'elenco dell'altro non lo mostra
    expect((await request(altro).get(`/api/service-program/agent-optimize/${jobId}`)).status).toBe(403);
    const elenco = await request(altro).get("/api/service-program/agent-optimize");
    expect(elenco.body.jobs.map((j: any) => j.jobId)).not.toContain(jobId);
  });
});
