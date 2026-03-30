import { lazy, Suspense } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout/Layout";

// Lazy-loaded pages — each is code-split into its own chunk
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Traffic = lazy(() => import("@/pages/traffic"));
const Territory = lazy(() => import("@/pages/territory"));
const Stops = lazy(() => import("@/pages/stops"));
const Reports = lazy(() => import("@/pages/reports"));
const Gtfs = lazy(() => import("@/pages/gtfs"));
const RoutesPage = lazy(() => import("@/pages/routes"));
const TravelTimePage = lazy(() => import("@/pages/travel-time"));
const SyncPage = lazy(() => import("@/pages/sync"));
const DemandPage = lazy(() => import("@/pages/demand"));
const SegmentsPage = lazy(() => import("@/pages/segments"));
const ScenariosPage = lazy(() => import("@/pages/scenarios"));
const IntermodalPage = lazy(() => import("@/pages/intermodal"));
const OptimizerRoutePage = lazy(() => import("@/pages/optimizer-route"));
const OptimizerSchedulePage = lazy(() => import("@/pages/optimizer-schedule"));
const DriverShiftsPage = lazy(() => import("@/pages/driver-shifts"));
const ClusterManagementPage = lazy(() => import("@/pages/cluster-management"));
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
      <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/">
            <Redirect to="/dashboard" />
          </Route>
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/traffic" component={Traffic} />
          <Route path="/territory" component={Territory} />
          <Route path="/stops" component={Stops} />
          <Route path="/reports" component={Reports} />
          <Route path="/gtfs" component={Gtfs} />
          <Route path="/routes" component={RoutesPage} />
          <Route path="/travel-time" component={TravelTimePage} />
          <Route path="/sync" component={SyncPage} />
          <Route path="/demand" component={DemandPage} />
          <Route path="/segments" component={SegmentsPage} />
          <Route path="/scenarios" component={ScenariosPage} />
          <Route path="/intermodal" component={IntermodalPage} />
          <Route path="/optimizer-route" component={OptimizerRoutePage} />
          <Route path="/optimizer-schedule" component={OptimizerSchedulePage} />
          <Route path="/cluster-management" component={ClusterManagementPage} />
          <Route path="/driver-shifts/:scenarioId" component={DriverShiftsPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
