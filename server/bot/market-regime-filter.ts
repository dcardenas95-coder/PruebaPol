import { binanceOracle } from "./binance-oracle";
import type { MarketData } from "@shared/schema";

export type MarketRegime = "TRENDING" | "RANGING" | "VOLATILE" | "DEAD";

export interface RegimeResult {
  regime: MarketRegime;
  tradeable: boolean;
  reason?: string;
  volatility: number;
  depth: number;
  spread: number;
}

export interface RegimeConfig {
  enabled: boolean;
  minDepth: number;
  maxVolatility: number;
  minVolatility: number;
  maxSpread: number;
}

const DEFAULT_CONFIG: RegimeConfig = {
  enabled: true,
  minDepth: 50,
  maxVolatility: 0.5,
  minVolatility: 0.1,
  maxSpread: 0.15,
};

export class MarketRegimeFilter {
  private config: RegimeConfig = { ...DEFAULT_CONFIG };

  getConfig(): RegimeConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<RegimeConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getRegime(marketData: MarketData): RegimeResult {
    const vol = binanceOracle.getVolatility(5);
    const depth = Math.min(marketData.bidDepth, marketData.askDepth);
    const spread = marketData.spread;

    if (!this.config.enabled) {
      return { regime: "TRENDING", tradeable: true, volatility: vol, depth, spread, reason: "Filter disabled" };
    }

    if (depth < this.config.minDepth) {
      return {
        regime: "DEAD",
        tradeable: false,
        reason: `Insufficient liquidity: depth $${depth.toFixed(0)} < $${this.config.minDepth} minimum`,
        volatility: vol,
        depth,
        spread,
      };
    }

    if (spread > this.config.maxSpread) {
      return {
        regime: "DEAD",
        tradeable: false,
        reason: `Spread too wide: ${(spread * 100).toFixed(1)}% > ${(this.config.maxSpread * 100).toFixed(1)}% maximum`,
        volatility: vol,
        depth,
        spread,
      };
    }

    if (vol > this.config.maxVolatility) {
      return {
        regime: "VOLATILE",
        tradeable: false,
        reason: `Volatility too high: ${vol.toFixed(3)}% > ${this.config.maxVolatility}% threshold`,
        volatility: vol,
        depth,
        spread,
      };
    }

    if (vol > this.config.minVolatility && vol <= this.config.maxVolatility) {
      return {
        regime: "TRENDING",
        tradeable: true,
        volatility: vol,
        depth,
        spread,
      };
    }

    if (vol <= this.config.minVolatility) {
      return {
        regime: "RANGING",
        tradeable: false,
        reason: `Market flat: volatility ${vol.toFixed(3)}% < ${this.config.minVolatility}% minimum`,
        volatility: vol,
        depth,
        spread,
      };
    }

    return { regime: "RANGING", tradeable: true, volatility: vol, depth, spread };
  }

  getStatus(marketData: MarketData | null): {
    enabled: boolean;
    config: RegimeConfig;
    currentRegime: RegimeResult | null;
  } {
    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      currentRegime: marketData ? this.getRegime(marketData) : null,
    };
  }
}

export const marketRegimeFilter = new MarketRegimeFilter();
