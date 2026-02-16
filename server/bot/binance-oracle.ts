import WebSocket from "ws";
import { storage } from "../storage";

export type SignalDirection = "UP" | "DOWN" | "NEUTRAL";
export type SignalStrength = "STRONG" | "WEAK" | "NONE";

export interface PriceSignal {
  direction: SignalDirection;
  strength: SignalStrength;
  confidence: number;
  delta: number;
  openingPrice: number;
  currentPrice: number;
  elapsedMs: number;
  btcPrice: number;
  volatility5m: number;
}

export interface OracleConfig {
  strongThreshold: number;
  weakThreshold: number;
  minConfidence: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: OracleConfig = {
  strongThreshold: 20,
  weakThreshold: 8,
  minConfidence: 0.35,
  enabled: true,
};

const WS_ENDPOINTS = [
  "wss://stream.binance.com:9443/ws/btcusdt@trade",
  "wss://stream.binance.us:9443/ws/btcusdt@trade",
  "wss://ws.coincap.io/prices?assets=bitcoin",
];

const REST_FALLBACK_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const REST_FALLBACK_INTERVAL_MS = 2000;

export class BinanceOracle {
  private ws: WebSocket | null = null;
  private openingPrice = 0;
  private currentPrice = 0;
  private priceBuffer: { price: number; ts: number }[] = [];
  private windowStartTime = 0;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private config: OracleConfig = { ...DEFAULT_CONFIG };
  private lastLogTime = 0;
  private readonly BUFFER_MAX_SIZE = 3000;
  private readonly RECONNECT_BASE_MS = 2000;
  private readonly RECONNECT_MAX_MS = 30000;
  private currentEndpointIndex = 0;
  private geoBlockedEndpoints = new Set<number>();
  private restPollingTimer: ReturnType<typeof setInterval> | null = null;
  private activeSource: string = "none";
  private wsConnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private manuallyDisconnected = false;
  private wsLatencyMs = -1;
  private wsPingSentAt = 0;
  private wsPingTimer: ReturnType<typeof setInterval> | null = null;

  getConfig(): OracleConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<OracleConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getActiveSource(): string {
    return this.activeSource;
  }

  connect(): void {
    this.manuallyDisconnected = false;
    if (this.ws) {
      this.disconnect();
      this.manuallyDisconnected = false;
    }
    this.tryNextWebSocket();
  }

  private tryNextWebSocket(): void {
    if (this.manuallyDisconnected) return;

    while (this.geoBlockedEndpoints.has(this.currentEndpointIndex)) {
      this.currentEndpointIndex++;
      if (this.currentEndpointIndex >= WS_ENDPOINTS.length) {
        console.log("[BinanceOracle] All WebSocket endpoints geo-blocked, falling back to REST polling");
        this.startRestPolling();
        return;
      }
    }

    if (this.currentEndpointIndex >= WS_ENDPOINTS.length) {
      console.log("[BinanceOracle] All WebSocket endpoints exhausted, falling back to REST polling");
      this.startRestPolling();
      return;
    }

    const url = WS_ENDPOINTS[this.currentEndpointIndex];
    const endpointIdx = this.currentEndpointIndex;
    const sourceName = url.includes("binance.com") ? "binance.com" :
                       url.includes("binance.us") ? "binance.us" :
                       url.includes("coincap") ? "coincap" : "ws";

    console.log(`[BinanceOracle] Trying ${sourceName}: ${url}`);

    try {
      this.ws = new WebSocket(url);

      this.wsConnectTimeout = setTimeout(() => {
        if (!this.connected && this.ws) {
          console.log(`[BinanceOracle] Connection timeout for ${sourceName}, trying next`);
          this.ws.removeAllListeners();
          try { this.ws.close(); } catch {}
          this.ws = null;
          this.currentEndpointIndex++;
          this.tryNextWebSocket();
        }
      }, 8000);

      this.ws.on("open", () => {
        if (this.wsConnectTimeout) {
          clearTimeout(this.wsConnectTimeout);
          this.wsConnectTimeout = null;
        }
        this.connected = true;
        this.reconnectAttempts = 0;
        this.activeSource = sourceName;
        console.log(`[BinanceOracle] Connected via ${sourceName}`);

        if (this.wsPingTimer) clearInterval(this.wsPingTimer);
        this.wsPingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.wsPingSentAt = Date.now();
            try { this.ws.ping(); } catch {}
          }
        }, 15_000);
      });

      this.ws.on("pong", () => {
        if (this.wsPingSentAt > 0) {
          this.wsLatencyMs = Date.now() - this.wsPingSentAt;
          this.wsPingSentAt = 0;
        }
      });

      this.ws.on("message", (raw: Buffer) => {
        try {
          const data = JSON.parse(raw.toString());
          let price: number | null = null;

          if (data.p) {
            price = parseFloat(data.p);
          } else if (data.bitcoin) {
            price = parseFloat(data.bitcoin);
          }

          if (price && price > 0) {
            const ts = data.T || Date.now();
            this.currentPrice = price;
            this.priceBuffer.push({ price, ts });

            if (this.priceBuffer.length > this.BUFFER_MAX_SIZE) {
              this.priceBuffer = this.priceBuffer.slice(-this.BUFFER_MAX_SIZE);
            }
          }
        } catch {}
      });

      this.ws.on("close", (code: number) => {
        if (this.wsConnectTimeout) {
          clearTimeout(this.wsConnectTimeout);
          this.wsConnectTimeout = null;
        }
        if (this.wsPingTimer) {
          clearInterval(this.wsPingTimer);
          this.wsPingTimer = null;
        }
        this.wsPingSentAt = 0;
        this.wsLatencyMs = -1;
        this.connected = false;
        this.activeSource = "none";
        if (!this.manuallyDisconnected) {
          console.log(`[BinanceOracle] ${sourceName} closed (code=${code}), scheduling reconnect`);
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err: Error) => {
        if (this.wsConnectTimeout) {
          clearTimeout(this.wsConnectTimeout);
          this.wsConnectTimeout = null;
        }
        this.connected = false;

        if (err.message.includes("451") || err.message.includes("403")) {
          console.log(`[BinanceOracle] ${sourceName} geo-blocked (${err.message}), trying next source`);
          this.geoBlockedEndpoints.add(endpointIdx);
          if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch {}
            this.ws = null;
          }
          this.currentEndpointIndex++;
          this.tryNextWebSocket();
        } else {
          console.error(`[BinanceOracle] ${sourceName} error: ${err.message}`);
        }
      });
    } catch (err: any) {
      console.error(`[BinanceOracle] Failed to connect to ${sourceName}: ${err.message}`);
      this.currentEndpointIndex++;
      this.tryNextWebSocket();
    }
  }

  private startRestPolling(): void {
    if (this.restPollingTimer) return;

    this.activeSource = "coinbase-rest";
    console.log("[BinanceOracle] Starting REST polling via Coinbase API");

    this.fetchRestPrice();

    this.restPollingTimer = setInterval(() => {
      this.fetchRestPrice();
    }, REST_FALLBACK_INTERVAL_MS);
  }

  private async fetchRestPrice(): Promise<void> {
    try {
      const resp = await fetch(REST_FALLBACK_URL);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json() as any;
      const price = parseFloat(data?.data?.amount);
      if (price && price > 0) {
        this.currentPrice = price;
        this.connected = true;
        const ts = Date.now();
        this.priceBuffer.push({ price, ts });

        if (this.priceBuffer.length > this.BUFFER_MAX_SIZE) {
          this.priceBuffer = this.priceBuffer.slice(-this.BUFFER_MAX_SIZE);
        }
      }
    } catch (err: any) {
      if (!this.connected) {
        console.error(`[BinanceOracle] REST fallback error: ${err.message}`);
      }
    }
  }

  private stopRestPolling(): void {
    if (this.restPollingTimer) {
      clearInterval(this.restPollingTimer);
      this.restPollingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manuallyDisconnected) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      this.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      this.RECONNECT_MAX_MS
    );
    console.log(`[BinanceOracle] Reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.currentEndpointIndex = 0;
      this.geoBlockedEndpoints.clear();
      this.tryNextWebSocket();
    }, delay);
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    if (this.wsConnectTimeout) {
      clearTimeout(this.wsConnectTimeout);
      this.wsConnectTimeout = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.wsPingTimer) {
      clearInterval(this.wsPingTimer);
      this.wsPingTimer = null;
    }
    this.stopRestPolling();
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.activeSource = "none";
    this.wsLatencyMs = -1;
  }

  markWindowStart(): void {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const intervalSec = 300;
    const boundaryTimestamp = nowSec - (nowSec % intervalSec);
    const boundaryMs = boundaryTimestamp * 1000;

    const nearBoundary = this.priceBuffer.filter(
      p => Math.abs(p.ts - boundaryMs) < 5000
    );

    if (nearBoundary.length > 0) {
      nearBoundary.sort((a, b) => Math.abs(a.ts - boundaryMs) - Math.abs(b.ts - boundaryMs));
      this.openingPrice = nearBoundary[0].price;
      this.windowStartTime = boundaryMs;
      console.log(`[BinanceOracle] Window start aligned to boundary: opening=$${this.openingPrice.toFixed(2)} (from buffer, ${Math.abs(nearBoundary[0].ts - boundaryMs)}ms from boundary)`);
    } else if (this.currentPrice > 0) {
      this.openingPrice = this.currentPrice;
      this.windowStartTime = nowMs;
      console.log(`[BinanceOracle] Window start marked (no boundary data): opening=$${this.openingPrice.toFixed(2)}`);
    }
  }

  setOpeningPrice(price: number): void {
    this.openingPrice = price;
    this.windowStartTime = Date.now();
  }

  getSignal(marketElapsedMs?: number): PriceSignal {
    const elapsed = marketElapsedMs ?? (this.windowStartTime > 0 ? Date.now() - this.windowStartTime : 0);

    if (!this.config.enabled || this.currentPrice === 0 || this.openingPrice === 0) {
      return {
        direction: "NEUTRAL",
        strength: "NONE",
        confidence: 0,
        delta: 0,
        openingPrice: this.openingPrice,
        currentPrice: this.currentPrice,
        elapsedMs: elapsed,
        btcPrice: this.currentPrice,
        volatility5m: this.getVolatility(5),
      };
    }

    const delta = this.currentPrice - this.openingPrice;
    const absDelta = Math.abs(delta);

    const timeFactor = Math.min(1, elapsed / 180000);
    const priceFactor = Math.min(1, absDelta / 50);
    const consistency = this.getDirectionConsistency();

    const confidence = (priceFactor * 0.5) + (timeFactor * 0.2) + (consistency * 0.3);

    let direction: SignalDirection = "NEUTRAL";
    let strength: SignalStrength = "NONE";

    if (absDelta >= this.config.strongThreshold && confidence >= 0.55) {
      direction = delta > 0 ? "UP" : "DOWN";
      strength = "STRONG";
    } else if (absDelta >= this.config.weakThreshold && confidence >= this.config.minConfidence) {
      direction = delta > 0 ? "UP" : "DOWN";
      strength = "WEAK";
    }

    return {
      direction,
      strength,
      confidence: parseFloat(confidence.toFixed(4)),
      delta: parseFloat(delta.toFixed(2)),
      openingPrice: this.openingPrice,
      currentPrice: this.currentPrice,
      elapsedMs: elapsed,
      btcPrice: this.currentPrice,
      volatility5m: this.getVolatility(5),
    };
  }

  private getDirectionConsistency(): number {
    const now = Date.now();
    const recent = this.priceBuffer.filter(p => now - p.ts < 30000);
    if (recent.length < 5) return 0.5;

    let sameDirection = 0;
    const overallDelta = this.currentPrice - this.openingPrice;
    const overallDir = overallDelta > 0 ? 1 : overallDelta < 0 ? -1 : 0;

    for (let i = 1; i < recent.length; i++) {
      const d = recent[i].price - recent[i - 1].price;
      if ((d > 0 && overallDir > 0) || (d < 0 && overallDir < 0)) {
        sameDirection++;
      }
    }

    return sameDirection / (recent.length - 1);
  }

  getVolatility(windowMinutes: number): number {
    const now = Date.now();
    const cutoff = now - windowMinutes * 60 * 1000;
    const prices = this.priceBuffer.filter(p => p.ts >= cutoff).map(p => p.price);

    if (prices.length < 3) return 0;

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const squaredDiffs = prices.map(p => Math.pow((p - avg) / avg * 100, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
    return parseFloat(Math.sqrt(variance).toFixed(4));
  }

  getRangeVolatility(windowMinutes: number): number {
    const now = Date.now();
    const cutoff = now - windowMinutes * 60 * 1000;
    const prices = this.priceBuffer.filter(p => p.ts >= cutoff).map(p => p.price);

    if (prices.length < 3) return 0;

    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    return parseFloat(((max - min) / avg * 100).toFixed(4));
  }

  getCurrentPrice(): number {
    return this.currentPrice;
  }

  getOpeningPrice(): number {
    return this.openingPrice;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getWsLatencyMs(): number {
    return this.wsLatencyMs;
  }

  getStatus(): {
    connected: boolean;
    btcPrice: number;
    openingPrice: number;
    delta: number;
    bufferSize: number;
    volatility5m: number;
    signal: PriceSignal;
    source: string;
    wsLatencyMs: number;
  } {
    const signal = this.getSignal();
    return {
      connected: this.connected,
      btcPrice: this.currentPrice,
      openingPrice: this.openingPrice,
      delta: parseFloat((this.currentPrice - this.openingPrice).toFixed(2)),
      bufferSize: this.priceBuffer.length,
      volatility5m: this.getVolatility(5),
      signal,
      source: this.activeSource,
      wsLatencyMs: this.wsLatencyMs,
    };
  }
}

export const binanceOracle = new BinanceOracle();

setTimeout(() => {
  if (!binanceOracle.isConnected()) {
    binanceOracle.connect();
    console.log("[BinanceOracle] Auto-connecting on module load");
  }
}, 2000);
