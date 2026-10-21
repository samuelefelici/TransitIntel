import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as ToasterSonner } from "@/components/ui/sonner";
import { toast as toastSonner } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout/Layout";
import { AuthProvider, useAuth, type Permission } from "@/hooks/use-auth";
import { CASA, NOMI_PERMESSI, PERMESSI_PAGINA } from "@/lib/navigazione";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import ArgosLiveBridge from "@/components/argos/ArgosLiveBridge";
import VirgilioController from "@/components/VirgilioController";

/**
 * lazy() resiliente al DEPLOY. Dopo un rilascio i chunk vecchi spariscono dal
 * server: se l'utente ha in cache l'index vecchio, l'import() di una pagina
 * fallisce con "Importing a module script failed" (404 sul chunk) e la pagina
 * crasha. Qui, al primo fallimento, ricarichiamo UNA volta la pagina così il
 * browser riscarica index.html e il manifest aggiornato. Guardia in
 * sessionStorage per non entrare in loop se il problema è reale (offline, ecc).
 */
function lazyWithRetry<T extends { default: React.ComponentType<any> }>(
  factory: () => Promise<T>,
): React.LazyExoticComponent<T["default"]> {
  return lazy(async () => {
    const KEY = "chunk-reload-once";
    try {
      const m = await factory();
      sessionStorage.removeItem(KEY);
      return m;
    } catch (err) {
      const isChunkError = err instanceof Error
        && /import|module script|dynamically imported|Failed to fetch|chunk/i.test(err.message);
      if (isChunkError && sessionStorage.getItem(KEY) !== "1") {
        sessionStorage.setItem(KEY, "1");
        window.location.reload();
        // ritorna una Promise che non risolve: la pagina si sta ricaricando
        return await new Promise<T>(() => {});
      }
      throw err;
    }
  });
}

// Lazy-loaded pages — each is code-split into its own chunk
const LoginPage = lazyWithRetry(() => import("@/pages/login"));
const OggiPage = lazyWithRetry(() => import("@/pages/oggi"));
const Dashboard = lazyWithRetry(() => import("@/pages/dashboard"));
const OperationsPage = lazyWithRetry(() => import("@/pages/operations"));
const TimetablesPage = lazyWithRetry(() => import("@/pages/timetables"));
const NetworkSharePage = lazyWithRetry(() => import("@/pages/network-share"));
const TimetableMapPage = lazyWithRetry(() => import("@/pages/timetable-map"));
const RuntimesPage = lazyWithRetry(() => import("@/pages/runtimes"));
const RosterPage = lazyWithRetry(() => import("@/pages/roster"));
const RosterPubblicazionePage = lazyWithRetry(() => import("@/pages/roster-pubblicazione"));
const AnagraficaPage = lazyWithRetry(() => import("@/pages/anagrafica"));
const MistoPage = lazyWithRetry(() => import("@/pages/misto"));
const ServiceDbPage = lazyWithRetry(() => import("@/pages/service-db"));
const Traffic = lazyWithRetry(() => import("@/pages/traffic"));
const Territory = lazyWithRetry(() => import("@/pages/territory"));
const NetworkPage = lazyWithRetry(() => import("@/pages/network"));
const DataPage = lazyWithRetry(() => import("@/pages/data"));
const AvmPage = lazyWithRetry(() => import("@/pages/avm"));
const ScenariosPage = lazyWithRetry(() => import("@/pages/scenarios"));
const IntermodalPage = lazyWithRetry(() => import("@/pages/intermodal"));
const FucinaPage = lazyWithRetry(() => import("@/pages/fucina"));
const SchedulingProjectDashboardPage = lazyWithRetry(() => import("@/pages/scheduling/ProjectDashboardPage"));
const VehicleScenariosPage = lazyWithRetry(() => import("@/pages/scheduling/VehicleScenariosPage"));
const DriverScenariosPage = lazyWithRetry(() => import("@/pages/scheduling/DriverScenariosPage"));
const ProcessReportPage = lazyWithRetry(() => import("@/pages/fucina/ProcessReportPage"));
// ClusterPage rimosso: i cluster ora vivono in Planner Studio
// (/planning-studio/:id/clusters). Le rotte /cluster e /cluster-management
// sono mantenute solo come Redirect per non rompere link esterni.
const DriverShiftsPage = lazyWithRetry(() => import("@/pages/driver-shifts"));
const CoincidenceZonesPage = lazyWithRetry(() => import("@/pages/coincidence-zones"));
const FaresPage = lazyWithRetry(() => import("@/pages/fares"));
const FaresPolimetrichePage = lazyWithRetry(() => import("@/pages/fares-polimetriche"));
const FareAnalyticsPage = lazyWithRetry(() => import("@/pages/fare-analytics"));
const FareDocsPage = lazyWithRetry(() => import("@/pages/fare-docs"));
const FareSimulatorPage = lazyWithRetry(() => import("@/pages/fare-simulator"));
const TripPlannerPage = lazyWithRetry(() => import("@/pages/trip-planner"));
const DepotsPage = lazyWithRetry(() => import("@/pages/depots"));
const DeadheadArcsPage = lazyWithRetry(() => import("@/pages/deadhead-arcs"));
const PlanningListPage = lazyWithRetry(() => import("@/pages/planning"));
const PlanningStudioListPage = lazyWithRetry(() => import("@/pages/planning-studio"));
const PlanningStudioEditorPage = lazyWithRetry(() => import("@/pages/planning-studio/EditorPage"));
const PlanningStudioClustersPage = lazyWithRetry(() => import("@/pages/planning-studio/ClustersPage"));
const PlanningStudioTripsPage = lazyWithRetry(() => import("@/pages/planning-studio/TripsPage"));
const PlanningStudioNetworkPage = lazyWithRetry(() => import("@/pages/planning-studio/NetworkPage"));
const PlanningStudioValidityPage = lazyWithRetry(() => import("@/pages/planning-studio/ValidityPage"));
const PlanningStudioValidityUnitsPage = lazyWithRetry(() => import("@/pages/planning-studio/ValidityUnitsPage"));
const PlanningStudioCalendarProfilePage = lazyWithRetry(() => import("@/pages/planning-studio/CalendarProfilePage"));
const PlanningStudioOperationalBoardPage = lazyWithRetry(() => import("@/pages/planning-studio/OperationalBoardPage"));
const PlanningStudioTtdPage = lazyWithRetry(() => import("@/pages/planning-studio/TtdPage"));
const PlanningStudioPercorrenzePage = lazyWithRetry(() => import("@/pages/planning-studio/PercorrenzePage"));
const PlanningStudioZonesPage = lazyWithRetry(() => import("@/pages/planning-studio/ZonesPage"));
const PlanningStudioActivityPage = lazyWithRetry(() => import("@/pages/planning-studio/ActivityPage"));
const AdminUsersPage = lazyWithRetry(() => import("@/pages/admin-users"));
const AdminParametriPage = lazyWithRetry(() => import("@/pages/admin-parametri"));
const AccountPage = lazyWithRetry(() => import("@/pages/account"));
const ApriFleetCare = lazyWithRetry(() => import("@/pages/fleetcare"));
const NotFound = lazyWithRetry(() => import("@/pages/not-found"));

// Initialize TanStack Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
    </div>
  );
}

/**
 * Una pagina che l'utente non può aprire: si torna a Oggi e si dice perché.
 * L'avviso parte una volta sola, anche se React monta due volte.
 */
function Respinto({ motivo }: { motivo: string }) {
  const detto = useRef(false);
  useEffect(() => {
    if (detto.current) return;
    detto.current = true;
    toastSonner.info("Pagina non disponibile", { description: motivo });
  }, [motivo]);
  return <Redirect to={CASA} replace />;
}

/**
 * Guardia di permesso: se l'utente non ha il permesso richiesto
 * (e non è admin), torna a Oggi.
 */
function Gated({ perm, children }: { perm: Permission | readonly Permission[]; children: ReactNode }) {
  const { hasPermission, verificato } = useAuth();
  const servono: readonly Permission[] = typeof perm === "string" ? [perm] : perm;
  /* con più permessi ne basta uno */
  if (!servono.some(p => hasPermission(p))) {
    /* i permessi in cache possono essere di prima (un permesso nuovo, un cambio dell'admin):
     * si rimanda via solo dopo che il server ha risposto */
    if (!verificato) return <PageLoader />;
    return <Respinto motivo={`Serve il permesso «${servono.map(p => NOMI_PERMESSI[p]).join("» o «")}»: chiedilo all'amministratore.`} />;
  }
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin, verificato } = useAuth();
  if (!isAdmin) {
    if (!verificato) return <PageLoader />;
    return <Respinto motivo="Questa pagina è riservata agli amministratori." />;
  }
  return <>{children}</>;
}

/** Un percorso vecchio che porta al nuovo, con la stessa query (wouter la perderebbe). */
function RedirectConQuery({ to }: { to: string }) {
  return <Redirect to={`${to}${window.location.search}`} replace />;
}

function Router() {
  return (
    <Layout>
      <ErrorBoundary context="Pagina">
        <Suspense fallback={<PageLoader />}>
          <Switch>
            <Route path="/account"><AccountPage /></Route>
            <Route path="/"><Redirect to={CASA} replace /></Route>
            <Route path="/oggi"><OggiPage /></Route>
            {/* la mappa di analisi: era la home, ora è nella sezione Analisi */}
            <Route path="/dashboard">
              <Gated perm={PERMESSI_PAGINA["/dashboard"]}><Dashboard /></Gated>
            </Route>
            {/* Centrale Operativa: Mappa live + AVM, modulo attivabile per utente */}
            <Route path="/operations">
              <Gated perm={PERMESSI_PAGINA["/operations"]}><OperationsPage /></Gated>
            </Route>
            <Route path="/avm">
              <Gated perm={PERMESSI_PAGINA["/avm"]}><AvmPage /></Gated>
            </Route>
            <Route path="/timetables">
              <Gated perm={PERMESSI_PAGINA["/timetables"]}><TimetablesPage /></Gated>
            </Route>
            <Route path="/runtimes">
              <Gated perm={PERMESSI_PAGINA["/runtimes"]}><RuntimesPage /></Gated>
            </Route>
            <Route path="/traffic">
              <Gated perm={PERMESSI_PAGINA["/traffic"]}><Traffic /></Gated>
            </Route>
            <Route path="/territory">
              <Gated perm={PERMESSI_PAGINA["/territory"]}><Territory /></Gated>
            </Route>
            <Route path="/network">
              <Gated perm={PERMESSI_PAGINA["/network"]}><NetworkPage /></Gated>
            </Route>
            <Route path="/data">
              <Gated perm={PERMESSI_PAGINA["/data"]}><DataPage /></Gated>
            </Route>

            {/* Redirects for old paths → new unified pages */}
            <Route path="/routes"><Redirect to="/network" replace /></Route>
            <Route path="/travel-time"><Redirect to="/network" replace /></Route>
            <Route path="/stops"><Redirect to="/network" replace /></Route>
            <Route path="/demand"><Redirect to="/territory" replace /></Route>
            <Route path="/segments"><Redirect to="/territory" replace /></Route>
            <Route path="/reports"><Redirect to="/territory" replace /></Route>
            <Route path="/gtfs"><Redirect to="/data" replace /></Route>
            <Route path="/sync"><Redirect to="/data" replace /></Route>

            {/* Crea Servizio (scheduling) */}
            {/* l'ingresso di Network Engine: ora le voci stanno nel menu */}
            <Route path="/network-engine"><Redirect to="/planning-studio" replace /></Route>
            <Route path="/scenarios">
              <Gated perm={PERMESSI_PAGINA["/scenarios"]}><ScenariosPage /></Gated>
            </Route>
            {/* Intermodale: sezione di progetto (/planning-studio/:id/intermodal) */}
            <Route path="/intermodal"><Redirect to="/planning-studio" replace /></Route>
            <Route path="/coincidence-zones">
              <Gated perm={PERMESSI_PAGINA["/coincidence-zones"]}><CoincidenceZonesPage /></Gated>
            </Route>

            {/* Confronta programmi; il vecchio planner sugli scenari GTFS (new, workspace) non c'è più */}
            <Route path="/planning">
              <Gated perm={PERMESSI_PAGINA["/planning"]}><PlanningListPage /></Gated>
            </Route>
            <Route path="/planning/*"><Redirect to="/planning" replace /></Route>

            {/* PlannerStudio (DB master del servizio) */}
            <Route path="/planning-studio">
              <Gated perm={PERMESSI_PAGINA["/planning-studio"]}><PlanningStudioListPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id">
              <Gated perm="network"><PlanningStudioEditorPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/clusters">
              <Gated perm="network"><PlanningStudioClustersPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/trips">
              <Gated perm="network"><PlanningStudioTripsPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/network">
              <Gated perm="network"><PlanningStudioNetworkPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/validity">
              <Gated perm="network"><PlanningStudioValidityPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/validity-units">
              <Gated perm="network"><PlanningStudioValidityUnitsPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/calendar">
              <Gated perm="network"><PlanningStudioCalendarProfilePage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/ttd">
              <Gated perm="network"><PlanningStudioTtdPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/percorrenze">
              <Gated perm="network"><PlanningStudioPercorrenzePage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/zones">
              <Gated perm="network"><PlanningStudioZonesPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/activity">
              <Gated perm="network"><PlanningStudioActivityPage /></Gated>
            </Route>
            {/* Infrastruttura del progetto: le stesse pagine che prima vivevano
                come sezioni globali (/depots, /deadhead-arcs, /intermodal),
                ora dentro il progetto e scopate su di esso. */}
            <Route path="/planning-studio/:id/depots">
              <Gated perm="network"><DepotsPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/deadhead-arcs">
              <Gated perm="network"><DeadheadArcsPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/intermodal">
              <Gated perm="network"><IntermodalPage /></Gated>
            </Route>

            {/* Bigliettazione (fares) */}
            {/* l'ingresso di Fares Engine: ora le voci stanno nel menu */}
            <Route path="/fares-engine"><Redirect to="/fares" replace /></Route>
            <Route path="/fares">
              <Gated perm={PERMESSI_PAGINA["/fares"]}><FaresPage /></Gated>
            </Route>
            <Route path="/fares-polimetriche">
              <Gated perm={PERMESSI_PAGINA["/fares-polimetriche"]}><FaresPolimetrichePage /></Gated>
            </Route>
            <Route path="/fare-analytics">
              <Gated perm={PERMESSI_PAGINA["/fare-analytics"]}><FareAnalyticsPage /></Gated>
            </Route>
            <Route path="/fare-docs">
              <Gated perm={PERMESSI_PAGINA["/fare-docs"]}><FareDocsPage /></Gated>
            </Route>
            <Route path="/fare-simulator">
              <Gated perm={PERMESSI_PAGINA["/fare-simulator"]}><FareSimulatorPage /></Gated>
            </Route>
            {/* la classificazione delle fermate è il passo 2 di Bigliettazione */}
            <Route path="/stops-classification"><Redirect to="/fares" replace /></Route>
            <Route path="/trip-planner">
              <Gated perm={PERMESSI_PAGINA["/trip-planner"]}><TripPlannerPage /></Gated>
            </Route>

            {/* Scheduling Engine — tutte le rotte della zona fuoco */}
            <Route path="/fucina"><RedirectConQuery to="/fucina/esercizio" /></Route>
            <Route path="/fucina/esercizio/:id">
              <Gated perm="scheduling"><PlanningStudioOperationalBoardPage /></Gated>
            </Route>
            <Route path="/fucina/esercizio">
              <Gated perm={PERMESSI_PAGINA["/fucina/esercizio"]}><PlanningStudioOperationalBoardPage /></Gated>
            </Route>
            <Route path="/fucina/relazioni/:reportId">
              <Gated perm="scheduling"><ProcessReportPage /></Gated>
            </Route>
            <Route path="/fucina/:projectId/pipeline">
              <Gated perm="scheduling"><FucinaPage /></Gated>
            </Route>
            <Route path="/fucina/:projectId/vehicles/:scenarioId">
              <Gated perm="scheduling"><FucinaPage /></Gated>
            </Route>
            <Route path="/fucina/:projectId/vehicles">
              <Gated perm="scheduling"><VehicleScenariosPage /></Gated>
            </Route>
            <Route path="/fucina/:projectId/drivers/:scenarioId">
              <Gated perm="scheduling"><FucinaPage /></Gated>
            </Route>
            <Route path="/fucina/:projectId/drivers">
              <Gated perm="scheduling"><DriverScenariosPage /></Gated>
            </Route>
            <Route path="/fucina/:projectId">
              <Gated perm="scheduling"><SchedulingProjectDashboardPage /></Gated>
            </Route>
            {/* la vecchia «Ottimizzazione Servizio»: le autovetture aziendali sono in Amministrazione › Parametri */}
            <Route path="/optimization"><Redirect to="/fucina/esercizio" replace /></Route>
            <Route path="/roster/anagrafica">
              <Gated perm={PERMESSI_PAGINA["/roster/anagrafica"]}><AnagraficaPage /></Gated>
            </Route>
            <Route path="/roster/pubblicazione">
              <Gated perm={PERMESSI_PAGINA["/roster/pubblicazione"]}><RosterPubblicazionePage /></Gated>
            </Route>
            <Route path="/roster">
              <Gated perm={PERMESSI_PAGINA["/roster"]}><RosterPage /></Gated>
            </Route>
            <Route path="/misto">
              <Gated perm={PERMESSI_PAGINA["/misto"]}><MistoPage /></Gated>
            </Route>
            <Route path="/service-db">
              <Gated perm={PERMESSI_PAGINA["/service-db"]}><ServiceDbPage /></Gated>
            </Route>
            {/* I cluster sono gestiti per-progetto dentro Planner Studio.
                Le vecchie rotte globali /cluster e /cluster-management vengono
                rediretti alla lista progetti Planner Studio. */}
            <Route path="/cluster"><Redirect to="/planning-studio" replace /></Route>
            <Route path="/cluster-management"><Redirect to="/planning-studio" replace /></Route>
            {/* Depositi e archi fuorilinea sono infrastruttura DI PROGETTO:
                si gestiscono in /planning-studio/:id/(depots|deadhead-arcs).
                Le vecchie pagine globali restano solo come redirect. */}
            <Route path="/depots"><Redirect to="/planning-studio" replace /></Route>
            <Route path="/deadhead-arcs"><Redirect to="/planning-studio" replace /></Route>
            {/* la pagina di prima dei turni guida: fuori dal menu, si toglie in Fase 2 */}
            <Route path="/driver-shifts/:scenarioId">
              <Gated perm={PERMESSI_PAGINA["/driver-shifts"]}><DriverShiftsPage /></Gated>
            </Route>

            {/* Admin */}
            <Route path="/admin/users">
              <AdminOnly><AdminUsersPage /></AdminOnly>
            </Route>
            <Route path="/admin/parametri">
              <AdminOnly><AdminParametriPage /></AdminOnly>
            </Route>

            {/* Redirects for old optimizer paths */}
            <Route path="/optimizer-route"><Redirect to="/fucina/esercizio" replace /></Route>
            <Route path="/optimizer-schedule"><Redirect to="/fucina/esercizio" replace /></Route>

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}

function AuthGate() {
  const { isAuthenticated, loading, user, accesso } = useAuth();
  const [location, navigate] = useLocation();
  const prevAuth = useRef(isAuthenticated);
  /* entrato con un codice di recupero: si parte dalla pagina per rifare la verifica */
  const recuperoRef = useRef(false);
  recuperoRef.current = !!accesso?.recupero;
  /* codici di recupero da rifare dopo un cambio di chiave: lo si dice all'ingresso */
  const codiciRef = useRef(false);
  codiciRef.current = !!accesso?.codiciDaRifare;
  /* la pagina chiesta prima dell'accesso (anche /fleetcare, da «Entra con Cerbero»): dopo si torna lì */
  const locationRef = useRef(location);
  locationRef.current = location;
  // true = appena fatto login, stiamo lasciando finire la sequenza cinematica dentro <LoginPage>
  const [waitingSequence, setWaitingSequence] = useState(false);

  // Listener globale: 401 -> svuota lo stato; AuthProvider richiede /me (hooks/use-auth.tsx)
  // e, se la sessione è davvero finita, torna il login.
  // NON forziamo redirect duro a /login: lasciamo che lo stato di auth si auto-aggiorni
  // (un singolo 401 su una route protetta non significa che la sessione è caduta — può essere
  // un endpoint per cui l'utente non ha permesso, e usare navigate qui interrompe la UX).
  useEffect(() => {
    function onUnauth() {
      try { sessionStorage.removeItem("transitintel_auth"); } catch {}
    }
    window.addEventListener("auth:unauthorized", onUnauth);
    return () => window.removeEventListener("auth:unauthorized", onUnauth);
  }, []);

  // Quando LoginPage finisce la sequenza "Verifica Identità → Accesso Autorizzato → Inizializzazione"
  // dispatcha auth:login-sequence-done. Solo allora smontiamo il login e montiamo l'app.
  useEffect(() => {
    function onSeqDone() { setWaitingSequence(false); }
    window.addEventListener("auth:login-sequence-done", onSeqDone);
    return () => window.removeEventListener("auth:login-sequence-done", onSeqDone);
  }, []);

  useEffect(() => {
    if (!prevAuth.current && isAuthenticated) {
      // Login fresco -> tieni montato LoginPage finché la sequenza non emette l'evento
      setWaitingSequence(true);
      /* replace: la pagina del login non resta nella cronologia (da FleetCare, Indietro
       * non deve riportare a /fleetcare e far ripartire un biglietto) */
      /* si torna alla pagina chiesta prima dell'accesso (un segnalibro, un link), con la sua
       * query; dalla radice o dal login si parte da Oggi */
      const chiesta = locationRef.current;
      navigate(recuperoRef.current
        ? "/account"
        : chiesta && chiesta !== "/" && chiesta !== "/login" ? `${chiesta}${window.location.search}` : CASA,
        { replace: true });
      if (codiciRef.current && !recuperoRef.current) {
        toastSonner.warning("Rifai i codici di recupero", {
          description: "Quelli che hai sono di prima di un aggiornamento della sicurezza: fanne di nuovi in «Sicurezza dell'account».",
          duration: 15000,
        });
      }
    }
    prevAuth.current = isAuthenticated;
  }, [isAuthenticated, navigate]);

  // Rotta PUBBLICA della Mappa di Rete condivisa: nessuna autenticazione.
  if (location.startsWith("/m/")) {
    return <Suspense fallback={<PageLoader />}><NetworkSharePage /></Suspense>;
  }
  // Rotta PUBBLICA della Mappa Orari (linea → percorsi → fermata → transiti).
  if (location.startsWith("/o/")) {
    return <Suspense fallback={<PageLoader />}><TimetableMapPage /></Suspense>;
  }

  if (loading) return <PageLoader />;

  // Se l'utente è autenticato MA siamo nel finestra di animazione post-login,
  // continuiamo a mostrare LoginPage (che ha gia' accessGranted=true e sta animando).
  const showApp = isAuthenticated && !waitingSequence;

  return (
    <Suspense fallback={<PageLoader />}>
      {showApp && accesso?.limitato ? (
        /* sessione limitata (password provvisoria, verifica da attivare): solo la pagina
         * per mettersi in regola, senza menu; il server rifiuta comunque il resto */
        <AccountPage forzata />
      ) : showApp && location === "/fleetcare" ? (
        /* il passaggio verso FleetCare: fuori dal menu, porta subito di là */
        <ApriFleetCare />
      ) : showApp ? (
        <>
          <VirgilioController />
          <Router />
        </>
      ) : (
        <LoginPage />
      )}
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary context="App">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <AuthGate />
            </WouterRouter>
            <Toaster />
            {/* il roster e l'anagrafica avvisano con sonner: senza questo i loro messaggi non si vedevano */}
            <ToasterSonner position="bottom-right" richColors closeButton />
            {/* Regia in diretta: le scritture dell'agente invalidano i dati
                di Planning Studio e le pagine aperte si aggiornano da sole. */}
            <ArgosLiveBridge />
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
