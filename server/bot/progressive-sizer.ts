import { storage } from "../storage";
import { format } from "date-fns";

export interface SizerConfig {
  enabled: boolean;
  level1MaxTrades: number;
  level1Size: number;
  level2MaxTrades: number;
  level2Size: number;
  level2MinWinRate: number;
  level3Size: number;
  level3HighSize: number;
  level3MinWinRate: number;
  level3HighWinRate: number;
  consecutiveLossReduction: boolean;
  consecutiveLossThreshold: number;
  consecutiveWinBonus: boolean;
  consecutiveWinThreshold: number;
  consecutiveWinMultiplier: number;
  maxSize: number;
}

export interface SizerLevel {
  level: number;
  name: string;
  size: number;
  reason: string;
}

const DEFAULT_CONFIG: SizerConfig = {
  enabled: true,
  level1MaxTrades: 20,
  level1Size: 1,
  level2MaxTrades: 50,
  level2Size: 5,
  level2MinWinRate: 0.55,
  level3Size: 10,
  level3HighSize: 20,
  level3MinWinRate: 0.55,
  level3HighWinRate: 0.65,
  consecutiveLossReduction: true,
  consecutiveLossThreshold: 2,
  consecutiveWinBonus: true,
  consecutiveWinThreshold: 5,
  consecutiveWinMultiplier: 1.25,
  maxSize: 20,
};

export class ProgressiveSizer {
  private config: SizerConfig = { ...DEFAULT_CONFIG };
  private cachedStats: { totalTrades: number; winRate: number; consecutiveWins: number; consecutiveLosses: number } | null = null;
  private lastStatsRefresh = 0;
  private readonly STATS_CACHE_TTL = 30_000;

  getConfig(): SizerConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<SizerConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  async getStats(): Promise<{ totalTrades: number; winRate: number; consecutiveWins: number; consecutiveLosses: number }> {
    const now = Date.now();
    if (this.cachedStats && now - this.lastStatsRefresh < this.STATS_CACHE_TTL) {
      return this.cachedStats;
    }

    try {
      const pnlRecords = await storage.getPnlRecords();
      let totalTrades = 0;
      let totalWins = 0;

      for (const record of pnlRecords) {
        totalTrades += record.tradesCount;
        totalWins += record.winCount;
      }

      const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;

      const recentEvents = await storage.getEvents(50);
      const fillEvents = recentEvents.filter(e => e.type === "ORDER_FILLED" || e.type === "PNL_UPDATE");
      let consecutiveWins = 0;
      let consecutiveLosses = 0;

      for (const evt of fillEvents) {
        const data = evt.data as any;
        if (data?.pnl !== undefined) {
          if (data.pnl > 0) {
            if (consecutiveLosses > 0) break;
            consecutiveWins++;
          } else if (data.pnl < 0) {
            if (consecutiveWins > 0) break;
            consecutiveLosses++;
          }
        }
      }

      this.cachedStats = { totalTrades, winRate, consecutiveWins, consecutiveLosses };
      this.lastStatsRefresh = now;
      return this.cachedStats;
    } catch {
      return { totalTrades: 0, winRate: 0, consecutiveWins: 0, consecutiveLosses: 0 };
    }
  }

  async getOrderSize(baseSize: number): Promise<SizerLevel> {
    if (!this.config.enabled) {
      return { level: 0, name: "Disabled", size: baseSize, reason: "Progressive sizer disabled, using config orderSize" };
    }

    const stats = await this.getStats();
    let size: number;
    let level: number;
    let name: string;
    let reason: string;

    if (stats.totalTrades < this.config.level1MaxTrades) {
      level = 1;
      name = "Validation";
      size = this.config.level1Size;
      reason = `Level 1 (${stats.totalTrades}/${this.config.level1MaxTrades} trades): $${size} per trade`;
    } else if (stats.totalTrades < this.config.level2MaxTrades) {
      level = 2;
      name = "Confirmation";
      if (stats.winRate < this.config.level2MinWinRate) {
        size = this.config.level1Size;
        reason = `Level 2 but winRate ${(stats.winRate * 100).toFixed(1)}% < ${(this.config.level2MinWinRate * 100).toFixed(0)}%: staying at $${size}`;
      } else {
        size = this.config.level2Size;
        reason = `Level 2 (${stats.totalTrades}/${this.config.level2MaxTrades} trades, WR ${(stats.winRate * 100).toFixed(1)}%): $${size} per trade`;
      }
    } else {
      level = 3;
      name = "Operation";
      if (stats.winRate < this.config.level3MinWinRate) {
        size = this.config.level2Size;
        reason = `Level 3 but winRate ${(stats.winRate * 100).toFixed(1)}% < ${(this.config.level3MinWinRate * 100).toFixed(0)}%: reduced to $${size}`;
      } else if (stats.winRate >= this.config.level3HighWinRate) {
        size = this.config.level3HighSize;
        reason = `Level 3 HIGH (WR ${(stats.winRate * 100).toFixed(1)}% >= ${(this.config.level3HighWinRate * 100).toFixed(0)}%): $${size} per trade`;
      } else {
        size = this.config.level3Size;
        reason = `Level 3 (WR ${(stats.winRate * 100).toFixed(1)}%): $${size} per trade`;
      }
    }

    if (this.config.consecutiveLossReduction && stats.consecutiveLosses >= this.config.consecutiveLossThreshold) {
      const reduction = Math.pow(0.5, Math.floor(stats.consecutiveLosses / this.config.consecutiveLossThreshold));
      const reduced = Math.max(this.config.level1Size, size * reduction);
      reason += ` | Reduced by ${stats.consecutiveLosses} consecutive losses: $${reduced.toFixed(2)}`;
      size = reduced;
    }

    if (this.config.consecutiveWinBonus && stats.consecutiveWins >= this.config.consecutiveWinThreshold) {
      const bonus = Math.min(size * this.config.consecutiveWinMultiplier, this.config.maxSize);
      reason += ` | Bonus for ${stats.consecutiveWins} consecutive wins: $${bonus.toFixed(2)}`;
      size = bonus;
    }

    size = Math.min(size, this.config.maxSize);
    size = Math.max(this.config.level1Size, size);

    return {
      level,
      name,
      size: parseFloat(size.toFixed(2)),
      reason,
    };
  }

  invalidateCache(): void {
    this.cachedStats = null;
    this.lastStatsRefresh = 0;
  }

  async getStatus(): Promise<{
    enabled: boolean;
    config: SizerConfig;
    currentLevel: SizerLevel;
    stats: { totalTrades: number; winRate: number; consecutiveWins: number; consecutiveLosses: number };
  }> {
    const stats = await this.getStats();
    const currentLevel = await this.getOrderSize(10);

    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      currentLevel,
      stats,
    };
  }
}

export const progressiveSizer = new ProgressiveSizer();
