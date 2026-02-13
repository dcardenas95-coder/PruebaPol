import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { Position } from "@shared/schema";

export default function Positions() {
  const { data: positions = [], isLoading } = useQuery<Position[]>({
    queryKey: ["/api/positions"],
    refetchInterval: 3000,
  });

  const totalUnrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const totalRealized = positions.reduce((s, p) => s + p.realizedPnl, 0);
  const totalExposure = positions.reduce((s, p) => s + p.size * p.avgEntryPrice, 0);

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
        <h1 className="text-2xl font-bold tracking-tight">Positions</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Current inventory and position tracking
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card data-testid="card-total-exposure">
          <CardContent className="p-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Total Exposure</span>
              <span className="text-xl font-bold font-mono">${totalExposure.toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-unrealized-pnl">
          <CardContent className="p-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Unrealized PnL</span>
              <span
                className={`text-xl font-bold font-mono ${
                  totalUnrealized > 0
                    ? "text-emerald-500"
                    : totalUnrealized < 0
                      ? "text-red-500"
                      : ""
                }`}
              >
                ${totalUnrealized.toFixed(2)}
              </span>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-realized-pnl">
          <CardContent className="p-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Realized PnL</span>
              <span
                className={`text-xl font-bold font-mono ${
                  totalRealized > 0
                    ? "text-emerald-500"
                    : totalRealized < 0
                      ? "text-red-500"
                      : ""
                }`}
              >
                ${totalRealized.toFixed(2)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Open Positions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {positions.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No open positions
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Avg Entry</TableHead>
                  <TableHead>Unrealized PnL</TableHead>
                  <TableHead>Realized PnL</TableHead>
                  <TableHead>Direction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((pos) => (
                  <TableRow key={pos.id} data-testid={`row-position-${pos.id}`}>
                    <TableCell className="font-mono text-xs max-w-[200px] truncate">
                      {pos.marketId}
                    </TableCell>
                    <TableCell>
                      <span className={`font-medium ${pos.side === "BUY" ? "text-emerald-500" : "text-red-500"}`}>
                        {pos.side}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono">{pos.size.toFixed(2)}</TableCell>
                    <TableCell className="font-mono">${pos.avgEntryPrice.toFixed(4)}</TableCell>
                    <TableCell>
                      <span
                        className={`font-mono ${
                          pos.unrealizedPnl > 0
                            ? "text-emerald-500"
                            : pos.unrealizedPnl < 0
                              ? "text-red-500"
                              : "text-muted-foreground"
                        }`}
                      >
                        ${pos.unrealizedPnl.toFixed(2)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`font-mono ${
                          pos.realizedPnl > 0
                            ? "text-emerald-500"
                            : pos.realizedPnl < 0
                              ? "text-red-500"
                              : "text-muted-foreground"
                        }`}
                      >
                        ${pos.realizedPnl.toFixed(2)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {pos.unrealizedPnl > 0 ? (
                        <TrendingUp className="w-4 h-4 text-emerald-500" />
                      ) : pos.unrealizedPnl < 0 ? (
                        <TrendingDown className="w-4 h-4 text-red-500" />
                      ) : (
                        <Minus className="w-4 h-4 text-muted-foreground" />
                      )}
                    </TableCell>
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
