import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
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
const ClusterPage = lazy(() => import("@/pages/cluster"));
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
function Gated({ perm, children }: { perm: "analytics" | "fares" | "scheduling"; children: ReactNode }) {
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
            <Route path="/scenarios">
              <Gated perm="scheduling"><ScenariosPage /></Gated>
            </Route>
            <Route path="/intermodal">
              <Gated perm="scheduling"><IntermodalPage /></Gated>
            </Route>
            <Route path="/coincidence-zones">
              <Gated perm="scheduling"><CoincidenceZonesPage /></Gated>
            </Route>

            {/* PlannerStudio (scheduling) */}
            <Route path="/planning">
              <Gated perm="scheduling"><PlanningListPage /></Gated>
            </Route>
            <Route path="/planning/new">
              <Gated perm="scheduling"><PlanningNewPage /></Gated>
            </Route>
            <Route path="/planning/:scenarioId/workspace">
              <Gated perm="scheduling"><PlanningWorkspacePage /></Gated>
            </Route>
            <Route path="/planning/:scenarioId">
              {(p) => <Redirect to={`/planning/${p.scenarioId}/workspace`} />}
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
              <Gated perm="scheduling"><FucinaPage /></Gated>
            </Route>
            <Route path="/optimization">
              <Gated perm="scheduling"><OptimizationPage /></Gated>
            </Route>
            <Route path="/cluster">
              <Gated perm="scheduling"><ClusterPage /></Gated>
            </Route>
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
            <Route path="/cluster-management"><Redirect to="/cluster" /></Route>

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}

function AuthGate() {
  const { isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();
  const prevAuth = useRef(isAuthenticated);

  // Listener globale: 401 -> logout client-side (redirect a login)
  useEffect(() => {
    function onUnauth() {
      // svuota lo stato lasciando che AuthProvider rinegozi via /me
      sessionStorage.removeItem("transitintel_auth");
    }
    window.addEventListener("auth:unauthorized", onUnauth);
    return () => window.removeEventListener("auth:unauthorized", onUnauth);
  }, []);

  useEffect(() => {
    if (!prevAuth.current && isAuthenticated) {
      navigate("/dashboard");
    }
    prevAuth.current = isAuthenticated;
  }, [isAuthenticated, navigate]);

  if (loading) return <PageLoader />;

  return (
    <Suspense fallback={<PageLoader />}>
      {isAuthenticated ? (
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
