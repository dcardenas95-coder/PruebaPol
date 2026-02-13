import { db } from "../../db";
import { dualEntryConfig, dualEntryCycles } from "@shared/schema";
import { eq, desc, sql } from "drizzle-orm";
import { liveTradingClient } from "../../bot/live-trading-client";
import { polymarketClient } from "../../bot/polymarket-client";
import { volatilityTracker } from "./volatility-tracker";
import type { CycleState, CycleContext, CycleLogEntry, StrategyConfig, EngineStatus, MarketSlot } from "./types";

const WINDOW_DURATION_MS = 5 * 60 * 1000;

export class DualEntry5mEngine {
  private running = false;
  private currentCycles: Map<string, CycleContext> = new Map();
  private config: StrategyConfig | null = null;
  private mainLoopInterval: ReturnType<typeof setInterval> | null = null;
  private cycleCounter = 0;
  private dedupeKeys = new Set<string>();

  async start(): Promise<{ success: boolean; error?: string }> {
    if (this.running) return { success: false, error: "Already running" };

    const cfg = await this.loadConfig();
    if (!cfg) return { success: false, error: "No config found" };
    if (!cfg.marketTokenYes || !cfg.marketTokenNo) {
      return { success: false, error: "Market tokens not configured (YES/NO)" };
    }

    this.config = cfg;
    this.running = true;
    this.dedupeKeys.clear();
    this.currentCycles.clear();

    if (!cfg.isDryRun && !liveTradingClient.isInitialized()) {
      const init = await liveTradingClient.initialize();
      if (!init.success) return { success: false, error: `Live client init failed: ${init.error}` };
    }

    await db.update(dualEntryConfig).set({ isActive: true, updatedAt: new Date() }).where(eq(dualEntryConfig.id, (await this.getConfigRow()).id));

    const lastCycles = await db.select().from(dualEntryCycles).orderBy(desc(dualEntryCycles.cycleNumber)).limit(1);
    this.cycleCounter = lastCycles.length > 0 ? lastCycles[0].cycleNumber : 0;

    volatilityTracker.start(cfg.marketTokenYes, cfg.marketTokenNo);

    this.log("ENGINE_START", `Strategy started. Dry-run: ${cfg.isDryRun}. Smart features: vol=${cfg.volFilterEnabled}, dynEntry=${cfg.dynamicEntryEnabled}, momTP=${cfg.momentumTpEnabled}, dynSize=${cfg.dynamicSizeEnabled}, smartCancel=${cfg.smartScratchCancel}, hourFilter=${cfg.hourFilterEnabled}, multiMarket=${cfg.multiMarketEnabled}`);

    this.mainLoopInterval = setInterval(() => this.tick(), 2000);
    this.tick();

    return { success: true };
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = null;
    }

    const keys = Array.from(this.currentCycles.keys());
    for (const key of keys) {
      const cycle = this.currentCycles.get(key);
      if (cycle) {
        this.clearCycleTimers(cycle);
        await this.transitionState(cycle, "CLEANUP");
        await this.cleanupCycle(cycle, "Strategy stopped by user");
      }
    }
    this.currentCycles.clear();

    volatilityTracker.stop();

    const row = await this.getConfigRow();
    if (row) {
      await db.update(dualEntryConfig).set({ isActive: false, updatedAt: new Date() }).where(eq(dualEntryConfig.id, row.id));
    }

    this.log("ENGINE_STOP", "Strategy stopped");
    this.config = null;
  }

  getStatus(): EngineStatus {
    const primaryCycle = this.currentCycles.get("primary") || null;
    return {
      isRunning: this.running,
      currentCycle: primaryCycle ? { ...primaryCycle, timers: [] } : null,
      config: this.config,
      nextWindowStart: this.running ? this.getNextWindowStart() : null,
      volatility: this.config ? volatilityTracker.getSnapshot(
        this.config.volWindowMinutes,
        this.config.volMinThreshold,
        this.config.volMaxThreshold
      ) : null,
      activeCycles: this.currentCycles.size,
    };
  }

  getAllCycleStatuses(): Array<CycleContext & { slotKey: string }> {
    const results: Array<CycleContext & { slotKey: string }> = [];
    const keys = Array.from(this.currentCycles.keys());
    for (const key of keys) {
      const cycle = this.currentCycles.get(key);
      if (cycle) {
        results.push({ ...cycle, timers: [], slotKey: key });
      }
    }
    return results;
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.config) return;

    try {
      const marketSlots = this.getMarketSlots();

      for (const slot of marketSlots) {
        const slotKey = slot.key;
        const cycle = this.currentCycles.get(slotKey);

        if (!cycle) {
          const nextWindow = this.getNextWindowStart();
          const now = Date.now();
          const armTime = nextWindow.getTime() - this.config.entryLeadSecondsPrimary * 1000;

          if (now >= armTime) {
            if (await this.shouldEnterCycle()) {
              await this.startNewCycle(nextWindow, slotKey, slot.tokenYes, slot.tokenNo, slot.negRisk, slot.tickSize);
            }
          }
        } else {
          await this.processCycleState(cycle, slotKey);
        }
      }
    } catch (err: any) {
      this.log("TICK_ERROR", err.message);
    }
  }

  private getMarketSlots(): Array<{ key: string; tokenYes: string; tokenNo: string; negRisk: boolean; tickSize: string }> {
    if (!this.config) return [];
    const slots = [{
      key: "primary",
      tokenYes: this.config.marketTokenYes,
      tokenNo: this.config.marketTokenNo,
      negRisk: this.config.negRisk,
      tickSize: this.config.tickSize,
    }];

    if (this.config.multiMarketEnabled && this.config.additionalMarkets.length > 0) {
      for (let i = 0; i < this.config.additionalMarkets.length; i++) {
        const m = this.config.additionalMarkets[i];
        slots.push({
          key: `market-${i}`,
          tokenYes: m.tokenYes,
          tokenNo: m.tokenNo,
          negRisk: m.negRisk,
          tickSize: m.tickSize,
        });
      }
    }
    return slots;
  }

  private async shouldEnterCycle(): Promise<boolean> {
    if (!this.config) return false;

    if (this.config.hourFilterEnabled && this.config.hourFilterAllowed.length > 0) {
      const currentHour = new Date().getUTCHours();
      if (!this.config.hourFilterAllowed.includes(currentHour)) {
        return false;
      }
    }

    if (this.config.volFilterEnabled) {
      const snapshot = volatilityTracker.getSnapshot(
        this.config.volWindowMinutes,
        this.config.volMinThreshold,
        this.config.volMaxThreshold
      );
      if (snapshot.priceCount >= 3 && !snapshot.withinRange) {
        this.log("VOL_FILTER", `Volatility ${snapshot.current.toFixed(3)} outside range [${snapshot.min}, ${snapshot.max}]. Skipping cycle.`);
        return false;
      }
    }

    return true;
  }

  private computeEntryPrice(): { price: number; method: string } {
    if (!this.config) return { price: 0.45, method: "fixed" };

    if (!this.config.dynamicEntryEnabled) {
      return { price: this.config.entryPrice, method: "fixed" };
    }

    const prices = volatilityTracker.getLatestPrices();
    if (!prices) return { price: this.config.entryPrice, method: "fixed" };

    const spread = Math.abs(prices.yesPrice - prices.noPrice);
    let dynamicPrice: number;
    if (spread > 0.2) {
      dynamicPrice = this.config.dynamicEntryMin;
    } else if (spread < 0.05) {
      dynamicPrice = this.config.dynamicEntryMax;
    } else {
      const ratio = (spread - 0.05) / 0.15;
      dynamicPrice = this.config.dynamicEntryMax - ratio * (this.config.dynamicEntryMax - this.config.dynamicEntryMin);
    }

    dynamicPrice = Math.max(this.config.dynamicEntryMin, Math.min(this.config.dynamicEntryMax, dynamicPrice));
    dynamicPrice = Math.round(dynamicPrice * 100) / 100;

    return { price: dynamicPrice, method: "dynamic" };
  }

  private computeTpPrice(): number {
    if (!this.config) return 0.65;

    if (!this.config.momentumTpEnabled) {
      return this.config.tpPrice;
    }

    const momentum = volatilityTracker.getMomentum(this.config.momentumWindowMinutes);
    const range = this.config.momentumTpMax - this.config.momentumTpMin;

    let tp: number;
    if (momentum.direction === "flat") {
      tp = this.config.momentumTpMin;
    } else {
      tp = this.config.momentumTpMin + momentum.strength * range;
    }

    tp = Math.max(this.config.momentumTpMin, Math.min(this.config.momentumTpMax, tp));
    tp = Math.round(tp * 100) / 100;

    return tp;
  }

  private computeOrderSize(tokenYes: string): number {
    if (!this.config) return 5;

    if (!this.config.dynamicSizeEnabled) {
      return this.config.orderSize;
    }

    const vol = volatilityTracker.getVolatility(this.config.volWindowMinutes);
    const minSize = this.config.dynamicSizeMin;
    const maxSize = this.config.dynamicSizeMax;

    let size: number;
    if (vol < 0.5) {
      size = minSize;
    } else if (vol > 3) {
      size = maxSize;
    } else {
      const ratio = (vol - 0.5) / 2.5;
      size = minSize + ratio * (maxSize - minSize);
    }

    size = Math.max(minSize, Math.min(maxSize, size));
    return Math.round(size);
  }

  private async startNewCycle(windowStart: Date, slotKey: string, tokenYes: string, tokenNo: string, negRisk: boolean, tickSize: string): Promise<void> {
    this.cycleCounter++;
    const cycleNumber = this.cycleCounter;

    const entry = this.computeEntryPrice();
    const tp = this.computeTpPrice();
    const orderSize = this.computeOrderSize(tokenYes);
    const vol = volatilityTracker.getVolatility(this.config?.volWindowMinutes ?? 15);

    const [row] = await db.insert(dualEntryCycles).values({
      cycleNumber,
      state: "ARMED",
      windowStart,
      windowEnd: new Date(windowStart.getTime() + WINDOW_DURATION_MS),
      isDryRun: this.config!.isDryRun,
      hourOfDay: new Date().getUTCHours(),
      dayOfWeek: new Date().getUTCDay(),
      btcVolatility: vol,
      entryMethod: entry.method,
      actualEntryPrice: entry.price,
      actualTpPrice: tp,
      actualOrderSize: orderSize,
      marketTokenYes: tokenYes,
      marketTokenNo: tokenNo,
      logs: [],
    }).returning();

    const cycle: CycleContext = {
      cycleId: row.id,
      cycleNumber,
      windowStart,
      state: "ARMED",
      yesFilled: false,
      noFilled: false,
      yesFilledSize: 0,
      noFilledSize: 0,
      tpFilled: false,
      scratchFilled: false,
      logs: [],
      timers: [],
      actualEntryPrice: entry.price,
      actualTpPrice: tp,
      actualOrderSize: orderSize,
      btcVolatility: vol,
      entryMethod: entry.method,
      marketTokenYes: tokenYes,
      marketTokenNo: tokenNo,
    };

    this.currentCycles.set(slotKey, cycle);
    this.logCycle(cycle, "CYCLE_START", `Cycle #${cycleNumber} armed. Entry: ${entry.price} (${entry.method}), TP: ${tp}, Size: ${orderSize}, Vol: ${vol.toFixed(3)}, Slot: ${slotKey}`);
    await this.placeEntryOrders(cycle, tokenYes, tokenNo, negRisk, tickSize);
  }

  private async processCycleState(cycle: CycleContext, slotKey: string): Promise<void> {
    if (!this.config) return;
    const now = Date.now();
    const windowMs = cycle.windowStart.getTime();
    const cfg = this.config;

    switch (cycle.state) {
      case "ARMED":
      case "ENTRY_WORKING": {
        const refreshTime = windowMs - cfg.entryLeadSecondsRefresh * 1000;
        if (now >= refreshTime && now < windowMs) {
          await this.refreshEntryOrders(cycle);
        }
        await this.checkEntryFills(cycle);
        if (now >= windowMs + cfg.postStartCleanupSeconds * 1000) {
          await this.postStartCleanup(cycle, slotKey);
        }
        break;
      }

      case "PARTIAL_FILL": {
        if (now >= windowMs + cfg.postStartCleanupSeconds * 1000) {
          await this.handlePartialFill(cycle, slotKey);
        }
        await this.checkEntryFills(cycle);
        break;
      }

      case "HEDGED":
      case "EXIT_WORKING": {
        await this.checkExitFills(cycle, slotKey);
        break;
      }

      case "DONE":
      case "CLEANUP":
      case "FAILSAFE": {
        this.clearCycleTimers(cycle);
        await this.persistCycle(cycle);
        this.currentCycles.delete(slotKey);
        break;
      }
    }
  }

  private async placeEntryOrders(cycle: CycleContext, tokenYes: string, tokenNo: string, negRisk: boolean, tickSize: string): Promise<void> {
    if (!this.config) return;
    const entryPrice = cycle.actualEntryPrice ?? this.config.entryPrice;
    const orderSize = cycle.actualOrderSize ?? this.config.orderSize;
    const dedupeYes = `entry-yes-${cycle.cycleNumber}`;
    const dedupeNo = `entry-no-${cycle.cycleNumber}`;

    if (this.dedupeKeys.has(dedupeYes) && this.dedupeKeys.has(dedupeNo)) return;

    this.logCycle(cycle, "PLACE_ENTRY", `Placing BUY YES @ ${entryPrice} & BUY NO @ ${entryPrice}, size=${orderSize}`);

    if (!this.dedupeKeys.has(dedupeYes)) {
      this.dedupeKeys.add(dedupeYes);
      const yesResult = await this.placeOrder({
        tokenId: tokenYes,
        side: "BUY",
        price: entryPrice,
        size: orderSize,
        label: "BUY YES entry",
        negRisk,
        tickSize,
      });
      if (yesResult.success) {
        cycle.yesOrderId = dedupeYes;
        cycle.yesExchangeOrderId = yesResult.orderID;
        this.logCycle(cycle, "ORDER_YES", `YES order placed: ${yesResult.orderID}`);
      } else {
        this.logCycle(cycle, "ORDER_YES_FAIL", `YES order failed: ${yesResult.errorMsg}`);
      }
    }

    if (!this.dedupeKeys.has(dedupeNo)) {
      this.dedupeKeys.add(dedupeNo);
      const noResult = await this.placeOrder({
        tokenId: tokenNo,
        side: "BUY",
        price: entryPrice,
        size: orderSize,
        label: "BUY NO entry",
        negRisk,
        tickSize,
      });
      if (noResult.success) {
        cycle.noOrderId = dedupeNo;
        cycle.noExchangeOrderId = noResult.orderID;
        this.logCycle(cycle, "ORDER_NO", `NO order placed: ${noResult.orderID}`);
      } else {
        this.logCycle(cycle, "ORDER_NO_FAIL", `NO order failed: ${noResult.errorMsg}`);
      }
    }

    await this.transitionState(cycle, "ENTRY_WORKING");
  }

  private async refreshEntryOrders(cycle: CycleContext): Promise<void> {
    if (!this.config) return;
    const dedupeRefresh = `refresh-${cycle.cycleNumber}`;
    if (this.dedupeKeys.has(dedupeRefresh)) return;
    this.dedupeKeys.add(dedupeRefresh);

    const cfg = this.config;
    const entryPrice = cycle.actualEntryPrice ?? cfg.entryPrice;
    const orderSize = cycle.actualOrderSize ?? cfg.orderSize;
    const tokenYes = cycle.marketTokenYes ?? cfg.marketTokenYes;
    const tokenNo = cycle.marketTokenNo ?? cfg.marketTokenNo;

    this.logCycle(cycle, "REFRESH", "T-30s refresh: checking unfilled orders");

    if (!cycle.yesFilled && cycle.yesExchangeOrderId) {
      await this.cancelOrder(cycle.yesExchangeOrderId, "refresh YES");
      this.dedupeKeys.add(`refresh-yes-${cycle.cycleNumber}`);
      const yesResult = await this.placeOrder({
        tokenId: tokenYes,
        side: "BUY",
        price: entryPrice,
        size: orderSize,
        label: "BUY YES refresh",
        negRisk: cfg.negRisk,
        tickSize: cfg.tickSize,
      });
      if (yesResult.success) {
        cycle.yesExchangeOrderId = yesResult.orderID;
        this.logCycle(cycle, "REFRESH_YES", `YES refreshed: ${yesResult.orderID}`);
      }
    }

    if (!cycle.noFilled && cycle.noExchangeOrderId) {
      await this.cancelOrder(cycle.noExchangeOrderId, "refresh NO");
      this.dedupeKeys.add(`refresh-no-${cycle.cycleNumber}`);
      const noResult = await this.placeOrder({
        tokenId: tokenNo,
        side: "BUY",
        price: entryPrice,
        size: orderSize,
        label: "BUY NO refresh",
        negRisk: cfg.negRisk,
        tickSize: cfg.tickSize,
      });
      if (noResult.success) {
        cycle.noExchangeOrderId = noResult.orderID;
        this.logCycle(cycle, "REFRESH_NO", `NO refreshed: ${noResult.orderID}`);
      }
    }
  }

  private async checkEntryFills(cycle: CycleContext): Promise<void> {
    if (!this.config) return;

    if (!cycle.yesFilled && cycle.yesExchangeOrderId) {
      const status = await this.getOrderStatus(cycle.yesExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        cycle.yesFilled = true;
        cycle.yesFilledSize = parseFloat(status.size_matched);
        cycle.yesFilledPrice = cycle.actualEntryPrice ?? this.config.entryPrice;
        this.logCycle(cycle, "FILL_YES", `YES filled: ${status.size_matched} @ ${cycle.yesFilledPrice}`);
      }
    }

    if (!cycle.noFilled && cycle.noExchangeOrderId) {
      const status = await this.getOrderStatus(cycle.noExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        cycle.noFilled = true;
        cycle.noFilledSize = parseFloat(status.size_matched);
        cycle.noFilledPrice = cycle.actualEntryPrice ?? this.config.entryPrice;
        this.logCycle(cycle, "FILL_NO", `NO filled: ${status.size_matched} @ ${cycle.noFilledPrice}`);
      }
    }

    if (cycle.yesFilled && cycle.noFilled) {
      await this.transitionState(cycle, "HEDGED");
      await this.placeExitOrders(cycle);
    } else if ((cycle.yesFilled || cycle.noFilled) && cycle.state === "ENTRY_WORKING") {
      await this.transitionState(cycle, "PARTIAL_FILL");
    }
  }

  private async placeExitOrders(cycle: CycleContext): Promise<void> {
    if (!this.config) return;
    const cfg = this.config;

    const winner = await this.determineWinner(cycle);
    cycle.winnerSide = winner;
    this.logCycle(cycle, "HEDGED", `Both legs filled. Winner: ${winner}`);

    const tokenYes = cycle.marketTokenYes ?? cfg.marketTokenYes;
    const tokenNo = cycle.marketTokenNo ?? cfg.marketTokenNo;
    const winnerToken = winner === "YES" ? tokenYes : tokenNo;
    const loserToken = winner === "YES" ? tokenNo : tokenYes;
    const winnerSize = winner === "YES" ? cycle.yesFilledSize : cycle.noFilledSize;
    const loserSize = winner === "YES" ? cycle.noFilledSize : cycle.yesFilledSize;
    const tpPrice = cycle.actualTpPrice ?? cfg.tpPrice;

    const dedupeTp = `tp-${cycle.cycleNumber}`;
    const dedupeScratch = `scratch-${cycle.cycleNumber}`;

    if (!this.dedupeKeys.has(dedupeTp)) {
      this.dedupeKeys.add(dedupeTp);
      const tpResult = await this.placeOrder({
        tokenId: winnerToken,
        side: "SELL",
        price: tpPrice,
        size: winnerSize,
        label: `SELL ${winner} TP`,
        negRisk: cfg.negRisk,
        tickSize: cfg.tickSize,
      });
      if (tpResult.success) {
        cycle.tpOrderId = dedupeTp;
        cycle.tpExchangeOrderId = tpResult.orderID;
        this.logCycle(cycle, "TP_PLACED", `TP order: SELL ${winner} ${winnerSize} @ ${tpPrice} (${tpResult.orderID})`);
      }
    }

    if (!this.dedupeKeys.has(dedupeScratch)) {
      this.dedupeKeys.add(dedupeScratch);
      const scratchResult = await this.placeOrder({
        tokenId: loserToken,
        side: "SELL",
        price: cfg.scratchPrice,
        size: loserSize,
        label: `SELL ${winner === "YES" ? "NO" : "YES"} scratch`,
        negRisk: cfg.negRisk,
        tickSize: cfg.tickSize,
      });
      if (scratchResult.success) {
        cycle.scratchOrderId = dedupeScratch;
        cycle.scratchExchangeOrderId = scratchResult.orderID;
        this.logCycle(cycle, "SCRATCH_PLACED", `Scratch order: SELL loser ${loserSize} @ ${cfg.scratchPrice} (${scratchResult.orderID})`);
      }
    }

    await this.transitionState(cycle, "EXIT_WORKING");
  }

  private async checkExitFills(cycle: CycleContext, slotKey: string): Promise<void> {
    if (!cycle) return;

    if (!cycle.tpFilled && cycle.tpExchangeOrderId) {
      const status = await this.getOrderStatus(cycle.tpExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        cycle.tpFilled = true;
        this.logCycle(cycle, "TP_FILLED", `TP filled`);

        if (this.config?.smartScratchCancel && cycle.scratchExchangeOrderId && !cycle.scratchFilled) {
          this.logCycle(cycle, "SMART_CANCEL", "TP filled → cancelling scratch (smart cancel)");
          await this.cancelOrder(cycle.scratchExchangeOrderId, "smart scratch cancel after TP fill");
          cycle.scratchFilled = false;
        }
      }
    }

    if (!cycle.scratchFilled && cycle.scratchExchangeOrderId) {
      const status = await this.getOrderStatus(cycle.scratchExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        cycle.scratchFilled = true;
        this.logCycle(cycle, "SCRATCH_FILLED", `Scratch filled`);
      }
    }

    if (cycle.tpFilled && cycle.scratchFilled) {
      await this.completeCycle(cycle, slotKey, "FULL_EXIT");
    } else if (cycle.tpFilled && this.config?.smartScratchCancel) {
      await this.completeCycle(cycle, slotKey, "TP_HIT");
    } else if (cycle.tpFilled) {
      await this.completeCycle(cycle, slotKey, "TP_HIT");
    }
  }

  private async postStartCleanup(cycle: CycleContext, slotKey: string): Promise<void> {
    if (!this.config) return;
    const dedupeCleanup = `cleanup-${cycle.cycleNumber}`;
    if (this.dedupeKeys.has(dedupeCleanup)) return;
    this.dedupeKeys.add(dedupeCleanup);

    if (!cycle.yesFilled && !cycle.noFilled) {
      this.logCycle(cycle, "FLAT", "T+10s: No fills. Cancelling all and ending cycle.");
      if (cycle.yesExchangeOrderId) await this.cancelOrder(cycle.yesExchangeOrderId, "cleanup YES");
      if (cycle.noExchangeOrderId) await this.cancelOrder(cycle.noExchangeOrderId, "cleanup NO");
      await this.completeCycle(cycle, slotKey, "FLAT");
    }
  }

  private async handlePartialFill(cycle: CycleContext, slotKey: string): Promise<void> {
    if (!this.config) return;
    const dedupePartial = `partial-exit-${cycle.cycleNumber}`;
    if (this.dedupeKeys.has(dedupePartial)) return;
    this.dedupeKeys.add(dedupePartial);

    const cfg = this.config;
    const tokenYes = cycle.marketTokenYes ?? cfg.marketTokenYes;
    const tokenNo = cycle.marketTokenNo ?? cfg.marketTokenNo;

    this.logCycle(cycle, "PARTIAL_CLEANUP", "T+10s: Only one leg filled. Cleaning up.");

    if (cycle.yesFilled && !cycle.noFilled) {
      if (cycle.noExchangeOrderId) await this.cancelOrder(cycle.noExchangeOrderId, "cancel unfilled NO");

      const bestBid = await this.getBestBid(tokenYes);
      const exitPrice = bestBid >= cfg.scratchPrice ? bestBid : cfg.scratchPrice;

      const result = await this.placeOrder({
        tokenId: tokenYes,
        side: "SELL",
        price: exitPrice,
        size: cycle.yesFilledSize,
        label: "SELL YES (partial exit)",
        negRisk: cfg.negRisk,
        tickSize: cfg.tickSize,
      });
      if (result.success) {
        this.logCycle(cycle, "PARTIAL_EXIT", `Exiting YES @ ${exitPrice} (${result.orderID})`);
      }
    } else if (cycle.noFilled && !cycle.yesFilled) {
      if (cycle.yesExchangeOrderId) await this.cancelOrder(cycle.yesExchangeOrderId, "cancel unfilled YES");

      const bestBid = await this.getBestBid(tokenNo);
      const exitPrice = bestBid >= cfg.scratchPrice ? bestBid : cfg.scratchPrice;

      const result = await this.placeOrder({
        tokenId: tokenNo,
        side: "SELL",
        price: exitPrice,
        size: cycle.noFilledSize,
        label: "SELL NO (partial exit)",
        negRisk: cfg.negRisk,
        tickSize: cfg.tickSize,
      });
      if (result.success) {
        this.logCycle(cycle, "PARTIAL_EXIT", `Exiting NO @ ${exitPrice} (${result.orderID})`);
      }
    }

    await this.completeCycle(cycle, slotKey, "PARTIAL_EXIT");
  }

  private async determineWinner(cycle: CycleContext): Promise<"YES" | "NO"> {
    if (!this.config) return "YES";
    const tokenYes = cycle.marketTokenYes ?? this.config.marketTokenYes;
    const tokenNo = cycle.marketTokenNo ?? this.config.marketTokenNo;

    try {
      const yesMid = await polymarketClient.fetchMidpoint(tokenYes);
      const noMid = await polymarketClient.fetchMidpoint(tokenNo);
      if (yesMid !== null && noMid !== null) {
        return yesMid >= noMid ? "YES" : "NO";
      }
    } catch {}

    return "YES";
  }

  private async getBestBid(tokenId: string): Promise<number> {
    try {
      const ob = await polymarketClient.fetchOrderBook(tokenId);
      if (ob && ob.bids.length > 0) {
        return parseFloat(ob.bids[0].price);
      }
    } catch {}
    return 0;
  }

  private async completeCycle(cycle: CycleContext, slotKey: string, outcome: string): Promise<void> {
    if (!this.config) return;

    let pnl = 0;
    const cfg = this.config;
    const entryPrice = cycle.actualEntryPrice ?? cfg.entryPrice;
    const tpPrice = cycle.actualTpPrice ?? cfg.tpPrice;

    if (outcome === "FULL_EXIT" || outcome === "TP_HIT") {
      const entryCost = (cycle.yesFilledSize * entryPrice) + (cycle.noFilledSize * entryPrice);
      const exitRevenue = (cycle.tpFilled ? (cycle.winnerSide === "YES" ? cycle.yesFilledSize : cycle.noFilledSize) * tpPrice : 0)
        + (cycle.scratchFilled ? (cycle.winnerSide === "YES" ? cycle.noFilledSize : cycle.yesFilledSize) * cfg.scratchPrice : 0);
      pnl = exitRevenue - entryCost;
    }

    cycle.outcome = outcome;
    cycle.pnl = pnl;
    this.logCycle(cycle, "CYCLE_DONE", `Cycle complete: ${outcome}, PnL: $${pnl.toFixed(4)}`);
    await this.transitionState(cycle, "DONE");
  }

  private async cleanupCycle(cycle: CycleContext, reason: string): Promise<void> {
    if (cycle.yesExchangeOrderId && !cycle.yesFilled) {
      await this.cancelOrder(cycle.yesExchangeOrderId, "cleanup");
    }
    if (cycle.noExchangeOrderId && !cycle.noFilled) {
      await this.cancelOrder(cycle.noExchangeOrderId, "cleanup");
    }
    if (cycle.tpExchangeOrderId && !cycle.tpFilled) {
      await this.cancelOrder(cycle.tpExchangeOrderId, "cleanup TP");
    }
    if (cycle.scratchExchangeOrderId && !cycle.scratchFilled) {
      await this.cancelOrder(cycle.scratchExchangeOrderId, "cleanup scratch");
    }

    cycle.outcome = `CLEANUP: ${reason}`;
    this.logCycle(cycle, "CLEANUP", reason);
    await this.transitionState(cycle, "DONE");
  }

  private async transitionState(cycle: CycleContext, newState: CycleState): Promise<void> {
    const oldState = cycle.state;
    cycle.state = newState;
    this.logCycle(cycle, "STATE", `${oldState} → ${newState}`);
    await this.persistCycle(cycle);
  }

  private async persistCycle(cycle: CycleContext): Promise<void> {
    try {
      await db.update(dualEntryCycles).set({
        state: cycle.state,
        yesOrderId: cycle.yesOrderId,
        noOrderId: cycle.noOrderId,
        yesExchangeOrderId: cycle.yesExchangeOrderId,
        noExchangeOrderId: cycle.noExchangeOrderId,
        yesFilled: cycle.yesFilled,
        noFilled: cycle.noFilled,
        yesFilledSize: cycle.yesFilledSize,
        noFilledSize: cycle.noFilledSize,
        yesFilledPrice: cycle.yesFilledPrice,
        noFilledPrice: cycle.noFilledPrice,
        winnerSide: cycle.winnerSide,
        tpOrderId: cycle.tpOrderId,
        scratchOrderId: cycle.scratchOrderId,
        tpExchangeOrderId: cycle.tpExchangeOrderId,
        scratchExchangeOrderId: cycle.scratchExchangeOrderId,
        tpFilled: cycle.tpFilled,
        scratchFilled: cycle.scratchFilled,
        outcome: cycle.outcome,
        pnl: cycle.pnl,
        logs: cycle.logs as any,
        actualEntryPrice: cycle.actualEntryPrice,
        actualTpPrice: cycle.actualTpPrice,
        actualOrderSize: cycle.actualOrderSize,
        btcVolatility: cycle.btcVolatility,
        entryMethod: cycle.entryMethod,
        updatedAt: new Date(),
      }).where(eq(dualEntryCycles.id, cycle.cycleId));
    } catch (err: any) {
      console.error("[DualEntry5m] Persist cycle error:", err.message);
    }
  }

  private async placeOrder(params: { tokenId: string; side: "BUY" | "SELL"; price: number; size: number; label: string; negRisk: boolean; tickSize: string }): Promise<{ success: boolean; orderID?: string; errorMsg?: string }> {
    if (!this.config) return { success: false, errorMsg: "No config" };

    if (this.config.isDryRun) {
      const fakeId = `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[DualEntry5m] [DRY_ORDER] ${params.label}: ${params.side} ${params.size} @ $${params.price} → ${fakeId}`);
      return { success: true, orderID: fakeId };
    }

    return await liveTradingClient.placeOrder({
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      negRisk: params.negRisk,
      tickSize: params.tickSize,
    });
  }

  private async cancelOrder(exchangeOrderId: string, reason: string): Promise<void> {
    if (!this.config) return;

    if (this.config.isDryRun) {
      console.log(`[DualEntry5m] [DRY_CANCEL] Cancel ${exchangeOrderId} (${reason})`);
      return;
    }

    try {
      await liveTradingClient.cancelOrder(exchangeOrderId);
      console.log(`[DualEntry5m] [CANCEL] Cancelled ${exchangeOrderId} (${reason})`);
    } catch (err: any) {
      console.error(`[DualEntry5m] [CANCEL_FAIL] Cancel failed ${exchangeOrderId}: ${err.message}`);
    }
  }

  private async getOrderStatus(exchangeOrderId: string): Promise<any | null> {
    if (!this.config) return null;

    if (this.config.isDryRun) {
      return { size_matched: "0", original_size: String(this.config.orderSize) };
    }

    return await liveTradingClient.getOrderStatus(exchangeOrderId);
  }

  private getNextWindowStart(): Date {
    const now = Date.now();
    const fiveMin = WINDOW_DURATION_MS;
    const nextBoundary = Math.ceil(now / fiveMin) * fiveMin;
    return new Date(nextBoundary);
  }

  private clearCycleTimers(cycle: CycleContext): void {
    for (const t of cycle.timers) {
      clearTimeout(t);
    }
    cycle.timers = [];
  }

  private logCycle(cycle: CycleContext, event: string, detail: string, data?: any): void {
    const entry: CycleLogEntry = { ts: Date.now(), event, detail, data };
    cycle.logs.push(entry);
    console.log(`[DualEntry5m] [${event}] ${detail}`);
  }

  private log(event: string, detail: string): void {
    console.log(`[DualEntry5m] [${event}] ${detail}`);
  }

  private async loadConfig(): Promise<StrategyConfig | null> {
    const rows = await db.select().from(dualEntryConfig).limit(1);
    if (rows.length === 0) return null;
    const c = rows[0];
    if (!c.marketTokenYes || !c.marketTokenNo) return null;
    return {
      marketTokenYes: c.marketTokenYes,
      marketTokenNo: c.marketTokenNo,
      marketSlug: c.marketSlug || "",
      negRisk: c.negRisk,
      tickSize: c.tickSize,
      entryPrice: c.entryPrice,
      tpPrice: c.tpPrice,
      scratchPrice: c.scratchPrice,
      entryLeadSecondsPrimary: c.entryLeadSecondsPrimary,
      entryLeadSecondsRefresh: c.entryLeadSecondsRefresh,
      postStartCleanupSeconds: c.postStartCleanupSeconds,
      exitTtlSeconds: c.exitTtlSeconds,
      orderSize: c.orderSize,
      isDryRun: c.isDryRun,
      smartScratchCancel: c.smartScratchCancel,
      volFilterEnabled: c.volFilterEnabled,
      volMinThreshold: c.volMinThreshold,
      volMaxThreshold: c.volMaxThreshold,
      volWindowMinutes: c.volWindowMinutes,
      dynamicEntryEnabled: c.dynamicEntryEnabled,
      dynamicEntryMin: c.dynamicEntryMin,
      dynamicEntryMax: c.dynamicEntryMax,
      momentumTpEnabled: c.momentumTpEnabled,
      momentumTpMin: c.momentumTpMin,
      momentumTpMax: c.momentumTpMax,
      momentumWindowMinutes: c.momentumWindowMinutes,
      dynamicSizeEnabled: c.dynamicSizeEnabled,
      dynamicSizeMin: c.dynamicSizeMin,
      dynamicSizeMax: c.dynamicSizeMax,
      hourFilterEnabled: c.hourFilterEnabled,
      hourFilterAllowed: (c.hourFilterAllowed as number[]) || [],
      multiMarketEnabled: c.multiMarketEnabled,
      additionalMarkets: (c.additionalMarkets as MarketSlot[]) || [],
    };
  }

  private async getConfigRow() {
    const rows = await db.select().from(dualEntryConfig).limit(1);
    return rows[0];
  }
}

export const dualEntry5mEngine = new DualEntry5mEngine();
