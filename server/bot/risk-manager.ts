import { storage } from "../storage";
import type { BotConfig } from "@shared/schema";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
  warnings?: string[];
}

export class RiskManager {
  private consecutiveLosses = 0;
  private dailyPnl = 0;
  private lastProximityAlert = 0;
  private readonly ALERT_COOLDOWN = 60_000;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const pnlRecords = await storage.getPnlRecords();
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      this.dailyPnl = 0;
      for (const rec of pnlRecords) {
        const recDate = new Date(rec.createdAt);
        if (recDate >= todayStart) {
          this.dailyPnl += rec.realizedPnl;
        }
      }

      this.consecutiveLosses = 0;
      const sortedRecords = [...pnlRecords].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      for (const rec of sortedRecords) {
        if (rec.realizedPnl < 0) {
          this.consecutiveLosses++;
        } else {
          break;
        }
      }

      this.initialized = true;
      await storage.createEvent({
        type: "INFO",
        message: `Risk Manager restored: dailyPnl=$${this.dailyPnl.toFixed(4)}, consecutiveLosses=${this.consecutiveLosses}`,
        data: { dailyPnl: this.dailyPnl, consecutiveLosses: this.consecutiveLosses },
        level: "info",
      });
    } catch (err) {
      this.initialized = true;
    }
  }

  async checkPreTrade(config: BotConfig, orderValue: number): Promise<RiskCheck> {
    await this.initialize();

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

    const warnings: string[] = [];
    const exposureRatio = (totalExposure + orderValue) / config.maxNetExposure;
    const lossRatio = config.maxDailyLoss > 0 ? Math.abs(this.dailyPnl) / config.maxDailyLoss : 0;
    const lossCountRatio = config.maxConsecutiveLosses > 0 ? this.consecutiveLosses / config.maxConsecutiveLosses : 0;

    if (exposureRatio >= 0.8) {
      warnings.push(`Exposure at ${(exposureRatio * 100).toFixed(0)}% of limit`);
    }
    if (lossRatio >= 0.7 && this.dailyPnl < 0) {
      warnings.push(`Daily loss at ${(lossRatio * 100).toFixed(0)}% of limit`);
    }
    if (lossCountRatio >= 0.67) {
      warnings.push(`Consecutive losses at ${this.consecutiveLosses}/${config.maxConsecutiveLosses}`);
    }

    if (warnings.length > 0) {
      await this.emitProximityAlert(warnings);
    }

    return { allowed: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  private async emitProximityAlert(warnings: string[]): Promise<void> {
    const now = Date.now();
    if (now - this.lastProximityAlert < this.ALERT_COOLDOWN) return;
    this.lastProximityAlert = now;

    await storage.createEvent({
      type: "RISK_ALERT",
      message: `Risk proximity warning: ${warnings.join("; ")}`,
      data: { warnings, dailyPnl: this.dailyPnl, consecutiveLosses: this.consecutiveLosses },
      level: "warn",
    });
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
