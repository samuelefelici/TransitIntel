import { lazy, Suspense, useEffect, useRef } from "react";
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
            <Route path="/traffic" component={Traffic} />
            <Route path="/territory" component={Territory} />
            <Route path="/network" component={NetworkPage} />
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

            {/* Crea Servizio */}
            <Route path="/scenarios" component={ScenariosPage} />
            <Route path="/intermodal" component={IntermodalPage} />
            <Route path="/coincidence-zones" component={CoincidenceZonesPage} />

            {/* PlannerStudio */}
            <Route path="/planning" component={PlanningListPage} />
            <Route path="/planning/new" component={PlanningNewPage} />
            <Route path="/planning/:scenarioId/workspace" component={PlanningWorkspacePage} />
            <Route path="/planning/:scenarioId">
              {(p) => <Redirect to={`/planning/${p.scenarioId}/workspace`} />}
            </Route>

            {/* Bigliettazione */}
            <Route path="/fares-engine" component={FaresEnginePage} />
            <Route path="/fares" component={FaresPage} />
            <Route path="/fare-analytics" component={FareAnalyticsPage} />
            <Route path="/fare-docs" component={FareDocsPage} />
            <Route path="/fare-simulator" component={FareSimulatorPage} />
            <Route path="/stops-classification" component={StopsClassificationPage} />
            <Route path="/trip-planner" component={TripPlannerPage} />

            {/* Scheduling Engine — tutte le rotte della zona fuoco */}
            <Route path="/fucina" component={FucinaPage} />
            <Route path="/optimization" component={OptimizationPage} />
            <Route path="/cluster" component={ClusterPage} />
            <Route path="/depots" component={DepotsPage} />
            <Route path="/driver-shifts/:scenarioId" component={DriverShiftsPage} />

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
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const prevAuth = useRef(isAuthenticated);

  useEffect(() => {
    // Redirect to dashboard only when transitioning from unauthenticated → authenticated
    if (!prevAuth.current && isAuthenticated) {
      navigate("/dashboard");
    }
    prevAuth.current = isAuthenticated;
  }, [isAuthenticated, navigate]);

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
