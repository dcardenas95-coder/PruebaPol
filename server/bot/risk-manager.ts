import { storage } from "../storage";
import type { BotConfig } from "@shared/schema";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
}

export class RiskManager {
  private consecutiveLosses = 0;
  private dailyPnl = 0;

  async checkPreTrade(config: BotConfig, orderValue: number): Promise<RiskCheck> {
    if (config.killSwitchActive) {
      return { allowed: false, reason: "Kill switch is active" };
    }

    if (!config.isActive) {
      return { allowed: false, reason: "Bot is not active" };
    }

    if (config.currentState === "CLOSE_ONLY" || config.currentState === "DONE" || config.currentState === "STOPPED") {
      return { allowed: false, reason: `Cannot open new positions in state: ${config.currentState}` };
    }

    const positions = await storage.getPositions();
    const totalExposure = positions.reduce((sum, p) => sum + p.size * p.avgEntryPrice, 0);

    if (totalExposure + orderValue > config.maxNetExposure) {
      return { allowed: false, reason: `Max net exposure exceeded: ${totalExposure + orderValue} > ${config.maxNetExposure}` };
    }

    if (Math.abs(this.dailyPnl) >= config.maxDailyLoss && this.dailyPnl < 0) {
      return { allowed: false, reason: `Max daily loss reached: ${this.dailyPnl}` };
    }

    if (this.consecutiveLosses >= config.maxConsecutiveLosses) {
      return { allowed: false, reason: `Max consecutive losses reached: ${this.consecutiveLosses}` };
    }

    return { allowed: true };
  }

  recordTradeResult(pnl: number) {
    this.dailyPnl += pnl;
    if (pnl < 0) {
      this.consecutiveLosses++;
    } else {
      this.consecutiveLosses = 0;
    }
  }

  getConsecutiveLosses(): number {
    return this.consecutiveLosses;
  }

  getDailyPnl(): number {
    return this.dailyPnl;
  }

  resetDaily() {
    this.dailyPnl = 0;
    this.consecutiveLosses = 0;
  }
}
