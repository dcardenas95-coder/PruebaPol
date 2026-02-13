import type { MarketData } from "@shared/schema";

export class MarketDataModule {
  private lastData: MarketData | null = null;

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
