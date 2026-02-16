import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { XCircle, RefreshCw, Download, Trophy, TrendingDown, Clock } from "lucide-react";
import type { Order } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "OPEN":
    case "PENDING":
      return "default";
    case "FILLED":
      return "secondary";
    case "PARTIALLY_FILLED":
      return "outline";
    case "CANCELLED":
    case "REJECTED":
      return "destructive";
    default:
      return "secondary";
  }
}

function sideBadgeClass(side: string) {
  return side === "BUY" ? "text-emerald-500" : "text-red-500";
}

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) {
    return (
      <Badge variant="outline" className="text-xs text-muted-foreground border-muted-foreground/30">
        <Clock className="w-3 h-3 mr-1" />
        Pending
      </Badge>
    );
  }
  if (outcome === "WON") {
    return (
      <Badge variant="outline" className="text-xs font-semibold border-emerald-500/50 text-emerald-400 bg-emerald-500/10">
        <Trophy className="w-3 h-3 mr-1" />
        WON
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs font-semibold border-red-500/50 text-red-400 bg-red-500/10">
      <TrendingDown className="w-3 h-3 mr-1" />
      LOST
    </Badge>
  );
}

function OrderRow({ order, onCancel, showOutcome }: { order: Order; onCancel: (id: string) => void; showOutcome?: boolean }) {
  const token = (order.tokenSide as "YES" | "NO") || "?";
  return (
    <TableRow data-testid={`row-order-${order.id}`}>
      <TableCell className="font-mono text-xs max-w-[120px] truncate">
        {order.clientOrderId}
      </TableCell>
      <TableCell>
        <span className={`font-medium text-sm ${sideBadgeClass(order.side)}`}>
          {order.side}
        </span>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={`text-xs font-semibold ${token === "YES" ? "border-emerald-500/50 text-emerald-400" : "border-red-500/50 text-red-400"}`}
          data-testid={`badge-token-${order.id}`}
        >
          {token}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-sm">${order.price.toFixed(4)}</TableCell>
      <TableCell className="font-mono text-sm">{order.size.toFixed(2)}</TableCell>
      <TableCell className="font-mono text-sm">{order.filledSize.toFixed(2)}</TableCell>
      <TableCell>
        <Badge variant={statusBadgeVariant(order.status)}>{order.status}</Badge>
      </TableCell>
      {showOutcome && (
        <TableCell data-testid={`cell-outcome-${order.id}`}>
          <OutcomeBadge outcome={order.outcome} />
        </TableCell>
      )}
      <TableCell>
        {order.isPaperTrade && <Badge variant="outline" className="text-xs">Paper</Badge>}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {format(new Date(order.createdAt), "HH:mm:ss")}
      </TableCell>
      <TableCell>
        {(order.status === "OPEN" || order.status === "PENDING") && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onCancel(order.id)}
            data-testid={`button-cancel-order-${order.id}`}
          >
            <XCircle className="w-4 h-4 text-destructive" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function Orders() {
  const { toast } = useToast();

  const { data: orders = [], isLoading } = useQuery<Order[]>({
    queryKey: ["/api/orders"],
    refetchInterval: 3000,
  });

  const cancelMutation = useMutation({
    mutationFn: async (orderId: string) => {
      return apiRequest("POST", `/api/orders/${orderId}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
      toast({ title: "Order cancelled" });
    },
  });

  const cancelAllMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/orders/cancel-all");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
      toast({ title: "All open orders cancelled" });
    },
  });

  const activeOrders = orders.filter(
    (o) => o.status === "OPEN" || o.status === "PENDING" || o.status === "PARTIALLY_FILLED"
  );
  const historicalOrders = orders.filter(
    (o) => o.status === "FILLED" || o.status === "CANCELLED" || o.status === "REJECTED"
  );

  const filledOrders = orders.filter((o) => o.status === "FILLED");
  const wonOrders = filledOrders.filter((o) => o.outcome === "WON");
  const lostOrders = filledOrders.filter((o) => o.outcome === "LOST");
  const pendingOutcome = filledOrders.filter((o) => !o.outcome);
  const winRate = wonOrders.length + lostOrders.length > 0
    ? ((wonOrders.length / (wonOrders.length + lostOrders.length)) * 100).toFixed(1)
    : null;

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Active and historical order management
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/orders"] })}
            data-testid="button-refresh-orders"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.open("/api/orders/export", "_blank");
            }}
            data-testid="button-export-orders"
          >
            <Download className="w-4 h-4 mr-1.5" />
            Export CSV
          </Button>
          {activeOrders.length > 0 && (
            <Button
              variant="destructive"
              onClick={() => cancelAllMutation.mutate()}
              disabled={cancelAllMutation.isPending}
              data-testid="button-cancel-all-orders"
            >
              Cancel All ({activeOrders.length})
            </Button>
          )}
        </div>
      </div>

      {filledOrders.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="outcome-summary">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-xs text-muted-foreground mb-1">Filled</p>
              <p className="text-2xl font-bold font-mono" data-testid="text-total-filled">{filledOrders.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-xs text-muted-foreground mb-1">Won</p>
              <p className="text-2xl font-bold font-mono text-emerald-400" data-testid="text-total-won">{wonOrders.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-xs text-muted-foreground mb-1">Lost</p>
              <p className="text-2xl font-bold font-mono text-red-400" data-testid="text-total-lost">{lostOrders.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-xs text-muted-foreground mb-1">Win Rate</p>
              <p className="text-2xl font-bold font-mono" data-testid="text-win-rate">
                {winRate !== null ? `${winRate}%` : "—"}
              </p>
              {pendingOutcome.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">{pendingOutcome.length} pending</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="active">
        <TabsList>
          <TabsTrigger value="active" data-testid="tab-active-orders">
            Active ({activeOrders.length})
          </TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history-orders">
            History ({historicalOrders.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active">
          <Card>
            <CardContent className="p-0">
              {activeOrders.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No active orders
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client ID</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Token</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Filled</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activeOrders.map((order) => (
                      <OrderRow
                        key={order.id}
                        order={order}
                        onCancel={(id) => cancelMutation.mutate(id)}
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardContent className="p-0">
              {historicalOrders.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  No order history
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client ID</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Token</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Filled</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historicalOrders.map((order) => (
                      <OrderRow
                        key={order.id}
                        order={order}
                        onCancel={(id) => cancelMutation.mutate(id)}
                        showOutcome
                      />
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
