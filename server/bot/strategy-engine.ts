import { storage } from "../storage";
import { MarketDataModule } from "./market-data";
import { OrderManager } from "./order-manager";
import { RiskManager } from "./risk-manager";
import { liveTradingClient } from "./live-trading-client";
import { polymarketWs } from "./polymarket-ws";
import { apiRateLimiter } from "./rate-limiter";
import { binanceOracle, type PriceSignal } from "./binance-oracle";
import { stopLossManager } from "./stop-loss-manager";
import { progressiveSizer } from "./progressive-sizer";
import { marketRegimeFilter } from "./market-regime-filter";
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
  private lastSeenBestBid = 0;
  private readonly PRICE_JUMP_THRESHOLD = 0.20;
  private lastEntryTokenSide: "YES" | "NO" | null = null;
  private lastEntryPrice: number | null = null;
  private lastEntrySize: number | null = null;

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
    this.lastSeenBestBid = 0;
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

    if (!binanceOracle.isConnected()) {
      binanceOracle.connect();
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
        (config as any).currentMarketTokenDown = market.tokenDown;

        await storage.updateBotConfig({
          currentMarketId: market.tokenUp,
          currentMarketSlug: market.slug,
          currentMarketNegRisk: market.negRisk,
          currentMarketTickSize: String(market.tickSize),
          currentMarketTokenDown: market.tokenDown,
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

    if (!binanceOracle.isConnected()) {
      binanceOracle.connect();
    }
    binanceOracle.markWindowStart();
    stopLossManager.clearAll();

    this.setupWebSocket(config);

    this.interval = setInterval(() => this.tick(), 2000);
  }

  private setupWebSocket(config: BotConfig): void {
    if (this.wsSetup) return;

    if (config.currentMarketId) {
      const assetIds = this.getMarketAssetIds(config);
      polymarketWs.setActiveAssetId(config.currentMarketId);
      polymarketWs.connectMarket(assetIds);
      this.marketData.setWsDataSource(polymarketWs);

      polymarketWs.onMarketData((data) => {
        this.marketData.updateFromWs(data);
      });

      polymarketWs.onRefreshAssetIds(async () => {
        const freshConfig = await storage.getBotConfig();
        return freshConfig ? this.getMarketAssetIds(freshConfig) : assetIds;
      });

      this.marketData.startRestPolling();
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
    if (config.currentMarketId) {
      return [config.currentMarketId];
    }
    return [];
  }

  async stop(): Promise<void> {
    if (this.waitForMarketInterval) {
      clearInterval(this.waitForMarketInterval);
      this.waitForMarketInterval = null;
    }

    const positions = await storage.getPositions();
    const openPositions = positions.filter(p => p.size > 0);

    if (openPositions.length > 0) {
      // HOLD-TO-RESOLUTION: Do NOT liquidate — settle positions at resolution price
      await this.orderManager.cancelAllOrders();

      const config = await storage.getBotConfig();
      if (config) {
        const data = this.marketData.getLastData();
        await this.settleMarketResolution(config, data || { bestBid: 0, bestAsk: 0, spread: 0, midpoint: 0, bidDepth: 0, askDepth: 0, lastPrice: 0, volume24h: 0 });
      }

      await storage.createEvent({
        type: "STATE_CHANGE",
        message: `[STOP] Bot stopped with ${openPositions.length} position(s) — settled at resolution (hold-to-resolution, no selling)`,
        data: { positionsSettled: openPositions.length },
        level: "info",
      });
    }

    await this.forceStop();
  }

  private async forceStop(): Promise<void> {
    this.isLiquidating = false;
    this.lastEntryTokenSide = null;
    this.lastEntryPrice = null;
    this.lastEntrySize = null;

    for (const t of this.hedgeLockRepriceTimers) clearTimeout(t);
    this.hedgeLockRepriceTimers = [];

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    polymarketWs.disconnectAll();
    this.marketData.stopRestPolling();
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
        const tokenUpId = config.currentMarketId || "";
        for (const order of activeOrders) {
          const isTokenDown = order.tokenId && order.tokenId !== tokenUpId && order.tokenId !== order.marketId;
          const orderBookData = isTokenDown
            ? {
                bestBid: parseFloat((1 - data.bestAsk).toFixed(4)),
                bestAsk: parseFloat((1 - data.bestBid).toFixed(4)),
                bidDepth: data.askDepth,
                askDepth: data.bidDepth,
              }
            : {
                bestBid: data.bestBid,
                bestAsk: data.bestAsk,
                bidDepth: data.bidDepth,
                askDepth: data.askDepth,
              };
          const result = await this.orderManager.simulateFill(order.id, orderBookData);
          if (result.filled && result.pnl !== 0) {
            this.riskManager.recordTradeResult(result.pnl);
            await this.updateDailyPnl(result.pnl, result.pnl > 0, undefined, result.fee);
          }
        }
      } else {
        const liveResults = await this.orderManager.pollLiveOrderStatuses();
        for (const result of liveResults) {
          if (result.filled && result.pnl !== 0) {
            this.riskManager.recordTradeResult(result.pnl);
            await this.updateDailyPnl(result.pnl, result.pnl > 0, undefined, result.fee);
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

      if (newState === "MAKING" || newState === "UNWIND") {
        let stopLossData = data;
        const allPositions = await storage.getPositions();
        const tokenDown = (config as any).currentMarketTokenDown;
        const hasTokenDownPositions = allPositions.some(p =>
          p.size > 0 && tokenDown && p.marketId === tokenDown
        );
        if (hasTokenDownPositions) {
          const tokenDownData = await this.getTokenDownData(config);
          if (tokenDownData) {
            stopLossData = tokenDownData;
          }
        }
        const stopLossResults = await stopLossManager.checkAllPositions(stopLossData, remaining, this.MARKET_DURATION);
        for (const sl of stopLossResults) {
          // HOLD-TO-RESOLUTION: Log stop-loss alerts but do NOT sell — positions resolve at market close
          await storage.createEvent({
            type: "RISK_ALERT",
            message: `[STOP-LOSS] ${sl.reason} (logged only, no sell in hold-to-resolution) | Position ${sl.marketId} entry=$${sl.entryPrice.toFixed(4)} current=$${sl.currentPrice.toFixed(4)} loss=${(sl.lossPct * 100).toFixed(1)}%`,
            data: { ...sl, holdToResolution: true },
            level: "warn",
          });
        }
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
        this.lastEntryTokenSide = null;
        this.lastEntryPrice = null;
        this.lastEntrySize = null;

        await this.orderManager.cancelAllOrders();

        await this.settleMarketResolution(config, data);

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
    if (remainingMs <= 15000) return "HEDGE_LOCK";
    if (remainingMs <= 30000) return "CLOSE_ONLY";
    if (remainingMs <= 60000) return "UNWIND";
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

  private async getTokenDownData(config: BotConfig): Promise<MarketData | null> {
    const tokenDown = (config as any).currentMarketTokenDown;
    if (!tokenDown || tokenDown.length < 10 || tokenDown.includes("sim")) return null;

    try {
      const { polymarketClient } = await import("./polymarket-client");
      return await polymarketClient.fetchMarketData(tokenDown);
    } catch (err: any) {
      console.error(`[StrategyEngine] Failed to fetch tokenDown data: ${err.message}`);
      return null;
    }
  }

  /**
   * Determines which token side to BUY based on Oracle signal.
   * side is always "BUY" because in binary markets we buy tokens (YES or NO).
   * tokenSide determines WHICH token to buy (YES = tokenUp, NO = tokenDown).
   */
  private getOracleAlignedSide(signal: PriceSignal, config: BotConfig): { side: "BUY" | null; tokenSide: "YES" | "NO" | null; sizeMultiplier: number } {
    if (signal.strength === "NONE" || signal.direction === "NEUTRAL") {
      return { side: null, tokenSide: null, sizeMultiplier: 0 };
    }

    const sizeMultiplier = signal.strength === "STRONG" ? 1.5 : 0.75;
    return { side: "BUY", tokenSide: signal.direction === "UP" ? "YES" : "NO", sizeMultiplier };
  }

  private async executeStrategy(config: BotConfig, data: MarketData): Promise<void> {
    if (this.lastSeenBestBid > 0 && Math.abs(data.bestBid - this.lastSeenBestBid) > this.PRICE_JUMP_THRESHOLD) {
      await storage.createEvent({
        type: "RISK_ALERT",
        message: `[SAFETY] Price jump detected: $${this.lastSeenBestBid.toFixed(4)} → $${data.bestBid.toFixed(4)} (Δ${Math.abs(data.bestBid - this.lastSeenBestBid).toFixed(4)} > ${this.PRICE_JUMP_THRESHOLD}) — skipping tick, possible mixed token data`,
        data: { filter: "priceJump", previous: this.lastSeenBestBid, current: data.bestBid, delta: Math.abs(data.bestBid - this.lastSeenBestBid) },
        level: "error",
      });
      this.lastSeenBestBid = data.bestBid;
      return;
    }
    this.lastSeenBestBid = data.bestBid;

    if (!this.marketData.isSpreadSufficient(config.minSpread)) {
      const lastData = this.marketData.getLastData();
      await storage.createEvent({
        type: "INFO",
        message: `[FILTER] Spread insuficiente: ${lastData?.spread?.toFixed(4) ?? "N/A"} < min ${config.minSpread} — no trade`,
        data: { filter: "spread", spread: lastData?.spread, minSpread: config.minSpread },
        level: "info",
      });
      return;
    }

    if (!this.marketData.isMarketActive()) {
      const lastData = this.marketData.getLastData();
      await storage.createEvent({
        type: "INFO",
        message: `[FILTER] Mercado inactivo: bidDepth=${lastData?.bidDepth?.toFixed(0) ?? "0"} askDepth=${lastData?.askDepth?.toFixed(0) ?? "0"} (min 10) — no trade`,
        data: { filter: "marketActive", bidDepth: lastData?.bidDepth, askDepth: lastData?.askDepth },
        level: "info",
      });
      return;
    }

    const regimeResult = marketRegimeFilter.getRegime(data);
    if (!regimeResult.tradeable) {
      await storage.createEvent({
        type: "INFO",
        message: `[FILTER] Regime ${regimeResult.regime}: ${regimeResult.reason} — no trade`,
        data: { filter: "regime", regime: regimeResult.regime, reason: regimeResult.reason, volatility: regimeResult.volatility, depth: regimeResult.depth, spread: regimeResult.spread },
        level: "info",
      });
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

    const activeOrders = await this.orderManager.getActiveOrders();
    const entryOrders = activeOrders.filter(o => o.side === "BUY");

    if (entryOrders.length >= 1) return;

    const positions = await storage.getPositions();
    const existingPosition = positions.find(p => p.size > 0);
    if (existingPosition) {
      return;
    }

    const oracleSignal = binanceOracle.getSignal();
    const oracleResult = this.getOracleAlignedSide(oracleSignal, config);

    if (binanceOracle.isConnected() && !oracleResult.side) {
      await storage.createEvent({
        type: "INFO",
        message: `[FILTER] Oracle NEUTRAL: direction=${oracleSignal.direction} strength=${oracleSignal.strength} delta=$${oracleSignal.delta.toFixed(2)} conf=${(oracleSignal.confidence * 100).toFixed(0)}% — no trade`,
        data: { filter: "oracle", direction: oracleSignal.direction, strength: oracleSignal.strength, delta: oracleSignal.delta, confidence: oracleSignal.confidence },
        level: "info",
      });
      return;
    }

    let effectiveTokenId = tokenId;
    if (binanceOracle.isConnected() && oracleResult.tokenSide === "NO") {
      const tokenDown = (config as any).currentMarketTokenDown;
      if (tokenDown && tokenDown.length > 10 && !tokenDown.includes("sim")) {
        effectiveTokenId = tokenDown;
      }
    }

    let entryPrice = data.bestBid;
    if (effectiveTokenId !== tokenId) {
      const tokenDownData = await this.getTokenDownData(config);
      if (tokenDownData) {
        entryPrice = tokenDownData.bestBid;
      } else {
        await storage.createEvent({
          type: "INFO",
          message: `[ORACLE] Signal says NO but no tokenDown market data available — skipping`,
          data: { signal: oracleSignal.direction },
          level: "warn",
        });
        return;
      }
    }

    const MAX_ENTRY_PRICE = 0.58;
    const MIN_ENTRY_PRICE = 0.10;

    if (entryPrice > MAX_ENTRY_PRICE) {
      await storage.createEvent({
        type: "INFO",
        message: `[STRATEGY] Entry price $${entryPrice.toFixed(3)} > max $${MAX_ENTRY_PRICE} — skipping (risk/reward unfavorable)`,
        data: { filter: "maxPrice", entryPrice, maxAllowed: MAX_ENTRY_PRICE },
        level: "info",
      });
      return;
    }

    if (entryPrice < MIN_ENTRY_PRICE) {
      await storage.createEvent({
        type: "INFO",
        message: `[STRATEGY] Entry price $${entryPrice.toFixed(3)} < min $${MIN_ENTRY_PRICE} — skipping (likely stale data)`,
        data: { filter: "minPrice", entryPrice, minAllowed: MIN_ENTRY_PRICE },
        level: "info",
      });
      return;
    }

    const oracleConfidence = oracleSignal.confidence;
    let effectiveSize: number;
    let layer: string;

    if (oracleSignal.strength === "STRONG" && oracleConfidence >= 0.55) {
      const maxRisk = config.maxNetExposure * 0.05;
      effectiveSize = parseFloat(Math.min(maxRisk / entryPrice, config.orderSize).toFixed(2));
      layer = "L1-STRONG";
    } else if (oracleSignal.strength !== "NONE" && oracleConfidence >= 0.35) {
      const maxRisk = config.maxNetExposure * 0.03;
      effectiveSize = parseFloat(Math.min(maxRisk / entryPrice, config.orderSize * 0.6).toFixed(2));
      layer = "L2-EARLY";
    } else {
      await storage.createEvent({
        type: "INFO",
        message: `[STRATEGY] Layer 3: Oracle too weak (confidence=${(oracleConfidence * 100).toFixed(0)}%, strength=${oracleSignal.strength}) — no trade`,
        data: { filter: "layer3", confidence: oracleConfidence, strength: oracleSignal.strength },
        level: "info",
      });
      return;
    }

    if (effectiveSize < 1) {
      effectiveSize = 1;
    }

    const riskCheck = await this.riskManager.checkPreTrade(config, effectiveSize * entryPrice);
    if (!riskCheck.allowed) {
      await storage.createEvent({
        type: "RISK_ALERT",
        message: `[FILTER] Risk check blocked: ${riskCheck.reason} — no trade`,
        data: { filter: "risk", reason: riskCheck.reason, warnings: riskCheck.warnings },
        level: "warn",
      });
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
        const orderCost = effectiveSize * entryPrice;
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

    try {
      await this.orderManager.placeOrder({
        marketId,
        tokenId: effectiveTokenId,
        side: "BUY",
        price: entryPrice,
        size: effectiveSize,
        isPaperTrade: config.isPaperTrading,
        negRisk,
        tickSize,
        oracleDirection: oracleSignal.direction,
        oracleConfidence: oracleSignal.confidence,
      });

      this.lastEntryTokenSide = oracleResult.tokenSide as "YES" | "NO";
      this.lastEntryPrice = entryPrice;
      this.lastEntrySize = effectiveSize;

      const expectedWin = (1.0 - entryPrice) * effectiveSize;
      const expectedLoss = entryPrice * effectiveSize;
      const rrRatio = ((1.0 - entryPrice) / entryPrice).toFixed(2);

      await storage.createEvent({
        type: "INFO",
        message: `[${layer}] ENTRY: ${oracleResult.tokenSide} @ $${entryPrice.toFixed(3)} x ${effectiveSize} shares | Oracle: ${oracleSignal.direction}/${oracleSignal.strength} conf=${(oracleSignal.confidence * 100).toFixed(0)}% delta=$${oracleSignal.delta.toFixed(2)} | HOLD TO RESOLUTION | Win=$${expectedWin.toFixed(2)} / Loss=-$${expectedLoss.toFixed(2)} (R:R ${rrRatio}) | regime=${regimeResult.regime}`,
        data: {
          layer,
          oracle: oracleSignal,
          effectiveSize,
          entryPrice,
          expectedWin,
          expectedLoss,
          riskRewardRatio: rrRatio,
          holdStrategy: "RESOLUTION",
          tokenSide: oracleResult.tokenSide,
          effectiveTokenId,
          regime: regimeResult.regime,
        },
        level: "info",
      });
    } catch (err: any) {
      if (err.message?.includes("regional restriction") || err.message?.includes("Access restricted") || err.message?.includes("GEO-BLOCKED")) {
        await storage.createEvent({
          type: "ERROR",
          message: `GEO-BLOCKED: Polymarket rechazó la orden por restricción regional. El servidor se ejecuta desde una IP bloqueada. Cambiando a paper trading automáticamente.`,
          data: { error: err.message, action: "auto_switch_paper" },
          level: "error",
        });
        await storage.updateBotConfig({ isPaperTrading: true });
        console.error(`[Strategy] GEO-BLOCKED: Auto-switching to paper trading mode`);
      }
    }
  }

  private async executeUnwind(config: BotConfig, data: MarketData): Promise<void> {
    const activeOrders = await this.orderManager.getActiveOrders();
    const buyOrders = activeOrders.filter(o => o.side === "BUY");

    if (buyOrders.length > 0) {
      for (const order of buyOrders) {
        await this.orderManager.cancelOrder(order.id);
      }
      await storage.createEvent({
        type: "INFO",
        message: `[UNWIND] Cancelled ${buyOrders.length} pending BUY orders — holding positions to resolution`,
        data: { cancelledBuys: buyOrders.length },
        level: "info",
      });
    }

    const positions = await storage.getPositions();
    const openPositions = positions.filter(p => p.size > 0);
    if (openPositions.length > 0) {
      const totalSize = openPositions.reduce((sum, p) => sum + p.size, 0);
      const avgEntry = openPositions.reduce((sum, p) => sum + p.avgEntryPrice * p.size, 0) / totalSize;
      await storage.createEvent({
        type: "INFO",
        message: `[UNWIND] Holding ${totalSize.toFixed(1)} shares @ avg $${avgEntry.toFixed(3)} to resolution (no selling)`,
        data: { totalSize, avgEntry, positionCount: openPositions.length },
        level: "info",
      });
    }
  }

  private hedgeLockRepriceTimers: ReturnType<typeof setTimeout>[] = [];

  private async executeHedgeLock(config: BotConfig, data: MarketData): Promise<void> {
    const activeOrders = await this.orderManager.getActiveOrders();
    if (activeOrders.length > 0) {
      await this.orderManager.cancelAllOrders();
      await storage.createEvent({
        type: "INFO",
        message: `[HEDGE_LOCK] Cancelled ${activeOrders.length} remaining orders — holding to resolution`,
        data: { cancelledOrders: activeOrders.length },
        level: "info",
      });
    }

    for (const t of this.hedgeLockRepriceTimers) clearTimeout(t);
    this.hedgeLockRepriceTimers = [];

    const positions = await storage.getPositions();
    const openPositions = positions.filter(p => p.size > 0);
    const remainingMs = this.getMarketRemainingMs();

    if (openPositions.length > 0) {
      const totalSize = openPositions.reduce((sum, p) => sum + p.size, 0);
      await storage.createEvent({
        type: "INFO",
        message: `[HEDGE_LOCK] ${Math.floor(remainingMs / 1000)}s to resolution — holding ${totalSize.toFixed(1)} shares (no selling)`,
        data: { totalSize, positionCount: openPositions.length, remainingMs },
        level: "info",
      });
    }
  }

  private async settleMarketResolution(config: BotConfig, data: MarketData): Promise<void> {
    const positions = await storage.getPositions();
    const openPositions = positions.filter(p => p.size > 0);

    if (openPositions.length === 0) return;

    const tokenUpId = config.currentMarketId || "";

    const oracleSignal = binanceOracle.getSignal();
    const btcWentUp = oracleSignal.delta > 0;

    for (const pos of openPositions) {
      const posTokenId = pos.tokenId || tokenUpId;
      const isTokenDown = posTokenId !== tokenUpId;

      const settlementPrice = isTokenDown
        ? (btcWentUp ? 0.00 : 1.00)
        : (btcWentUp ? 1.00 : 0.00);

      const realizedPnl = parseFloat(((settlementPrice - pos.avgEntryPrice) * pos.size).toFixed(4));

      await storage.createFill({
        orderId: "settlement",
        marketId: pos.marketId,
        tokenId: posTokenId,
        side: "SELL",
        price: settlementPrice,
        size: pos.size,
        fee: 0,
        isPaperTrade: config.isPaperTrading,
      });

      await storage.deletePosition(pos.id);

      this.riskManager.recordTradeResult(realizedPnl);
      await this.updateDailyPnl(realizedPnl, realizedPnl > 0, undefined, 0);

      await storage.createEvent({
        type: "PNL_UPDATE",
        message: `[SETTLEMENT] Market resolved: ${isTokenDown ? "tokenDown" : "tokenUp"} settled @ $${settlementPrice.toFixed(2)} (entry: $${pos.avgEntryPrice.toFixed(4)}, size: ${pos.size}, PnL: ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(4)}) [BTC ${btcWentUp ? "UP" : "DOWN"}]`,
        data: {
          marketId: pos.marketId,
          tokenId: posTokenId,
          isTokenDown,
          settlementPrice,
          entryPrice: pos.avgEntryPrice,
          size: pos.size,
          realizedPnl,
          btcDirection: btcWentUp ? "UP" : "DOWN",
          oracleDelta: oracleSignal.delta,
        },
        level: realizedPnl >= 0 ? "info" : "warn",
      });
    }

    await storage.createEvent({
      type: "STATE_CHANGE",
      message: `[SETTLEMENT] ${openPositions.length} position(s) settled at market resolution`,
      data: { positionsSettled: openPositions.length },
      level: "info",
    });
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

    binanceOracle.markWindowStart();
    stopLossManager.clearAll();
    for (const t of this.hedgeLockRepriceTimers) clearTimeout(t);
    this.hedgeLockRepriceTimers = [];

    await storage.updateBotConfig({
      currentMarketId: market.tokenUp,
      currentMarketSlug: market.slug,
      currentMarketNegRisk: market.negRisk,
      currentMarketTickSize: String(market.tickSize),
      currentMarketTokenDown: market.tokenDown,
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

    const activeTokenId = config.currentMarketId || market.tokenUp;
    const assetIds = [activeTokenId];
    polymarketWs.setActiveAssetId(activeTokenId);
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
      return [activeTokenId];
    });

    if (!config.isPaperTrading && liveTradingClient.isInitialized()) {
      const creds = liveTradingClient.getApiCreds();
      if (creds) {
        polymarketWs.connectUser([activeTokenId], creds);
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

    this.marketData.startRestPolling();

    this.wsSetup = true;
  }

  private async updateDailyPnl(pnl: number, isWin: boolean, tradeValue?: number, fee?: number): Promise<void> {
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
        volume: parseFloat((existing.volume + (tradeValue || Math.abs(pnl))).toFixed(4)),
        fees: parseFloat((existing.fees + (fee || 0)).toFixed(4)),
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
        volume: tradeValue || Math.abs(pnl),
        fees: fee || 0,
      });
    }
  }

  getMarketDataModule(): MarketDataModule {
    return this.marketData;
  }

  getOrderManager(): OrderManager {
    return this.orderManager;
  }

  getMarketDataStatus(): { source: string; wsActive: boolean; restPolling: boolean; lastUpdate: number | null } {
    return this.marketData.getDataSourceStatus();
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

    const sizerStatus = await progressiveSizer.getStatus();

    return {
      config: config || {
        id: "",
        isActive: false,
        isPaperTrading: true,
        currentState: "STOPPED",
        minSpread: 0.005,
        targetProfitMin: 0.40,
        targetProfitMax: 0.53,
        maxNetExposure: 200,
        maxDailyLoss: 50,
        maxConsecutiveLosses: 3,
        orderSize: 5,
        killSwitchActive: false,
        currentMarketId: null,
        currentMarketSlug: null,
        currentMarketNegRisk: false,
        currentMarketTickSize: "0.01",
        currentMarketTokenDown: null,
        autoRotate: false,
        autoRotateAsset: "btc",
        autoRotateInterval: "5m",
        updatedAt: new Date(),
      },
      marketData,
      marketDataNo: marketData ? {
        bestBid: parseFloat((1 - marketData.bestAsk).toFixed(4)),
        bestAsk: parseFloat((1 - marketData.bestBid).toFixed(4)),
        spread: marketData.spread,
        midpoint: parseFloat((1 - marketData.midpoint).toFixed(4)),
        bidDepth: marketData.askDepth,
        askDepth: marketData.bidDepth,
        lastPrice: parseFloat((1 - marketData.lastPrice).toFixed(4)),
        volume24h: marketData.volume24h,
      } : null,
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
      isLiquidating: false,
      cycleCount: this.cycleCount,
      oracle: binanceOracle.getStatus(),
      stopLoss: stopLossManager.getStatus(),
      progressiveSizer: sizerStatus,
      marketRegime: marketRegimeFilter.getStatus(marketData),
      lastEntry: this.lastEntryTokenSide ? {
        tokenSide: this.lastEntryTokenSide,
        price: this.lastEntryPrice!,
        size: this.lastEntrySize!,
      } : (positions.length > 0 && config?.currentMarketId ? (() => {
        const pos = positions[0];
        const tokenUpId = config.currentMarketId;
        const posTokenId = pos.tokenId || pos.marketId;
        const isTokenDown = posTokenId !== tokenUpId;
        return {
          tokenSide: isTokenDown ? "NO" as const : "YES" as const,
          price: pos.avgEntryPrice,
          size: pos.size,
        };
      })() : null),
    };
  }
}

export const strategyEngine = new StrategyEngine();
