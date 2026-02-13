import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Save, AlertTriangle, Shield, Crosshair, Gauge } from "lucide-react";
import type { BotConfig } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

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
    currentMarketSlug: "",
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
        currentMarketSlug: config.currentMarketSlug || "",
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
            Strategy parameters and risk management settings
          </p>
        </div>
        <Button onClick={handleSave} disabled={updateMutation.isPending} data-testid="button-save-config">
          <Save className="w-4 h-4 mr-1.5" />
          Save Changes
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">General Settings</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Paper Trading Mode</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Simulate trades using real market data without risking capital
              </p>
            </div>
            <Switch
              checked={formState.isPaperTrading}
              onCheckedChange={(v) => setFormState((s) => ({ ...s, isPaperTrading: v }))}
              data-testid="switch-paper-trading"
            />
          </div>
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
            <div className="space-y-1.5">
              <Label htmlFor="marketSlug">Market Slug</Label>
              <Input
                id="marketSlug"
                placeholder="e.g., btc-5min-up-or-down"
                value={formState.currentMarketSlug}
                onChange={(e) => setFormState((s) => ({ ...s, currentMarketSlug: e.target.value }))}
                data-testid="input-market-slug"
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
    </div>
  );
}
