import { polymarketClient } from "../../bot/polymarket-client";
import type { VolatilitySnapshot } from "./types";

interface PriceTick {
  ts: number;
  yesPrice: number;
  noPrice: number;
}

export class VolatilityTracker {
  private ticks: PriceTick[] = [];
  private maxTicks = 500;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private tokenYes: string | null = null;
  private tokenNo: string | null = null;

  start(tokenYes: string, tokenNo: string) {
    this.tokenYes = tokenYes;
    this.tokenNo = tokenNo;
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(() => this.fetchTick(), 10000);
    this.fetchTick();
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  updateTokens(tokenYes: string, tokenNo: string) {
    this.tokenYes = tokenYes;
    this.tokenNo = tokenNo;
  }

  private async fetchTick() {
    if (!this.tokenYes) return;
    try {
      const yesPrice = await polymarketClient.fetchMidpoint(this.tokenYes);
      const noPrice = this.tokenNo ? await polymarketClient.fetchMidpoint(this.tokenNo) : null;
      if (yesPrice !== null) {
        this.ticks.push({
          ts: Date.now(),
          yesPrice,
          noPrice: noPrice ?? (1 - yesPrice),
        });
        if (this.ticks.length > this.maxTicks) {
          this.ticks = this.ticks.slice(-this.maxTicks);
        }
      }
    } catch {}
  }

  getVolatility(windowMinutes: number): number {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const recent = this.ticks.filter(t => t.ts >= cutoff);
    if (recent.length < 3) return 0;

    const prices = recent.map(t => t.yesPrice);
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        returns.push(Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
      }
    }
    if (returns.length === 0) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  getSnapshot(windowMinutes: number, minThreshold: number, maxThreshold: number): VolatilitySnapshot {
    const current = this.getVolatility(windowMinutes);
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const priceCount = this.ticks.filter(t => t.ts >= cutoff).length;
    return {
      current,
      windowMinutes,
      withinRange: current >= minThreshold && current <= maxThreshold,
      min: minThreshold,
      max: maxThreshold,
      priceCount,
    };
  }

  getMomentum(windowMinutes: number): { direction: "up" | "down" | "flat"; strength: number } {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const recent = this.ticks.filter(t => t.ts >= cutoff);
    if (recent.length < 3) return { direction: "flat", strength: 0 };

    const first = recent[0].yesPrice;
    const last = recent[recent.length - 1].yesPrice;
    const change = last - first;
    const pctChange = Math.abs(change / first) * 100;

    if (pctChange < 0.5) return { direction: "flat", strength: 0 };

    const strength = Math.min(pctChange / 5, 1);
    return {
      direction: change > 0 ? "up" : "down",
      strength,
    };
  }

  getLatestPrices(): { yesPrice: number; noPrice: number } | null {
    if (this.ticks.length === 0) return null;
    const last = this.ticks[this.ticks.length - 1];
    return { yesPrice: last.yesPrice, noPrice: last.noPrice };
  }

  getTickCount(): number {
    return this.ticks.length;
  }
}

export const volatilityTracker = new VolatilityTracker();
