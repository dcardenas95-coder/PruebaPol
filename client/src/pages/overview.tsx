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
  Timer,
  Target,
  Zap,
  RotateCw,
  Clock,
  FlaskConical,
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

const CYCLE_STATES = ["IDLE", "ARMED", "ENTRY_WORKING", "PARTIAL_FILL", "HEDGED", "EXIT_WORKING", "DONE"];
const CYCLE_STATE_LABELS: Record<string, string> = {
  IDLE: "Idle",
  ARMED: "Armado",
  ENTRY_WORKING: "Entrada",
  PARTIAL_FILL: "Parcial",
  HEDGED: "Hedge",
  EXIT_WORKING: "Salida",
  DONE: "Hecho",
  CLEANUP: "Limpieza",
  FAILSAFE: "Failsafe",
};
const CYCLE_STATE_COLORS: Record<string, string> = {
  IDLE: "bg-muted",
  ARMED: "bg-yellow-500",
  ENTRY_WORKING: "bg-blue-500",
  PARTIAL_FILL: "bg-orange-500",
  HEDGED: "bg-emerald-500",
  EXIT_WORKING: "bg-purple-500",
  DONE: "bg-muted-foreground",
  CLEANUP: "bg-red-500",
  FAILSAFE: "bg-red-600",
};

function CycleStateTimeline({ state }: { state: string }) {
  const currentIndex = CYCLE_STATES.indexOf(state);

  return (
    <div className="flex items-center gap-1 w-full" data-testid="cycle-state-timeline">
      {CYCLE_STATES.map((s, i) => {
        const isActive = s === state;
        const isPast = i < currentIndex && currentIndex >= 0;
        return (
          <div key={s} className="flex items-center gap-1 flex-1">
            <div className="flex flex-col items-center gap-1 flex-1">
              <div
                className={`w-full h-1.5 rounded-full transition-colors ${
                  isActive
                    ? (CYCLE_STATE_COLORS[s] || "bg-primary")
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
                {CYCLE_STATE_LABELS[s] || s}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NextWindowCountdown({ nextWindowStart }: { nextWindowStart: string | null }) {
  const [countdown, setCountdown] = useState("");

  useEffect(() => {
    if (!nextWindowStart) {
      setCountdown("—");
      return;
    }
    const update = () => {
      const diff = new Date(nextWindowStart).getTime() - Date.now();
      if (diff <= 0) {
        setCountdown("ahora");
        return;
      }
      const min = Math.floor(diff / 60000);
      const sec = Math.floor((diff % 60000) / 1000);
      setCountdown(`${min}:${sec.toString().padStart(2, "0")}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [nextWindowStart]);

  return (
    <span className="text-sm font-mono font-medium" data-testid="text-next-window">
      {countdown}
    </span>
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
      const de5m = status?.dualEntry5m;
      const isCurrentlyRunning = de5m?.isRunning || status?.config.isActive;
      return apiRequest("PATCH", "/api/bot/config", { isActive: !isCurrentlyRunning });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m/status"] });
      const de5m = status?.dualEntry5m;
      const wasRunning = de5m?.isRunning || status?.config.isActive;
      toast({ title: wasRunning ? "Motor detenido" : "Motor iniciado" });
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
  const de5m = status?.dualEntry5m;
  const isEngineRunning = de5m?.isRunning ?? false;
  const currentCycle = de5m?.currentCycle;
  const cycleState = currentCycle?.state ?? "IDLE";

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-sm text-muted-foreground">
              Dual-Entry 5m Strategy
            </p>
            {de5m?.isDryRun ? (
              <Badge variant="outline" className="text-xs gap-1" data-testid="badge-mode">
                <FlaskConical className="w-3 h-3 text-yellow-500" />
                Paper
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs gap-1 border-emerald-500/30" data-testid="badge-mode">
                <Zap className="w-3 h-3 text-emerald-500" />
                Live
              </Badge>
            )}
            {de5m?.autoRotate && (
              <Badge variant="outline" className="text-xs gap-1" data-testid="badge-auto-rotate">
                <RotateCw className="w-3 h-3" />
                Auto {de5m.asset?.toUpperCase()} {de5m.interval}
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
            variant={isEngineRunning ? "destructive" : "default"}
            onClick={() => toggleMutation.mutate()}
            disabled={toggleMutation.isPending || config?.killSwitchActive}
            data-testid="button-toggle-bot"
          >
            {isEngineRunning ? (
              <>
                <Square className="w-4 h-4 mr-1.5" /> Detener
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-1.5" /> Iniciar
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
              <p className="text-sm font-medium text-destructive">Kill Switch Activo</p>
              <p className="text-xs text-muted-foreground">
                Todo el trading está detenido. Desactiva en Configuración para reanudar.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          title="Wallet Balance"
          value={walletBalance?.initialized ? `$${parseFloat(walletBalance.usdc || "0").toFixed(2)}` : "—"}
          icon={Wallet}
          subtitle={walletBalance?.initialized ? `${walletBalance.walletAddress?.slice(0, 6)}...${walletBalance.walletAddress?.slice(-4)}` : "Wallet no conectada"}
          testId="card-wallet-balance"
        />
        <StatCard
          title="PnL Diario"
          value={`$${dailyPnl.toFixed(2)}`}
          icon={dailyPnl >= 0 ? TrendingUp : TrendingDown}
          trend={dailyPnl > 0 ? "up" : dailyPnl < 0 ? "down" : "neutral"}
          testId="card-daily-pnl"
        />
        <StatCard
          title="Ciclos Activos"
          value={String(de5m?.activeCycles ?? 0)}
          icon={Activity}
          subtitle={currentCycle ? `Ciclo #${currentCycle.cycleNumber}` : "Sin ciclo"}
          testId="card-active-cycles"
        />
        <StatCard
          title="Órdenes Activas"
          value={String(status?.activeOrders ?? 0)}
          icon={ShoppingCart}
          testId="card-active-orders"
        />
        <StatCard
          title="Posiciones"
          value={String(status?.openPositions ?? 0)}
          icon={ArrowUpDown}
          testId="card-open-positions"
        />
        <StatCard
          title="Pérdidas Consecutivas"
          value={String(status?.consecutiveLosses ?? 0)}
          icon={BarChart3}
          subtitle={`Máx: ${config?.maxConsecutiveLosses ?? 3}`}
          trend={
            (status?.consecutiveLosses ?? 0) >= (config?.maxConsecutiveLosses ?? 3)
              ? "down"
              : "neutral"
          }
          testId="card-consecutive-losses"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="card-cycle-state">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium">Estado del Ciclo</CardTitle>
            <div className="flex items-center gap-1.5">
              <Activity
                className={`w-3.5 h-3.5 ${
                  isEngineRunning ? "text-emerald-500" : "text-muted-foreground"
                }`}
              />
              <Badge variant={isEngineRunning ? "default" : "secondary"} data-testid="badge-engine-state">
                {isEngineRunning ? (currentCycle ? CYCLE_STATE_LABELS[cycleState] || cycleState : "Esperando") : "Detenido"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <CycleStateTimeline state={isEngineRunning ? cycleState : "IDLE"} />
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Próxima Ventana</span>
                <div className="flex items-center gap-1.5">
                  <Timer className="w-3.5 h-3.5 text-muted-foreground" />
                  <NextWindowCountdown nextWindowStart={de5m?.nextWindowStart ?? null} />
                </div>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Order Size</span>
                <span className="text-sm font-mono font-medium">
                  ${(de5m?.orderSize ?? 5).toFixed(2)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Entry / TP</span>
                <span className="text-sm font-mono font-medium">
                  ¢{((de5m?.entryPrice ?? 0.50) * 100).toFixed(0)} → ¢{((de5m?.tpPrice ?? 0.55) * 100).toFixed(0)}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Scratch</span>
                <span className="text-sm font-mono font-medium">
                  ¢{((de5m?.scratchPrice ?? 0.49) * 100).toFixed(0)}
                </span>
              </div>
            </div>

            {currentCycle && (
              <div className="mt-4 pt-3 border-t">
                <div className="text-xs font-medium text-muted-foreground mb-2">Ciclo Actual #{currentCycle.cycleNumber}</div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${currentCycle.yesFilled ? "bg-emerald-500" : "bg-muted"}`} />
                    <span className="text-xs">YES {currentCycle.yesFilled ? `✓ ${currentCycle.yesFilledSize.toFixed(1)}` : "pending"}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${currentCycle.noFilled ? "bg-emerald-500" : "bg-muted"}`} />
                    <span className="text-xs">NO {currentCycle.noFilled ? `✓ ${currentCycle.noFilledSize.toFixed(1)}` : "pending"}</span>
                  </div>
                  {currentCycle.winnerSide && (
                    <div className="col-span-2 flex items-center gap-1.5">
                      <Target className="w-3 h-3 text-emerald-500" />
                      <span className="text-xs">Winner: {currentCycle.winnerSide}</span>
                      {currentCycle.tpFilled && <Badge variant="outline" className="text-[10px] ml-1">TP ✓</Badge>}
                      {currentCycle.scratchFilled && <Badge variant="outline" className="text-[10px] ml-1">Scratch ✓</Badge>}
                    </div>
                  )}
                  {currentCycle.pnl !== null && (
                    <div className="col-span-2 flex items-center gap-1.5">
                      <BarChart3 className={`w-3 h-3 ${(currentCycle.pnl ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"}`} />
                      <span className={`text-xs font-mono ${(currentCycle.pnl ?? 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        PnL: ${currentCycle.pnl?.toFixed(4)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <MarketDataPanel
          data={status?.marketData ?? null}
          isLive={status?.isLiveData}
          marketSlug={de5m?.marketSlug || status?.config?.currentMarketSlug}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="card-strategy-params">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Parámetros de Estrategia</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Modo</span>
                <span className="text-sm font-medium">
                  {de5m?.isDryRun ? "Paper Trading" : "Live Trading"}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Dual TP</span>
                <span className="text-sm font-medium">
                  {de5m?.dualTpMode ? "Activo" : "Inactivo"}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Auto-Rotate</span>
                <span className="text-sm font-medium">
                  {de5m?.autoRotate ? `${de5m.asset?.toUpperCase()} ${de5m.interval}` : "Manual"}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Mercado</span>
                <span className="text-xs font-mono truncate max-w-[180px]" title={de5m?.marketSlug ?? ""}>
                  {de5m?.marketSlug ? de5m.marketSlug.slice(0, 40) + (de5m.marketSlug.length > 40 ? "..." : "") : "—"}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Max Daily Loss</span>
                <span className="text-sm font-mono">
                  ${config?.maxDailyLoss?.toFixed(0) ?? "50"}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Max Exposure</span>
                <span className="text-sm font-mono">
                  ${config?.maxNetExposure?.toFixed(0) ?? "100"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-ws-health">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Cable className="w-4 h-4" />
              WebSocket
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">Market Feed</span>
                  <span className="text-xs text-muted-foreground">
                    {wsHealth?.marketSubscribedAssets?.length
                      ? `${wsHealth.marketSubscribedAssets.length} asset(s)`
                      : "Sin suscripciones"}
                  </span>
                  {wsHealth?.marketLastMessage ? (
                    <span className="text-[10px] text-muted-foreground font-mono">
                      Último: {formatWsTime(wsHealth.marketLastMessage)}
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
                      <><Wifi className="w-3 h-3 mr-1" /> OK</>
                    ) : (
                      <><WifiOff className="w-3 h-3 mr-1" /> Off</>
                    )}
                  </Badge>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">User Feed</span>
                  <span className="text-xs text-muted-foreground">
                    {wsHealth?.userSubscribedAssets?.length
                      ? `${wsHealth.userSubscribedAssets.length} asset(s)`
                      : de5m?.isDryRun ? "Paper mode" : "Sin suscripciones"}
                  </span>
                  {wsHealth?.userLastMessage ? (
                    <span className="text-[10px] text-muted-foreground font-mono">
                      Último: {formatWsTime(wsHealth.userLastMessage)}
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
                      <><Wifi className="w-3 h-3 mr-1" /> OK</>
                    ) : (
                      <><WifiOff className="w-3 h-3 mr-1" /> Off</>
                    )}
                  </Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function formatWsTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "ahora";
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}
