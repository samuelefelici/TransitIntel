import { lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout/Layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ErrorBoundary } from "@/components/ErrorBoundary";

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
const DriverShiftsPage = lazy(() => import("@/pages/driver-shifts"));
const CoincidenceZonesPage = lazy(() => import("@/pages/coincidence-zones"));
const FaresPage = lazy(() => import("@/pages/fares"));
const StopsClassificationPage = lazy(() => import("@/pages/stops-classification"));
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

            {/* Bigliettazione */}
            <Route path="/fares" component={FaresPage} />
            <Route path="/stops-classification" component={StopsClassificationPage} />

            {/* Ottimizzazione Servizio */}
            <Route path="/optimization" component={OptimizationPage} />
            <Route path="/fucina" component={FucinaPage} />
            <Route path="/driver-shifts/:scenarioId" component={DriverShiftsPage} />

            {/* Redirects for old optimizer paths */}
            <Route path="/optimizer-route"><Redirect to="/optimization" /></Route>
            <Route path="/optimizer-schedule"><Redirect to="/optimization" /></Route>
            <Route path="/cluster-management"><Redirect to="/optimization" /></Route>

            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}

function AuthGate() {
  const { isAuthenticated } = useAuth();
  return (
    <Suspense fallback={<PageLoader />}>
      {isAuthenticated ? <Router /> : <LoginPage />}
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
