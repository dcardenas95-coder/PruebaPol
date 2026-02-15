import { storage } from "../storage";
import { MarketDataModule } from "./market-data";
import { OrderManager } from "./order-manager";
import { RiskManager } from "./risk-manager";
import { liveTradingClient } from "./live-trading-client";
import { polymarketWs } from "./polymarket-ws";
import { apiRateLimiter } from "./rate-limiter";
import type { BotConfig, MarketData, BotStatus, Order } from "@shared/schema";
import { format } from "date-fns";
import { fetchCurrentIntervalMarket, type AssetType, type IntervalType } from "../strategies/dualEntry5m/market-5m-discovery";

type BotState = "MAKING" | "UNWIND" | "CLOSE_ONLY" | "HEDGE_LOCK" | "DONE" | "STOPPED";

export class StrategyEngine {
  private marketData: MarketDataModule;
  private orderManager: OrderManager;
  private riskManager: RiskManager;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTime: number = Date.now();
  private cycleCount = 0;
  private marketCycleStart = 0;
  private MARKET_DURATION = 5 * 60 * 1000;
  private wsSetup = false;
  private lastDailyReset = new Date().toDateString();
  private waitForMarketInterval: ReturnType<typeof setInterval> | null = null;
  private isLiquidating = false;
  private liquidatingStartTime = 0;
  private readonly LIQUIDATION_PATIENCE_MS = 60000;
  private liquidationInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.marketData = new MarketDataModule();
    this.orderManager = new OrderManager();
    this.riskManager = new RiskManager();
  }

  private alignCycleStartToMarketBoundary(): void {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const intervalSec = this.MARKET_DURATION / 1000;
    const elapsedInCurrentInterval = (nowSec % intervalSec) * 1000;
    this.marketCycleStart = nowMs - elapsedInCurrentInterval;
    console.log(`[StrategyEngine] Aligned cycle start to market boundary: elapsed=${Math.floor(elapsedInCurrentInterval / 1000)}s, remaining=${Math.floor((this.MARKET_DURATION - elapsedInCurrentInterval) / 1000)}s`);
  }

  private alignCycleStartFromTimeRemaining(timeRemainingMs: number): void {
    this.marketCycleStart = Date.now() - (this.MARKET_DURATION - timeRemainingMs);
    console.log(`[StrategyEngine] Aligned cycle start from API timeRemaining: remaining=${Math.floor(timeRemainingMs / 1000)}s`);
  }

  getMarketRemainingMs(): number {
    if (this.marketCycleStart === 0) return 0;
    const elapsed = Date.now() - this.marketCycleStart;
    return Math.max(0, this.MARKET_DURATION - elapsed);
  }

  async start(): Promise<void> {
    let config = await storage.getBotConfig();
    if (!config) return;

    if (this.interval) {
      clearInterval(this.interval);
    }

    this.startTime = Date.now();

    if (config.autoRotateInterval === "15m") {
      this.MARKET_DURATION = 15 * 60 * 1000;
    } else {
      this.MARKET_DURATION = 5 * 60 * 1000;
    }

    if (config.autoRotate) {
      const asset = (config.autoRotateAsset || "btc") as AssetType;
      const interval = (config.autoRotateInterval || "5m") as IntervalType;
      const market = await fetchCurrentIntervalMarket(asset, interval);
      const minRemaining = interval === "15m" ? 90000 : 45000;
      if (market && !market.closed && market.acceptingOrders && market.timeRemainingMs > minRemaining) {
        config = { ...config };
        (config as any).currentMarketId = market.tokenUp;
        (config as any).currentMarketSlug = market.slug;
        (config as any).currentMarketNegRisk = market.negRisk;
        (config as any).currentMarketTickSize = String(market.tickSize);

        await storage.updateBotConfig({
          currentMarketId: market.tokenUp,
          currentMarketSlug: market.slug,
          currentMarketNegRisk: market.negRisk,
          currentMarketTickSize: String(market.tickSize),
        });

        this.marketData.setTokenId(market.tokenUp);
        this.alignCycleStartFromTimeRemaining(market.timeRemainingMs);

        await storage.createEvent({
          type: "STATE_CHANGE",
          message: `Auto-rotate: starting with ${market.slug} (${Math.floor(market.timeRemainingMs / 1000)}s remaining)`,
          data: { slug: market.slug, tokenUp: market.tokenUp, asset, interval },
          level: "info",
        });
      } else {
        this.alignCycleStartToMarketBoundary();
      }
    } else {
      this.alignCycleStartToMarketBoundary();
    }

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

    this.setupTakeProfitCallback(config);
    this.setupWebSocket(config);

    this.interval = setInterval(() => this.tick(), 3000);
  }

  private setupTakeProfitCallback(config: BotConfig): void {
    this.orderManager.onBuyFill(async (marketId, side, fillSize, avgEntryPrice) => {
      try {
        const freshConfig = await storage.getBotConfig();
        if (!freshConfig || !freshConfig.isActive) return;
        const currentState = freshConfig.currentState as BotState;
        if (currentState !== "MAKING" && currentState !== "UNWIND") return;

        const tokenId = freshConfig.currentMarketId || "";
        const negRisk = freshConfig.currentMarketNegRisk ?? false;
        const tickSize = freshConfig.currentMarketTickSize ?? "0.01";
        if (!tokenId) return;

        const exitPrice = this.marketData.getExitPrice(avgEntryPrice, freshConfig.targetProfitMin, freshConfig.targetProfitMax);

        const pos = await storage.getPositionByMarket(marketId, "BUY");
        if (!pos) return;

        await storage.upsertPosition({
          marketId: pos.marketId,
          side: pos.side,
          size: pos.size,
          avgEntryPrice: pos.avgEntryPrice,
          targetExitPrice: exitPrice,
          unrealizedPnl: pos.unrealizedPnl,
          realizedPnl: pos.realizedPnl,
        });

        const activeOrders = await this.orderManager.getActiveOrders();
        const existingTps = activeOrders.filter(o => o.side === "SELL" && o.marketId === marketId);

        if (existingTps.length >= 4) return;

        const tpCoveredSize = existingTps.reduce((sum, o) => sum + (o.size - o.filledSize), 0);
        const uncoveredSize = pos.size - tpCoveredSize;

        if (uncoveredSize < 0.5) return;

        const tpSize = Math.min(uncoveredSize, freshConfig.orderSize);

        await storage.createEvent({
          type: "ORDER_PLACED",
          message: `[TP-IMMEDIATE] BUY filled → placing SELL TP: ${tpSize.toFixed(2)} @ $${exitPrice.toFixed(4)} (entry avg: $${avgEntryPrice.toFixed(4)}, uncovered: ${uncoveredSize.toFixed(2)})`,
          data: { avgEntryPrice, exitPrice, tpSize, uncoveredSize, existingTpCount: existingTps.length },
          level: "info",
        });

        await this.orderManager.placeOrder({
          marketId,
          tokenId,
          side: "SELL",
          price: exitPrice,
          size: tpSize,
          isPaperTrade: freshConfig.isPaperTrading,
          negRisk,
          tickSize,
        });
      } catch (err: any) {
        console.error(`[StrategyEngine] Immediate TP placement error: ${err.message} | stack: ${err.stack?.split("\n")[1]?.trim() || "none"}`);
      }
    });
  }

  private setupWebSocket(config: BotConfig): void {
    if (this.wsSetup) return;

    if (config.currentMarketId) {
      const assetIds = this.getMarketAssetIds(config);
      polymarketWs.connectMarket(assetIds);
      this.marketData.setWsDataSource(polymarketWs);

      polymarketWs.onMarketData((data) => {
        this.marketData.updateFromWs(data);
      });

      polymarketWs.onRefreshAssetIds(async () => {
        const freshConfig = await storage.getBotConfig();
        return freshConfig ? this.getMarketAssetIds(freshConfig) : assetIds;
      });
    }

    if (!config.isPaperTrading && liveTradingClient.isInitialized()) {
      const creds = liveTradingClient.getApiCreds();
      if (creds && config.currentMarketId) {
        const assetIds = this.getMarketAssetIds(config);
        polymarketWs.connectUser(assetIds, creds);

        polymarketWs.onRefreshApiCreds(async () => {
          return liveTradingClient.getApiCreds();
        });

        polymarketWs.onFill(async (fillData) => {
          try {
            await this.orderManager.handleWsFill(fillData);
          } catch (err: any) {
            console.error(`[StrategyEngine] WS fill handler error: ${err.message} | fillData: ${JSON.stringify(fillData).slice(0, 200)} | stack: ${err.stack?.split("\n")[1]?.trim() || "none"}`);
          }
        });
      }
    }

    this.wsSetup = true;
  }

  private getMarketAssetIds(config: BotConfig): string[] {
    const ids: string[] = [];
    if (config.currentMarketId) {
      ids.push(config.currentMarketId);
    }
    const configAny = config as any;
    if (configAny.marketTokenYes && configAny.marketTokenYes !== config.currentMarketId) {
      ids.push(configAny.marketTokenYes);
    }
    if (configAny.marketTokenNo && configAny.marketTokenNo !== config.currentMarketId) {
      ids.push(configAny.marketTokenNo);
    }
    return ids;
  }

  async stop(): Promise<void> {
    if (this.waitForMarketInterval) {
      clearInterval(this.waitForMarketInterval);
      this.waitForMarketInterval = null;
    }

    const positions = await storage.getPositions();
    const openPositions = positions.filter(p => p.size > 0);

    if (openPositions.length > 0) {
      await this.startLiquidation(openPositions);
      return;
    }

    await this.forceStop();
  }

  private async startLiquidation(openPositions: any[]): Promise<void> {
    this.isLiquidating = true;
    this.liquidatingStartTime = Date.now();

    await storage.updateBotConfig({ isActive: false });

    this.orderManager.clearAllTimeouts();

    const activeOrders = await this.orderManager.getActiveOrders();
    const buyOrders = activeOrders.filter(o => o.side === "BUY");
    for (const order of buyOrders) {
      await this.orderManager.cancelOrder(order.id);
    }

    const totalSize = openPositions.reduce((sum: number, p: any) => sum + p.size, 0);

    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `[LIQUIDATING] Stop requested with ${openPositions.length} open position(s) (total size: ${totalSize.toFixed(2)}). Attempting orderly exit at break-even for 60s before force-crossing spread.`,
      data: { positions: openPositions.length, totalSize, patienceMs: this.LIQUIDATION_PATIENCE_MS },
      level: "warn",
    });

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    polymarketWs.disconnectAll();
    this.wsSetup = false;

    this.liquidationInterval = setInterval(() => this.liquidationTick(), 3000);
  }

  private async liquidationTick(): Promise<void> {
    try {
      const config = await storage.getBotConfig();
      if (!config) { await this.forceStop(); return; }

      const positions = await storage.getPositions();
      const openPositions = positions.filter(p => p.size > 0);

      if (openPositions.length === 0) {
        await storage.createEvent({
          type: "STATE_CHANGE",
          message: "[LIQUIDATING] All positions closed successfully. Bot stopped.",
          data: {},
          level: "info",
        });
        await this.forceStop();
        return;
      }

      if (config.isPaperTrading) {
        let liqData: MarketData | null = null;
        try { liqData = await this.marketData.getData(); } catch (_) {}
        const activeOrders = await this.orderManager.getActiveOrders();
        for (const order of activeOrders) {
          await this.orderManager.simulateFill(order.id, liqData ? {
            bestBid: liqData.bestBid,
            bestAsk: liqData.bestAsk,
            bidDepth: liqData.bidDepth,
            askDepth: liqData.askDepth,
          } : undefined);
        }
      } else {
        await this.orderManager.pollLiveOrderStatuses();
      }

      const positionsAfterFills = await storage.getPositions();
      const stillOpen = positionsAfterFills.filter(p => p.size > 0);
      if (stillOpen.length === 0) {
        await storage.createEvent({
          type: "STATE_CHANGE",
          message: "[LIQUIDATING] All positions closed after fill check. Bot stopped.",
          data: {},
          level: "info",
        });
        await this.forceStop();
        return;
      }

      const elapsed = Date.now() - this.liquidatingStartTime;
      const tokenId = config.currentMarketId || "";
      const negRisk = config.currentMarketNegRisk ?? false;
      const tickSize = config.currentMarketTickSize ?? "0.01";

      if (!tokenId || tokenId.includes("sim")) {
        for (const pos of stillOpen) {
          await storage.upsertPosition({
            marketId: pos.marketId,
            side: pos.side,
            size: 0,
            avgEntryPrice: pos.avgEntryPrice,
            unrealizedPnl: 0,
            realizedPnl: pos.realizedPnl,
          });
        }
        await storage.createEvent({
          type: "STATE_CHANGE",
          message: "[LIQUIDATING] No real market token - zeroed simulated positions. Bot stopped.",
          data: {},
          level: "info",
        });
        await this.forceStop();
        return;
      }

      let data: MarketData | null = null;
      try {
        data = await this.marketData.getData();
      } catch (_) {}

      if (!data) {
        try {
          const { polymarketClient } = await import("./polymarket-client");
          data = await polymarketClient.fetchMarketData(tokenId);
        } catch (_) {}
      }

      if (!data) {
        return;
      }

      if (elapsed < this.LIQUIDATION_PATIENCE_MS) {
        for (const pos of stillOpen) {
          const existingOrders = await this.orderManager.getActiveOrders();
          const sellOrders = existingOrders.filter(o => o.side === "SELL" && o.marketId === pos.marketId);
          const coveredSize = sellOrders.reduce((sum, o) => sum + (o.size - o.filledSize), 0);
          const uncovered = pos.size - coveredSize;

          if (uncovered < 0.5) continue;

          const exitPrice = pos.side === "BUY"
            ? Math.max(pos.avgEntryPrice, data.bestBid)
            : Math.min(pos.avgEntryPrice, data.bestAsk);

          const clampedPrice = Math.max(0.01, Math.min(0.99, exitPrice));
          const exitSide = pos.side === "BUY" ? "SELL" : "BUY";

          await storage.createEvent({
            type: "INFO",
            message: `[LIQUIDATING] Placing break-even exit: ${exitSide} ${uncovered.toFixed(2)} @ $${clampedPrice.toFixed(4)} (entry: $${pos.avgEntryPrice.toFixed(4)}, ${Math.floor((this.LIQUIDATION_PATIENCE_MS - elapsed) / 1000)}s patience left)`,
            data: { side: exitSide, price: clampedPrice, size: uncovered, entryPrice: pos.avgEntryPrice },
            level: "info",
          });

          await this.orderManager.placeOrder({
            marketId: pos.marketId,
            tokenId,
            side: exitSide,
            price: clampedPrice,
            size: uncovered,
            isPaperTrade: config.isPaperTrading,
            negRisk,
            tickSize,
          });
        }
      } else {
        await this.orderManager.cancelAllOrders();

        for (const pos of stillOpen) {
          const exitSide = pos.side === "BUY" ? "SELL" : "BUY";
          let exitPrice: number;

          if (pos.side === "BUY") {
            exitPrice = data.bestBid - 0.01;
          } else {
            exitPrice = data.bestAsk + 0.01;
          }

          exitPrice = Math.max(0.01, Math.min(0.99, exitPrice));

          await storage.createEvent({
            type: "INFO",
            message: `[LIQUIDATING] Patience expired → force-crossing spread: ${exitSide} ${pos.size.toFixed(2)} @ $${exitPrice.toFixed(4)} (entry: $${pos.avgEntryPrice.toFixed(4)})`,
            data: { side: exitSide, price: exitPrice, size: pos.size, entryPrice: pos.avgEntryPrice },
            level: "warn",
          });

          await this.orderManager.placeOrder({
            marketId: pos.marketId,
            tokenId,
            side: exitSide,
            price: exitPrice,
            size: pos.size,
            isPaperTrade: config.isPaperTrading,
            negRisk,
            tickSize,
          });
        }
      }
    } catch (err: any) {
      console.error(`[StrategyEngine] Liquidation tick error (will retry): ${err.message}`);
      await storage.createEvent({
        type: "ERROR",
        message: `[LIQUIDATING] Tick error (retrying): ${err.message}`,
        data: { stack: err.stack?.slice(0, 300) },
        level: "error",
      });
    }
  }

  private async forceStop(): Promise<void> {
    this.isLiquidating = false;
    this.liquidatingStartTime = 0;

    if (this.liquidationInterval) {
      clearInterval(this.liquidationInterval);
      this.liquidationInterval = null;
    }

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
    await this.forceStop();
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
    let tickConfig: BotConfig | undefined | null = null;
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
      tickConfig = config;
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
          const result = await this.orderManager.simulateFill(order.id, {
            bestBid: data.bestBid,
            bestAsk: data.bestAsk,
            bidDepth: data.bidDepth,
            askDepth: data.askDepth,
          });
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
        if (this.waitForMarketInterval) return;

        this.cycleCount++;

        await this.orderManager.cancelAllOrders();

        if (config.autoRotate) {
          await this.rotateToNextMarket(config);
        } else {
          this.alignCycleStartToMarketBoundary();
          await storage.updateBotConfig({ currentState: "MAKING" });
          await storage.createEvent({
            type: "STATE_CHANGE",
            message: `Market cycle ${this.cycleCount} completed, starting new cycle (same market). Remaining: ${Math.floor(this.getMarketRemainingMs() / 1000)}s`,
            data: { cycle: this.cycleCount, remainingMs: this.getMarketRemainingMs() },
            level: "info",
          });
        }
      }
    } catch (error: any) {
      await storage.createEvent({
        type: "ERROR",
        message: `Tick error in state ${tickConfig?.currentState || "UNKNOWN"}: ${error.message}`,
        data: { state: tickConfig?.currentState, market: tickConfig?.currentMarketSlug, tokenId: tickConfig?.currentMarketId?.slice(0, 12), stack: error.stack?.slice(0, 500), remainingMs: this.getMarketRemainingMs() },
        level: "error",
      });
    }
  }

  private calculateState(current: BotState, remainingMs: number): BotState {
    if (current === "STOPPED") return current;
    if (current === "DONE") return current;
    if (remainingMs <= 0) return "DONE";
    if (remainingMs <= 45000) return "HEDGE_LOCK";
    if (remainingMs <= 60000) return "CLOSE_ONLY";
    if (remainingMs <= 120000) return "UNWIND";
    return "MAKING";
  }

  private async transitionState(from: BotState, to: BotState): Promise<void> {
    const remainingMs = this.getMarketRemainingMs();
    await storage.updateBotConfig({ currentState: to });
    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `State transition: ${from} -> ${to} (${Math.floor(remainingMs / 1000)}s remaining)`,
      data: { from, to, remainingMs },
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

    if (!config.isPaperTrading) {
      const wsHealth = polymarketWs.getHealth();
      if (!wsHealth.marketConnected) {
        return;
      }
    }

    const activeOrders = await this.orderManager.getActiveOrders();
    const entryOrders = activeOrders.filter(o => o.side === "BUY");
    const tpOrders = activeOrders.filter(o => o.side === "SELL");

    await this.ensureTakeProfitOrders(config, data, tpOrders, tokenId, marketId, negRisk, tickSize);

    if (entryOrders.length >= 3) return;

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
        let usdcBalance = 0;
        const collateral = await liveTradingClient.getCollateralBalance();
        apiRateLimiter.recordSuccess();
        if (collateral && parseFloat(collateral.balance) > 0) {
          const raw = parseFloat(collateral.balance);
          usdcBalance = raw > 1000 ? raw / 1e6 : raw;
        } else {
          const onChain = await liveTradingClient.getOnChainUsdcBalance();
          if (onChain) {
            usdcBalance = parseFloat(onChain.total);
          }
        }
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
        console.error(`[Strategy] Balance check failed: ${error.message} | market=${config.currentMarketSlug} | mode=${config.isPaperTrading ? "PAPER" : "LIVE"} | stack: ${error.stack?.split("\n")[1]?.trim() || "none"}`);
        return;
      }
    }

    const bestSide = this.marketData.getBestSide();
    if (!bestSide) return;

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
  }

  private async ensureTakeProfitOrders(
    config: BotConfig,
    data: MarketData,
    existingTpOrders: Order[],
    tokenId: string,
    marketId: string,
    negRisk: boolean,
    tickSize: string,
  ): Promise<void> {
    const positions = await storage.getPositions();
    const buyPositions = positions.filter(p => p.side === "BUY" && p.size > 0);

    if (buyPositions.length === 0) return;

    for (const pos of buyPositions) {
      const tpForThisPos = existingTpOrders.filter(o => o.marketId === pos.marketId);
      const tpCoveredSize = tpForThisPos.reduce((sum, o) => sum + (o.size - o.filledSize), 0);
      const uncoveredSize = pos.size - tpCoveredSize;

      if (uncoveredSize < 0.5) continue;

      let exitPrice = pos.targetExitPrice;
      const newExitPrice = this.marketData.getExitPrice(pos.avgEntryPrice, config.targetProfitMin, config.targetProfitMax);

      if (!exitPrice || Math.abs(exitPrice - newExitPrice) > 0.005) {
        exitPrice = newExitPrice;
        await storage.upsertPosition({
          marketId: pos.marketId,
          side: pos.side,
          size: pos.size,
          avgEntryPrice: pos.avgEntryPrice,
          targetExitPrice: exitPrice,
          unrealizedPnl: pos.unrealizedPnl,
          realizedPnl: pos.realizedPnl,
        });

        if (tpForThisPos.length > 0 && Math.abs((pos.targetExitPrice || 0) - exitPrice) > 0.005) {
          for (const oldTp of tpForThisPos) {
            await this.orderManager.cancelOrder(oldTp.id);
          }
          await storage.createEvent({
            type: "INFO",
            message: `[TP] Cancelled ${tpForThisPos.length} stale TP orders (entry avg changed, old TP: $${(pos.targetExitPrice || 0).toFixed(4)} → new: $${exitPrice.toFixed(4)})`,
            data: { oldTp: pos.targetExitPrice, newTp: exitPrice, cancelled: tpForThisPos.length },
            level: "info",
          });
        }
      }

      const tpSize = Math.min(uncoveredSize, config.orderSize);

      if (existingTpOrders.length >= 4) return;

      await storage.createEvent({
        type: "ORDER_PLACED",
        message: `[TP] Placing take-profit SELL: ${tpSize.toFixed(2)} @ $${exitPrice.toFixed(4)} (entry avg: $${pos.avgEntryPrice.toFixed(4)}, profit target: $${(exitPrice - pos.avgEntryPrice).toFixed(4)})`,
        data: { entryPrice: pos.avgEntryPrice, exitPrice, size: tpSize, uncoveredSize, tpCoveredSize },
        level: "info",
      });

      await this.orderManager.placeOrder({
        marketId,
        tokenId,
        side: "SELL",
        price: exitPrice,
        size: tpSize,
        isPaperTrade: config.isPaperTrading,
        negRisk,
        tickSize,
      });
    }
  }

  private async executeUnwind(config: BotConfig, data: MarketData): Promise<void> {
    const positions = await storage.getPositions();
    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length >= 2) return;

    const tokenId = config.currentMarketId || "";
    const negRisk = config.currentMarketNegRisk ?? false;
    const tickSize = config.currentMarketTickSize ?? "0.01";

    for (const pos of positions) {
      if (pos.size > 0) {
        const exitPrice = pos.side === "BUY"
          ? data.bestAsk - 0.01
          : data.bestBid + 0.01;

        await this.orderManager.placeOrder({
          marketId: pos.marketId,
          tokenId,
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
    const openPositions = positions.filter(p => p.size > 0);

    if (openPositions.length === 0) return;

    const tokenId = config.currentMarketId || "";
    const negRisk = config.currentMarketNegRisk ?? false;
    const tickSize = config.currentMarketTickSize ?? "0.01";

    if (!tokenId || tokenId.includes("sim")) {
      return;
    }

    await this.orderManager.cancelAllOrders();

    const remainingMs = this.getMarketRemainingMs();

    for (const pos of openPositions) {
      const exitSide = pos.side === "BUY" ? "SELL" : "BUY";
      let exitPrice: number;

      if (pos.side === "BUY") {
        if (remainingMs <= 20000) {
          exitPrice = data.bestBid - 0.01;
        } else if (remainingMs <= 30000) {
          exitPrice = data.bestBid - 0.005;
        } else {
          exitPrice = data.bestBid;
        }
      } else {
        if (remainingMs <= 20000) {
          exitPrice = data.bestAsk + 0.01;
        } else if (remainingMs <= 30000) {
          exitPrice = data.bestAsk + 0.005;
        } else {
          exitPrice = data.bestAsk;
        }
      }

      exitPrice = Math.max(0.01, Math.min(0.99, exitPrice));

      await storage.createEvent({
        type: "INFO",
        message: `[HEDGE_LOCK] Force-exiting ${pos.side} position: ${pos.size} @ $${exitPrice.toFixed(4)} (${Math.floor(remainingMs / 1000)}s left)`,
        data: { side: exitSide, price: exitPrice, size: pos.size, remainingMs },
        level: "warn",
      });

      await this.orderManager.placeOrder({
        marketId: pos.marketId,
        tokenId,
        side: exitSide,
        price: exitPrice,
        size: pos.size,
        isPaperTrade: config.isPaperTrading,
        negRisk,
        tickSize,
      });
    }
  }

  private async rotateToNextMarket(config: BotConfig): Promise<void> {
    const asset = (config.autoRotateAsset || "btc") as AssetType;
    const interval = (config.autoRotateInterval || "5m") as IntervalType;

    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `Cycle ${this.cycleCount} done. Searching for next ${interval} ${asset.toUpperCase()} market...`,
      data: { cycle: this.cycleCount, asset, interval },
      level: "info",
    });

    const market = await fetchCurrentIntervalMarket(asset, interval);

    if (!market) {
      await storage.createEvent({
        type: "INFO",
        message: `No active ${interval} ${asset.toUpperCase()} market found. Waiting for next window...`,
        data: { asset, interval },
        level: "warn",
      });

      await this.waitForNextMarket(config, asset, interval);
      return;
    }

    if (market.closed || !market.acceptingOrders) {
      await storage.createEvent({
        type: "INFO",
        message: `Market ${market.slug} is closed/not accepting orders. Waiting for next window...`,
        data: { slug: market.slug, closed: market.closed, acceptingOrders: market.acceptingOrders },
        level: "warn",
      });
      await this.waitForNextMarket(config, asset, interval);
      return;
    }

    const minRemaining = interval === "15m" ? 90000 : 45000;
    if (market.timeRemainingMs < minRemaining) {
      await storage.createEvent({
        type: "INFO",
        message: `Market ${market.slug} has only ${Math.floor(market.timeRemainingMs / 1000)}s remaining. Waiting for next window...`,
        data: { slug: market.slug, timeRemainingMs: market.timeRemainingMs },
        level: "info",
      });
      await this.waitForNextMarket(config, asset, interval);
      return;
    }

    await this.switchToMarket(config, market);
  }

  private async waitForNextMarket(config: BotConfig, asset: AssetType, interval: IntervalType): Promise<void> {
    await storage.updateBotConfig({ currentState: "DONE" });

    if (this.waitForMarketInterval) {
      clearInterval(this.waitForMarketInterval);
    }

    this.waitForMarketInterval = setInterval(async () => {
      try {
        const freshConfig = await storage.getBotConfig();
        if (!freshConfig || !freshConfig.isActive || freshConfig.killSwitchActive) {
          if (this.waitForMarketInterval) clearInterval(this.waitForMarketInterval);
          this.waitForMarketInterval = null;
          return;
        }

        const market = await fetchCurrentIntervalMarket(asset, interval);
        if (!market || market.closed || !market.acceptingOrders) return;

        const minRemaining = interval === "15m" ? 90000 : 45000;
        if (market.timeRemainingMs < minRemaining) return;

        if (this.waitForMarketInterval) clearInterval(this.waitForMarketInterval);
        this.waitForMarketInterval = null;
        await this.switchToMarket(freshConfig, market);
      } catch (err: any) {
        console.error(`[StrategyEngine] waitForNextMarket error: ${err.message} | asset=${asset} interval=${interval} | stack: ${err.stack?.split("\n")[1]?.trim() || "none"}`);
      }
    }, 5000);
  }

  private async switchToMarket(config: BotConfig, market: { slug: string; tokenUp: string; tokenDown: string; negRisk: boolean; tickSize: number; timeRemainingMs: number }): Promise<void> {
    const prevSlug = config.currentMarketSlug;

    await storage.updateBotConfig({
      currentMarketId: market.tokenUp,
      currentMarketSlug: market.slug,
      currentMarketNegRisk: market.negRisk,
      currentMarketTickSize: String(market.tickSize),
      currentState: "MAKING",
    });

    this.marketData.setTokenId(market.tokenUp);
    this.alignCycleStartFromTimeRemaining(market.timeRemainingMs);

    this.RECONNECT_WS(config, market);

    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `Rotated to new market: ${market.slug} (${Math.floor(market.timeRemainingMs / 1000)}s remaining). Cycle #${this.cycleCount + 1} starting.`,
      data: {
        prevMarket: prevSlug,
        newMarket: market.slug,
        tokenUp: market.tokenUp,
        tokenDown: market.tokenDown,
        timeRemainingMs: market.timeRemainingMs,
        cycle: this.cycleCount + 1,
      },
      level: "info",
    });
  }

  private RECONNECT_WS(config: BotConfig, market: { tokenUp: string; tokenDown: string }): void {
    polymarketWs.disconnectAll();
    this.wsSetup = false;

    const assetIds = [market.tokenUp, market.tokenDown];
    polymarketWs.connectMarket(assetIds);
    this.marketData.setWsDataSource(polymarketWs);

    polymarketWs.onMarketData((data) => {
      this.marketData.updateFromWs(data);
    });

    polymarketWs.onRefreshAssetIds(async () => {
      const freshConfig = await storage.getBotConfig();
      if (freshConfig?.currentMarketId) {
        return [freshConfig.currentMarketId];
      }
      return assetIds;
    });

    if (!config.isPaperTrading && liveTradingClient.isInitialized()) {
      const creds = liveTradingClient.getApiCreds();
      if (creds) {
        polymarketWs.connectUser(assetIds, creds);
        polymarketWs.onRefreshApiCreds(async () => {
          return liveTradingClient.getApiCreds();
        });
        polymarketWs.onFill(async (fillData) => {
          try {
            await this.orderManager.handleWsFill(fillData);
          } catch (err: any) {
            console.error(`[StrategyEngine] WS fill handler error (reconnect): ${err.message} | fillData: ${JSON.stringify(fillData).slice(0, 200)} | stack: ${err.stack?.split("\n")[1]?.trim() || "none"}`);
          }
        });
      }
    }

    this.wsSetup = true;
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

    let marketData = this.marketData.getLastData();
    let isLiveData = this.marketData.isUsingLiveData();

    if (!marketData && config?.currentMarketId) {
      try {
        const { polymarketClient } = await import("./polymarket-client");
        const liveData = await polymarketClient.fetchMarketData(config.currentMarketId);
        if (liveData) {
          marketData = liveData;
          isLiveData = true;
        }
      } catch (_) {}
    }

    const remainingMs = this.getMarketRemainingMs();

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
        autoRotate: false,
        autoRotateAsset: "btc",
        autoRotateInterval: "5m",
        updatedAt: new Date(),
      },
      marketData,
      activeOrders: activeOrders.length,
      openPositions: positions.length,
      dailyPnl: this.riskManager.getDailyPnl(),
      consecutiveLosses: this.riskManager.getConsecutiveLosses(),
      uptime: Date.now() - this.startTime,
      isLiveData,
      currentTokenId: this.marketData.getTokenId(),
      wsHealth: polymarketWs.getHealth(),
      marketRemainingMs: remainingMs,
      marketDurationMs: this.MARKET_DURATION,
      isLiquidating: this.isLiquidating,
      liquidationElapsedMs: this.isLiquidating ? Date.now() - this.liquidatingStartTime : undefined,
      liquidationPatienceMs: this.isLiquidating ? this.LIQUIDATION_PATIENCE_MS : undefined,
    };
  }
}

export const strategyEngine = new StrategyEngine();
