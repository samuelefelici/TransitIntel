import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "@/components/layout/Layout";
import Dashboard from "@/pages/dashboard";
import Traffic from "@/pages/traffic";
import Territory from "@/pages/territory";
import Stops from "@/pages/stops";
import Reports from "@/pages/reports";
import Gtfs from "@/pages/gtfs";
import RoutesPage from "@/pages/routes";
import TravelTimePage from "@/pages/travel-time";
import SyncPage from "@/pages/sync";
import DemandPage from "@/pages/demand";
import NotFound from "@/pages/not-found";

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

function Router() {
  return (
    <Layout>
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
        <Route component={NotFound} />
      </Switch>
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
