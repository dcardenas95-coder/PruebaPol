import {
  LayoutDashboard,
  ShoppingCart,
  BarChart3,
  Settings,
  ScrollText,
  TrendingUp,
  Activity,
  Zap,
} from "lucide-react";
import { useLocation, Link } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import type { BotConfig } from "@shared/schema";

const navItems = [
  { title: "Overview", url: "/", icon: LayoutDashboard },
  { title: "Orders", url: "/orders", icon: ShoppingCart },
  { title: "Positions", url: "/positions", icon: TrendingUp },
  { title: "PnL", url: "/pnl", icon: BarChart3 },
  { title: "Configuration", url: "/config", icon: Settings },
  { title: "Logs", url: "/logs", icon: ScrollText },
];

function StateIndicator({ state }: { state: string }) {
  const colors: Record<string, string> = {
    MAKING: "bg-emerald-500",
    UNWIND: "bg-amber-500",
    CLOSE_ONLY: "bg-orange-500",
    HEDGE_LOCK: "bg-red-500",
    DONE: "bg-slate-500",
    STOPPED: "bg-gray-600",
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[state] || "bg-gray-500"}`} />
  );
}

export function AppSidebar() {
  const [location] = useLocation();

  const { data: config } = useQuery<BotConfig>({
    queryKey: ["/api/bot/config"],
    refetchInterval: 3000,
  });

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary">
            <Zap className="w-4 h-4 text-primary-foreground" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">PolyMaker</span>
            <span className="text-xs text-muted-foreground">Market Making Bot</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.url === "/"
                        ? location === "/"
                        : location.startsWith(item.url)
                    }
                  >
                    <Link href={item.url} data-testid={`link-nav-${item.title.toLowerCase()}`}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Status</span>
            <div className="flex items-center gap-1.5">
              <StateIndicator state={config?.currentState || "STOPPED"} />
              <span className="text-xs font-medium">{config?.currentState || "STOPPED"}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Mode</span>
            <Badge variant={config?.isPaperTrading ? "secondary" : "destructive"} className="text-xs">
              {config?.isPaperTrading ? "Paper" : "Live"}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Engine</span>
            <div className="flex items-center gap-1.5">
              <Activity className={`w-3 h-3 ${config?.isActive ? "text-emerald-500" : "text-muted-foreground"}`} />
              <span className="text-xs">{config?.isActive ? "Running" : "Idle"}</span>
            </div>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
