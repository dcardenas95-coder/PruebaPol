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
  strongThreshold: 30,
  weakThreshold: 15,
  minConfidence: 0.60,
  enabled: true,
};

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

  getConfig(): OracleConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<OracleConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  connect(): void {
    if (this.ws) {
      this.disconnect();
    }

    try {
      this.ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        console.log("[BinanceOracle] Connected to Binance btcusdt@trade stream");
      });

      this.ws.on("message", (raw: Buffer) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.p) {
            const price = parseFloat(data.p);
            const ts = data.T || Date.now();
            this.currentPrice = price;
            this.priceBuffer.push({ price, ts });

            if (this.priceBuffer.length > this.BUFFER_MAX_SIZE) {
              this.priceBuffer = this.priceBuffer.slice(-this.BUFFER_MAX_SIZE);
            }
          }
        } catch {}
      });

      this.ws.on("close", () => {
        this.connected = false;
        console.log("[BinanceOracle] WebSocket closed, scheduling reconnect");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err: Error) => {
        console.error(`[BinanceOracle] WebSocket error: ${err.message}`);
        this.connected = false;
      });
    } catch (err: any) {
      console.error(`[BinanceOracle] Failed to connect: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      this.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      this.RECONNECT_MAX_MS
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  markWindowStart(): void {
    if (this.currentPrice > 0) {
      this.openingPrice = this.currentPrice;
      this.windowStartTime = Date.now();
      console.log(`[BinanceOracle] Window start marked: opening=$${this.openingPrice.toFixed(2)}`);
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

    if (absDelta >= this.config.strongThreshold && confidence >= 0.75) {
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

  getCurrentPrice(): number {
    return this.currentPrice;
  }

  getOpeningPrice(): number {
    return this.openingPrice;
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null;
  }

  getStatus(): {
    connected: boolean;
    btcPrice: number;
    openingPrice: number;
    delta: number;
    bufferSize: number;
    volatility5m: number;
    signal: PriceSignal;
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
    };
  }
}

export const binanceOracle = new BinanceOracle();
