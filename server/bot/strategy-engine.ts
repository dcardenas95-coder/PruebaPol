import { storage } from "../storage";
import { MarketDataModule } from "./market-data";
import { OrderManager } from "./order-manager";
import { RiskManager } from "./risk-manager";
import type { BotConfig, MarketData, BotStatus } from "@shared/schema";
import { format } from "date-fns";

type BotState = "MAKING" | "UNWIND" | "CLOSE_ONLY" | "HEDGE_LOCK" | "DONE" | "STOPPED";

export class StrategyEngine {
  private marketData: MarketDataModule;
  private orderManager: OrderManager;
  private riskManager: RiskManager;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTime: number = Date.now();
  private cycleCount = 0;
  private marketCycleStart = 0;
  private readonly MARKET_DURATION = 5 * 60 * 1000;

  constructor() {
    this.marketData = new MarketDataModule();
    this.orderManager = new OrderManager();
    this.riskManager = new RiskManager();
  }

  async start(): Promise<void> {
    const config = await storage.getBotConfig();
    if (!config) return;

    if (this.interval) {
      clearInterval(this.interval);
    }

    this.startTime = Date.now();
    this.marketCycleStart = Date.now();

    if (config.currentMarketId) {
      this.marketData.setTokenId(config.currentMarketId);
    }

    await storage.updateBotConfig({ isActive: true, currentState: "MAKING" });

    const dataSource = this.marketData.isUsingLiveData() ? "LIVE Polymarket data" : "simulated data";
    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `Bot started - entering MAKING state (${dataSource})`,
      data: { state: "MAKING", isPaperTrading: config.isPaperTrading, dataSource },
      level: "info",
    });

    this.interval = setInterval(() => this.tick(), 3000);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    await this.orderManager.cancelAllOrders();
    await storage.updateBotConfig({ isActive: false, currentState: "STOPPED" });

    await storage.createEvent({
      type: "STATE_CHANGE",
      message: "Bot stopped",
      data: { state: "STOPPED" },
      level: "info",
    });
  }

  async killSwitch(): Promise<void> {
    await this.stop();
    await storage.updateBotConfig({ killSwitchActive: true, isActive: false, currentState: "STOPPED" });

    await storage.createEvent({
      type: "KILL_SWITCH",
      message: "Kill switch activated - all trading halted",
      data: {},
      level: "error",
    });
  }

  async deactivateKillSwitch(): Promise<void> {
    await storage.updateBotConfig({ killSwitchActive: false });

    await storage.createEvent({
      type: "KILL_SWITCH",
      message: "Kill switch deactivated",
      data: {},
      level: "warn",
    });
  }

  private async tick(): Promise<void> {
    try {
      const config = await storage.getBotConfig();
      if (!config || !config.isActive || config.killSwitchActive) return;

      const data = await this.marketData.getData();
      const elapsed = Date.now() - this.marketCycleStart;
      const remaining = this.MARKET_DURATION - elapsed;

      const newState = this.calculateState(config.currentState as BotState, remaining);
      if (newState !== config.currentState) {
        await this.transitionState(config.currentState as BotState, newState);
      }

      const activeOrders = await this.orderManager.getActiveOrders();
      for (const order of activeOrders) {
        if (config.isPaperTrading) {
          const result = await this.orderManager.simulateFill(order.id);
          if (result.filled && result.pnl !== 0) {
            this.riskManager.recordTradeResult(result.pnl);
            await this.updateDailyPnl(result.pnl, result.pnl > 0);
          }
        }
      }

      if (this.riskManager.getConsecutiveLosses() >= config.maxConsecutiveLosses) {
        await storage.createEvent({
          type: "RISK_ALERT",
          message: `Max consecutive losses (${config.maxConsecutiveLosses}) reached - stopping bot`,
          data: { consecutiveLosses: this.riskManager.getConsecutiveLosses() },
          level: "error",
        });
        await this.stop();
        return;
      }

      if (this.riskManager.getDailyPnl() <= -config.maxDailyLoss) {
        await storage.createEvent({
          type: "RISK_ALERT",
          message: `Daily loss limit ($${config.maxDailyLoss}) reached - stopping bot`,
          data: { dailyPnl: this.riskManager.getDailyPnl() },
          level: "error",
        });
        await this.stop();
        return;
      }

      if (newState === "MAKING") {
        await this.executeStrategy(config, data);
      } else if (newState === "UNWIND") {
        await this.executeUnwind(config, data);
      } else if (newState === "HEDGE_LOCK") {
        await this.executeHedgeLock(config, data);
      } else if (newState === "DONE") {
        this.marketCycleStart = Date.now();
        this.cycleCount++;
        await storage.updateBotConfig({ currentState: "MAKING" });
        await storage.createEvent({
          type: "STATE_CHANGE",
          message: `Market cycle ${this.cycleCount} completed, starting new cycle`,
          data: { cycle: this.cycleCount },
          level: "info",
        });
      }
    } catch (error: any) {
      await storage.createEvent({
        type: "ERROR",
        message: `Tick error: ${error.message}`,
        data: { stack: error.stack?.slice(0, 500) },
        level: "error",
      });
    }
  }

  private calculateState(current: BotState, remainingMs: number): BotState {
    if (current === "STOPPED" || current === "DONE") return current;
    if (remainingMs <= 45000) return "HEDGE_LOCK";
    if (remainingMs <= 60000) return "CLOSE_ONLY";
    if (remainingMs <= 120000) return "UNWIND";
    return "MAKING";
  }

  private async transitionState(from: BotState, to: BotState): Promise<void> {
    await storage.updateBotConfig({ currentState: to });
    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `State transition: ${from} -> ${to}`,
      data: { from, to },
      level: "info",
    });

    if (to === "CLOSE_ONLY") {
      await this.orderManager.cancelAllOrders();
    }
  }

  private async executeStrategy(config: BotConfig, data: MarketData): Promise<void> {
    if (!this.marketData.isSpreadSufficient(config.minSpread)) {
      return;
    }

    if (!this.marketData.isMarketActive()) {
      return;
    }

    const riskCheck = await this.riskManager.checkPreTrade(config, config.orderSize * data.bestBid);
    if (!riskCheck.allowed) {
      return;
    }

    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length >= 4) return;

    const bestSide = this.marketData.getBestSide();
    if (!bestSide) return;

    const marketId = config.currentMarketId || "btc-5min-sim";

    if (bestSide === "BUY") {
      await this.orderManager.placeOrder({
        marketId,
        side: "BUY",
        price: data.bestBid,
        size: config.orderSize,
        isPaperTrade: config.isPaperTrading,
      });
    }

    const positions = await storage.getPositions();
    const buyPositions = positions.filter(p => p.side === "BUY" && p.size > 0);
    for (const pos of buyPositions) {
      const exitPrice = this.marketData.getExitPrice(pos.avgEntryPrice, config.targetProfitMin, config.targetProfitMax);
      if (data.bestAsk >= exitPrice) {
        await this.orderManager.placeOrder({
          marketId,
          side: "SELL",
          price: exitPrice,
          size: Math.min(pos.size, config.orderSize),
          isPaperTrade: config.isPaperTrading,
        });
      }
    }
  }

  private async executeUnwind(config: BotConfig, data: MarketData): Promise<void> {
    const positions = await storage.getPositions();
    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length >= 2) return;

    for (const pos of positions) {
      if (pos.size > 0) {
        const exitPrice = pos.side === "BUY"
          ? data.bestAsk - 0.01
          : data.bestBid + 0.01;

        await this.orderManager.placeOrder({
          marketId: pos.marketId,
          side: pos.side === "BUY" ? "SELL" : "BUY",
          price: Math.max(0.01, exitPrice),
          size: parseFloat((pos.size * 0.5).toFixed(2)),
          isPaperTrade: config.isPaperTrading,
        });
      }
    }
  }

  private async executeHedgeLock(config: BotConfig, data: MarketData): Promise<void> {
    const positions = await storage.getPositions();
    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length >= 2) return;

    for (const pos of positions) {
      if (pos.size > 0) {
        const hedgePrice = pos.side === "BUY"
          ? data.bestAsk - 0.005
          : data.bestBid + 0.005;

        await this.orderManager.placeOrder({
          marketId: pos.marketId,
          side: pos.side === "BUY" ? "SELL" : "BUY",
          price: Math.max(0.01, hedgePrice),
          size: pos.size,
          isPaperTrade: config.isPaperTrading,
        });
      }
    }
  }

  private async updateDailyPnl(pnl: number, isWin: boolean): Promise<void> {
    const today = format(new Date(), "yyyy-MM-dd");
    const existing = await storage.getPnlByDate(today);

    if (existing) {
      await storage.upsertPnlRecord({
        date: today,
        realizedPnl: parseFloat((existing.realizedPnl + pnl).toFixed(4)),
        unrealizedPnl: existing.unrealizedPnl,
        totalPnl: parseFloat((existing.totalPnl + pnl).toFixed(4)),
        tradesCount: existing.tradesCount + 1,
        winCount: existing.winCount + (isWin ? 1 : 0),
        lossCount: existing.lossCount + (isWin ? 0 : 1),
        volume: parseFloat((existing.volume + Math.abs(pnl)).toFixed(4)),
        fees: existing.fees,
      });
    } else {
      await storage.upsertPnlRecord({
        date: today,
        realizedPnl: pnl,
        unrealizedPnl: 0,
        totalPnl: pnl,
        tradesCount: 1,
        winCount: isWin ? 1 : 0,
        lossCount: isWin ? 0 : 1,
        volume: Math.abs(pnl),
        fees: 0,
      });
    }
  }

  getMarketDataModule(): MarketDataModule {
    return this.marketData;
  }

  async getStatus(): Promise<BotStatus> {
    const config = await storage.getBotConfig();
    const activeOrders = await this.orderManager.getActiveOrders();
    const positions = await storage.getPositions();

    if (config?.currentMarketId && this.marketData.getTokenId() !== config.currentMarketId) {
      this.marketData.setTokenId(config.currentMarketId);
    }

    return {
      config: config || {
        id: "",
        isActive: false,
        isPaperTrading: true,
        currentState: "STOPPED",
        minSpread: 0.03,
        targetProfitMin: 0.03,
        targetProfitMax: 0.05,
        maxNetExposure: 100,
        maxDailyLoss: 50,
        maxConsecutiveLosses: 3,
        orderSize: 10,
        killSwitchActive: false,
        currentMarketId: null,
        currentMarketSlug: null,
        updatedAt: new Date(),
      },
      marketData: this.marketData.getLastData(),
      activeOrders: activeOrders.length,
      openPositions: positions.length,
      dailyPnl: this.riskManager.getDailyPnl(),
      consecutiveLosses: this.riskManager.getConsecutiveLosses(),
      uptime: Date.now() - this.startTime,
      isLiveData: this.marketData.isUsingLiveData(),
      currentTokenId: this.marketData.getTokenId(),
    };
  }
}

export const strategyEngine = new StrategyEngine();
