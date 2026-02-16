import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/lib/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { LatencyWidget } from "@/components/latency-widget";
import NotFound from "@/pages/not-found";
import Overview from "@/pages/overview";
import Orders from "@/pages/orders";
import Positions from "@/pages/positions";
import PnL from "@/pages/pnl";
import Configuration from "@/pages/config";
import Logs from "@/pages/logs";
import DualEntry5m from "@/pages/dual-entry-5m";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Overview} />
      <Route path="/orders" component={Orders} />
      <Route path="/positions" component={Positions} />
      <Route path="/pnl" component={PnL} />
      <Route path="/config" component={Configuration} />
      <Route path="/logs" component={Logs} />
      <Route path="/strategies/dual-entry-5m" component={DualEntry5m} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <SidebarProvider style={style as React.CSSProperties}>
            <div className="flex h-screen w-full">
              <AppSidebar />
              <div className="flex flex-col flex-1 min-w-0">
                <header className="flex items-center justify-between gap-2 p-2 border-b sticky top-0 z-50 bg-background">
                  <SidebarTrigger data-testid="button-sidebar-toggle" />
                  <div className="flex items-center gap-2">
                    <LatencyWidget />
                    <ThemeToggle />
                  </div>
                </header>
                <main className="flex-1 overflow-auto">
                  <Router />
                </main>
              </div>
            </div>
          </SidebarProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
