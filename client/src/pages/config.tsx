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
  Save,
  AlertTriangle,
  Shield,
  Crosshair,
  Gauge,
  Search,
  Radio,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Zap,
  ShieldAlert,
  Wallet,
  FlaskConical,
  CircleCheck,
  CircleX,
} from "lucide-react";
import type { BotConfig } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

interface PolyMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  tokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
  active: boolean;
  closed: boolean;
  endDate: string;
  volume: number;
  volume24hr: number;
  liquidity: number;
  negRisk: boolean;
  tickSize: number;
  minSize: number;
  acceptingOrders: boolean;
  description?: string;
}

interface IntervalMarket extends PolyMarket {
  timeRemainingMs?: number;
  intervalType?: string;
  asset?: string;
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Expired";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MarketSelector({ currentMarketId, currentMarketSlug }: { currentMarketId?: string | null; currentMarketSlug?: string | null }) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"btc" | "search" | "5min" | "15min">("btc");

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

  const { data: markets5m, isLoading: loading5m } = useQuery<IntervalMarket[]>({
    queryKey: ["/api/markets/interval", "5m"],
    queryFn: async () => {
      const res = await fetch("/api/markets/interval?interval=5m");
      if (!res.ok) throw new Error("Failed to fetch 5m markets");
      return res.json();
    },
    enabled: searchMode === "5min",
    refetchInterval: searchMode === "5min" ? 30000 : false,
  });

  const { data: markets15m, isLoading: loading15m } = useQuery<IntervalMarket[]>({
    queryKey: ["/api/markets/interval", "15m"],
    queryFn: async () => {
      const res = await fetch("/api/markets/interval?interval=15m");
      if (!res.ok) throw new Error("Failed to fetch 15m markets");
      return res.json();
    },
    enabled: searchMode === "15min",
    refetchInterval: searchMode === "15min" ? 30000 : false,
  });

  const selectMutation = useMutation({
    mutationFn: async (market: { tokenId: string; marketSlug: string; question: string; negRisk: boolean; tickSize: number }) => {
      return apiRequest("POST", "/api/markets/select", market);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "Market selected - live data connected" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to select market", description: err.message, variant: "destructive" });
    },
  });

  const handleSearch = () => {
    if (searchQuery.trim()) {
      setSearchMode("search");
      doSearch();
    }
  };

  const handleSelectMarket = (market: PolyMarket, tokenIndex: number) => {
    const tokenId = market.tokenIds[tokenIndex];
    if (!tokenId) return;
    selectMutation.mutate({
      tokenId,
      marketSlug: market.slug,
      question: `${market.question} (${market.outcomes[tokenIndex]})`,
      negRisk: market.negRisk ?? false,
      tickSize: market.tickSize || 0.01,
    });
  };

  const markets = searchMode === "5min" ? (markets5m || [])
    : searchMode === "15min" ? (markets15m || [])
    : searchMode === "search" && searchResults ? searchResults
    : btcMarkets || [];
  const loading = searchMode === "5min" ? loading5m
    : searchMode === "15min" ? loading15m
    : searchMode === "search" ? searchLoading
    : btcLoading;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Polymarket Connection</CardTitle>
          {currentMarketId && (
            <Badge variant="default" className="ml-auto" data-testid="badge-connected">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Connected
            </Badge>
          )}
          {!currentMarketId && (
            <Badge variant="secondary" className="ml-auto" data-testid="badge-disconnected">
              Not Connected
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {currentMarketSlug && (
          <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" data-testid="text-current-market">
                {currentMarketSlug}
              </p>
              <p className="text-xs text-muted-foreground">Active market - receiving live data</p>
            </div>
            <a
              href={`https://polymarket.com/event/${currentMarketSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0"
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-foreground" />
            </a>
          </div>
        )}

        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search markets (e.g. Bitcoin, Ethereum, Trump...)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="pl-9"
              data-testid="input-market-search"
            />
          </div>
          <Button onClick={handleSearch} variant="secondary" data-testid="button-search-markets">
            Search
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => { setSearchMode("btc"); setSearchQuery(""); }}
            variant={searchMode === "btc" ? "default" : "outline"}
            size="sm"
            data-testid="button-btc-markets"
          >
            BTC
          </Button>
          <Button
            onClick={() => { setSearchMode("5min"); setSearchQuery(""); }}
            variant={searchMode === "5min" ? "default" : "outline"}
            size="sm"
            data-testid="button-5min-markets"
          >
            <Zap className="w-3 h-3 mr-1" />
            5 min
          </Button>
          <Button
            onClick={() => { setSearchMode("15min"); setSearchQuery(""); }}
            variant={searchMode === "15min" ? "default" : "outline"}
            size="sm"
            data-testid="button-15min-markets"
          >
            <Zap className="w-3 h-3 mr-1" />
            15 min
          </Button>
        </div>

        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center p-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && markets.length === 0 && (
            <div className="text-sm text-muted-foreground text-center p-6">
              No markets found. Try a different search.
            </div>
          )}
          {!loading && markets.map((market) => {
            const im = market as IntervalMarket;
            const isInterval = searchMode === "5min" || searchMode === "15min";
            return (
            <div
              key={market.id || market.conditionId || market.slug}
              className="border rounded-md p-3 space-y-2"
              data-testid={`card-market-${market.id || market.slug}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-snug">{market.question}</p>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    {isInterval && im.asset && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {im.asset}
                      </Badge>
                    )}
                    {isInterval && im.timeRemainingMs != null && im.timeRemainingMs > 0 && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                        {formatTimeRemaining(im.timeRemainingMs)}
                      </Badge>
                    )}
                    {isInterval && im.timeRemainingMs != null && im.timeRemainingMs <= 0 && (
                      <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                        Expired
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      Vol: ${(market.volume || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      24h: ${(market.volume24hr || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Liq: ${(market.liquidity || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                {market.tokenIds?.map((tokenId, idx) => {
                  const isSelected = tokenId === currentMarketId;
                  const outcome = market.outcomes?.[idx] || `Token ${idx + 1}`;
                  const price = market.outcomePrices?.[idx] || "?";
                  return (
                    <Button
                      key={tokenId}
                      size="sm"
                      variant={isSelected ? "default" : "outline"}
                      onClick={() => handleSelectMarket(market, idx)}
                      disabled={selectMutation.isPending}
                      data-testid={`button-select-${market.id}-${idx}`}
                    >
                      {isSelected && <CheckCircle2 className="w-3 h-3 mr-1" />}
                      {outcome} ({parseFloat(price) ? `$${parseFloat(price).toFixed(2)}` : price})
                    </Button>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export default function Configuration() {
  const { toast } = useToast();

  const { data: config, isLoading } = useQuery<BotConfig>({
    queryKey: ["/api/bot/config"],
  });

  const [formState, setFormState] = useState({
    isPaperTrading: true,
    minSpread: 0.03,
    targetProfitMin: 0.03,
    targetProfitMax: 0.05,
    maxNetExposure: 100,
    maxDailyLoss: 50,
    maxConsecutiveLosses: 3,
    orderSize: 10,
  });

  useEffect(() => {
    if (config) {
      setFormState({
        isPaperTrading: config.isPaperTrading,
        minSpread: config.minSpread,
        targetProfitMin: config.targetProfitMin,
        targetProfitMax: config.targetProfitMax,
        maxNetExposure: config.maxNetExposure,
        maxDailyLoss: config.maxDailyLoss,
        maxConsecutiveLosses: config.maxConsecutiveLosses,
        orderSize: config.orderSize,
      });
    }
  }, [config]);

  const updateMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      return apiRequest("PATCH", "/api/bot/config", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "Configuration saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const killSwitchMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/bot/kill-switch");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: config?.killSwitchActive ? "Kill switch deactivated" : "Kill switch activated" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const handleSave = () => {
    updateMutation.mutate(formState);
  };

  return (
    <div className="p-6 space-y-6 max-w-[900px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Configuration</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Strategy parameters, market selection, and risk management
          </p>
        </div>
        <Button onClick={handleSave} disabled={updateMutation.isPending} data-testid="button-save-config">
          <Save className="w-4 h-4 mr-1.5" />
          Save Changes
        </Button>
      </div>

      <MarketSelector
        currentMarketId={config?.currentMarketId}
        currentMarketSlug={config?.currentMarketSlug}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">General Settings</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {formState.isPaperTrading ? (
                <Shield className="w-5 h-5 text-muted-foreground" />
              ) : (
                <Zap className="w-5 h-5 text-amber-500" />
              )}
              <div>
                <Label>
                  {formState.isPaperTrading ? "Paper Trading Mode" : "LIVE Trading Mode"}
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formState.isPaperTrading
                    ? "Simulate trades using real market data without risking capital"
                    : "Real orders are placed on Polymarket with real money"
                  }
                </p>
              </div>
            </div>
            <Switch
              checked={formState.isPaperTrading}
              onCheckedChange={(v) => {
                if (!v) {
                  if (!window.confirm("⚠️ ADVERTENCIA: Estás a punto de activar el trading en vivo.\n\nEsto significa que se colocarán órdenes REALES en Polymarket con dinero real.\n\n¿Estás seguro de que deseas continuar?")) {
                    return;
                  }
                }
                setFormState((s) => ({ ...s, isPaperTrading: v }));
              }}
              data-testid="switch-paper-trading"
            />
          </div>
          {!formState.isPaperTrading && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-amber-500/10 border border-amber-500/30">
              <ShieldAlert className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-amber-400">Live Trading Active</p>
                <p className="text-xs text-muted-foreground">
                  Real orders will be placed on Polymarket. Make sure you have sufficient USDC balance,
                  your risk limits are properly configured, and the kill switch is easily accessible.
                </p>
              </div>
            </div>
          )}
          <Separator />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="orderSize">Order Size ($)</Label>
              <Input
                id="orderSize"
                type="number"
                step="1"
                min="1"
                value={formState.orderSize}
                onChange={(e) => setFormState((s) => ({ ...s, orderSize: parseFloat(e.target.value) || 10 }))}
                data-testid="input-order-size"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Strategy Parameters</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="minSpread">Min Spread (decimal)</Label>
              <Input
                id="minSpread"
                type="number"
                step="0.01"
                min="0.01"
                max="0.5"
                value={formState.minSpread}
                onChange={(e) => setFormState((s) => ({ ...s, minSpread: parseFloat(e.target.value) || 0.03 }))}
                data-testid="input-min-spread"
              />
              <p className="text-xs text-muted-foreground">
                {(formState.minSpread * 100).toFixed(1)}%
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profitMin">Target Profit Min (decimal)</Label>
              <Input
                id="profitMin"
                type="number"
                step="0.01"
                min="0.01"
                max="0.5"
                value={formState.targetProfitMin}
                onChange={(e) => setFormState((s) => ({ ...s, targetProfitMin: parseFloat(e.target.value) || 0.03 }))}
                data-testid="input-target-profit-min"
              />
              <p className="text-xs text-muted-foreground">
                {(formState.targetProfitMin * 100).toFixed(1)}%
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profitMax">Target Profit Max (decimal)</Label>
              <Input
                id="profitMax"
                type="number"
                step="0.01"
                min="0.01"
                max="1.0"
                value={formState.targetProfitMax}
                onChange={(e) => setFormState((s) => ({ ...s, targetProfitMax: parseFloat(e.target.value) || 0.05 }))}
                data-testid="input-target-profit-max"
              />
              <p className="text-xs text-muted-foreground">
                {(formState.targetProfitMax * 100).toFixed(1)}%
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">Risk Management</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="maxExposure">Max Net Exposure ($)</Label>
              <Input
                id="maxExposure"
                type="number"
                step="10"
                min="1"
                max="10000"
                value={formState.maxNetExposure}
                onChange={(e) => setFormState((s) => ({ ...s, maxNetExposure: parseFloat(e.target.value) || 100 }))}
                data-testid="input-max-exposure"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maxDailyLoss">Max Daily Loss ($)</Label>
              <Input
                id="maxDailyLoss"
                type="number"
                step="5"
                min="1"
                max="10000"
                value={formState.maxDailyLoss}
                onChange={(e) => setFormState((s) => ({ ...s, maxDailyLoss: parseFloat(e.target.value) || 50 }))}
                data-testid="input-max-daily-loss"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maxLosses">Max Consecutive Losses</Label>
              <Input
                id="maxLosses"
                type="number"
                step="1"
                min="1"
                max="50"
                value={formState.maxConsecutiveLosses}
                onChange={(e) => setFormState((s) => ({ ...s, maxConsecutiveLosses: parseInt(e.target.value) || 3 }))}
                data-testid="input-max-consecutive-losses"
              />
            </div>
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className={`w-5 h-5 ${config?.killSwitchActive ? "text-destructive" : "text-muted-foreground"}`} />
              <div>
                <Label>Kill Switch</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Emergency halt all trading activity immediately
                </p>
              </div>
            </div>
            <Button
              variant={config?.killSwitchActive ? "default" : "destructive"}
              onClick={() => killSwitchMutation.mutate()}
              disabled={killSwitchMutation.isPending}
              data-testid="button-kill-switch-config"
            >
              {config?.killSwitchActive ? "Deactivate" : "Activate Kill Switch"}
            </Button>
          </div>
          {config?.killSwitchActive && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10">
              <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0" />
              <span className="text-sm text-destructive">
                Kill switch is active. All trading is halted.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <LiveTestCard config={config} />
      <OptimizationPanel />
      <RateLimiterCard />
    </div>
  );
}

function LiveTestCard({ config }: { config?: BotConfig }) {
  const { toast } = useToast();
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; data?: any } | null>(null);

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/trading/test-live");
      return res.json();
    },
    onSuccess: (data) => {
      setTestResult(data);
      toast({
        title: data.success ? "Test passed" : "Test failed",
        description: data.message,
        variant: data.success ? "default" : "destructive",
      });
    },
    onError: (err: Error) => {
      setTestResult({ success: false, message: err.message });
      toast({ title: "Test error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Live Trading Test</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Place a minimum-size test order to verify exchange connectivity, wallet signing,
          and order flow. The order will be placed and immediately cancelled.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending || config?.isPaperTrading}
            data-testid="button-test-live"
          >
            {testMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <FlaskConical className="w-4 h-4 mr-1.5" />
            )}
            Run Test
          </Button>
          {config?.isPaperTrading && (
            <span className="text-xs text-muted-foreground">Switch to live mode to test</span>
          )}
        </div>
        {testResult && (
          <div className={`flex items-start gap-2 p-3 rounded-md ${testResult.success ? "bg-emerald-500/10 border border-emerald-500/30" : "bg-destructive/10 border border-destructive/30"}`}>
            {testResult.success ? (
              <CircleCheck className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
            ) : (
              <CircleX className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            )}
            <div>
              <p className="text-sm font-medium">{testResult.success ? "Test Passed" : "Test Failed"}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{testResult.message}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OptimizationPanel() {
  const { data: analytics, isLoading } = useQuery<{
    metrics: {
      totalTrades: number;
      totalWins: number;
      totalLosses: number;
      winRate: number;
      totalPnl: number;
      avgPnlPerTrade: number;
      totalFees: number;
      buyFillRate: number;
      tpFillRate: number;
      avgBuyPrice: number;
      avgSellPrice: number;
      avgSpreadCapture: number;
      medianBuyPrice: number;
      avgFillSize: number;
      forcedExitRate: number;
      hedgeLockExits: number;
      totalBuyOrders: number;
      totalSellOrders: number;
      filledBuys: number;
      filledSells: number;
    };
    suggestions: Array<{ param: string; current: string; suggested: string; reason: string }>;
    currentParams: {
      minSpread: number;
      targetProfitMin: number;
      targetProfitMax: number;
      orderSize: number;
    };
  }>({
    queryKey: ["/api/analytics/optimization"],
    refetchInterval: 30000,
  });

  const m = analytics?.metrics;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Crosshair className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">Optimización de Parámetros</CardTitle>
          {m && m.totalTrades > 0 && (
            <Badge variant="secondary" className="ml-auto font-mono" data-testid="badge-total-trades">
              {m.totalTrades} trades
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !m || m.totalTrades === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground" data-testid="text-no-data">
            Sin datos de trading todavía. Las métricas aparecerán cuando el bot complete trades.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Win Rate</p>
                <p className={`text-lg font-mono font-bold ${m.winRate >= 50 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-win-rate">
                  {m.winRate.toFixed(1)}%
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">PnL Total</p>
                <p className={`text-lg font-mono font-bold ${m.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-total-pnl">
                  ${m.totalPnl.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">PnL/Trade</p>
                <p className={`text-lg font-mono font-bold ${m.avgPnlPerTrade >= 0 ? "text-emerald-500" : "text-red-500"}`} data-testid="text-avg-pnl">
                  ${m.avgPnlPerTrade.toFixed(4)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Fees</p>
                <p className="text-lg font-mono font-bold" data-testid="text-total-fees">
                  ${m.totalFees.toFixed(2)}
                </p>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">BUY Fill Rate</p>
                <p className="text-lg font-mono font-bold" data-testid="text-buy-fill-rate">
                  {m.buyFillRate.toFixed(1)}%
                </p>
                <p className="text-[10px] text-muted-foreground">{m.filledBuys}/{m.totalBuyOrders} órdenes</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">TP Fill Rate</p>
                <p className={`text-lg font-mono font-bold ${m.tpFillRate >= 50 ? "text-emerald-500" : "text-amber-500"}`} data-testid="text-tp-fill-rate">
                  {m.tpFillRate.toFixed(1)}%
                </p>
                <p className="text-[10px] text-muted-foreground">{m.filledSells}/{m.filledSells + (m.totalSellOrders - m.filledSells)} TP fills</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Spread Capturado</p>
                <p className="text-lg font-mono font-bold" data-testid="text-spread-capture">
                  ${m.avgSpreadCapture.toFixed(4)}
                </p>
                <p className="text-[10px] text-muted-foreground">avg sell - avg buy</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Salidas Forzadas</p>
                <p className={`text-lg font-mono font-bold ${m.forcedExitRate > 30 ? "text-amber-500" : "text-emerald-500"}`} data-testid="text-forced-exit-rate">
                  {m.forcedExitRate.toFixed(1)}%
                </p>
                <p className="text-[10px] text-muted-foreground">{m.hedgeLockExits} HEDGE_LOCK exits</p>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Precio Entry Prom.</p>
                <p className="text-sm font-mono" data-testid="text-avg-buy-price">${m.avgBuyPrice.toFixed(4)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Precio Exit Prom.</p>
                <p className="text-sm font-mono" data-testid="text-avg-sell-price">${m.avgSellPrice.toFixed(4)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Size Prom. Fill</p>
                <p className="text-sm font-mono" data-testid="text-avg-fill-size">{m.avgFillSize.toFixed(2)}</p>
              </div>
            </div>

            {analytics?.suggestions && analytics.suggestions.length > 0 && (
              <>
                <Separator />
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="w-4 h-4 text-amber-500" />
                    <p className="text-sm font-medium">Sugerencias de Optimización</p>
                  </div>
                  <div className="space-y-3">
                    {analytics.suggestions.map((s, i) => (
                      <div key={i} className="rounded-lg border p-3 space-y-1" data-testid={`suggestion-${i}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-muted-foreground">{s.param}</span>
                          <div className="flex items-center gap-2 text-xs font-mono">
                            <span className="text-red-400">{s.current}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="text-emerald-400">{s.suggested}</span>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">{s.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RateLimiterCard() {
  const { data: rlStatus } = useQuery<{
    requestsLastSecond: number;
    requestsLastMinute: number;
    consecutiveErrors: number;
    circuitOpen: boolean;
    circuitCooldownRemaining: number;
  }>({
    queryKey: ["/api/rate-limiter/status"],
    refetchInterval: 5000,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-sm font-medium">API Rate Limiter & Circuit Breaker</CardTitle>
          {rlStatus?.circuitOpen && (
            <Badge variant="destructive" className="ml-auto" data-testid="badge-circuit-open">
              Circuit Open
            </Badge>
          )}
          {rlStatus && !rlStatus.circuitOpen && (
            <Badge variant="secondary" className="ml-auto" data-testid="badge-circuit-closed">
              Normal
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rlStatus ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Req/sec</p>
              <p className="text-lg font-mono font-bold" data-testid="text-req-per-sec">{rlStatus.requestsLastSecond}/8</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Req/min</p>
              <p className="text-lg font-mono font-bold" data-testid="text-req-per-min">{rlStatus.requestsLastMinute}/100</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Consecutive Errors</p>
              <p className={`text-lg font-mono font-bold ${rlStatus.consecutiveErrors >= 3 ? "text-amber-500" : ""}`} data-testid="text-consecutive-errors">
                {rlStatus.consecutiveErrors}/5
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cooldown</p>
              <p className="text-lg font-mono font-bold" data-testid="text-cooldown">
                {rlStatus.circuitCooldownRemaining > 0 ? `${Math.ceil(rlStatus.circuitCooldownRemaining / 1000)}s` : "—"}
              </p>
            </div>
          </div>
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
      </CardContent>
    </Card>
  );
}
