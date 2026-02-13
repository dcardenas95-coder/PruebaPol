import type { MarketData } from "@shared/schema";
import { polymarketClient } from "./polymarket-client";
import type { PolymarketWebSocket } from "./polymarket-ws";

export class MarketDataModule {
  private lastData: MarketData | null = null;
  private currentTokenId: string | null = null;
  private useSimulation = false;
  private consecutiveErrors = 0;
  private readonly MAX_ERRORS_BEFORE_FALLBACK = 5;
  private wsSource: PolymarketWebSocket | null = null;
  private lastWsUpdate = 0;
  private readonly WS_STALE_THRESHOLD = 15_000;

  setTokenId(tokenId: string | null): void {
    this.currentTokenId = tokenId;
    this.consecutiveErrors = 0;
    this.useSimulation = false;
  }

  getTokenId(): string | null {
    return this.currentTokenId;
  }

  setWsDataSource(ws: PolymarketWebSocket): void {
    this.wsSource = ws;
  }

  updateFromWs(data: MarketData): void {
    this.lastData = data;
    this.lastWsUpdate = Date.now();
    this.consecutiveErrors = 0;
  }

  isUsingLiveData(): boolean {
    return !!this.currentTokenId && !this.useSimulation;
  }

  isWsActive(): boolean {
    if (!this.wsSource) return false;
    return Date.now() - this.lastWsUpdate < this.WS_STALE_THRESHOLD;
  }

  async fetchLiveData(): Promise<MarketData | null> {
    if (!this.currentTokenId) return null;

    try {
      const data = await polymarketClient.fetchMarketData(this.currentTokenId);
      if (data) {
        this.consecutiveErrors = 0;
        this.lastData = data;
        return data;
      }
      this.consecutiveErrors++;
    } catch (error: any) {
      this.consecutiveErrors++;
      console.error("[MarketData] Live data error:", error.message);
    }

    if (this.consecutiveErrors >= this.MAX_ERRORS_BEFORE_FALLBACK) {
      console.warn("[MarketData] Too many errors, falling back to simulation");
      this.useSimulation = true;
    }

    return null;
  }

  generateSimulatedData(): MarketData {
    const basePrice = 0.45 + Math.random() * 0.1;
    const spread = 0.02 + Math.random() * 0.06;
    const bestBid = basePrice;
    const bestAsk = basePrice + spread;
    const midpoint = (bestBid + bestAsk) / 2;

    this.lastData = {
      bestBid: parseFloat(bestBid.toFixed(4)),
      bestAsk: parseFloat(bestAsk.toFixed(4)),
      spread: parseFloat(spread.toFixed(4)),
      midpoint: parseFloat(midpoint.toFixed(4)),
      bidDepth: parseFloat((50 + Math.random() * 200).toFixed(2)),
      askDepth: parseFloat((50 + Math.random() * 200).toFixed(2)),
      lastPrice: parseFloat((midpoint + (Math.random() - 0.5) * 0.01).toFixed(4)),
      volume24h: parseFloat((1000 + Math.random() * 5000).toFixed(2)),
    };

    return this.lastData;
  }

  async getData(): Promise<MarketData> {
    if (this.isWsActive() && this.lastData) {
      return this.lastData;
    }

    if (this.currentTokenId && !this.useSimulation) {
      const liveData = await this.fetchLiveData();
      if (liveData) return liveData;
    }
    return this.generateSimulatedData();
  }

  getLastData(): MarketData | null {
    return this.lastData;
  }

  isSpreadSufficient(minSpread: number): boolean {
    if (!this.lastData) return false;
    return this.lastData.spread >= minSpread;
  }

  isMarketActive(): boolean {
    if (!this.lastData) return false;
    return this.lastData.bidDepth > 10 && this.lastData.askDepth > 10;
  }

  getBestSide(): "BUY" | "SELL" | null {
    if (!this.lastData) return null;
    if (this.lastData.bidDepth > this.lastData.askDepth * 1.2) return "BUY";
    if (this.lastData.askDepth > this.lastData.bidDepth * 1.2) return "SELL";
    return "BUY";
  }

  getExitPrice(entryPrice: number, profitMin: number, profitMax: number): number {
    const target = profitMin + Math.random() * (profitMax - profitMin);
    return parseFloat((entryPrice + target).toFixed(4));
  }
}
