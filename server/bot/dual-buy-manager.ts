import { storage } from "../storage";
import { fetchNextIntervalMarket, computeNextIntervalSlug, type AssetType, type IntervalType } from "../strategies/dualEntry5m/market-5m-discovery";
import { OrderManager } from "./order-manager";
import { apiRateLimiter } from "./rate-limiter";
import { liveTradingClient } from "./live-trading-client";
import type { BotConfig } from "@shared/schema";

export class DualBuyManager {
  private lastPlacedCycleSlug: string | null = null;
  private ordersPlacedThisCycle = 0;
  private placing = false;

  getStatus(config: BotConfig, marketRemainingMs: number) {
    const asset = (config.autoRotateAsset || "btc") as AssetType;
    const interval = (config.autoRotateInterval || "5m") as IntervalType;
    const leadSeconds = config.dualBuyLeadSeconds || 30;

    let nextPlacementIn: number | null = null;
    if (config.dualBuyEnabled && config.isActive) {
      const nextInfo = computeNextIntervalSlug(asset, interval);
      const msUntilNextMarket = nextInfo.startsInMs;
      const placementMs = msUntilNextMarket - (leadSeconds * 1000);
      if (placementMs > 0) {
        nextPlacementIn = Math.round(placementMs / 1000);
      } else if (this.lastPlacedCycleSlug !== nextInfo.slug) {
        nextPlacementIn = 0;
      }
    }

    return {
      enabled: config.dualBuyEnabled || false,
      price: config.dualBuyPrice || 0.45,
      size: config.dualBuySize || 1,
      leadSeconds,
      lastPlacedCycle: this.lastPlacedCycleSlug,
      ordersThisCycle: this.ordersPlacedThisCycle,
      nextPlacementIn,
    };
  }

  async tick(config: BotConfig, orderManager: OrderManager): Promise<void> {
    if (!config.dualBuyEnabled || !config.isActive || config.killSwitchActive) return;
    if (this.placing) return;

    const asset = (config.autoRotateAsset || "btc") as AssetType;
    const interval = (config.autoRotateInterval || "5m") as IntervalType;
    const leadSeconds = config.dualBuyLeadSeconds || 30;
    const price = config.dualBuyPrice || 0.45;
    const size = config.dualBuySize || 1;

    const nextInfo = computeNextIntervalSlug(asset, interval);
    const msUntilNextMarket = nextInfo.startsInMs;
    const leadMs = leadSeconds * 1000;

    if (msUntilNextMarket > leadMs) return;

    if (this.lastPlacedCycleSlug === nextInfo.slug) return;

    this.placing = true;
    try {
      await this.placeDualOrders(config, orderManager, nextInfo.slug, asset, interval, price, size);
    } finally {
      this.placing = false;
    }
  }

  private async placeDualOrders(
    config: BotConfig,
    orderManager: OrderManager,
    cycleSlug: string,
    asset: AssetType,
    interval: IntervalType,
    price: number,
    size: number
  ): Promise<void> {
    const rateCheck = await apiRateLimiter.canProceed();
    if (!rateCheck.allowed) {
      console.log(`[DualBuy] Rate limited, skipping cycle ${cycleSlug}`);
      return;
    }

    const market = await fetchNextIntervalMarket(asset, interval);

    if (!market) {
      console.log(`[DualBuy] Next market not found for cycle ${cycleSlug}, will retry`);
      return;
    }

    if (market.slug !== cycleSlug) {
      console.log(`[DualBuy] Slug mismatch: got ${market.slug}, expected ${cycleSlug}, skipping`);
      return;
    }

    if (!market.tokenUp || !market.tokenDown) {
      console.log(`[DualBuy] Missing token IDs for ${cycleSlug}`);
      return;
    }

    const negRisk = market.negRisk;
    const tickSize = String(market.tickSize || "0.01");
    const isPaper = config.isPaperTrading;

    if (!isPaper) {
      const balanceCheck = await apiRateLimiter.canProceed();
      if (!balanceCheck.allowed) return;

      let usdcBalance = 0;
      try {
        const collateral = await liveTradingClient.getCollateralBalance();
        apiRateLimiter.recordSuccess();
        if (collateral && parseFloat(collateral.balance) > 0) {
          const raw = parseFloat(collateral.balance);
          usdcBalance = raw > 1000 ? raw / 1e6 : raw;
        } else {
          const onChain = await liveTradingClient.getOnChainUsdcBalance();
          if (onChain) usdcBalance = parseFloat(onChain.total);
        }
      } catch (e) {
        console.error(`[DualBuy] Balance check failed:`, e);
        return;
      }

      const totalCost = price * size * 2;
      if (usdcBalance < totalCost) {
        await storage.createEvent({
          type: "RISK_ALERT",
          message: `[DualBuy] Insufficient balance: $${usdcBalance.toFixed(2)} < $${totalCost.toFixed(2)} needed`,
          data: { usdcBalance, totalCost, price, size },
          level: "warn",
        });
        return;
      }
    }

    this.ordersPlacedThisCycle = 0;

    try {
      await orderManager.placeOrder({
        marketId: market.slug,
        tokenId: market.tokenUp,
        tokenSide: "YES",
        side: "BUY",
        price,
        size,
        isPaperTrade: isPaper,
        negRisk,
        tickSize,
        isMakerOrder: true,
        oracleDirection: "DUAL_BUY",
        oracleConfidence: 0,
      });
      this.ordersPlacedThisCycle++;
      console.log(`[DualBuy] Placed YES BUY @ $${price} x${size} for ${cycleSlug}`);
    } catch (err: any) {
      console.error(`[DualBuy] YES order failed: ${err.message}`);
      await storage.createEvent({
        type: "ERROR",
        message: `[DualBuy] YES order failed: ${err.message}`,
        data: { side: "YES", price, size, error: err.message },
        level: "error",
      });
    }

    try {
      await orderManager.placeOrder({
        marketId: market.slug,
        tokenId: market.tokenDown,
        tokenSide: "NO",
        side: "BUY",
        price,
        size,
        isPaperTrade: isPaper,
        negRisk,
        tickSize,
        isMakerOrder: true,
        oracleDirection: "DUAL_BUY",
        oracleConfidence: 0,
      });
      this.ordersPlacedThisCycle++;
      console.log(`[DualBuy] Placed NO BUY @ $${price} x${size} for ${cycleSlug}`);
    } catch (err: any) {
      console.error(`[DualBuy] NO order failed: ${err.message}`);
      await storage.createEvent({
        type: "ERROR",
        message: `[DualBuy] NO order failed: ${err.message}`,
        data: { side: "NO", price, size, error: err.message },
        level: "error",
      });
    }

    this.lastPlacedCycleSlug = cycleSlug;

    await storage.createEvent({
      type: "ORDER_PLACED",
      message: `[DualBuy] Placed ${this.ordersPlacedThisCycle}/2 orders @ $${price} x${size} for cycle ${cycleSlug}`,
      data: {
        cycleSlug,
        price,
        size,
        ordersPlaced: this.ordersPlacedThisCycle,
        isPaper: isPaper,
        tokenUp: market.tokenUp,
        tokenDown: market.tokenDown,
      },
      level: "info",
    });
  }

  reset(): void {
    this.lastPlacedCycleSlug = null;
    this.ordersPlacedThisCycle = 0;
    this.placing = false;
  }
}

export const dualBuyManager = new DualBuyManager();
