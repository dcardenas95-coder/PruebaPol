import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  AlertTriangle,
  Power,
  Play,
  Square,
  ArrowUpDown,
  BarChart3,
  Wifi,
  WifiOff,
  Cable,
  RefreshCw,
  Wallet,
} from "lucide-react";
import type { BotStatus } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

function StatCard({
  title,
  value,
  icon: Icon,
  subtitle,
  trend,
  testId,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
  subtitle?: string;
  trend?: "up" | "down" | "neutral";
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{title}</span>
            <span className="text-xl font-bold tracking-tight" data-testid={`${testId}-value`}>
              {value}
            </span>
            {subtitle && (
              <span className="text-xs text-muted-foreground">{subtitle}</span>
            )}
          </div>
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted">
            <Icon
              className={`w-5 h-5 ${
                trend === "up"
                  ? "text-emerald-500"
                  : trend === "down"
                    ? "text-red-500"
                    : "text-muted-foreground"
              }`}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StateTimeline({ state }: { state: string }) {
  const states = ["MAKING", "UNWIND", "CLOSE_ONLY", "HEDGE_LOCK", "DONE"];
  const currentIndex = states.indexOf(state);

  return (
    <div className="flex items-center gap-1 w-full" data-testid="fsm-state-timeline">
      {states.map((s, i) => {
        const isActive = s === state;
        const isPast = i < currentIndex && currentIndex >= 0;
        return (
          <div key={s} className="flex items-center gap-1 flex-1">
            <div className="flex flex-col items-center gap-1 flex-1">
              <div
                className={`w-full h-1.5 rounded-full transition-colors ${
                  isActive
                    ? "bg-primary"
                    : isPast
                      ? "bg-primary/40"
                      : "bg-muted"
                }`}
              />
              <span
                className={`text-[10px] ${
                  isActive
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {s}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MarketDataPanel({ data, isLive, marketSlug }: { data: { bestBid: number; bestAsk: number; spread: number; midpoint: number; bidDepth: number; askDepth: number; lastPrice: number; volume24h: number } | null; isLive?: boolean; marketSlug?: string | null }) {
  if (!data) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm font-medium">Market Data</CardTitle>
          <Badge variant="secondary">No Market</Badge>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="text-sm text-muted-foreground">
            No active market selected. Configure a market in settings.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-market-data">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm font-medium">Market Data</CardTitle>
          {marketSlug && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]" data-testid="text-market-slug">
              {marketSlug}
            </span>
          )}
        </div>
        <Badge variant={isLive ? "default" : "secondary"} data-testid="badge-data-source">
          {isLive ? "LIVE" : "Simulated"}
        </Badge>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Best Bid</span>
            <span className="text-sm font-mono font-medium text-emerald-500" data-testid="text-best-bid">
              ${data.bestBid.toFixed(4)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Best Ask</span>
            <span className="text-sm font-mono font-medium text-red-500" data-testid="text-best-ask">
              ${data.bestAsk.toFixed(4)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Spread</span>
            <span className={`text-sm font-mono font-medium ${data.spread >= 0.03 ? "text-emerald-500" : "text-muted-foreground"}`} data-testid="text-spread">
              {(data.spread * 100).toFixed(2)}%
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Midpoint</span>
            <span className="text-sm font-mono font-medium" data-testid="text-midpoint">
              ${data.midpoint.toFixed(4)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Bid Depth</span>
            <span className="text-sm font-mono" data-testid="text-bid-depth">
              ${data.bidDepth.toFixed(2)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Ask Depth</span>
            <span className="text-sm font-mono" data-testid="text-ask-depth">
              ${data.askDepth.toFixed(2)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Last Price</span>
            <span className="text-sm font-mono" data-testid="text-last-price">
              ${data.lastPrice.toFixed(4)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">24h Volume</span>
            <span className="text-sm font-mono" data-testid="text-volume">
              ${data.volume24h.toFixed(2)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const { toast } = useToast();

  const { data: status, isLoading } = useQuery<BotStatus>({
    queryKey: ["/api/bot/status"],
    refetchInterval: 2000,
  });

  const { data: walletBalance } = useQuery<{ initialized: boolean; walletAddress: string | null; usdc: string | null; allowance: string | null }>({
    queryKey: ["/api/trading/wallet-balance"],
    refetchInterval: 15000,
  });

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const newState = !status?.config.isActive;
      return apiRequest("PATCH", "/api/bot/config", { isActive: newState });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/config"] });
      toast({ title: status?.config.isActive ? "Bot detenido" : "Bot iniciado" });
    },
  });

  const killSwitchMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/bot/kill-switch");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/config"] });
      toast({ title: "Kill switch activado", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-16 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const config = status?.config;
  const dailyPnl = status?.dailyPnl ?? 0;
  const wsHealth = status?.wsHealth;

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-sm text-muted-foreground">
              Asymmetric market making for Polymarket
            </p>
            {status?.isLiveData ? (
              <Badge variant="outline" className="text-xs gap-1" data-testid="badge-live-connection">
                <Wifi className="w-3 h-3 text-emerald-500" />
                Live
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs gap-1" data-testid="badge-sim-connection">
                <WifiOff className="w-3 h-3 text-muted-foreground" />
                Simulated
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={config?.isActive ? "destructive" : "default"}
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending || config?.killSwitchActive}
            data-testid="button-toggle-bot"
          >
            {config?.isActive ? (
              <>
                <Square className="w-4 h-4 mr-1.5" /> Stop Bot
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-1.5" /> Start Bot
              </>
            )}
          </Button>
          <Button
            variant="destructive"
            size="icon"
            onClick={() => killSwitchMutation.mutate()}
            disabled={killSwitchMutation.isPending}
            data-testid="button-kill-switch"
          >
            <Power className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {config?.killSwitchActive && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-destructive">Kill Switch Active</p>
              <p className="text-xs text-muted-foreground">
                All trading is halted. Deactivate in Configuration to resume.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          title="Wallet Balance"
          value={walletBalance?.initialized ? `$${parseFloat(walletBalance.usdc || "0").toFixed(2)}` : "—"}
          icon={Wallet}
          subtitle={walletBalance?.initialized ? `${walletBalance.walletAddress?.slice(0, 6)}...${walletBalance.walletAddress?.slice(-4)}` : "Wallet not connected"}
          testId="card-wallet-balance"
        />
        <StatCard
          title="Daily PnL"
          value={`$${dailyPnl.toFixed(2)}`}
          icon={dailyPnl >= 0 ? TrendingUp : TrendingDown}
          trend={dailyPnl > 0 ? "up" : dailyPnl < 0 ? "down" : "neutral"}
          testId="card-daily-pnl"
        />
        <StatCard
          title="Active Orders"
          value={String(status?.activeOrders ?? 0)}
          icon={ShoppingCart}
          testId="card-active-orders"
        />
        <StatCard
          title="Open Positions"
          value={String(status?.openPositions ?? 0)}
          icon={ArrowUpDown}
          testId="card-open-positions"
        />
        <StatCard
          title="Consecutive Losses"
          value={String(status?.consecutiveLosses ?? 0)}
          icon={BarChart3}
          subtitle={`Max: ${config?.maxConsecutiveLosses ?? 3}`}
          trend={
            (status?.consecutiveLosses ?? 0) >= (config?.maxConsecutiveLosses ?? 3)
              ? "down"
              : "neutral"
          }
          testId="card-consecutive-losses"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="card-fsm-state">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium">Strategy State Machine</CardTitle>
            <div className="flex items-center gap-1.5">
              <Activity
                className={`w-3.5 h-3.5 ${
                  config?.isActive ? "text-emerald-500" : "text-muted-foreground"
                }`}
              />
              <Badge variant={config?.isActive ? "default" : "secondary"}>
                {config?.currentState || "STOPPED"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <StateTimeline state={config?.currentState || "STOPPED"} />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Mode</span>
                <span className="text-sm font-medium">
                  {config?.isPaperTrading ? "Paper Trading" : "Live Trading"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Order Size</span>
                <span className="text-sm font-mono font-medium">
                  ${config?.orderSize?.toFixed(2) ?? "10.00"}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Min Spread</span>
                <span className="text-sm font-mono font-medium">
                  {((config?.minSpread ?? 0.03) * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Max Exposure</span>
                <span className="text-sm font-mono font-medium">
                  ${config?.maxNetExposure?.toFixed(2) ?? "100.00"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <MarketDataPanel
          data={status?.marketData ?? null}
          isLive={status?.isLiveData}
          marketSlug={status?.config?.currentMarketSlug}
        />
      </div>

      <Card data-testid="card-risk-overview">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Risk Parameters</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Max Net Exposure</span>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all"
                    style={{ width: `${Math.min(100, ((status?.openPositions ?? 0) / (config?.maxNetExposure ?? 100)) * 100)}%` }}
                  />
                </div>
                <span className="text-xs font-mono">${config?.maxNetExposure?.toFixed(0) ?? "100"}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Daily Loss Limit</span>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${dailyPnl < 0 ? "bg-destructive" : "bg-emerald-500"}`}
                    style={{ width: `${Math.min(100, (Math.abs(dailyPnl) / (config?.maxDailyLoss ?? 50)) * 100)}%` }}
                  />
                </div>
                <span className="text-xs font-mono">${config?.maxDailyLoss?.toFixed(0) ?? "50"}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Target Profit</span>
              <span className="text-sm font-mono">
                {((config?.targetProfitMin ?? 0.03) * 100).toFixed(1)}% - {((config?.targetProfitMax ?? 0.05) * 100).toFixed(1)}%
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Consec. Loss Stop</span>
              <span className="text-sm font-mono">
                {status?.consecutiveLosses ?? 0} / {config?.maxConsecutiveLosses ?? 3}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-ws-health">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Cable className="w-4 h-4" />
            WebSocket Connections
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium">Market Data Feed</span>
                <span className="text-xs text-muted-foreground">
                  {wsHealth?.marketSubscribedAssets?.length
                    ? `${wsHealth.marketSubscribedAssets.length} asset(s)`
                    : "No subscriptions"}
                </span>
                {wsHealth?.marketLastMessage ? (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    Last: {formatWsTime(wsHealth.marketLastMessage)}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {(wsHealth?.marketReconnects ?? 0) > 0 && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                    <RefreshCw className="w-3 h-3" />
                    {wsHealth?.marketReconnects}
                  </span>
                )}
                <Badge
                  variant={wsHealth?.marketConnected ? "default" : "secondary"}
                  className="text-[10px]"
                  data-testid="badge-ws-market"
                >
                  {wsHealth?.marketConnected ? (
                    <><Wifi className="w-3 h-3 mr-1" /> Connected</>
                  ) : (
                    <><WifiOff className="w-3 h-3 mr-1" /> Disconnected</>
                  )}
                </Badge>
              </div>
            </div>

            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium">User Order Feed</span>
                <span className="text-xs text-muted-foreground">
                  {wsHealth?.userSubscribedAssets?.length
                    ? `${wsHealth.userSubscribedAssets.length} asset(s)`
                    : config?.isPaperTrading ? "Paper mode (disabled)" : "No subscriptions"}
                </span>
                {wsHealth?.userLastMessage ? (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    Last: {formatWsTime(wsHealth.userLastMessage)}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {(wsHealth?.userReconnects ?? 0) > 0 && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                    <RefreshCw className="w-3 h-3" />
                    {wsHealth?.userReconnects}
                  </span>
                )}
                <Badge
                  variant={wsHealth?.userConnected ? "default" : "secondary"}
                  className="text-[10px]"
                  data-testid="badge-ws-user"
                >
                  {wsHealth?.userConnected ? (
                    <><Wifi className="w-3 h-3 mr-1" /> Connected</>
                  ) : (
                    <><WifiOff className="w-3 h-3 mr-1" /> Disconnected</>
                  )}
                </Badge>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatWsTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
