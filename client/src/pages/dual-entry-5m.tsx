import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Play,
  Square,
  Save,
  FlaskConical,
  Zap,
  Timer,
  Target,
  ArrowUpDown,
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
  logs: Array<{ ts: number; event: string; detail?: string }>;
  createdAt: string;
}

interface EngineStatus {
  isRunning: boolean;
  currentCycle: CycleData | null;
  config: any;
  nextWindowStart: string | null;
}

function MarketSelectorDE({ config }: { config: DualEntryConfig | undefined }) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");

  const { data: btcMarkets, isLoading: btcLoading } = useQuery<PolyMarket[]>({
    queryKey: ["/api/markets/btc"],
  });

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
    mutationFn: async (data: { marketTokenYes: string; marketTokenNo: string; marketSlug: string; marketQuestion: string; negRisk: boolean; tickSize: string }) => {
      return apiRequest("POST", "/api/strategies/dual-entry-5m/config", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m/config"] });
      toast({ title: "Mercado seleccionado" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
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
          <CardTitle className="text-sm font-medium">Mercado</CardTitle>
          {config?.marketTokenYes && (
            <Badge variant="default" className="ml-auto" data-testid="badge-de-market-connected">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Conectado
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
            <Input
              placeholder="Buscar mercados..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && searchQuery.trim()) { setMode("search"); doSearch(); } }}
              className="pl-9"
              data-testid="input-de-market-search"
            />
          </div>
          <Button onClick={() => { setMode("search"); doSearch(); }} variant="secondary" size="sm" data-testid="button-de-search">Buscar</Button>
          <Button onClick={() => { setMode("btc"); setSearchQuery(""); }} variant="outline" size="sm" data-testid="button-de-btc">BTC</Button>
        </div>
        <div className="space-y-2 max-h-[300px] overflow-y-auto">
          {loading && <div className="flex justify-center p-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}
          {!loading && markets.filter(m => m.tokenIds?.length >= 2 && m.acceptingOrders).map((market) => {
            const isSelected = market.tokenIds[0] === config?.marketTokenYes;
            return (
              <div key={market.id} className={`border rounded-md p-3 space-y-2 ${isSelected ? "border-primary" : ""}`} data-testid={`card-de-market-${market.id}`}>
                <p className="text-sm font-medium leading-snug">{market.question}</p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>24h: ${(market.volume24hr || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                  <span>Liq: ${(market.liquidity || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                </div>
                <Button
                  size="sm"
                  variant={isSelected ? "default" : "outline"}
                  onClick={() => handleSelect(market)}
                  disabled={selectMutation.isPending}
                  data-testid={`button-de-select-${market.id}`}
                >
                  {isSelected ? <CheckCircle2 className="w-3 h-3 mr-1" /> : null}
                  {isSelected ? "Seleccionado" : "Seleccionar"}
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
    IDLE: "bg-gray-500",
    ARMED: "bg-blue-500",
    ENTRY_WORKING: "bg-amber-500",
    PARTIAL_FILL: "bg-orange-500",
    HEDGED: "bg-emerald-500",
    EXIT_WORKING: "bg-teal-500",
    DONE: "bg-slate-500",
    CLEANUP: "bg-red-500",
    FAILSAFE: "bg-red-600",
  };

  return (
    <div className="border rounded-md p-3 space-y-2" data-testid={`card-cycle-${cycle.cycleNumber}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${stateColors[cycle.state] || "bg-gray-500"}`} />
          <span className="text-sm font-medium">Ciclo #{cycle.cycleNumber}</span>
          <Badge variant="secondary" className="text-xs">{cycle.state}</Badge>
          {cycle.isDryRun && <Badge variant="outline" className="text-xs">DRY-RUN</Badge>}
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
          <span>YES: {cycle.yesFilledSize > 0 ? cycle.yesFilledSize : "—"}</span>
        </div>
        <div className="flex items-center gap-1">
          {cycle.noFilled ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <XCircle className="w-3 h-3 text-muted-foreground" />}
          <span>NO: {cycle.noFilledSize > 0 ? cycle.noFilledSize : "—"}</span>
        </div>
        <div className="flex items-center gap-1">
          {cycle.tpFilled ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <CircleDot className="w-3 h-3 text-muted-foreground" />}
          <span>TP: {cycle.tpFilled ? "filled" : "—"}</span>
        </div>
        <div className="flex items-center gap-1">
          {cycle.scratchFilled ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <CircleDot className="w-3 h-3 text-muted-foreground" />}
          <span>Scratch: {cycle.scratchFilled ? "filled" : "—"}</span>
        </div>
      </div>

      {cycle.logs && cycle.logs.length > 0 && (
        <div className="space-y-0.5 max-h-[150px] overflow-y-auto mt-1">
          {cycle.logs.slice(-10).map((log, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-muted-foreground font-mono flex-shrink-0 w-[70px]">
                {new Date(log.ts).toLocaleTimeString()}
              </span>
              <Badge variant="outline" className="text-[10px] flex-shrink-0">{log.event}</Badge>
              <span className="text-muted-foreground truncate">{log.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DualEntry5m() {
  const { toast } = useToast();

  const { data: config, isLoading: configLoading } = useQuery<DualEntryConfig>({
    queryKey: ["/api/strategies/dual-entry-5m/config"],
  });

  const { data: status } = useQuery<EngineStatus>({
    queryKey: ["/api/strategies/dual-entry-5m/status"],
    refetchInterval: 2000,
  });

  const { data: cycles } = useQuery<CycleData[]>({
    queryKey: ["/api/strategies/dual-entry-5m/cycles"],
    refetchInterval: 5000,
  });

  const { data: walletBalance } = useQuery<{ initialized: boolean; walletAddress: string | null; usdc: string | null }>({
    queryKey: ["/api/trading/wallet-balance"],
    refetchInterval: 15000,
  });

  const [form, setForm] = useState({
    entryPrice: 0.45,
    tpPrice: 0.65,
    scratchPrice: 0.45,
    entryLeadSecondsPrimary: 180,
    entryLeadSecondsRefresh: 30,
    postStartCleanupSeconds: 10,
    exitTtlSeconds: 120,
    orderSize: 5,
    isDryRun: true,
  });

  useEffect(() => {
    if (config) {
      setForm({
        entryPrice: config.entryPrice,
        tpPrice: config.tpPrice,
        scratchPrice: config.scratchPrice,
        entryLeadSecondsPrimary: config.entryLeadSecondsPrimary,
        entryLeadSecondsRefresh: config.entryLeadSecondsRefresh,
        postStartCleanupSeconds: config.postStartCleanupSeconds,
        exitTtlSeconds: config.exitTtlSeconds,
        orderSize: config.orderSize,
        isDryRun: config.isDryRun,
      });
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => apiRequest("POST", "/api/strategies/dual-entry-5m/config", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m/config"] });
      toast({ title: "Configuración guardada" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/strategies/dual-entry-5m/start");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m"] });
      if (!data.success) toast({ title: "Error", description: data.error, variant: "destructive" });
      else toast({ title: "Estrategia iniciada" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const stopMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/strategies/dual-entry-5m/stop"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies/dual-entry-5m"] });
      toast({ title: "Estrategia detenida" });
    },
  });

  if (configLoading) return <div className="p-6"><Skeleton className="h-96 w-full" /></div>;

  const isRunning = status?.isRunning || false;

  return (
    <div className="p-6 space-y-6 max-w-[1000px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">5m Dual-Entry (45c/45c)</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Estrategia de doble entrada en mercados de ventana de 5 minutos
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button variant="destructive" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending} data-testid="button-de-stop">
              <Square className="w-4 h-4 mr-1.5" />
              Detener
            </Button>
          ) : (
            <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending || !config?.marketTokenYes} data-testid="button-de-start">
              <Play className="w-4 h-4 mr-1.5" />
              Iniciar
            </Button>
          )}
          <Button variant="secondary" onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending} data-testid="button-de-save">
            <Save className="w-4 h-4 mr-1.5" />
            Guardar
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
                {form.isDryRun && <Badge variant="outline">DRY-RUN</Badge>}
                {!form.isDryRun && <Badge variant="destructive">LIVE</Badge>}
              </div>
              {status?.currentCycle && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>Ciclo #{status.currentCycle.cycleNumber}</span>
                  <Badge variant="secondary">{status.currentCycle.state}</Badge>
                </div>
              )}
              {status?.nextWindowStart && !status.currentCycle && (
                <div className="text-xs text-muted-foreground">
                  Próxima ventana: {new Date(status.nextWindowStart).toLocaleTimeString()}
                </div>
              )}
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
                  {walletBalance?.initialized ? `$${parseFloat(walletBalance.usdc || "0").toFixed(2)}` : "—"}
                </p>
              </div>
            </div>
            <div className="text-right">
              {walletBalance?.initialized ? (
                <div>
                  <Badge variant="outline" className="text-xs">
                    <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-500" />
                    {walletBalance.walletAddress?.slice(0, 6)}...{walletBalance.walletAddress?.slice(-4)}
                  </Badge>
                </div>
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
              <CardTitle className="text-sm font-medium">Precios</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Precio de entrada</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.entryPrice} onChange={(e) => setForm(s => ({ ...s, entryPrice: parseFloat(e.target.value) || 0.45 }))} data-testid="input-de-entry-price" />
              <p className="text-xs text-muted-foreground">{(form.entryPrice * 100).toFixed(0)}¢ por pierna</p>
            </div>
            <div className="space-y-1.5">
              <Label>Take Profit</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.tpPrice} onChange={(e) => setForm(s => ({ ...s, tpPrice: parseFloat(e.target.value) || 0.65 }))} data-testid="input-de-tp-price" />
              <p className="text-xs text-muted-foreground">{(form.tpPrice * 100).toFixed(0)}¢ — Ganancia: {((form.tpPrice - form.entryPrice) * 100).toFixed(0)}¢/contrato</p>
            </div>
            <div className="space-y-1.5">
              <Label>Scratch (salida plana)</Label>
              <Input type="number" step="0.01" min="0.01" max="0.99" value={form.scratchPrice} onChange={(e) => setForm(s => ({ ...s, scratchPrice: parseFloat(e.target.value) || 0.45 }))} data-testid="input-de-scratch-price" />
            </div>
            <div className="space-y-1.5">
              <Label>Tamaño de orden</Label>
              <Input type="number" step="1" min="1" value={form.orderSize} onChange={(e) => setForm(s => ({ ...s, orderSize: parseFloat(e.target.value) || 5 }))} data-testid="input-de-order-size" />
              <p className="text-xs text-muted-foreground">Costo total por ciclo: ${(form.orderSize * form.entryPrice * 2).toFixed(2)}</p>
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
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Entry lead primario (seg)</Label>
              <Input type="number" step="10" min="10" max="600" value={form.entryLeadSecondsPrimary} onChange={(e) => setForm(s => ({ ...s, entryLeadSecondsPrimary: parseInt(e.target.value) || 180 }))} data-testid="input-de-lead-primary" />
              <p className="text-xs text-muted-foreground">T-{form.entryLeadSecondsPrimary}s: colocar órdenes de entrada</p>
            </div>
            <div className="space-y-1.5">
              <Label>Refresh lead (seg)</Label>
              <Input type="number" step="5" min="5" max="300" value={form.entryLeadSecondsRefresh} onChange={(e) => setForm(s => ({ ...s, entryLeadSecondsRefresh: parseInt(e.target.value) || 30 }))} data-testid="input-de-lead-refresh" />
              <p className="text-xs text-muted-foreground">T-{form.entryLeadSecondsRefresh}s: re-postear órdenes no llenas</p>
            </div>
            <div className="space-y-1.5">
              <Label>Post-start cleanup (seg)</Label>
              <Input type="number" step="1" min="1" max="120" value={form.postStartCleanupSeconds} onChange={(e) => setForm(s => ({ ...s, postStartCleanupSeconds: parseInt(e.target.value) || 10 }))} data-testid="input-de-cleanup" />
              <p className="text-xs text-muted-foreground">T+{form.postStartCleanupSeconds}s: limpiar si no hay fills</p>
            </div>
            <div className="space-y-1.5">
              <Label>Exit TTL (seg)</Label>
              <Input type="number" step="10" min="30" max="600" value={form.exitTtlSeconds} onChange={(e) => setForm(s => ({ ...s, exitTtlSeconds: parseInt(e.target.value) || 120 }))} data-testid="input-de-exit-ttl" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Modo de ejecución</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {form.isDryRun ? (
                <FlaskConical className="w-5 h-5 text-muted-foreground" />
              ) : (
                <Zap className="w-5 h-5 text-amber-500" />
              )}
              <div>
                <Label>{form.isDryRun ? "Dry-Run (simulado)" : "LIVE (órdenes reales)"}</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {form.isDryRun
                    ? "Simula el scheduler y estados sin colocar órdenes reales"
                    : "Coloca órdenes reales en Polymarket con dinero real"
                  }
                </p>
              </div>
            </div>
            <Switch
              checked={form.isDryRun}
              onCheckedChange={(v) => {
                if (!v) {
                  if (!window.confirm("⚠️ ADVERTENCIA: Vas a activar órdenes LIVE.\n\nSe colocarán órdenes reales en Polymarket.\n\n¿Continuar?")) return;
                }
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
                <p className="text-xs text-muted-foreground">Se colocarán órdenes reales. Verifica balance y configuración.</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
              {cycles.map((cycle) => (
                <CycleTimeline key={cycle.id} cycle={cycle} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6">
              No hay ciclos registrados aún. Inicia la estrategia para comenzar.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
