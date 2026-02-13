import { db } from "../../db";
import { dualEntryConfig, dualEntryCycles } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { liveTradingClient } from "../../bot/live-trading-client";
import { polymarketClient } from "../../bot/polymarket-client";
import type { CycleState, CycleContext, CycleLogEntry, StrategyConfig, EngineStatus } from "./types";

const WINDOW_DURATION_MS = 5 * 60 * 1000;

export class DualEntry5mEngine {
  private running = false;
  private currentCycle: CycleContext | null = null;
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

    if (!cfg.isDryRun && !liveTradingClient.isInitialized()) {
      const init = await liveTradingClient.initialize();
      if (!init.success) return { success: false, error: `Live client init failed: ${init.error}` };
    }

    await db.update(dualEntryConfig).set({ isActive: true, updatedAt: new Date() }).where(eq(dualEntryConfig.id, (await this.getConfigRow()).id));

    const lastCycles = await db.select().from(dualEntryCycles).orderBy(desc(dualEntryCycles.cycleNumber)).limit(1);
    this.cycleCounter = lastCycles.length > 0 ? lastCycles[0].cycleNumber : 0;

    this.log("ENGINE_START", `Strategy started. Dry-run: ${cfg.isDryRun}`);

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

    if (this.currentCycle) {
      this.clearCycleTimers();
      await this.transitionState("CLEANUP");
      await this.cleanupCycle("Strategy stopped by user");
    }

    const row = await this.getConfigRow();
    if (row) {
      await db.update(dualEntryConfig).set({ isActive: false, updatedAt: new Date() }).where(eq(dualEntryConfig.id, row.id));
    }

    this.log("ENGINE_STOP", "Strategy stopped");
    this.currentCycle = null;
    this.config = null;
  }

  getStatus(): EngineStatus {
    return {
      isRunning: this.running,
      currentCycle: this.currentCycle ? { ...this.currentCycle, timers: [] } : null,
      config: this.config,
      nextWindowStart: this.running ? this.getNextWindowStart() : null,
    };
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.config) return;

    try {
      if (!this.currentCycle) {
        const nextWindow = this.getNextWindowStart();
        const now = Date.now();
        const armTime = nextWindow.getTime() - this.config.entryLeadSecondsPrimary * 1000;

        if (now >= armTime) {
          await this.startNewCycle(nextWindow);
        }
        return;
      }

      await this.processCycleState();
    } catch (err: any) {
      this.logCycle("TICK_ERROR", err.message);
    }
  }

  private async startNewCycle(windowStart: Date): Promise<void> {
    this.cycleCounter++;
    const cycleNumber = this.cycleCounter;

    const [row] = await db.insert(dualEntryCycles).values({
      cycleNumber,
      state: "ARMED",
      windowStart,
      windowEnd: new Date(windowStart.getTime() + WINDOW_DURATION_MS),
      isDryRun: this.config!.isDryRun,
      logs: [],
    }).returning();

    this.currentCycle = {
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
    };

    this.logCycle("CYCLE_START", `Cycle #${cycleNumber} armed for window ${windowStart.toISOString()}`);
    await this.placeEntryOrders();
  }

  private async processCycleState(): Promise<void> {
    if (!this.currentCycle || !this.config) return;
    const now = Date.now();
    const windowMs = this.currentCycle.windowStart.getTime();
    const cfg = this.config;

    switch (this.currentCycle.state) {
      case "ARMED":
      case "ENTRY_WORKING": {
        const refreshTime = windowMs - cfg.entryLeadSecondsRefresh * 1000;
        if (now >= refreshTime && now < windowMs) {
          await this.refreshEntryOrders();
        }
        await this.checkEntryFills();
        if (now >= windowMs + cfg.postStartCleanupSeconds * 1000) {
          await this.postStartCleanup();
        }
        break;
      }

      case "PARTIAL_FILL": {
        if (now >= windowMs + cfg.postStartCleanupSeconds * 1000) {
          await this.handlePartialFill();
        }
        await this.checkEntryFills();
        break;
      }

      case "HEDGED": {
        await this.checkExitFills();
        break;
      }

      case "EXIT_WORKING": {
        await this.checkExitFills();
        break;
      }

      case "DONE":
      case "CLEANUP":
      case "FAILSAFE": {
        this.clearCycleTimers();
        await this.persistCycle();
        this.currentCycle = null;
        break;
      }
    }
  }

  private async placeEntryOrders(): Promise<void> {
    if (!this.currentCycle || !this.config) return;
    const cfg = this.config;
    const dedupeYes = `entry-yes-${this.currentCycle.cycleNumber}`;
    const dedupeNo = `entry-no-${this.currentCycle.cycleNumber}`;

    if (this.dedupeKeys.has(dedupeYes) && this.dedupeKeys.has(dedupeNo)) return;

    this.logCycle("PLACE_ENTRY", `Placing BUY YES @ ${cfg.entryPrice} & BUY NO @ ${cfg.entryPrice}, size=${cfg.orderSize}`);

    if (!this.dedupeKeys.has(dedupeYes)) {
      this.dedupeKeys.add(dedupeYes);
      const yesResult = await this.placeOrder({
        tokenId: cfg.marketTokenYes,
        side: "BUY",
        price: cfg.entryPrice,
        size: cfg.orderSize,
        label: "BUY YES entry",
      });
      if (yesResult.success) {
        this.currentCycle.yesOrderId = dedupeYes;
        this.currentCycle.yesExchangeOrderId = yesResult.orderID;
        this.logCycle("ORDER_YES", `YES order placed: ${yesResult.orderID}`);
      } else {
        this.logCycle("ORDER_YES_FAIL", `YES order failed: ${yesResult.errorMsg}`);
      }
    }

    if (!this.dedupeKeys.has(dedupeNo)) {
      this.dedupeKeys.add(dedupeNo);
      const noResult = await this.placeOrder({
        tokenId: cfg.marketTokenNo,
        side: "BUY",
        price: cfg.entryPrice,
        size: cfg.orderSize,
        label: "BUY NO entry",
      });
      if (noResult.success) {
        this.currentCycle.noOrderId = dedupeNo;
        this.currentCycle.noExchangeOrderId = noResult.orderID;
        this.logCycle("ORDER_NO", `NO order placed: ${noResult.orderID}`);
      } else {
        this.logCycle("ORDER_NO_FAIL", `NO order failed: ${noResult.errorMsg}`);
      }
    }

    await this.transitionState("ENTRY_WORKING");
  }

  private async refreshEntryOrders(): Promise<void> {
    if (!this.currentCycle || !this.config) return;
    const dedupeRefresh = `refresh-${this.currentCycle.cycleNumber}`;
    if (this.dedupeKeys.has(dedupeRefresh)) return;
    this.dedupeKeys.add(dedupeRefresh);

    const cfg = this.config;
    this.logCycle("REFRESH", "T-30s refresh: checking unfilled orders");

    if (!this.currentCycle.yesFilled && this.currentCycle.yesExchangeOrderId) {
      await this.cancelOrder(this.currentCycle.yesExchangeOrderId, "refresh YES");
      const newDedupeYes = `refresh-yes-${this.currentCycle.cycleNumber}`;
      this.dedupeKeys.add(newDedupeYes);
      const yesResult = await this.placeOrder({
        tokenId: cfg.marketTokenYes,
        side: "BUY",
        price: cfg.entryPrice,
        size: cfg.orderSize,
        label: "BUY YES refresh",
      });
      if (yesResult.success) {
        this.currentCycle.yesExchangeOrderId = yesResult.orderID;
        this.logCycle("REFRESH_YES", `YES refreshed: ${yesResult.orderID}`);
      }
    }

    if (!this.currentCycle.noFilled && this.currentCycle.noExchangeOrderId) {
      await this.cancelOrder(this.currentCycle.noExchangeOrderId, "refresh NO");
      const newDedupeNo = `refresh-no-${this.currentCycle.cycleNumber}`;
      this.dedupeKeys.add(newDedupeNo);
      const noResult = await this.placeOrder({
        tokenId: cfg.marketTokenNo,
        side: "BUY",
        price: cfg.entryPrice,
        size: cfg.orderSize,
        label: "BUY NO refresh",
      });
      if (noResult.success) {
        this.currentCycle.noExchangeOrderId = noResult.orderID;
        this.logCycle("REFRESH_NO", `NO refreshed: ${noResult.orderID}`);
      }
    }
  }

  private async checkEntryFills(): Promise<void> {
    if (!this.currentCycle || !this.config) return;

    if (!this.currentCycle.yesFilled && this.currentCycle.yesExchangeOrderId) {
      const status = await this.getOrderStatus(this.currentCycle.yesExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        this.currentCycle.yesFilled = true;
        this.currentCycle.yesFilledSize = parseFloat(status.size_matched);
        this.currentCycle.yesFilledPrice = this.config.entryPrice;
        this.logCycle("FILL_YES", `YES filled: ${status.size_matched} @ ${this.config.entryPrice}`);
      }
    }

    if (!this.currentCycle.noFilled && this.currentCycle.noExchangeOrderId) {
      const status = await this.getOrderStatus(this.currentCycle.noExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        this.currentCycle.noFilled = true;
        this.currentCycle.noFilledSize = parseFloat(status.size_matched);
        this.currentCycle.noFilledPrice = this.config.entryPrice;
        this.logCycle("FILL_NO", `NO filled: ${status.size_matched} @ ${this.config.entryPrice}`);
      }
    }

    if (this.currentCycle.yesFilled && this.currentCycle.noFilled) {
      await this.transitionState("HEDGED");
      await this.placeExitOrders();
    } else if ((this.currentCycle.yesFilled || this.currentCycle.noFilled) && this.currentCycle.state === "ENTRY_WORKING") {
      await this.transitionState("PARTIAL_FILL");
    }
  }

  private async placeExitOrders(): Promise<void> {
    if (!this.currentCycle || !this.config) return;
    const cfg = this.config;

    const winner = await this.determineWinner();
    this.currentCycle.winnerSide = winner;
    this.logCycle("HEDGED", `Both legs filled. Winner: ${winner}`);

    const winnerToken = winner === "YES" ? cfg.marketTokenYes : cfg.marketTokenNo;
    const loserToken = winner === "YES" ? cfg.marketTokenNo : cfg.marketTokenYes;
    const winnerSize = winner === "YES" ? this.currentCycle.yesFilledSize : this.currentCycle.noFilledSize;
    const loserSize = winner === "YES" ? this.currentCycle.noFilledSize : this.currentCycle.yesFilledSize;

    const dedupeTp = `tp-${this.currentCycle.cycleNumber}`;
    const dedupeScratch = `scratch-${this.currentCycle.cycleNumber}`;

    if (!this.dedupeKeys.has(dedupeTp)) {
      this.dedupeKeys.add(dedupeTp);
      const tpResult = await this.placeOrder({
        tokenId: winnerToken,
        side: "SELL",
        price: cfg.tpPrice,
        size: winnerSize,
        label: `SELL ${winner} TP`,
      });
      if (tpResult.success) {
        this.currentCycle.tpOrderId = dedupeTp;
        this.currentCycle.tpExchangeOrderId = tpResult.orderID;
        this.logCycle("TP_PLACED", `TP order: SELL ${winner} ${winnerSize} @ ${cfg.tpPrice} (${tpResult.orderID})`);
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
      });
      if (scratchResult.success) {
        this.currentCycle.scratchOrderId = dedupeScratch;
        this.currentCycle.scratchExchangeOrderId = scratchResult.orderID;
        this.logCycle("SCRATCH_PLACED", `Scratch order: SELL loser ${loserSize} @ ${cfg.scratchPrice} (${scratchResult.orderID})`);
      }
    }

    await this.transitionState("EXIT_WORKING");
  }

  private async checkExitFills(): Promise<void> {
    if (!this.currentCycle) return;

    if (!this.currentCycle.tpFilled && this.currentCycle.tpExchangeOrderId) {
      const status = await this.getOrderStatus(this.currentCycle.tpExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        this.currentCycle.tpFilled = true;
        this.logCycle("TP_FILLED", `TP filled`);
      }
    }

    if (!this.currentCycle.scratchFilled && this.currentCycle.scratchExchangeOrderId) {
      const status = await this.getOrderStatus(this.currentCycle.scratchExchangeOrderId);
      if (status && parseFloat(status.size_matched || "0") > 0) {
        this.currentCycle.scratchFilled = true;
        this.logCycle("SCRATCH_FILLED", `Scratch filled`);
      }
    }

    if (this.currentCycle.tpFilled && this.currentCycle.scratchFilled) {
      await this.completeCycle("FULL_EXIT");
    } else if (this.currentCycle.tpFilled) {
      await this.completeCycle("TP_HIT");
    }
  }

  private async postStartCleanup(): Promise<void> {
    if (!this.currentCycle || !this.config) return;
    const dedupeCleanup = `cleanup-${this.currentCycle.cycleNumber}`;
    if (this.dedupeKeys.has(dedupeCleanup)) return;
    this.dedupeKeys.add(dedupeCleanup);

    if (!this.currentCycle.yesFilled && !this.currentCycle.noFilled) {
      this.logCycle("FLAT", "T+10s: No fills. Cancelling all and ending cycle.");
      if (this.currentCycle.yesExchangeOrderId) await this.cancelOrder(this.currentCycle.yesExchangeOrderId, "cleanup YES");
      if (this.currentCycle.noExchangeOrderId) await this.cancelOrder(this.currentCycle.noExchangeOrderId, "cleanup NO");
      await this.completeCycle("FLAT");
    }
  }

  private async handlePartialFill(): Promise<void> {
    if (!this.currentCycle || !this.config) return;
    const dedupePartial = `partial-exit-${this.currentCycle.cycleNumber}`;
    if (this.dedupeKeys.has(dedupePartial)) return;
    this.dedupeKeys.add(dedupePartial);

    const cfg = this.config;
    this.logCycle("PARTIAL_CLEANUP", "T+10s: Only one leg filled. Cleaning up.");

    if (this.currentCycle.yesFilled && !this.currentCycle.noFilled) {
      if (this.currentCycle.noExchangeOrderId) await this.cancelOrder(this.currentCycle.noExchangeOrderId, "cancel unfilled NO");

      const bestBid = await this.getBestBid(cfg.marketTokenYes);
      const exitPrice = bestBid >= cfg.scratchPrice ? bestBid : cfg.scratchPrice;

      const result = await this.placeOrder({
        tokenId: cfg.marketTokenYes,
        side: "SELL",
        price: exitPrice,
        size: this.currentCycle.yesFilledSize,
        label: "SELL YES (partial exit)",
      });
      if (result.success) {
        this.logCycle("PARTIAL_EXIT", `Exiting YES @ ${exitPrice} (${result.orderID})`);
      }
    } else if (this.currentCycle.noFilled && !this.currentCycle.yesFilled) {
      if (this.currentCycle.yesExchangeOrderId) await this.cancelOrder(this.currentCycle.yesExchangeOrderId, "cancel unfilled YES");

      const bestBid = await this.getBestBid(cfg.marketTokenNo);
      const exitPrice = bestBid >= cfg.scratchPrice ? bestBid : cfg.scratchPrice;

      const result = await this.placeOrder({
        tokenId: cfg.marketTokenNo,
        side: "SELL",
        price: exitPrice,
        size: this.currentCycle.noFilledSize,
        label: "SELL NO (partial exit)",
      });
      if (result.success) {
        this.logCycle("PARTIAL_EXIT", `Exiting NO @ ${exitPrice} (${result.orderID})`);
      }
    }

    await this.completeCycle("PARTIAL_EXIT");
  }

  private async determineWinner(): Promise<"YES" | "NO"> {
    if (!this.config) return "YES";

    try {
      const yesMid = await polymarketClient.fetchMidpoint(this.config.marketTokenYes);
      const noMid = await polymarketClient.fetchMidpoint(this.config.marketTokenNo);
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

  private async completeCycle(outcome: string): Promise<void> {
    if (!this.currentCycle || !this.config) return;

    let pnl = 0;
    const cfg = this.config;
    if (outcome === "FULL_EXIT" || outcome === "TP_HIT") {
      const entryCost = (this.currentCycle.yesFilledSize * cfg.entryPrice) + (this.currentCycle.noFilledSize * cfg.entryPrice);
      const exitRevenue = (this.currentCycle.tpFilled ? (this.currentCycle.winnerSide === "YES" ? this.currentCycle.yesFilledSize : this.currentCycle.noFilledSize) * cfg.tpPrice : 0)
        + (this.currentCycle.scratchFilled ? (this.currentCycle.winnerSide === "YES" ? this.currentCycle.noFilledSize : this.currentCycle.yesFilledSize) * cfg.scratchPrice : 0);
      pnl = exitRevenue - entryCost;
    }

    this.currentCycle.outcome = outcome;
    this.currentCycle.pnl = pnl;
    this.logCycle("CYCLE_DONE", `Cycle complete: ${outcome}, PnL: $${pnl.toFixed(4)}`);
    await this.transitionState("DONE");
  }

  private async cleanupCycle(reason: string): Promise<void> {
    if (!this.currentCycle) return;

    if (this.currentCycle.yesExchangeOrderId && !this.currentCycle.yesFilled) {
      await this.cancelOrder(this.currentCycle.yesExchangeOrderId, "cleanup");
    }
    if (this.currentCycle.noExchangeOrderId && !this.currentCycle.noFilled) {
      await this.cancelOrder(this.currentCycle.noExchangeOrderId, "cleanup");
    }
    if (this.currentCycle.tpExchangeOrderId && !this.currentCycle.tpFilled) {
      await this.cancelOrder(this.currentCycle.tpExchangeOrderId, "cleanup TP");
    }
    if (this.currentCycle.scratchExchangeOrderId && !this.currentCycle.scratchFilled) {
      await this.cancelOrder(this.currentCycle.scratchExchangeOrderId, "cleanup scratch");
    }

    this.currentCycle.outcome = `CLEANUP: ${reason}`;
    this.logCycle("CLEANUP", reason);
    await this.transitionState("DONE");
  }

  private async transitionState(newState: CycleState): Promise<void> {
    if (!this.currentCycle) return;
    const oldState = this.currentCycle.state;
    this.currentCycle.state = newState;
    this.logCycle("STATE", `${oldState} → ${newState}`);
    await this.persistCycle();
  }

  private async persistCycle(): Promise<void> {
    if (!this.currentCycle) return;
    const c = this.currentCycle;

    try {
      await db.update(dualEntryCycles).set({
        state: c.state,
        yesOrderId: c.yesOrderId,
        noOrderId: c.noOrderId,
        yesExchangeOrderId: c.yesExchangeOrderId,
        noExchangeOrderId: c.noExchangeOrderId,
        yesFilled: c.yesFilled,
        noFilled: c.noFilled,
        yesFilledSize: c.yesFilledSize,
        noFilledSize: c.noFilledSize,
        yesFilledPrice: c.yesFilledPrice,
        noFilledPrice: c.noFilledPrice,
        winnerSide: c.winnerSide,
        tpOrderId: c.tpOrderId,
        scratchOrderId: c.scratchOrderId,
        tpExchangeOrderId: c.tpExchangeOrderId,
        scratchExchangeOrderId: c.scratchExchangeOrderId,
        tpFilled: c.tpFilled,
        scratchFilled: c.scratchFilled,
        outcome: c.outcome,
        pnl: c.pnl,
        logs: c.logs as any,
        updatedAt: new Date(),
      }).where(eq(dualEntryCycles.id, c.cycleId));
    } catch (err: any) {
      console.error("[DualEntry5m] Persist cycle error:", err.message);
    }
  }

  private async placeOrder(params: { tokenId: string; side: "BUY" | "SELL"; price: number; size: number; label: string }): Promise<{ success: boolean; orderID?: string; errorMsg?: string }> {
    if (!this.config) return { success: false, errorMsg: "No config" };

    if (this.config.isDryRun) {
      const fakeId = `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.logCycle("DRY_ORDER", `[DRY-RUN] ${params.label}: ${params.side} ${params.size} @ $${params.price} → ${fakeId}`);
      return { success: true, orderID: fakeId };
    }

    return await liveTradingClient.placeOrder({
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      negRisk: this.config.negRisk,
      tickSize: this.config.tickSize,
    });
  }

  private async cancelOrder(exchangeOrderId: string, reason: string): Promise<void> {
    if (!this.config) return;

    if (this.config.isDryRun) {
      this.logCycle("DRY_CANCEL", `[DRY-RUN] Cancel ${exchangeOrderId} (${reason})`);
      return;
    }

    try {
      await liveTradingClient.cancelOrder(exchangeOrderId);
      this.logCycle("CANCEL", `Cancelled ${exchangeOrderId} (${reason})`);
    } catch (err: any) {
      this.logCycle("CANCEL_FAIL", `Cancel failed ${exchangeOrderId}: ${err.message}`);
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

  private clearCycleTimers(): void {
    if (!this.currentCycle) return;
    for (const t of this.currentCycle.timers) {
      clearTimeout(t);
    }
    this.currentCycle.timers = [];
  }

  private logCycle(event: string, detail: string, data?: any): void {
    const entry: CycleLogEntry = { ts: Date.now(), event, detail, data };
    if (this.currentCycle) {
      this.currentCycle.logs.push(entry);
    }
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
    };
  }

  private async getConfigRow() {
    const rows = await db.select().from(dualEntryConfig).limit(1);
    return rows[0];
  }
}

export const dualEntry5mEngine = new DualEntry5mEngine();
