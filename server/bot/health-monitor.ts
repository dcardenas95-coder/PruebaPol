import { polymarketClient } from "./polymarket-client";
import { polymarketWs, type WsConnectionHealth } from "./polymarket-ws";
import { liveTradingClient } from "./live-trading-client";
import { apiRateLimiter } from "./rate-limiter";
import { alertManager, type AlertLevel } from "./alert-manager";
import { binanceOracle } from "./binance-oracle";
import { storage } from "../storage";

export interface HealthCheckResult {
  overall: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptime: number;
  checks: {
    rpc: { status: "ok" | "error"; latencyMs: number | null; endpoint: string | null; error?: string };
    clobApi: { status: "ok" | "error"; latencyMs: number | null; error?: string };
    websocket: { status: "ok" | "degraded" | "error"; market: boolean; user: boolean; lastMessageAge: number | null };
    database: { status: "ok" | "error"; latencyMs: number | null; error?: string };
    rateLimiter: { status: "ok" | "warning"; circuitOpen: boolean; requestsLastMinute: number };
    oracle: { status: "ok" | "disconnected"; connected: boolean; btcPrice: number | null };
  };
  botState: {
    isActive: boolean;
    isPaperTrading: boolean;
    currentState: string;
    hasMarketSelected: boolean;
  };
}

const startTime = Date.now();
let lastHealthCheck: HealthCheckResult | null = null;
let consecutiveUnhealthy = 0;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

async function checkRpc(): Promise<HealthCheckResult["checks"]["rpc"]> {
  const start = Date.now();
  try {
    const endpoints = process.env.POLYGON_RPC_URL
      ? [process.env.POLYGON_RPC_URL]
      : ["https://rpc.ankr.com/polygon"];
    const endpoint = endpoints[0];
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "eth_blockNumber", params: [], id: 1, jsonrpc: "2.0" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data: any = await resp.json();
    if (data.error) throw new Error(data.error.message || "RPC error");
    return { status: "ok", latencyMs: Date.now() - start, endpoint: endpoint.slice(0, 40) + "..." };
  } catch (err: any) {
    return { status: "error", latencyMs: null, endpoint: null, error: err.message };
  }
}

async function checkClobApi(): Promise<HealthCheckResult["checks"]["clobApi"]> {
  const start = Date.now();
  try {
    const resp = await fetch("https://clob.polymarket.com/time", {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: "error", latencyMs: null, error: err.message };
  }
}

function checkWebSocket(botActive: boolean): HealthCheckResult["checks"]["websocket"] {
  const health: WsConnectionHealth = polymarketWs.getHealth();
  const now = Date.now();
  const lastMsg = health.marketLastMessage || health.userLastMessage || null;
  const lastMessageAge = lastMsg ? now - lastMsg : null;

  let status: "ok" | "degraded" | "error" = "ok";

  if (!botActive) {
    status = "ok";
  } else if (!health.marketConnected && !health.userConnected) {
    status = "error";
  } else if (!health.marketConnected || !health.userConnected) {
    status = "degraded";
  } else if (lastMessageAge && lastMessageAge > 60_000) {
    status = "degraded";
  }

  return {
    status,
    market: health.marketConnected,
    user: health.userConnected,
    lastMessageAge,
  };
}

async function checkDatabase(): Promise<HealthCheckResult["checks"]["database"]> {
  const start = Date.now();
  try {
    await storage.getBotConfig();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: "error", latencyMs: null, error: err.message };
  }
}

function checkRateLimiter(): HealthCheckResult["checks"]["rateLimiter"] {
  const status = apiRateLimiter.getStatus();
  return {
    status: status.circuitOpen ? "warning" : "ok",
    circuitOpen: status.circuitOpen,
    requestsLastMinute: status.requestsLastMinute,
  };
}

export async function runHealthCheck(): Promise<HealthCheckResult> {
  const [rpc, clobApi, db, config] = await Promise.all([
    checkRpc(),
    checkClobApi(),
    checkDatabase(),
    storage.getBotConfig().catch(() => null),
  ]);

  const botActive = config?.isActive ?? false;
  const ws = checkWebSocket(botActive);
  const rl = checkRateLimiter();

  const criticalFailures = [rpc.status === "error", clobApi.status === "error", db.status === "error"].filter(Boolean).length;
  const warnings = [ws.status !== "ok", rl.status !== "ok"].filter(Boolean).length;

  let overall: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (criticalFailures >= 2) overall = "unhealthy";
  else if (criticalFailures >= 1 || warnings >= 1) overall = "degraded";

  const oracleConnected = binanceOracle.isConnected();
  const oracleStatus = oracleConnected ? "ok" as const : "disconnected" as const;
  const oraclePrice = oracleConnected ? binanceOracle.getStatus().btcPrice : null;

  const result: HealthCheckResult = {
    overall,
    timestamp: new Date().toISOString(),
    uptime: Date.now() - startTime,
    checks: { rpc, clobApi, websocket: ws, database: db, rateLimiter: rl, oracle: { status: oracleStatus, connected: oracleConnected, btcPrice: oraclePrice } },
    botState: {
      isActive: config?.isActive ?? false,
      isPaperTrading: config?.isPaperTrading ?? true,
      currentState: config?.currentState ?? "STOPPED",
      hasMarketSelected: !!config?.currentMarketId,
    },
  };

  lastHealthCheck = result;

  if (overall === "unhealthy") {
    consecutiveUnhealthy++;
  } else {
    consecutiveUnhealthy = 0;
  }

  await processHealthAlerts(result);

  return result;
}

async function processHealthAlerts(result: HealthCheckResult): Promise<void> {
  const { checks } = result;

  if (checks.rpc.status === "error") {
    await alertManager.sendAlert("critical", "RPC Desconectado", `Polygon RPC no responde: ${checks.rpc.error}`, "rpc_down");
  } else {
    alertManager.resolveAlert("rpc_down");
  }

  if (checks.clobApi.status === "error") {
    await alertManager.sendAlert("critical", "CLOB API Caída", `Polymarket CLOB API no responde: ${checks.clobApi.error}`, "clob_down");
  } else {
    alertManager.resolveAlert("clob_down");
  }

  if (checks.websocket.status === "error") {
    await alertManager.sendAlert("warning", "WebSocket Desconectado", "Ambas conexiones WebSocket (market y user) caídas", "ws_down");
  } else if (checks.websocket.status === "degraded") {
    await alertManager.sendAlert("warning", "WebSocket Degradado", "Una conexión WebSocket caída o datos desactualizados", "ws_degraded");
  } else {
    alertManager.resolveAlert("ws_down");
    alertManager.resolveAlert("ws_degraded");
  }

  if (checks.database.status === "error") {
    await alertManager.sendAlert("critical", "Base de Datos Error", `PostgreSQL no responde: ${checks.database.error}`, "db_down");
  } else {
    alertManager.resolveAlert("db_down");
  }

  if (checks.rateLimiter.circuitOpen) {
    await alertManager.sendAlert("warning", "Circuit Breaker Abierto", "Demasiados errores consecutivos en API. Trading pausado temporalmente.", "circuit_open");
  } else {
    alertManager.resolveAlert("circuit_open");
  }

  if (result.overall === "unhealthy" && consecutiveUnhealthy >= 3) {
    await alertManager.sendAlert("critical", "Sistema Crítico", `${consecutiveUnhealthy} health checks consecutivos fallidos. Considerar reinicio.`, "system_critical");
  } else if (result.overall !== "unhealthy") {
    alertManager.resolveAlert("system_critical");
  }
}

export function startHealthMonitor(intervalMs = 30_000): void {
  if (healthCheckInterval) return;
  console.log(`[HealthMonitor] Starting periodic health checks every ${intervalMs / 1000}s`);
  healthCheckInterval = setInterval(async () => {
    try {
      await runHealthCheck();
    } catch (err: any) {
      console.error(`[HealthMonitor] Health check error: ${err.message}`);
    }
  }, intervalMs);
  setTimeout(() => runHealthCheck().catch(() => {}), 5000);
}

export function stopHealthMonitor(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

export function getLastHealthCheck(): HealthCheckResult | null {
  return lastHealthCheck;
}
