import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Filter } from "lucide-react";
import type { BotEvent } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { useState } from "react";

function levelColor(level: string) {
  switch (level) {
    case "error":
      return "text-red-500";
    case "warn":
      return "text-amber-500";
    case "info":
      return "text-blue-400";
    case "debug":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

function typeBadgeVariant(type: string): "default" | "secondary" | "destructive" | "outline" {
  if (type.includes("ERROR") || type.includes("RISK") || type.includes("KILL")) return "destructive";
  if (type.includes("ORDER") || type.includes("FILL")) return "default";
  if (type.includes("STATE") || type.includes("POSITION")) return "outline";
  return "secondary";
}

export default function Logs() {
  const [filterType, setFilterType] = useState<string>("all");
  const [filterLevel, setFilterLevel] = useState<string>("all");

  const { data: events = [], isLoading } = useQuery<BotEvent[]>({
    queryKey: ["/api/events"],
    refetchInterval: 3000,
  });

  const filtered = events.filter((e) => {
    if (filterType !== "all" && e.type !== filterType) return false;
    if (filterLevel !== "all" && e.level !== filterLevel) return false;
    return true;
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Event Logs</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Structured event logging and audit trail
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/events"] })}
          data-testid="button-refresh-logs"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Filters:</span>
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-[180px]" data-testid="select-filter-type">
            <SelectValue placeholder="Event Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="ORDER_PLACED">Order Placed</SelectItem>
            <SelectItem value="ORDER_FILLED">Order Filled</SelectItem>
            <SelectItem value="ORDER_CANCELLED">Order Cancelled</SelectItem>
            <SelectItem value="ORDER_REJECTED">Order Rejected</SelectItem>
            <SelectItem value="STATE_CHANGE">State Change</SelectItem>
            <SelectItem value="RISK_ALERT">Risk Alert</SelectItem>
            <SelectItem value="KILL_SWITCH">Kill Switch</SelectItem>
            <SelectItem value="ERROR">Error</SelectItem>
            <SelectItem value="INFO">Info</SelectItem>
            <SelectItem value="RECONCILIATION">Reconciliation</SelectItem>
            <SelectItem value="POSITION_UPDATE">Position Update</SelectItem>
            <SelectItem value="PNL_UPDATE">PnL Update</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterLevel} onValueChange={setFilterLevel}>
          <SelectTrigger className="w-[140px]" data-testid="select-filter-level">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="warn">Warning</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>
        <Badge variant="secondary">{filtered.length} events</Badge>
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No events matching filters
            </div>
          ) : (
            <ScrollArea className="h-[600px]">
              <div className="divide-y divide-border">
                {filtered.map((event) => (
                  <div
                    key={event.id}
                    className="px-4 py-3 flex items-start gap-3"
                    data-testid={`log-event-${event.id}`}
                  >
                    <div className="flex flex-col items-center gap-0.5 min-w-[60px] pt-0.5">
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {format(new Date(event.createdAt), "HH:mm:ss")}
                      </span>
                      <span className={`text-[10px] font-mono font-medium uppercase ${levelColor(event.level)}`}>
                        {event.level}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={typeBadgeVariant(event.type)} className="text-[10px]">
                          {event.type}
                        </Badge>
                        <span className="text-sm">{event.message}</span>
                      </div>
                      {event.data && (
                        <pre className="mt-1 text-[11px] text-muted-foreground font-mono overflow-x-auto max-w-full">
                          {JSON.stringify(event.data, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
