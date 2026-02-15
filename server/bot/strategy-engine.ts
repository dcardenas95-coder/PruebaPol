import { storage } from "../storage";
import { MarketDataModule } from "./market-data";
import { OrderManager } from "./order-manager";
import { RiskManager } from "./risk-manager";
import { liveTradingClient } from "./live-trading-client";
import { polymarketWs } from "./polymarket-ws";
import { apiRateLimiter } from "./rate-limiter";
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
  private wsSetup = false;
  private lastDailyReset = new Date().toDateString();

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

    if (!config.isPaperTrading) {
      if (!config.currentMarketId) {
        await storage.createEvent({
          type: "ERROR",
          message: "Cannot start live trading without a market selected",
          data: {},
          level: "error",
        });
        return;
      }

      if (!liveTradingClient.isInitialized()) {
        const result = await liveTradingClient.initialize();
        if (!result.success) {
          await storage.createEvent({
            type: "ERROR",
            message: `Cannot start live trading: ${result.error}`,
            data: { error: result.error },
            level: "error",
          });
          return;
        }
      }

      await storage.createEvent({
        type: "INFO",
        message: "LIVE TRADING MODE - Real orders will be placed on Polymarket",
        data: { wallet: liveTradingClient.getWalletAddress() },
        level: "warn",
      });

      await this.orderManager.reconcileOnStartup();
    }

    await storage.updateBotConfig({ isActive: true, currentState: "MAKING" });

    const mode = config.isPaperTrading ? "PAPER" : "LIVE";
    const dataSource = this.marketData.isUsingLiveData() ? "LIVE Polymarket data" : "simulated data";
    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `Bot started [${mode}] - entering MAKING state (${dataSource})`,
      data: { state: "MAKING", isPaperTrading: config.isPaperTrading, dataSource, mode },
      level: "info",
    });

    this.setupWebSocket(config);

    this.interval = setInterval(() => this.tick(), 3000);
  }

  private setupWebSocket(config: BotConfig): void {
    if (this.wsSetup) return;

    if (config.currentMarketId) {
      polymarketWs.connectMarket([config.currentMarketId]);
      this.marketData.setWsDataSource(polymarketWs);

      polymarketWs.onMarketData((data) => {
        this.marketData.updateFromWs(data);
      });
    }

    if (!config.isPaperTrading && liveTradingClient.isInitialized()) {
      const creds = liveTradingClient.getApiCreds();
      if (creds && config.currentMarketId) {
        polymarketWs.connectUser([config.currentMarketId], creds);

        polymarketWs.onFill(async (fillData) => {
          try {
            await this.orderManager.handleWsFill(fillData);
          } catch (err: any) {
            console.error("[StrategyEngine] WS fill handler error:", err.message);
          }
        });
      }
    }

    this.wsSetup = true;
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    polymarketWs.disconnectAll();
    this.wsSetup = false;
    this.orderManager.clearAllTimeouts();

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
      const today = new Date().toDateString();
      if (today !== this.lastDailyReset) {
        this.riskManager.resetDaily();
        this.lastDailyReset = today;
        await storage.createEvent({
          type: "INFO",
          message: "Daily risk counters reset",
          data: {},
          level: "info",
        });
      }

      const config = await storage.getBotConfig();
      if (!config || !config.isActive || config.killSwitchActive) return;

      if (apiRateLimiter.isCircuitOpen()) {
        return;
      }

      const rateCheck = await apiRateLimiter.canProceed();
      if (!rateCheck.allowed) {
        return;
      }

      apiRateLimiter.recordRequest();
      const data = await this.marketData.getData();
      const elapsed = Date.now() - this.marketCycleStart;
      const remaining = this.MARKET_DURATION - elapsed;

      const newState = this.calculateState(config.currentState as BotState, remaining);
      if (newState !== config.currentState) {
        await this.transitionState(config.currentState as BotState, newState);
      }

      if (config.isPaperTrading) {
        const activeOrders = await this.orderManager.getActiveOrders();
        for (const order of activeOrders) {
          const result = await this.orderManager.simulateFill(order.id);
          if (result.filled && result.pnl !== 0) {
            this.riskManager.recordTradeResult(result.pnl);
            await this.updateDailyPnl(result.pnl, result.pnl > 0);
          }
        }
      } else {
        const liveResults = await this.orderManager.pollLiveOrderStatuses();
        for (const result of liveResults) {
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

    if (!config.isPaperTrading && liveTradingClient.isInitialized() && config.currentMarketId) {
      try {
        const balanceRateCheck = await apiRateLimiter.canProceed();
        if (!balanceRateCheck.allowed) {
          return;
        }
        const balance = await liveTradingClient.getBalanceAllowance(config.currentMarketId);
        apiRateLimiter.recordSuccess();
        const usdcBalance = parseFloat(balance?.balance || "0");
        const orderCost = config.orderSize * data.bestBid;
        if (usdcBalance < orderCost) {
          await storage.createEvent({
            type: "RISK_ALERT",
            message: `Insufficient balance: $${usdcBalance.toFixed(2)} < order cost $${orderCost.toFixed(2)}`,
            data: { balance: usdcBalance, orderCost },
            level: "warn",
          });
          return;
        }
      } catch (error: any) {
        await apiRateLimiter.recordError(error.message);
        console.error("[Strategy] Balance check failed:", error.message);
        return;
      }
    }

    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length >= 4) return;

    const bestSide = this.marketData.getBestSide();
    if (!bestSide) return;

    const tokenId = config.currentMarketId || "";
    const marketId = config.currentMarketSlug || config.currentMarketId || "unknown";
    const negRisk = config.currentMarketNegRisk ?? false;
    const tickSize = config.currentMarketTickSize ?? "0.01";

    if (!tokenId || tokenId.includes("sim")) {
      await storage.createEvent({
        type: "ERROR",
        message: "Cannot place live orders: no real market token selected. Select a market in Configuration first.",
        data: { marketId, tokenId },
        level: "error",
      });
      return;
    }

    if (bestSide === "BUY") {
      await this.orderManager.placeOrder({
        marketId,
        tokenId,
        side: "BUY",
        price: data.bestBid,
        size: config.orderSize,
        isPaperTrade: config.isPaperTrading,
        negRisk,
        tickSize,
      });
    }

    const positions = await storage.getPositions();
    const buyPositions = positions.filter(p => p.side === "BUY" && p.size > 0);
    for (const pos of buyPositions) {
      const exitPrice = this.marketData.getExitPrice(pos.avgEntryPrice, config.targetProfitMin, config.targetProfitMax);
      if (data.bestAsk >= exitPrice) {
        await this.orderManager.placeOrder({
          marketId,
          tokenId,
          side: "SELL",
          price: exitPrice,
          size: Math.min(pos.size, config.orderSize),
          isPaperTrade: config.isPaperTrading,
          negRisk,
          tickSize,
        });
      }
    }
  }

  private async executeUnwind(config: BotConfig, data: MarketData): Promise<void> {
    const positions = await storage.getPositions();
    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length >= 2) return;

    const negRisk = config.currentMarketNegRisk ?? false;
    const tickSize = config.currentMarketTickSize ?? "0.01";

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
          negRisk,
          tickSize,
        });
      }
    }
  }

  private async executeHedgeLock(config: BotConfig, data: MarketData): Promise<void> {
    const positions = await storage.getPositions();
    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length >= 2) return;

    const tokenId = config.currentMarketId || "";
    const negRisk = config.currentMarketNegRisk ?? false;
    const tickSize = config.currentMarketTickSize ?? "0.01";

    if (!tokenId || tokenId.includes("sim")) {
      return;
    }

    for (const pos of positions) {
      if (pos.size > 0) {
        const hedgePrice = pos.side === "BUY"
          ? data.bestAsk - 0.005
          : data.bestBid + 0.005;

        await this.orderManager.placeOrder({
          marketId: pos.marketId,
          tokenId,
          side: pos.side === "BUY" ? "SELL" : "BUY",
          price: Math.max(0.01, hedgePrice),
          size: pos.size,
          isPaperTrade: config.isPaperTrading,
          negRisk,
          tickSize,
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

  getOrderManager(): OrderManager {
    return this.orderManager;
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
        currentMarketNegRisk: false,
        currentMarketTickSize: "0.01",
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
      wsHealth: polymarketWs.getHealth(),
    };
  }
}

export const strategyEngine = new StrategyEngine();
