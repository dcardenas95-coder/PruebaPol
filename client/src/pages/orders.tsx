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
import { XCircle, RefreshCw, Download } from "lucide-react";
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

function OrderRow({ order, onCancel }: { order: Order; onCancel: (id: string) => void }) {
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
      <TableCell className="font-mono text-sm">${order.price.toFixed(4)}</TableCell>
      <TableCell className="font-mono text-sm">{order.size.toFixed(2)}</TableCell>
      <TableCell className="font-mono text-sm">{order.filledSize.toFixed(2)}</TableCell>
      <TableCell>
        <Badge variant={statusBadgeVariant(order.status)}>{order.status}</Badge>
      </TableCell>
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
                    {historicalOrders.map((order) => (
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
      </Tabs>
    </div>
  );
}
