import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect } from "react";
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
  RotateCw,
  Timer,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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

function MarketCountdown({ remainingMs, durationMs, currentState }: { remainingMs: number; durationMs: number; currentState?: string }) {
  const [displayMs, setDisplayMs] = useState(remainingMs);

  useEffect(() => {
    setDisplayMs(remainingMs);
  }, [remainingMs]);

  useEffect(() => {
    const timer = setInterval(() => {
      setDisplayMs(prev => Math.max(0, prev - 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const totalSec = Math.floor(displayMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (displayMs / durationMs) * 100)) : 0;

  let barColor = "bg-emerald-500";
  let textColor = "text-emerald-500";
  if (totalSec <= 45) {
    barColor = "bg-red-500";
    textColor = "text-red-500";
  } else if (totalSec <= 60) {
    barColor = "bg-orange-500";
    textColor = "text-orange-500";
  } else if (totalSec <= 120) {
    barColor = "bg-yellow-500";
    textColor = "text-yellow-500";
  }

  let stateLabel = "";
  if (totalSec <= 0) stateLabel = "DONE";
  else if (totalSec <= 45) stateLabel = "HEDGE_LOCK";
  else if (totalSec <= 60) stateLabel = "CLOSE_ONLY";
  else if (totalSec <= 120) stateLabel = "UNWIND";
  else stateLabel = "MAKING";

  return (
    <div className="flex flex-col gap-1.5" data-testid="market-countdown">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Timer className={`w-3.5 h-3.5 ${textColor}`} />
          <span className="text-xs text-muted-foreground">Market Timer</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] ${textColor}`} data-testid="badge-timer-state">
            {stateLabel}
          </Badge>
          <span className={`text-lg font-mono font-bold tabular-nums ${textColor}`} data-testid="text-countdown">
            {min}:{sec.toString().padStart(2, "0")}
          </span>
        </div>
      </div>
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden" data-testid="countdown-bar">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
        <span>0:00</span>
        <span>{Math.floor(durationMs / 60000)}:00</span>
      </div>
    </div>
  );
}

function MarketDataPanel({ data, isLive, marketSlug, remainingMs, durationMs, currentState }: { data: { bestBid: number; bestAsk: number; spread: number; midpoint: number; bidDepth: number; askDepth: number; lastPrice: number; volume24h: number } | null; isLive?: boolean; marketSlug?: string | null; remainingMs?: number; durationMs?: number; currentState?: string }) {
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
      <CardContent className="p-4 pt-0 space-y-4">
        {remainingMs !== undefined && durationMs !== undefined && durationMs > 0 && (
          <MarketCountdown remainingMs={remainingMs} durationMs={durationMs} currentState={currentState} />
        )}
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

  const autoRotateMutation = useMutation({
    mutationFn: async (updates: { autoRotate?: boolean; autoRotateAsset?: string; autoRotateInterval?: string }) => {
      return apiRequest("PATCH", "/api/bot/config", updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/config"] });
      toast({ title: "Auto-rotate updated" });
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
            {config?.autoRotate && (
              <Badge variant="outline" className="text-xs gap-1" data-testid="badge-auto-rotate">
                <RotateCw className="w-3 h-3 text-emerald-500" />
                Auto {config.autoRotateAsset?.toUpperCase()} {config.autoRotateInterval}
              </Badge>
            )}
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
            variant={config?.isActive || status?.isLiquidating ? "destructive" : "default"}
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending || config?.killSwitchActive || status?.isLiquidating}
            data-testid="button-toggle-bot"
          >
            {status?.isLiquidating ? (
              <>
                <Square className="w-4 h-4 mr-1.5 animate-pulse" /> Liquidando...
              </>
            ) : config?.isActive ? (
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

      {status?.isLiquidating && (
        <Card className="border-orange-500/50 bg-orange-500/5" data-testid="card-liquidating-banner">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <AlertTriangle className="w-5 h-5 text-orange-500 flex-shrink-0 animate-pulse" />
              <div className="flex-1">
                <p className="text-sm font-medium text-orange-500">Liquidando posiciones abiertas...</p>
                <p className="text-xs text-muted-foreground">
                  {(status.liquidationElapsedMs ?? 0) < (status.liquidationPatienceMs ?? 60000)
                    ? `Intentando salir al precio de entrada. Cruce forzado del spread en ${Math.max(0, Math.floor(((status.liquidationPatienceMs ?? 60000) - (status.liquidationElapsedMs ?? 0)) / 1000))}s`
                    : "Cruzando spread para forzar cierre de posiciones..."}
                </p>
              </div>
              <Badge variant="outline" className="text-orange-500 border-orange-500/50 font-mono">
                {status.openPositions} pos. abiertas
              </Badge>
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-orange-500 transition-all duration-1000"
                style={{ width: `${Math.min(100, ((status.liquidationElapsedMs ?? 0) / (status.liquidationPatienceMs ?? 60000)) * 100)}%` }}
              />
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
                  status?.isLiquidating ? "text-orange-500 animate-pulse" : config?.isActive ? "text-emerald-500" : "text-muted-foreground"
                }`}
              />
              <Badge variant={status?.isLiquidating ? "destructive" : config?.isActive ? "default" : "secondary"}>
                {status?.isLiquidating ? "LIQUIDATING" : config?.currentState || "STOPPED"}
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

            <div className="mt-4 pt-3 border-t">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <RotateCw className={`w-3.5 h-3.5 ${config?.autoRotate ? "text-emerald-500" : "text-muted-foreground"}`} />
                  <span className="text-xs font-medium">Auto-Rotate 5m Markets</span>
                </div>
                <Switch
                  checked={config?.autoRotate ?? false}
                  onCheckedChange={(checked) => autoRotateMutation.mutate({ autoRotate: checked })}
                  disabled={autoRotateMutation.isPending}
                  data-testid="switch-auto-rotate"
                />
              </div>
              {config?.autoRotate && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Asset</span>
                    <Select
                      value={config.autoRotateAsset ?? "btc"}
                      onValueChange={(val) => autoRotateMutation.mutate({ autoRotateAsset: val })}
                    >
                      <SelectTrigger className="h-8 text-xs" data-testid="select-auto-rotate-asset">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="btc">BTC</SelectItem>
                        <SelectItem value="eth">ETH</SelectItem>
                        <SelectItem value="sol">SOL</SelectItem>
                        <SelectItem value="xrp">XRP</SelectItem>
                        <SelectItem value="doge">DOGE</SelectItem>
                        <SelectItem value="bnb">BNB</SelectItem>
                        <SelectItem value="link">LINK</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">Interval</span>
                    <Select
                      value={config.autoRotateInterval ?? "5m"}
                      onValueChange={(val) => autoRotateMutation.mutate({ autoRotateInterval: val })}
                    >
                      <SelectTrigger className="h-8 text-xs" data-testid="select-auto-rotate-interval">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="5m">5 minutes</SelectItem>
                        <SelectItem value="15m">15 minutes</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <MarketDataPanel
          data={status?.marketData ?? null}
          isLive={status?.isLiveData}
          marketSlug={status?.config?.currentMarketSlug}
          remainingMs={status?.marketRemainingMs}
          durationMs={status?.marketDurationMs}
          currentState={status?.config?.currentState ?? undefined}
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

      {status && <OraclePanel status={status} />}

      {status && <SmartModulesPanel status={status} />}

      <HealthAlertsPanel />
    </div>
  );
}

function OraclePanel({ status }: { status: BotStatus }) {
  const oracle = status.oracle;
  const { toast } = useToast();

  const connectMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/oracle/connect"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "Oracle conectando a Binance BTC feed" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/oracle/disconnect"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "Oracle desconectado" });
    },
  });

  const signal = oracle?.signal;
  const directionColor = signal?.direction === "UP" ? "text-emerald-500" : signal?.direction === "DOWN" ? "text-red-400" : "text-muted-foreground";
  const strengthColor = signal?.strength === "STRONG" ? "bg-emerald-500/20 text-emerald-400" : signal?.strength === "WEAK" ? "bg-yellow-500/20 text-yellow-400" : "bg-muted text-muted-foreground";

  return (
    <Card data-testid="card-oracle-panel">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <TrendingUp className="w-4 h-4" />
          Binance Oracle — BTC Price Feed
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge
            variant={oracle?.connected ? "default" : "secondary"}
            className="text-[10px]"
            data-testid="badge-oracle-status"
          >
            {oracle?.connected ? (
              <><Wifi className="w-3 h-3 mr-1" /> Live</>
            ) : (
              <><WifiOff className="w-3 h-3 mr-1" /> Off</>
            )}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs px-2"
            onClick={() => oracle?.connected ? disconnectMutation.mutate() : connectMutation.mutate()}
            disabled={connectMutation.isPending || disconnectMutation.isPending}
            data-testid="button-oracle-toggle"
          >
            {oracle?.connected ? "Disconnect" : "Connect"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {oracle?.connected && signal ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="flex flex-col gap-1 p-2 rounded bg-muted/50">
              <span className="text-[10px] text-muted-foreground">BTC Price</span>
              <span className="text-sm font-mono font-bold" data-testid="text-oracle-btc-price">
                ${oracle.btcPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2 rounded bg-muted/50">
              <span className="text-[10px] text-muted-foreground">Window Delta</span>
              <span className={`text-sm font-mono font-bold ${directionColor}`} data-testid="text-oracle-delta">
                {signal.delta >= 0 ? "+" : ""}${signal.delta?.toFixed(2) ?? "—"}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-2 rounded bg-muted/50">
              <span className="text-[10px] text-muted-foreground">Signal</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-sm font-bold ${directionColor}`} data-testid="text-oracle-direction">
                  {signal.direction ?? "—"}
                </span>
                <Badge className={`text-[9px] ${strengthColor} border-0`} variant="outline" data-testid="badge-oracle-strength">
                  {signal.strength ?? "—"}
                </Badge>
              </div>
            </div>
            <div className="flex flex-col gap-1 p-2 rounded bg-muted/50">
              <span className="text-[10px] text-muted-foreground">Confidence</span>
              <span className="text-sm font-mono font-bold" data-testid="text-oracle-confidence">
                {signal.confidence != null ? `${(signal.confidence * 100).toFixed(0)}%` : "—"}
              </span>
              <span className="text-[10px] text-muted-foreground font-mono">
                Vol 5m: ${oracle.volatility5m?.toFixed(2) ?? "—"}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground p-3 text-center">
            Oracle desconectado. Conecta para señales de precio BTC en tiempo real de Binance.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SmartModulesPanel({ status }: { status: BotStatus }) {
  const sizer = status.progressiveSizer;
  const sl = status.stopLoss;
  const regime = status.marketRegime;

  return (
    <Card data-testid="card-smart-modules">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <BarChart3 className="w-4 h-4" />
          Smart Trading Modules
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="flex flex-col gap-2 p-3 rounded bg-muted/30 border border-muted" data-testid="module-progressive-sizer">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Progressive Sizer</span>
              <Badge variant={sizer?.enabled ? "default" : "secondary"} className="text-[9px]" data-testid="badge-sizer-status">
                {sizer?.enabled ? "Active" : "Off"}
              </Badge>
            </div>
            {sizer ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Level</span>
                  <span className="text-xs font-mono font-bold" data-testid="text-sizer-level">
                    L{sizer.currentLevel.level} — ${sizer.currentLevel.size}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Win Rate</span>
                  <span className="text-xs font-mono" data-testid="text-sizer-winrate">
                    {(sizer.stats.winRate * 100).toFixed(1)}% ({sizer.stats.totalTrades} trades)
                  </span>
                </div>
                <span className="text-[9px] text-muted-foreground">{sizer.currentLevel.reason}</span>
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground">No data</span>
            )}
          </div>

          <div className="flex flex-col gap-2 p-3 rounded bg-muted/30 border border-muted" data-testid="module-stop-loss">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Stop-Loss Protection</span>
              <Badge variant={sl?.enabled ? "default" : "secondary"} className="text-[9px]" data-testid="badge-stoploss-status">
                {sl?.enabled ? "Active" : "Off"}
              </Badge>
            </div>
            {sl ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Max Loss</span>
                  <span className="text-xs font-mono">{(sl.config.maxLossPercent * 100).toFixed(0)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Trailing</span>
                  <span className="text-xs font-mono">{sl.config.trailingEnabled ? `${(sl.config.trailingPercent * 100).toFixed(0)}%` : "Off"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Tracked</span>
                  <span className="text-xs font-mono" data-testid="text-stoploss-tracked">{sl.trackedPositions} positions</span>
                </div>
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground">No data</span>
            )}
          </div>

          <div className="flex flex-col gap-2 p-3 rounded bg-muted/30 border border-muted" data-testid="module-market-regime">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Market Regime</span>
              <Badge variant={regime?.enabled ? "default" : "secondary"} className="text-[9px]" data-testid="badge-regime-status">
                {regime?.enabled ? "Active" : "Off"}
              </Badge>
            </div>
            {regime?.currentRegime ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Regime</span>
                  <Badge
                    variant="outline"
                    className={`text-[9px] border-0 ${
                      regime.currentRegime.regime === "TRENDING" ? "bg-emerald-500/20 text-emerald-400"
                      : regime.currentRegime.regime === "RANGING" ? "bg-blue-500/20 text-blue-400"
                      : regime.currentRegime.regime === "VOLATILE" ? "bg-orange-500/20 text-orange-400"
                      : "bg-muted text-muted-foreground"
                    }`}
                    data-testid="badge-regime-type"
                  >
                    {regime.currentRegime.regime}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Tradeable</span>
                  <span className={`text-xs font-mono ${regime.currentRegime.tradeable ? "text-emerald-400" : "text-red-400"}`}>
                    {regime.currentRegime.tradeable ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Spread</span>
                  <span className="text-xs font-mono">{(regime.currentRegime.spread * 100).toFixed(1)}%</span>
                </div>
                {regime.currentRegime.reason && (
                  <span className="text-[9px] text-muted-foreground">{regime.currentRegime.reason}</span>
                )}
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground">No market data</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function HealthAlertsPanel() {
  const { data: health } = useQuery<any>({
    queryKey: ["/api/health"],
    refetchInterval: 15000,
  });

  const { data: alerts } = useQuery<any>({
    queryKey: ["/api/alerts"],
    refetchInterval: 10000,
  });

  const overallColor = health?.overall === "healthy"
    ? "text-emerald-500"
    : health?.overall === "degraded"
      ? "text-yellow-500"
      : "text-red-500";

  const overallBg = health?.overall === "healthy"
    ? "bg-emerald-500/10"
    : health?.overall === "degraded"
      ? "bg-yellow-500/10"
      : "bg-red-500/10";

  const checks = health?.checks;

  return (
    <Card data-testid="card-health-alerts">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Activity className="w-4 h-4" />
          System Health
        </CardTitle>
        {health && (
          <Badge
            variant="outline"
            className={`text-[10px] ${overallBg} ${overallColor} border-0`}
            data-testid="badge-health-overall"
          >
            {health.overall === "healthy" ? "Healthy" : health.overall === "degraded" ? "Degraded" : "Unhealthy"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {checks ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
            <HealthCheck
              label="RPC"
              status={checks.rpc.status}
              detail={checks.rpc.latencyMs ? `${checks.rpc.latencyMs}ms` : checks.rpc.error?.slice(0, 20)}
            />
            <HealthCheck
              label="CLOB API"
              status={checks.clobApi.status}
              detail={checks.clobApi.latencyMs ? `${checks.clobApi.latencyMs}ms` : checks.clobApi.error?.slice(0, 20)}
            />
            <HealthCheck
              label="WebSocket"
              status={checks.websocket.status}
              detail={checks.websocket.market && checks.websocket.user ? "Both OK" : checks.websocket.market ? "Market only" : checks.websocket.user ? "User only" : "Down"}
            />
            <HealthCheck
              label="Database"
              status={checks.database.status}
              detail={checks.database.latencyMs ? `${checks.database.latencyMs}ms` : checks.database.error?.slice(0, 20)}
            />
            <HealthCheck
              label="Rate Limiter"
              status={checks.rateLimiter.status === "ok" ? "ok" : "error"}
              detail={checks.rateLimiter.circuitOpen ? "Circuit OPEN" : `${checks.rateLimiter.requestsLastMinute} req/min`}
            />
          </div>
        ) : (
          <Skeleton className="h-12 w-full mb-3" />
        )}

        {alerts?.active?.length > 0 && (
          <div className="flex flex-col gap-1.5 mt-2">
            <span className="text-xs font-medium text-muted-foreground">
              Active Alerts ({alerts.active.length})
            </span>
            {alerts.active.slice(0, 5).map((alert: any) => (
              <div
                key={alert.id}
                className={`flex items-center gap-2 p-2 rounded text-xs ${
                  alert.level === "critical"
                    ? "bg-red-500/10 text-red-400"
                    : alert.level === "warning"
                      ? "bg-yellow-500/10 text-yellow-400"
                      : "bg-blue-500/10 text-blue-400"
                }`}
                data-testid={`alert-${alert.key}`}
              >
                <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                <span className="font-medium">{alert.title}:</span>
                <span className="truncate">{alert.message}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mt-2 pt-2 border-t border-muted">
          <span className="text-[10px] text-muted-foreground">
            Telegram: {alerts?.summary?.telegramEnabled ? "Configurado" : "No configurado"}
          </span>
          {health?.uptime && (
            <span className="text-[10px] text-muted-foreground font-mono">
              Uptime: {formatUptime(health.uptime)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function HealthCheck({ label, status, detail }: { label: string; status: string; detail?: string }) {
  const isOk = status === "ok";
  return (
    <div className={`flex flex-col items-center p-2 rounded ${isOk ? "bg-emerald-500/5" : "bg-red-500/10"}`} data-testid={`health-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className={`w-2 h-2 rounded-full mb-1 ${isOk ? "bg-emerald-500" : "bg-red-500"}`} />
      <span className="text-[10px] font-medium">{label}</span>
      {detail && <span className={`text-[9px] font-mono ${isOk ? "text-muted-foreground" : "text-red-400"}`}>{detail}</span>}
    </div>
  );
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function formatWsTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
