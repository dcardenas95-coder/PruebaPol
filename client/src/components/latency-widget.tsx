import { useQuery } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface LatencyEntry {
  pm: number;
  bn: number;
  ts: number;
}

interface LatencyData {
  current: LatencyEntry;
  history: LatencyEntry[];
}

function getColor(ms: number): string {
  if (ms < 0) return "text-zinc-500";
  if (ms < 100) return "text-emerald-400";
  if (ms < 300) return "text-yellow-400";
  return "text-red-400";
}

function getDotColor(ms: number): string {
  if (ms < 0) return "bg-zinc-500";
  if (ms < 100) return "bg-emerald-400";
  if (ms < 300) return "bg-yellow-400";
  return "bg-red-400";
}

function MiniSparkline({ data, type }: { data: LatencyEntry[]; type: "pm" | "bn" }) {
  if (data.length < 2) return null;

  const values = data.map((d) => (d[type] < 0 ? 0 : d[type]));
  const max = Math.max(...values, 1);
  const height = 16;
  const width = 60;
  const step = width / (values.length - 1);

  const points = values
    .map((v, i) => `${i * step},${height - (v / max) * height}`)
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      className="inline-block ml-1 opacity-70"
      data-testid={`sparkline-${type}`}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        points={points}
        className={values[values.length - 1] < 100
          ? "text-emerald-400"
          : values[values.length - 1] < 300
            ? "text-yellow-400"
            : "text-red-400"}
      />
    </svg>
  );
}

function formatMs(ms: number): string {
  if (ms < 0) return "---";
  return `${ms}ms`;
}

export function LatencyWidget() {
  const { data, isLoading } = useQuery<LatencyData>({
    queryKey: ["/api/latency"],
    refetchInterval: 15_000,
    staleTime: 14_000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground px-2" data-testid="latency-widget-loading">
        <span>PM: ---</span>
        <span className="text-muted-foreground/50">|</span>
        <span>BN: ---</span>
      </div>
    );
  }

  const { current, history } = data;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center gap-1.5 text-xs font-mono cursor-default px-2 py-1 rounded-md bg-muted/50 hover:bg-muted transition-colors"
          data-testid="latency-widget"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${getDotColor(current.pm)}`} />
          <span className={getColor(current.pm)}>PM: {formatMs(current.pm)}</span>
          <MiniSparkline data={history} type="pm" />
          <span className="text-muted-foreground/40 mx-0.5">|</span>
          <span className={`w-1.5 h-1.5 rounded-full ${getDotColor(current.bn)}`} />
          <span className={getColor(current.bn)}>BN: {formatMs(current.bn)}</span>
          <MiniSparkline data={history} type="bn" />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-xs">
        <div className="space-y-1">
          <div>Polymarket CLOB: {formatMs(current.pm)}</div>
          <div>Binance API: {formatMs(current.bn)}</div>
          <div className="text-muted-foreground">
            Muestras: {history.length}/20 · Cada 15s
          </div>
          <div className="text-muted-foreground text-[10px]">
            Verde &lt;100ms · Amarillo &lt;300ms · Rojo &gt;300ms
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
