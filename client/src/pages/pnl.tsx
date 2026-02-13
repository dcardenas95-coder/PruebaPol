import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { TrendingUp, TrendingDown, BarChart3, Target, Percent } from "lucide-react";
import type { PnlRecord } from "@shared/schema";

export default function PnL() {
  const { data: records = [], isLoading } = useQuery<PnlRecord[]>({
    queryKey: ["/api/pnl"],
  });

  const totalPnl = records.reduce((s, r) => s + r.totalPnl, 0);
  const totalTrades = records.reduce((s, r) => s + r.tradesCount, 0);
  const totalWins = records.reduce((s, r) => s + r.winCount, 0);
  const totalLosses = records.reduce((s, r) => s + r.lossCount, 0);
  const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
  const totalVolume = records.reduce((s, r) => s + r.volume, 0);
  const totalFees = records.reduce((s, r) => s + r.fees, 0);

  const chartData = records.map((r) => ({
    date: r.date,
    pnl: r.totalPnl,
    cumulative: 0,
  }));

  let cum = 0;
  chartData.forEach((d) => {
    cum += d.pnl;
    d.cumulative = cum;
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profit & Loss</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Performance tracking and analytics
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-total-pnl">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Total PnL</span>
                <span
                  className={`text-xl font-bold font-mono ${
                    totalPnl > 0
                      ? "text-emerald-500"
                      : totalPnl < 0
                        ? "text-red-500"
                        : ""
                  }`}
                >
                  ${totalPnl.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted">
                {totalPnl >= 0 ? (
                  <TrendingUp className="w-5 h-5 text-emerald-500" />
                ) : (
                  <TrendingDown className="w-5 h-5 text-red-500" />
                )}
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-total-trades">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Total Trades</span>
                <span className="text-xl font-bold font-mono">{totalTrades}</span>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted">
                <BarChart3 className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-win-rate">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Win Rate</span>
                <span className="text-xl font-bold font-mono">{winRate.toFixed(1)}%</span>
                <span className="text-xs text-muted-foreground">
                  {totalWins}W / {totalLosses}L
                </span>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted">
                <Target className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-volume">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Volume / Fees</span>
                <span className="text-xl font-bold font-mono">${totalVolume.toFixed(2)}</span>
                <span className="text-xs text-muted-foreground">
                  Fees: ${totalFees.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-center w-10 h-10 rounded-md bg-muted">
                <Percent className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {chartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card data-testid="card-cumulative-pnl-chart">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Cumulative PnL</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="date" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="cumulative"
                      stroke="hsl(var(--primary))"
                      fill="hsl(var(--primary) / 0.1)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-daily-pnl-chart">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Daily PnL</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="date" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                    />
                    <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                      {chartData.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={entry.pnl >= 0 ? "rgb(16 185 129)" : "rgb(239 68 68)"}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Daily Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {records.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No PnL data yet. Start the bot to generate trading data.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Realized</TableHead>
                  <TableHead>Unrealized</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Trades</TableHead>
                  <TableHead>W/L</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead>Fees</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id} data-testid={`row-pnl-${r.id}`}>
                    <TableCell className="font-mono text-sm">{r.date}</TableCell>
                    <TableCell className={`font-mono text-sm ${r.realizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      ${r.realizedPnl.toFixed(2)}
                    </TableCell>
                    <TableCell className={`font-mono text-sm ${r.unrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      ${r.unrealizedPnl.toFixed(2)}
                    </TableCell>
                    <TableCell className={`font-mono text-sm font-medium ${r.totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      ${r.totalPnl.toFixed(2)}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{r.tradesCount}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {r.winCount}/{r.lossCount}
                    </TableCell>
                    <TableCell className="font-mono text-sm">${r.volume.toFixed(2)}</TableCell>
                    <TableCell className="font-mono text-sm">${r.fees.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
