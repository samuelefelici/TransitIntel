import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "../lib/auth";
import { requireAuth, requirePermissionByPath } from "../lib/auth";
import { ensureTenantMiddleware } from "../lib/tenant";
import trafficRouter from "./traffic";
import poiRouter from "./poi";
import populationRouter from "./population";
import stopsRouter from "./stops";
import routesBusRouter from "./routes-bus";
import analysisRouter from "./analysis";
import cronRouter from "./cron";
import gtfsUploadRouter from "./gtfs-upload";
import gtfsQueriesRouter from "./gtfs-queries";
import gtfsAnalysisRouter from "./gtfs-analysis";
import gtfsTravelRouter from "./gtfs-travel";
import adminRouter from "./admin";
import scenariosRouter from "./scenarios";
import intermodalRouter from "./intermodal";
import optimizerRouteRouter from "./optimizer-route";
import optimizerScheduleRouter from "./optimizer-schedule";
import serviceProgramRouter from "./service-program";
import driverShiftsRouter from "./driver-shifts";
import optimizerRuleProfilesRouter from "./optimizer-rule-profiles";
import clustersRouter from "./clusters";
import coincidenceZonesRouter from "./coincidence-zones";
import weatherRouter from "./weather";
import faresRouter from "./fares";
import faresMinOdRouter from "./fares-min-od";
import faresNodeAssignmentRouter from "./fares-node-assignment";
import faresPolimetricheRouter from "./fares-polimetriche";
import caronteRouter from "./caronte";
import gtfsRtRouter from "./gtfs-rt";
import operationsRouter from "./operations";
import timetablesRouter from "./timetables";
import networkShareRouter from "./network-share";
import planningStudioTimetablesRouter from "./planning-studio-timetables";
import rosterRouter from "./roster";
import serviceDbRouter from "./service-db";
import depotsRouter from "./depots";
import deadheadsRouter from "./deadheads";
import deadheadArcsRouter from "./deadhead-arcs";
import intermodalOptimizerRouter from "./intermodal-optimizer";
import aiRouter from "./ai";
import planningRouter from "./planning";
import territoryRouter from "./territory";
import schedulingProjectsRouter from "../lib/scheduling-projects";
import scheduleSharesRouter from "../lib/schedule-shares";
import planningStudioRouter from "../lib/planning-studio";
import planningStudioImportRouter from "../lib/planning-studio-import";
import planningStudioExportRouter from "../lib/planning-studio-export";
import planningStudioClustersRouter from "../lib/planning-studio-clusters";
import planningStudioPeriodsRouter from "../lib/planning-studio-periods";
import planningStudioTripsExtRouter from "../lib/planning-studio-trips-ext";
import planningStudioNetworkRouter from "../lib/planning-studio-network";
import planningStudioMaterializeRouter from "../lib/planning-studio-materialize";
import planningStudioValidityRouter from "../lib/planning-studio-validity";
import planningStudioValidityCategoriesRouter from "../lib/planning-studio-validity-categories";
import planningStudioValidityUnitsRouter from "../lib/planning-studio-validity-units";
import planningStudioCalendarRouter from "../lib/planning-studio-calendar";
import planningStudioZonesRouter from "../lib/planning-studio-zones";
import planningCompareRouter from "../lib/planning-compare";
import rosterRotazioniRouter from "../lib/roster-rotazioni";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(cronRouter); // pubblico (webhook/job esterni)
router.use("/caronte", caronteRouter); // pubblico, prefisso /caronte: auth via Bearer CERBERO_API_KEY (validatore)
router.use("/gtfs-rt", gtfsRtRouter); // pubblico (aggregatori infomobilità): key opzionale GTFS_RT_API_KEY
router.use(networkShareRouter); // pubblico: mappa di rete condivisa via link

// ⛔ Tutto sotto qui richiede autenticazione + colonne tenant pronte
router.use(requireAuth);
router.use(ensureTenantMiddleware);
// RBAC centralizzato per dominio (analytics/fares/scheduling/network).
router.use(requirePermissionByPath);

router.use(trafficRouter);
router.use(poiRouter);
router.use(populationRouter);
router.use(stopsRouter);
router.use(routesBusRouter);
router.use(analysisRouter);
router.use(gtfsUploadRouter);
router.use(gtfsQueriesRouter);
router.use(gtfsAnalysisRouter);
router.use(gtfsTravelRouter);
router.use(adminRouter); // gate requireAdmin applicato dentro admin.ts (sync distruttivi)
router.use(scenariosRouter);
router.use(intermodalRouter);
router.use(intermodalOptimizerRouter);
router.use(optimizerRouteRouter);
router.use(optimizerScheduleRouter);
router.use(serviceProgramRouter);
router.use(driverShiftsRouter);
router.use(optimizerRuleProfilesRouter); // profili-regole riusabili ottimizzatore turni guida
router.use(clustersRouter);
router.use(coincidenceZonesRouter);
router.use(weatherRouter);
router.use(operationsRouter); // Sala Operativa: flotta live + puntualità (legge schema caronte)
router.use(timetablesRouter); // Stampa Orari: quadri di fermata + orari generali di linea (feed GTFS)
router.use(planningStudioTimetablesRouter); // Stampa Orari dal programma di esercizio Planning Studio (ps_*)
router.use(rosterRouter); // Roster: assegnazione turni guida al personale viaggiante
router.use(rosterRotazioniRouter); // Roster: rotazioni riposi (ciclo settimanale) + assistente CP-SAT
router.use(serviceDbRouter); // Database di Esercizio: vista unica della catena di pianificazione
router.use(faresRouter);
router.use(faresMinOdRouter);
router.use(faresNodeAssignmentRouter);
router.use(faresPolimetricheRouter);
router.use(depotsRouter);
router.use(deadheadsRouter);
router.use(deadheadArcsRouter);
router.use(aiRouter);
router.use(planningRouter);
router.use(territoryRouter);
router.use(schedulingProjectsRouter);
router.use(scheduleSharesRouter);
router.use(planningStudioRouter);
router.use(planningStudioImportRouter);
router.use(planningStudioExportRouter); // export GTFS zip del programma (deliverable Regione/open data/AVM)
router.use(planningStudioClustersRouter);
router.use(planningStudioPeriodsRouter);
router.use(planningStudioTripsExtRouter);
router.use(planningStudioNetworkRouter);
router.use(planningStudioMaterializeRouter);
router.use(planningStudioValidityRouter);
router.use(planningStudioValidityCategoriesRouter);
router.use(planningStudioValidityUnitsRouter);
router.use(planningStudioCalendarRouter); // calendario aziendale + classificazione giorni (albero validità)
router.use(planningStudioZonesRouter); // zonizzazione: confini comunali + km sviluppati per comune
router.use(planningCompareRouter); // Planner Legacy: confronto tra due progetti Planning Studio

export default router;
