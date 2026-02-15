import { storage } from "../storage";
import type { Position, MarketData } from "@shared/schema";

export interface StopLossConfig {
  enabled: boolean;
  maxLossPercent: number;
  trailingEnabled: boolean;
  trailingPercent: number;
  timeDecayEnabled: boolean;
}

export interface StopLossResult {
  triggered: boolean;
  reason?: string;
  positionId: string;
  marketId: string;
  entryPrice: number;
  currentPrice: number;
  lossPct: number;
  suggestedExitPrice: number;
}

const DEFAULT_CONFIG: StopLossConfig = {
  enabled: true,
  maxLossPercent: 0.15,
  trailingEnabled: true,
  trailingPercent: 0.10,
  timeDecayEnabled: true,
};

export class StopLossManager {
  private config: StopLossConfig = { ...DEFAULT_CONFIG };
  private highWaterMarks: Map<string, number> = new Map();

  getConfig(): StopLossConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<StopLossConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  updateHighWaterMark(positionKey: string, currentPrice: number, side: string = "BUY"): void {
    const existing = this.highWaterMarks.get(positionKey) || (side === "BUY" ? 0 : Infinity);
    if (side === "BUY") {
      if (currentPrice > existing) {
        this.highWaterMarks.set(positionKey, currentPrice);
      }
    } else {
      if (currentPrice < existing) {
        this.highWaterMarks.set(positionKey, currentPrice);
      }
    }
  }

  getHighWaterMark(positionKey: string): number | undefined {
    return this.highWaterMarks.get(positionKey);
  }

  clearHighWaterMark(positionKey: string): void {
    this.highWaterMarks.delete(positionKey);
  }

  clearAll(): void {
    this.highWaterMarks.clear();
  }

  checkStopLoss(
    position: Position,
    marketData: MarketData,
    remainingMs: number,
    marketDurationMs: number,
  ): StopLossResult {
    const posKey = `${position.marketId}-${position.side}`;

    const currentPrice = position.side === "BUY" ? marketData.bestBid : marketData.bestAsk;
    const entryPrice = position.avgEntryPrice;
    const entryValue = position.size * entryPrice;
    const currentValue = position.size * currentPrice;

    const isLoss = position.side === "BUY"
      ? currentPrice < entryPrice
      : currentPrice > entryPrice;

    const lossPct = isLoss
      ? Math.abs(entryValue - currentValue) / entryValue
      : 0;

    const baseResult: StopLossResult = {
      triggered: false,
      positionId: position.id,
      marketId: position.marketId,
      entryPrice,
      currentPrice,
      lossPct: parseFloat(lossPct.toFixed(4)),
      suggestedExitPrice: position.side === "BUY"
        ? Math.max(0.01, marketData.bestBid - 0.005)
        : Math.min(0.99, marketData.bestAsk + 0.005),
    };

    if (!this.config.enabled) return baseResult;

    this.updateHighWaterMark(posKey, currentPrice, position.side);

    if (lossPct >= this.config.maxLossPercent) {
      return {
        ...baseResult,
        triggered: true,
        reason: `Fixed stop-loss: ${(lossPct * 100).toFixed(1)}% loss >= ${(this.config.maxLossPercent * 100).toFixed(1)}% limit`,
      };
    }

    if (this.config.timeDecayEnabled && marketDurationMs > 0) {
      const timeProgress = 1 - (remainingMs / marketDurationMs);
      const adjustedStop = this.config.maxLossPercent * (1 - timeProgress * 0.5);

      if (lossPct >= adjustedStop && isLoss) {
        return {
          ...baseResult,
          triggered: true,
          reason: `Time-decay stop: ${(lossPct * 100).toFixed(1)}% loss >= adjusted ${(adjustedStop * 100).toFixed(1)}% limit (${(timeProgress * 100).toFixed(0)}% of market elapsed)`,
        };
      }
    }

    if (this.config.trailingEnabled) {
      const hwm = this.highWaterMarks.get(posKey);
      if (hwm && hwm > entryPrice) {
        const dropFromHigh = position.side === "BUY"
          ? (hwm - currentPrice) / hwm
          : (currentPrice - hwm) / hwm;

        if (dropFromHigh >= this.config.trailingPercent && dropFromHigh > 0) {
          return {
            ...baseResult,
            triggered: true,
            reason: `Trailing stop: ${(dropFromHigh * 100).toFixed(1)}% drop from high ($${hwm.toFixed(4)}) >= ${(this.config.trailingPercent * 100).toFixed(1)}% trailing limit`,
          };
        }
      }
    }

    return baseResult;
  }

  async checkAllPositions(
    marketData: MarketData,
    remainingMs: number,
    marketDurationMs: number,
  ): Promise<StopLossResult[]> {
    if (!this.config.enabled) return [];

    const positions = await storage.getPositions();
    const openPositions = positions.filter(p => p.size > 0);
    const results: StopLossResult[] = [];

    for (const pos of openPositions) {
      const result = this.checkStopLoss(pos, marketData, remainingMs, marketDurationMs);
      if (result.triggered) {
        results.push(result);
      }
    }

    return results;
  }

  getStatus(): {
    enabled: boolean;
    config: StopLossConfig;
    trackedPositions: number;
    highWaterMarks: Record<string, number>;
  } {
    const hwmObj: Record<string, number> = {};
    this.highWaterMarks.forEach((v, k) => { hwmObj[k] = v; });

    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      trackedPositions: this.highWaterMarks.size,
      highWaterMarks: hwmObj,
    };
  }
}

export const stopLossManager = new StopLossManager();
