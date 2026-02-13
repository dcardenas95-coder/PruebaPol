import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Play,
  Square,
  Save,
  FlaskConical,
  Zap,
  Timer,
  Target,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Search,
  Radio,
  ExternalLink,
  CircleDot,
  Wallet,
  Activity,
  BarChart3,
  TrendingUp,
  Shield,
  Gauge,
  Layers,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import type { DualEntryConfig } from "@shared/schema";

interface PolyMarket {
  id: string;
  question: string;
  slug: string;
  tokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
  active: boolean;
  closed: boolean;
  volume24hr: number;
  liquidity: number;
  negRisk: boolean;
  tickSize: number;
  acceptingOrders: boolean;
}

interface CycleData {
  id: string;
  cycleNumber: number;
  state: string;
  windowStart: string;
  yesFilled: boolean;
  noFilled: boolean;
  yesFilledSize: number;
  noFilledSize: number;
  winnerSide: string | null;
  tpFilled: boolean;
  scratchFilled: boolean;
  outcome: string | null;
  pnl: number | null;
  isDryRun: boolean;
  entryMethod: string | null;
  actualEntryPrice: number | null;
  actualTpPrice: number | null;
  actualOrderSize: number | null;
  btcVolatility: number | null;
  hourOfDay: number | null;
  logs: Array<{ ts: number; event: string; detail?: string }>;
  createdAt: string;
}

interface VolatilitySnapshot {
  current: number;
  windowMinutes: number;
  withinRange: boolean;
  min: number;
  max: number;
  priceCount: number;
}

interface EngineStatus {
  isRunning: boolean;
  currentCycle: CycleData | null;
  config: any;
  nextWindowStart: string | null;
  volatility: VolatilitySnapshot | null;
  activeCycles: number;
}

interface AnalyticsData {
  summary: {
    totalCycles: number;
    totalWins: number;
    winRate: string;
    totalPnl: string;
    totalFlat: number;
    totalPartial: number;
  };
  hourlyStats: Record<string, { total: number; wins: number; pnl: number; avgVol: number }>;
  dayStats: Record<string, { total: number; wins: number; pnl: number }>;
  entryMethodStats: Record<string, { total: number; wins: number; pnl: number }>;
}

function MarketSelectorDE({ config }: { config: DualEntryConfig | undefined }) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const { data: btcMarkets, isLoading: btcLoading } = useQuery<PolyMarket[]>({ queryKey: ["/api/markets/btc"] });
  const { data: searchResults, isLoading: searchLoading, refetch: doSearch } = useQuery<PolyMarket[]>({
    queryKey: ["/api/markets/search", searchQuery],
    queryFn: async () => {
      const res = await fetch(`/api/markets/search?q=${encodeURIComponent(searchQuery)}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: false,
  });
  const [mode, setMode] = useState<"btc" | "search">("btc");

  const selectMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => apiRequest("POST", "/api/strategies/dual-entry-5m/config", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m/config"] });
      toast({ title: "Mercado seleccionado" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleSelect = (market: PolyMarket) => {
    if (market.tokenIds.length < 2) return;
    selectMutation.mutate({
      marketTokenYes: market.tokenIds[0],
      marketTokenNo: market.tokenIds[1],
      marketSlug: market.slug,
      marketQuestion: market.question,
      negRisk: market.negRisk ?? false,
      tickSize: String(market.tickSize || 0.01),
    });
  };

  const markets = mode === "search" && searchResults ? searchResults : btcMarkets || [];
  const loading = mode === "search" ? searchLoading : btcLoading;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Mercado principal</CardTitle>
          {config?.marketTokenYes && (
            <Badge variant="default" className="ml-auto" data-testid="badge-de-market-connected">
              <CheckCircle2 className="w-3 h-3 mr-1" /> Conectado
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {config?.marketQuestion && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" data-testid="text-de-current-market">{config.marketQuestion}</p>
              <p className="text-xs text-muted-foreground">YES: {config.marketTokenYes?.slice(0, 12)}... | NO: {config.marketTokenNo?.slice(0, 12)}...</p>
            </div>
            {config.marketSlug && (
              <a href={`https://polymarket.com/event/${config.marketSlug}`} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
                <ExternalLink className="w-4 h-4 text-muted-foreground" />
              </a>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Buscar mercados..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && searchQuery.trim()) { setMode("search"); doSearch(); } }} className="pl-9" data-testid="input-de-market-search" />
          </div>
          <Button onClick={() => { setMode("search"); doSearch(); }} variant="secondary" size="sm" data-testid="button-de-search">Buscar</Button>
          <Button onClick={() => { setMode("btc"); setSearchQuery(""); }} variant="outline" size="sm" data-testid="button-de-btc">BTC</Button>
        </div>
        <div className="space-y-2 max-h-[250px] overflow-y-auto">
          {loading && <div className="flex justify-center p-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}
          {!loading && markets.filter(m => m.tokenIds?.length >= 2 && m.acceptingOrders).map((market) => {
            const isSelected = market.tokenIds[0] === config?.marketTokenYes;
            return (
              <div key={market.id} className={`border rounded-md p-3 space-y-1.5 ${isSelected ? "border-primary" : ""}`} data-testid={`card-de-market-${market.id}`}>
                <p className="text-sm font-medium leading-snug">{market.question}</p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>24h: ${(market.volume24hr || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  <span>Liq: ${(market.liquidity || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                <Button size="sm" variant={isSelected ? "default" : "outline"} onClick={() => handleSelect(market)} disabled={selectMutation.isPending} data-testid={`button-de-select-${market.id}`}>
                  {isSelected ? <><CheckCircle2 className="w-3 h-3 mr-1" />Seleccionado</> : "Seleccionar"}
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function CycleTimeline({ cycle }: { cycle: CycleData }) {
  const stateColors: Record<string, string> = {
    IDLE: "bg-gray-500", ARMED: "bg-blue-500", ENTRY_WORKING: "bg-amber-500", PARTIAL_FILL: "bg-orange-500",
    HEDGED: "bg-emerald-500", EXIT_WORKING: "bg-teal-500", DONE: "bg-slate-500", CLEANUP: "bg-red-500", FAILSAFE: "bg-red-600",
  };

  return (
    <div className="border rounded-md p-3 space-y-2" data-testid={`card-cycle-${cycle.cycleNumber}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${stateColors[cycle.state] || "bg-gray-500"}`} />
          <span className="text-sm font-medium">Ciclo #{cycle.cycleNumber}</span>
          <Badge variant="secondary" className="text-xs">{cycle.state}</Badge>
          {cycle.isDryRun && <Badge variant="outline" className="text-xs">DRY-RUN</Badge>}
          {cycle.entryMethod && cycle.entryMethod !== "fixed" && <Badge variant="outline" className="text-xs">{cycle.entryMethod}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {cycle.outcome && <Badge variant={cycle.outcome === "TP_HIT" || cycle.outcome === "FULL_EXIT" ? "default" : "secondary"} className="text-xs">{cycle.outcome}</Badge>}
          {cycle.pnl !== null && (
            <span className={`text-xs font-mono font-bold ${cycle.pnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {cycle.pnl >= 0 ? "+" : ""}{cycle.pnl.toFixed(4)}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div className="flex items-center gap-1">
          {cycle.yesFilled ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <XCircle className="w-3 h-3 text-muted-foreground" />}
          <span>YES: {cycle.yesFilledSize > 0 ? cycle.yesFilledSize : "\u2014"}</span>
        </div>
        <div className="flex items-center gap-1">
          {cycle.noFilled ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <XCircle className="w-3 h-3 text-muted-foreground" />}
          <span>NO: {cycle.noFilledSize > 0 ? cycle.noFilledSize : "\u2014"}</span>
        </div>
        <div className="flex items-center gap-1">
          {cycle.tpFilled ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <CircleDot className="w-3 h-3 text-muted-foreground" />}
          <span>TP: {cycle.tpFilled ? "filled" : "\u2014"}</span>
        </div>
        <div className="flex items-center gap-1">
          {cycle.scratchFilled ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <CircleDot className="w-3 h-3 text-muted-foreground" />}
          <span>Scratch: {cycle.scratchFilled ? "filled" : "\u2014"}</span>
        </div>
      </div>

      {(cycle.actualEntryPrice || cycle.actualTpPrice || cycle.actualOrderSize) && (
        <div className="flex gap-3 text-xs text-muted-foreground">
          {cycle.actualEntryPrice && <span>Entry: {cycle.actualEntryPrice.toFixed(2)}</span>}
          {cycle.actualTpPrice && <span>TP: {cycle.actualTpPrice.toFixed(2)}</span>}
          {cycle.actualOrderSize && <span>Size: {cycle.actualOrderSize}</span>}
          {cycle.btcVolatility != null && <span>Vol: {cycle.btcVolatility.toFixed(3)}</span>}
        </div>
      )}

      {cycle.logs && cycle.logs.length > 0 && (
        <div className="space-y-0.5 max-h-[120px] overflow-y-auto mt-1">
          {cycle.logs.slice(-8).map((log, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-muted-foreground font-mono flex-shrink-0 w-[70px]">{new Date(log.ts).toLocaleTimeString()}</span>
              <Badge variant="outline" className="text-[10px] flex-shrink-0">{log.event}</Badge>
              <span className="text-muted-foreground truncate">{log.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HourlyHeatmap({ analytics }: { analytics: AnalyticsData }) {
  const dayNames = ["Dom", "Lun", "Mar", "Mi\u00e9", "Jue", "Vie", "S\u00e1b"];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Win-rate por hora (UTC)</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <p className="text-xs text-muted-foreground mb-2">Por hora</p>
            <div className="grid grid-cols-6 gap-1">
              {Array.from({ length: 24 }).map((_, h) => {
                const s = analytics.hourlyStats[h.toString()];
                const wr = s && s.total > 0 ? s.wins / s.total : 0;
                const bg = s && s.total > 0
                  ? wr >= 0.6 ? "bg-emerald-500/80" : wr >= 0.4 ? "bg-amber-500/60" : "bg-red-500/50"
                  : "bg-muted/30";
                return (
                  <div key={h} className={`${bg} rounded p-1 text-center`} title={`${h}:00 UTC | ${s?.total || 0} ciclos | WR: ${(wr * 100).toFixed(0)}% | PnL: $${(s?.pnl || 0).toFixed(2)}`}>
                    <span className="text-[10px] font-mono">{h.toString().padStart(2, "0")}</span>
                    {s && s.total > 0 && <span className="text-[9px] block">{(wr * 100).toFixed(0)}%</span>}
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-2">Por d\u00eda</p>
            <div className="space-y-1">
              {dayNames.map((name, d) => {
                const s = analytics.dayStats[d.toString()];
                const wr = s && s.total > 0 ? s.wins / s.total : 0;
                return (
                  <div key={d} className="flex items-center gap-2 text-xs">
                    <span className="w-8 text-muted-foreground">{name}</span>
                    <div className="flex-1 h-4 bg-muted/30 rounded overflow-hidden">
                      <div className={`h-full rounded ${wr >= 0.5 ? "bg-emerald-500/70" : "bg-red-500/50"}`} style={{ width: `${Math.max(wr * 100, 0)}%` }} />
                    </div>
                    <span className="w-12 text-right font-mono">{s?.total || 0}c</span>
                    <span className="w-14 text-right font-mono">{s && s.total > 0 ? `${(wr * 100).toFixed(0)}%` : "\u2014"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-3 border-t">
          <div className="text-center">
            <p className="text-lg font-bold font-mono">{analytics.summary.totalCycles}</p>
            <p className="text-xs text-muted-foreground">Ciclos totales</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold font-mono text-emerald-500">{analytics.summary.winRate}%</p>
            <p className="text-xs text-muted-foreground">Win Rate</p>
          </div>
          <div className="text-center">
            <p className={`text-lg font-bold font-mono ${parseFloat(analytics.summary.totalPnl) >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              ${analytics.summary.totalPnl}
            </p>
            <p className="text-xs text-muted-foreground">PnL Total</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold font-mono">{analytics.summary.totalFlat}</p>
            <p className="text-xs text-muted-foreground">Flat / Sin fill</p>
          </div>
        </div>

        {Object.keys(analytics.entryMethodStats).length > 0 && (
          <div className="mt-3 pt-3 border-t">
            <p className="text-xs text-muted-foreground mb-1">Por m\u00e9todo de entrada</p>
            <div className="flex gap-3">
              {Object.entries(analytics.entryMethodStats).map(([method, s]) => (
                <Badge key={method} variant="outline" className="text-xs">
                  {method}: {s.total}c / {s.total > 0 ? ((s.wins / s.total) * 100).toFixed(0) : 0}% WR / ${s.pnl.toFixed(2)}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DualEntry5m() {
  const { toast } = useToast();

  const { data: config, isLoading: configLoading } = useQuery<DualEntryConfig>({ queryKey: ["/api/strategies/dual-entry-5m/config"] });
  const { data: status } = useQuery<EngineStatus>({ queryKey: ["/api/strategies/dual-entry-5m/status"], refetchInterval: 2000 });
  const { data: cycles } = useQuery<CycleData[]>({ queryKey: ["/api/strategies/dual-entry-5m/cycles"], refetchInterval: 5000 });
  const { data: analytics } = useQuery<AnalyticsData>({ queryKey: ["/api/strategies/dual-entry-5m/analytics"], refetchInterval: 15000 });
  const { data: walletBalance } = useQuery<{ initialized: boolean; walletAddress: string | null; usdc: string | null }>({ queryKey: ["/api/trading/wallet-balance"], refetchInterval: 15000 });

  const [form, setForm] = useState({
    entryPrice: 0.45, tpPrice: 0.65, scratchPrice: 0.45,
    entryLeadSecondsPrimary: 180, entryLeadSecondsRefresh: 30,
    postStartCleanupSeconds: 10, exitTtlSeconds: 120, orderSize: 5, isDryRun: true,
    smartScratchCancel: true,
    volFilterEnabled: false, volMinThreshold: 0.3, volMaxThreshold: 5.0, volWindowMinutes: 15,
    dynamicEntryEnabled: false, dynamicEntryMin: 0.40, dynamicEntryMax: 0.48,
    momentumTpEnabled: false, momentumTpMin: 0.55, momentumTpMax: 0.75, momentumWindowMinutes: 5,
    dynamicSizeEnabled: false, dynamicSizeMin: 3, dynamicSizeMax: 20,
    hourFilterEnabled: false, hourFilterAllowed: [] as number[],
  });

  useEffect(() => {
    if (config) {
      setForm({
        entryPrice: config.entryPrice, tpPrice: config.tpPrice, scratchPrice: config.scratchPrice,
        entryLeadSecondsPrimary: config.entryLeadSecondsPrimary, entryLeadSecondsRefresh: config.entryLeadSecondsRefresh,
        postStartCleanupSeconds: config.postStartCleanupSeconds, exitTtlSeconds: config.exitTtlSeconds,
        orderSize: config.orderSize, isDryRun: config.isDryRun,
        smartScratchCancel: config.smartScratchCancel,
        volFilterEnabled: config.volFilterEnabled, volMinThreshold: config.volMinThreshold,
        volMaxThreshold: config.volMaxThreshold, volWindowMinutes: config.volWindowMinutes,
        dynamicEntryEnabled: config.dynamicEntryEnabled, dynamicEntryMin: config.dynamicEntryMin,
        dynamicEntryMax: config.dynamicEntryMax,
        momentumTpEnabled: config.momentumTpEnabled, momentumTpMin: config.momentumTpMin,
        momentumTpMax: config.momentumTpMax, momentumWindowMinutes: config.momentumWindowMinutes,
        dynamicSizeEnabled: config.dynamicSizeEnabled, dynamicSizeMin: config.dynamicSizeMin,
        dynamicSizeMax: config.dynamicSizeMax,
        hourFilterEnabled: config.hourFilterEnabled,
        hourFilterAllowed: (config.hourFilterAllowed as number[]) || [],
      });
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => apiRequest("POST", "/api/strategies/dual-entry-5m/config", data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m/config"] }); toast({ title: "Configuraci\u00f3n guardada" }); },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const startMutation = useMutation({
    mutationFn: async () => { const res = await apiRequest("POST", "/api/strategies/dual-entry-5m/start"); return res.json(); },
    onSuccess: (data) => { queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m"] }); if (!data.success) toast({ title: "Error", description: data.error, variant: "destructive" }); else toast({ title: "Estrategia iniciada" }); },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const stopMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/strategies/dual-entry-5m/stop"),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m"] }); toast({ title: "Estrategia detenida" }); },
  });

  const toggleHour = (h: number) => {
    setForm(s => {
      const current = s.hourFilterAllowed;
      return { ...s, hourFilterAllowed: current.includes(h) ? current.filter(x => x !== h) : [...current, h].sort((a, b) => a - b) };
    });
  };

  if (configLoading) return <div className="p-6"><Skeleton className="h-96 w-full" /></div>;

  const isRunning = status?.isRunning || false;

  return (
    <div className="p-6 space-y-6 max-w-[1000px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">5m Dual-Entry (45c/45c)</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Estrategia de doble entrada con mejoras inteligentes</p>
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button variant="destructive" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending} data-testid="button-de-stop">
              <Square className="w-4 h-4 mr-1.5" />Detener
            </Button>
          ) : (
            <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending || !config?.marketTokenYes} data-testid="button-de-start">
              <Play className="w-4 h-4 mr-1.5" />Iniciar
            </Button>
          )}
          <Button variant="secondary" onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending} data-testid="button-de-save">
            <Save className="w-4 h-4 mr-1.5" />Guardar
          </Button>
        </div>
      </div>

      {isRunning && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-sm font-medium">Estrategia activa</span>
                {form.isDryRun ? <Badge variant="outline">DRY-RUN</Badge> : <Badge variant="destructive">LIVE</Badge>}
                {status?.activeCycles != null && status.activeCycles > 0 && <Badge variant="secondary">{status.activeCycles} ciclo(s)</Badge>}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                {status?.currentCycle && (
                  <>
                    <span>Ciclo #{status.currentCycle.cycleNumber}</span>
                    <Badge variant="secondary">{status.currentCycle.state}</Badge>
                  </>
                )}
                {status?.volatility && (
                  <span className={status.volatility.withinRange ? "text-emerald-400" : "text-amber-400"}>
                    Vol: {status.volatility.current.toFixed(3)} ({status.volatility.priceCount} ticks)
                  </span>
                )}
                {status?.nextWindowStart && !status.currentCycle && (
                  <span>Pr\u00f3xima: {new Date(status.nextWindowStart).toLocaleTimeString()}</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-de-wallet-balance">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-9 h-9 rounded-md bg-muted">
                <Wallet className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Balance USDC</p>
                <p className="text-lg font-bold font-mono" data-testid="text-de-wallet-usdc">
                  {walletBalance?.initialized ? `$${parseFloat(walletBalance.usdc || "0").toFixed(2)}` : "\u2014"}
                </p>
              </div>
            </div>
            <div className="text-right">
              {walletBalance?.initialized ? (
                <Badge variant="outline" className="text-xs">
                  <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-500" />
                  {walletBalance.walletAddress?.slice(0, 6)}...{walletBalance.walletAddress?.slice(-4)}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">Wallet no conectada</Badge>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {status?.currentCycle && <CycleTimeline cycle={status.currentCycle as any} />}

      <MarketSelectorDE config={config} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Precios base</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Precio de entrada</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.entryPrice} onChange={(e) => setForm(s => ({ ...s, entryPrice: parseFloat(e.target.value) || 0.45 }))} data-testid="input-de-entry-price" />
              <p className="text-xs text-muted-foreground">{(form.entryPrice * 100).toFixed(0)}\u00a2 por pierna (base fija)</p>
            </div>
            <div className="space-y-1">
              <Label>Take Profit</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.tpPrice} onChange={(e) => setForm(s => ({ ...s, tpPrice: parseFloat(e.target.value) || 0.65 }))} data-testid="input-de-tp-price" />
            </div>
            <div className="space-y-1">
              <Label>Scratch (salida plana)</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.scratchPrice} onChange={(e) => setForm(s => ({ ...s, scratchPrice: parseFloat(e.target.value) || 0.45 }))} data-testid="input-de-scratch-price" />
            </div>
            <div className="space-y-1">
              <Label>Tama\u00f1o de orden (base)</Label>
              <Input type="number" step="1" min="1" value={form.orderSize} onChange={(e) => setForm(s => ({ ...s, orderSize: parseFloat(e.target.value) || 5 }))} data-testid="input-de-order-size" />
              <p className="text-xs text-muted-foreground">Costo por ciclo: ${(form.orderSize * form.entryPrice * 2).toFixed(2)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Timer className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Tiempos</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Entry lead primario (seg)</Label>
              <Input type="number" step="10" min="10" max="600" value={form.entryLeadSecondsPrimary} onChange={(e) => setForm(s => ({ ...s, entryLeadSecondsPrimary: parseInt(e.target.value) || 180 }))} data-testid="input-de-lead-primary" />
            </div>
            <div className="space-y-1">
              <Label>Refresh lead (seg)</Label>
              <Input type="number" step="5" min="5" max="300" value={form.entryLeadSecondsRefresh} onChange={(e) => setForm(s => ({ ...s, entryLeadSecondsRefresh: parseInt(e.target.value) || 30 }))} data-testid="input-de-lead-refresh" />
            </div>
            <div className="space-y-1">
              <Label>Post-start cleanup (seg)</Label>
              <Input type="number" step="1" min="1" max="120" value={form.postStartCleanupSeconds} onChange={(e) => setForm(s => ({ ...s, postStartCleanupSeconds: parseInt(e.target.value) || 10 }))} data-testid="input-de-cleanup" />
            </div>
            <div className="space-y-1">
              <Label>Exit TTL (seg)</Label>
              <Input type="number" step="10" min="30" max="600" value={form.exitTtlSeconds} onChange={(e) => setForm(s => ({ ...s, exitTtlSeconds: parseInt(e.target.value) || 120 }))} data-testid="input-de-exit-ttl" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Cancelaci\u00f3n inteligente</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Cancelar scratch al llenar TP</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Cuando el TP se llena, cancela el scratch inmediatamente en vez de esperar</p>
            </div>
            <Switch checked={form.smartScratchCancel} onCheckedChange={(v) => setForm(s => ({ ...s, smartScratchCancel: v }))} data-testid="switch-smart-scratch" />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Filtro de volatilidad</CardTitle>
              <Switch checked={form.volFilterEnabled} onCheckedChange={(v) => setForm(s => ({ ...s, volFilterEnabled: v }))} className="ml-auto" data-testid="switch-vol-filter" />
            </div>
          </CardHeader>
          <CardContent className={`space-y-3 ${!form.volFilterEnabled ? "opacity-50" : ""}`}>
            <div className="space-y-1">
              <Label>M\u00ednima (%)</Label>
              <Input type="number" step="0.1" min="0" value={form.volMinThreshold} onChange={(e) => setForm(s => ({ ...s, volMinThreshold: parseFloat(e.target.value) || 0.3 }))} disabled={!form.volFilterEnabled} data-testid="input-vol-min" />
              <p className="text-xs text-muted-foreground">Saltar ciclos si volatilidad &lt; este umbral</p>
            </div>
            <div className="space-y-1">
              <Label>M\u00e1xima (%)</Label>
              <Input type="number" step="0.1" min="0" value={form.volMaxThreshold} onChange={(e) => setForm(s => ({ ...s, volMaxThreshold: parseFloat(e.target.value) || 5.0 }))} disabled={!form.volFilterEnabled} data-testid="input-vol-max" />
            </div>
            <div className="space-y-1">
              <Label>Ventana (min)</Label>
              <Input type="number" step="1" min="1" max="60" value={form.volWindowMinutes} onChange={(e) => setForm(s => ({ ...s, volWindowMinutes: parseInt(e.target.value) || 15 }))} disabled={!form.volFilterEnabled} data-testid="input-vol-window" />
            </div>
            {status?.volatility && (
              <div className="flex items-center gap-2 p-2 rounded bg-muted/30 text-xs">
                <Gauge className="w-3 h-3" />
                <span>Actual: {status.volatility.current.toFixed(3)}%</span>
                <Badge variant={status.volatility.withinRange ? "default" : "secondary"} className="text-[10px]">
                  {status.volatility.withinRange ? "En rango" : "Fuera de rango"}
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Entrada din\u00e1mica</CardTitle>
              <Switch checked={form.dynamicEntryEnabled} onCheckedChange={(v) => setForm(s => ({ ...s, dynamicEntryEnabled: v }))} className="ml-auto" data-testid="switch-dynamic-entry" />
            </div>
          </CardHeader>
          <CardContent className={`space-y-3 ${!form.dynamicEntryEnabled ? "opacity-50" : ""}`}>
            <div className="space-y-1">
              <Label>Precio m\u00ednimo</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.dynamicEntryMin} onChange={(e) => setForm(s => ({ ...s, dynamicEntryMin: parseFloat(e.target.value) || 0.40 }))} disabled={!form.dynamicEntryEnabled} data-testid="input-dyn-entry-min" />
              <p className="text-xs text-muted-foreground">{(form.dynamicEntryMin * 100).toFixed(0)}\u00a2 \u2014 spread alto = entry bajo</p>
            </div>
            <div className="space-y-1">
              <Label>Precio m\u00e1ximo</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.dynamicEntryMax} onChange={(e) => setForm(s => ({ ...s, dynamicEntryMax: parseFloat(e.target.value) || 0.48 }))} disabled={!form.dynamicEntryEnabled} data-testid="input-dyn-entry-max" />
              <p className="text-xs text-muted-foreground">{(form.dynamicEntryMax * 100).toFixed(0)}\u00a2 \u2014 spread bajo = entry alto</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">TP por momentum</CardTitle>
              <Switch checked={form.momentumTpEnabled} onCheckedChange={(v) => setForm(s => ({ ...s, momentumTpEnabled: v }))} className="ml-auto" data-testid="switch-momentum-tp" />
            </div>
          </CardHeader>
          <CardContent className={`space-y-3 ${!form.momentumTpEnabled ? "opacity-50" : ""}`}>
            <div className="space-y-1">
              <Label>TP m\u00ednimo (flat)</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.momentumTpMin} onChange={(e) => setForm(s => ({ ...s, momentumTpMin: parseFloat(e.target.value) || 0.55 }))} disabled={!form.momentumTpEnabled} data-testid="input-mom-tp-min" />
              <p className="text-xs text-muted-foreground">TP conservador cuando BTC est\u00e1 lateral</p>
            </div>
            <div className="space-y-1">
              <Label>TP m\u00e1ximo (trending)</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.momentumTpMax} onChange={(e) => setForm(s => ({ ...s, momentumTpMax: parseFloat(e.target.value) || 0.75 }))} disabled={!form.momentumTpEnabled} data-testid="input-mom-tp-max" />
              <p className="text-xs text-muted-foreground">TP agresivo con momentum fuerte</p>
            </div>
            <div className="space-y-1">
              <Label>Ventana momentum (min)</Label>
              <Input type="number" step="1" min="1" max="60" value={form.momentumWindowMinutes} onChange={(e) => setForm(s => ({ ...s, momentumWindowMinutes: parseInt(e.target.value) || 5 }))} disabled={!form.momentumTpEnabled} data-testid="input-mom-window" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Tama\u00f1o din\u00e1mico</CardTitle>
              <Switch checked={form.dynamicSizeEnabled} onCheckedChange={(v) => setForm(s => ({ ...s, dynamicSizeEnabled: v }))} className="ml-auto" data-testid="switch-dynamic-size" />
            </div>
          </CardHeader>
          <CardContent className={`space-y-3 ${!form.dynamicSizeEnabled ? "opacity-50" : ""}`}>
            <div className="space-y-1">
              <Label>Tama\u00f1o m\u00ednimo</Label>
              <Input type="number" step="1" min="1" value={form.dynamicSizeMin} onChange={(e) => setForm(s => ({ ...s, dynamicSizeMin: parseFloat(e.target.value) || 3 }))} disabled={!form.dynamicSizeEnabled} data-testid="input-dyn-size-min" />
              <p className="text-xs text-muted-foreground">Volatilidad baja = tama\u00f1o peque\u00f1o</p>
            </div>
            <div className="space-y-1">
              <Label>Tama\u00f1o m\u00e1ximo</Label>
              <Input type="number" step="1" min="1" value={form.dynamicSizeMax} onChange={(e) => setForm(s => ({ ...s, dynamicSizeMax: parseFloat(e.target.value) || 20 }))} disabled={!form.dynamicSizeEnabled} data-testid="input-dyn-size-max" />
              <p className="text-xs text-muted-foreground">Volatilidad alta = tama\u00f1o grande</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Filtro por horario</CardTitle>
            <Switch checked={form.hourFilterEnabled} onCheckedChange={(v) => setForm(s => ({ ...s, hourFilterEnabled: v }))} className="ml-auto" data-testid="switch-hour-filter" />
          </div>
        </CardHeader>
        <CardContent className={!form.hourFilterEnabled ? "opacity-50" : ""}>
          <p className="text-xs text-muted-foreground mb-2">Selecciona horas permitidas (UTC). Solo operar\u00e1 durante estas horas.</p>
          <div className="grid grid-cols-8 gap-1">
            {Array.from({ length: 24 }).map((_, h) => (
              <Button
                key={h}
                size="sm"
                variant={form.hourFilterAllowed.includes(h) ? "default" : "outline"}
                className="text-xs h-8 px-1"
                onClick={() => toggleHour(h)}
                disabled={!form.hourFilterEnabled}
                data-testid={`button-hour-${h}`}
              >
                {h.toString().padStart(2, "0")}
              </Button>
            ))}
          </div>
          {form.hourFilterEnabled && form.hourFilterAllowed.length > 0 && (
            <p className="text-xs text-muted-foreground mt-2">{form.hourFilterAllowed.length} horas seleccionadas: {form.hourFilterAllowed.map(h => `${h}:00`).join(", ")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Modo de ejecuci\u00f3n</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {form.isDryRun ? <FlaskConical className="w-5 h-5 text-muted-foreground" /> : <Zap className="w-5 h-5 text-amber-500" />}
              <div>
                <Label>{form.isDryRun ? "Dry-Run (simulado)" : "LIVE (\u00f3rdenes reales)"}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {form.isDryRun ? "Simula el scheduler y estados sin colocar \u00f3rdenes reales" : "Coloca \u00f3rdenes reales en Polymarket con dinero real"}
                </p>
              </div>
            </div>
            <Switch
              checked={form.isDryRun}
              onCheckedChange={(v) => {
                if (!v) { if (!window.confirm("\u26a0\ufe0f ADVERTENCIA: Vas a activar \u00f3rdenes LIVE.\n\nSe colocar\u00e1n \u00f3rdenes reales en Polymarket.\n\n\u00bfContinuar?")) return; }
                setForm(s => ({ ...s, isDryRun: v }));
              }}
              data-testid="switch-de-dry-run"
            />
          </div>
          {!form.isDryRun && (
            <div className="flex items-start gap-3 p-3 mt-3 rounded-md bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-amber-400">Modo LIVE activo</p>
                <p className="text-xs text-muted-foreground">Se colocar\u00e1n \u00f3rdenes reales. Verifica balance y configuraci\u00f3n.</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {analytics && analytics.summary.totalCycles > 0 && <HourlyHeatmap analytics={analytics} />}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Historial de ciclos</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {cycles && cycles.length > 0 ? (
            <div className="space-y-2">
              {cycles.map((cycle) => <CycleTimeline key={cycle.id} cycle={cycle} />)}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6">No hay ciclos registrados a\u00fan. Inicia la estrategia para comenzar.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
