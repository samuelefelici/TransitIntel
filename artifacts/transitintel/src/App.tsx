import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout/Layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import VirgilioController from "@/components/VirgilioController";
// VirgilioTentacles disabilitato — mantenuto solo l'highlight CSS sui target

// Lazy-loaded pages — each is code-split into its own chunk
const LoginPage = lazy(() => import("@/pages/login"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Traffic = lazy(() => import("@/pages/traffic"));
const Territory = lazy(() => import("@/pages/territory"));
const NetworkPage = lazy(() => import("@/pages/network"));
const DataPage = lazy(() => import("@/pages/data"));
const ScenariosPage = lazy(() => import("@/pages/scenarios"));
const IntermodalPage = lazy(() => import("@/pages/intermodal"));
const OptimizationPage = lazy(() => import("@/pages/optimization"));
const FucinaPage = lazy(() => import("@/pages/fucina"));
const SchedulingProjectsHubPage = lazy(() => import("@/pages/scheduling/ProjectsHubPage"));
const SchedulingProjectDashboardPage = lazy(() => import("@/pages/scheduling/ProjectDashboardPage"));
const VehicleScenariosPage = lazy(() => import("@/pages/scheduling/VehicleScenariosPage"));
const DriverScenariosPage = lazy(() => import("@/pages/scheduling/DriverScenariosPage"));
// ClusterPage rimosso: i cluster ora vivono in Planner Studio
// (/planning-studio/:id/clusters). Le rotte /cluster e /cluster-management
// sono mantenute solo come Redirect per non rompere link esterni.
const DriverShiftsPage = lazy(() => import("@/pages/driver-shifts"));
const CoincidenceZonesPage = lazy(() => import("@/pages/coincidence-zones"));
const FaresPage = lazy(() => import("@/pages/fares"));
const FareAnalyticsPage = lazy(() => import("@/pages/fare-analytics"));
const FareDocsPage = lazy(() => import("@/pages/fare-docs"));
const FareSimulatorPage = lazy(() => import("@/pages/fare-simulator"));
const StopsClassificationPage = lazy(() => import("@/pages/stops-classification"));
const FaresEnginePage = lazy(() => import("@/pages/fares-engine"));
const TripPlannerPage = lazy(() => import("@/pages/trip-planner"));
const DepotsPage = lazy(() => import("@/pages/depots"));
const PlanningListPage = lazy(() => import("@/pages/planning"));
const PlanningNewPage = lazy(() => import("@/pages/planning/new"));
const PlanningWorkspacePage = lazy(() => import("@/pages/planning/workspace"));
const PlanningStudioListPage = lazy(() => import("@/pages/planning-studio"));
const PlanningStudioEditorPage = lazy(() => import("@/pages/planning-studio/EditorPage"));
const PlanningStudioClustersPage = lazy(() => import("@/pages/planning-studio/ClustersPage"));
const PlanningStudioServicePeriodsPage = lazy(() => import("@/pages/planning-studio/ServicePeriodsPage"));
const PlanningStudioTripsPage = lazy(() => import("@/pages/planning-studio/TripsPage"));
const PlanningStudioNetworkPage = lazy(() => import("@/pages/planning-studio/NetworkPage"));
const PlanningStudioValidityPage = lazy(() => import("@/pages/planning-studio/ValidityPage"));
const PlanningStudioValidityUnitsPage = lazy(() => import("@/pages/planning-studio/ValidityUnitsPage"));
const NetworkEngineHub = lazy(() => import("@/pages/network-engine"));
const AdminUsersPage = lazy(() => import("@/pages/admin-users"));
const NotFound = lazy(() => import("@/pages/not-found"));

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
 * Guardia di permesso: se l'utente non ha il permesso richiesto
 * (e non è admin), redirige a /dashboard.
 */
function Gated({ perm, children }: { perm: "analytics" | "fares" | "scheduling" | "network"; children: ReactNode }) {
  const { hasPermission } = useAuth();
  if (!hasPermission(perm)) return <Redirect to="/dashboard" />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Redirect to="/dashboard" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Layout>
      <ErrorBoundary context="Pagina">
        <Suspense fallback={<PageLoader />}>
          <Switch>
            <Route path="/">
              <Redirect to="/dashboard" />
            </Route>
            <Route path="/dashboard" component={Dashboard} />
            <Route path="/traffic">
              <Gated perm="analytics"><Traffic /></Gated>
            </Route>
            <Route path="/territory">
              <Gated perm="analytics"><Territory /></Gated>
            </Route>
            <Route path="/network">
              <Gated perm="analytics"><NetworkPage /></Gated>
            </Route>
            <Route path="/data" component={DataPage} />

            {/* Redirects for old paths → new unified pages */}
            <Route path="/routes"><Redirect to="/network" /></Route>
            <Route path="/travel-time"><Redirect to="/network" /></Route>
            <Route path="/stops"><Redirect to="/network" /></Route>
            <Route path="/demand"><Redirect to="/territory" /></Route>
            <Route path="/segments"><Redirect to="/territory" /></Route>
            <Route path="/reports"><Redirect to="/territory" /></Route>
            <Route path="/gtfs"><Redirect to="/data" /></Route>
            <Route path="/sync"><Redirect to="/data" /></Route>

            {/* Crea Servizio (scheduling) */}
            <Route path="/network-engine">
              <Gated perm="network"><NetworkEngineHub /></Gated>
            </Route>
            <Route path="/scenarios">
              <Gated perm="network"><ScenariosPage /></Gated>
            </Route>
            <Route path="/intermodal">
              <Gated perm="network"><IntermodalPage /></Gated>
            </Route>
            <Route path="/coincidence-zones">
              <Gated perm="network"><CoincidenceZonesPage /></Gated>
            </Route>

            {/* PlannerStudio (scheduling) */}
            <Route path="/planning">
              <Gated perm="network"><PlanningListPage /></Gated>
            </Route>
            <Route path="/planning/new">
              <Gated perm="network"><PlanningNewPage /></Gated>
            </Route>
            <Route path="/planning/:scenarioId/workspace">
              <Gated perm="network"><PlanningWorkspacePage /></Gated>
            </Route>
            <Route path="/planning/:scenarioId">
              {(p) => <Redirect to={`/planning/${p.scenarioId}/workspace`} />}
            </Route>

            {/* PlannerStudio (DB master del servizio) */}
            <Route path="/planning-studio">
              <Gated perm="network"><PlanningStudioListPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id">
              <Gated perm="network"><PlanningStudioEditorPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/clusters">
              <Gated perm="network"><PlanningStudioClustersPage /></Gated>
            </Route>
            <Route path="/planning-studio/:id/service-periods">
              <Gated perm="network"><PlanningStudioServicePeriodsPage /></Gated>
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

            {/* Bigliettazione (fares) */}
            <Route path="/fares-engine">
              <Gated perm="fares"><FaresEnginePage /></Gated>
            </Route>
            <Route path="/fares">
              <Gated perm="fares"><FaresPage /></Gated>
            </Route>
            <Route path="/fare-analytics">
              <Gated perm="fares"><FareAnalyticsPage /></Gated>
            </Route>
            <Route path="/fare-docs">
              <Gated perm="fares"><FareDocsPage /></Gated>
            </Route>
            <Route path="/fare-simulator">
              <Gated perm="fares"><FareSimulatorPage /></Gated>
            </Route>
            <Route path="/stops-classification">
              <Gated perm="fares"><StopsClassificationPage /></Gated>
            </Route>
            <Route path="/trip-planner">
              <Gated perm="fares"><TripPlannerPage /></Gated>
            </Route>

            {/* Scheduling Engine — tutte le rotte della zona fuoco */}
            <Route path="/fucina">
              <Gated perm="scheduling"><SchedulingProjectsHubPage /></Gated>
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
            <Route path="/optimization">
              <Gated perm="scheduling"><OptimizationPage /></Gated>
            </Route>
            {/* I cluster sono gestiti per-progetto dentro Planner Studio.
                Le vecchie rotte globali /cluster e /cluster-management vengono
                rediretti alla lista progetti Planner Studio. */}
            <Route path="/cluster"><Redirect to="/planning-studio" /></Route>
            <Route path="/cluster-management"><Redirect to="/planning-studio" /></Route>
            <Route path="/depots">
              <Gated perm="scheduling"><DepotsPage /></Gated>
            </Route>
            <Route path="/driver-shifts/:scenarioId" component={DriverShiftsPage} />

            {/* Admin */}
            <Route path="/admin/users">
              <AdminOnly><AdminUsersPage /></AdminOnly>
            </Route>

            {/* Redirects for old optimizer paths */}
            <Route path="/optimizer-route"><Redirect to="/fucina" /></Route>
            <Route path="/optimizer-schedule"><Redirect to="/fucina" /></Route>

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}

function AuthGate() {
  const { isAuthenticated, loading, user } = useAuth();
  const [, navigate] = useLocation();
  const prevAuth = useRef(isAuthenticated);
  // true = appena fatto login, stiamo lasciando finire la sequenza cinematica dentro <LoginPage>
  const [waitingSequence, setWaitingSequence] = useState(false);

  // Listener globale: 401 -> svuota lo stato; AuthProvider rinegozierà via /me.
  // NON forziamo redirect duro a /login: lasciamo che lo stato di auth si auto-aggiorni
  // (un singolo 401 su una route protetta non significa che la sessione è caduta — può essere
  // un endpoint per cui l'utente non ha permesso, e usare navigate qui interrompe la UX).
  useEffect(() => {
    function onUnauth() {
      // best-effort: invalida cache locale; AuthProvider farà /me al prossimo tick
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
      navigate("/dashboard");
    }
    prevAuth.current = isAuthenticated;
  }, [isAuthenticated, navigate]);

  if (loading) return <PageLoader />;

  // Se l'utente è autenticato MA siamo nel finestra di animazione post-login,
  // continuiamo a mostrare LoginPage (che ha gia' accessGranted=true e sta animando).
  const showApp = isAuthenticated && !waitingSequence;

  return (
    <Suspense fallback={<PageLoader />}>
      {showApp ? (
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
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
