import { storage } from "../storage";
import { randomUUID } from "crypto";
import type { Order, InsertOrder } from "@shared/schema";
import { liveTradingClient } from "./live-trading-client";

export class OrderManager {
  private orderTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly DEFAULT_ORDER_TTL = 5 * 60 * 1000;

  async reconcileOnStartup(): Promise<void> {
    if (!liveTradingClient.isInitialized()) return;

    await storage.createEvent({
      type: "RECONCILIATION",
      message: "Starting order reconciliation on boot...",
      data: {},
      level: "info",
    });

    const dbActiveOrders = await storage.getActiveOrders();
    const liveOrders = dbActiveOrders.filter(o => !o.isPaperTrade && o.exchangeOrderId);

    if (liveOrders.length === 0) {
      await storage.createEvent({
        type: "RECONCILIATION",
        message: "No live orders in DB to reconcile",
        data: {},
        level: "info",
      });
      return;
    }

    const exchangeOrders = await liveTradingClient.getOpenOrders();
    const exchangeMap = new Map<string, any>();
    for (const o of exchangeOrders) {
      exchangeMap.set(o.id, o);
    }

    let reconciled = 0;
    let cancelled = 0;
    let filled = 0;

    for (const dbOrder of liveOrders) {
      if (!dbOrder.exchangeOrderId) continue;

      const exchangeOrder = exchangeMap.get(dbOrder.exchangeOrderId);

      if (exchangeOrder) {
        const sizeMatched = parseFloat(exchangeOrder.size_matched || "0");
        if (sizeMatched > dbOrder.filledSize) {
          const newFillSize = sizeMatched - dbOrder.filledSize;
          const fillPrice = dbOrder.price;
          const fee = parseFloat((newFillSize * fillPrice * 0.001).toFixed(4));

          await storage.createFill({
            orderId: dbOrder.id,
            marketId: dbOrder.marketId,
            side: dbOrder.side,
            price: fillPrice,
            size: newFillSize,
            fee,
            isPaperTrade: false,
          });

          await storage.updateOrderStatus(dbOrder.id, "PARTIALLY_FILLED", sizeMatched);
          await this.updatePosition(dbOrder.marketId, dbOrder.side, newFillSize, fillPrice, fee);
          filled++;
        }
        reconciled++;
      } else {
        const orderInfo = await liveTradingClient.getOrderStatus(dbOrder.exchangeOrderId);
        const sizeMatched = parseFloat(orderInfo?.size_matched || "0");
        const originalSize = parseFloat(orderInfo?.original_size || String(dbOrder.size));

        if (sizeMatched > dbOrder.filledSize) {
          const newFillSize = sizeMatched - dbOrder.filledSize;
          const fillPrice = dbOrder.price;
          const fee = parseFloat((newFillSize * fillPrice * 0.001).toFixed(4));

          await storage.createFill({
            orderId: dbOrder.id,
            marketId: dbOrder.marketId,
            side: dbOrder.side,
            price: fillPrice,
            size: newFillSize,
            fee,
            isPaperTrade: false,
          });
          await this.updatePosition(dbOrder.marketId, dbOrder.side, newFillSize, fillPrice, fee);
          filled++;
        }

        const totalFilled = Math.max(sizeMatched, dbOrder.filledSize);
        if (totalFilled >= originalSize * 0.99) {
          await storage.updateOrderStatus(dbOrder.id, "FILLED", totalFilled);
        } else {
          await storage.updateOrderStatus(dbOrder.id, "CANCELLED", totalFilled);
          cancelled++;
        }
        reconciled++;
      }
    }

    await storage.createEvent({
      type: "RECONCILIATION",
      message: `Reconciliation complete: ${reconciled} checked, ${filled} fills found, ${cancelled} orphans cancelled`,
      data: { reconciled, filled, cancelled, totalDbOrders: liveOrders.length, totalExchangeOrders: exchangeOrders.length },
      level: "info",
    });
  }

  setOrderTimeout(orderId: string, ttlMs?: number): void {
    const ttl = ttlMs || this.DEFAULT_ORDER_TTL;

    if (this.orderTimeouts.has(orderId)) {
      clearTimeout(this.orderTimeouts.get(orderId)!);
    }

    const timer = setTimeout(async () => {
      this.orderTimeouts.delete(orderId);
      const order = await storage.getOrderById(orderId);
      if (!order || order.status === "FILLED" || order.status === "CANCELLED" || order.status === "REJECTED") {
        return;
      }

      await storage.createEvent({
        type: "ORDER_CANCELLED",
        message: `Order timed out after ${(ttl / 1000).toFixed(0)}s: ${order.clientOrderId}`,
        data: { orderId, ttlMs: ttl, side: order.side, price: order.price },
        level: "warn",
      });

      await this.cancelOrder(orderId);
    }, ttl);

    this.orderTimeouts.set(orderId, timer);
  }

  clearAllTimeouts(): void {
    this.orderTimeouts.forEach((timer) => {
      clearTimeout(timer);
    });
    this.orderTimeouts.clear();
  }

  async placeOrder(params: {
    marketId: string;
    tokenId?: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    isPaperTrade: boolean;
    negRisk?: boolean;
    tickSize?: string;
  }): Promise<Order> {
    const clientOrderId = `pm-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const existing = await storage.getOrderByClientId(clientOrderId);
    if (existing) {
      return existing;
    }

    if (!params.isPaperTrade) {
      return this.placeLiveOrder(params, clientOrderId);
    }

    const order = await storage.createOrder({
      clientOrderId,
      marketId: params.marketId,
      side: params.side,
      price: params.price,
      size: params.size,
      filledSize: 0,
      status: "OPEN",
      isPaperTrade: true,
    });

    await storage.createEvent({
      type: "ORDER_PLACED",
      message: `[PAPER] ${params.side} order placed: ${params.size} @ $${params.price.toFixed(4)}`,
      data: { orderId: order.id, clientOrderId, side: params.side, price: params.price, size: params.size },
      level: "info",
    });

    this.setOrderTimeout(order.id);
    return order;
  }

  private async placeLiveOrder(params: {
    marketId: string;
    tokenId?: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    isPaperTrade: boolean;
    negRisk?: boolean;
    tickSize?: string;
  }, clientOrderId: string): Promise<Order> {
    if (!liveTradingClient.isInitialized()) {
      const initResult = await liveTradingClient.initialize();
      if (!initResult.success) {
        await storage.createEvent({
          type: "ERROR",
          message: `Cannot place live order: ${initResult.error}`,
          data: { error: initResult.error },
          level: "error",
        });
        throw new Error(`Live trading not available: ${initResult.error}`);
      }
    }

    const order = await storage.createOrder({
      clientOrderId,
      marketId: params.marketId,
      side: params.side,
      price: params.price,
      size: params.size,
      filledSize: 0,
      status: "PENDING",
      isPaperTrade: false,
    });

    const sdkTokenId = params.tokenId || params.marketId;

    if (sdkTokenId.includes("sim") || sdkTokenId.length < 10) {
      await storage.updateOrderStatus(order.id, "REJECTED");
      await storage.createEvent({
        type: "ORDER_REJECTED",
        message: `[LIVE] Order rejected: Invalid token ID "${sdkTokenId}" — cannot place live orders with simulated tokens`,
        data: { orderId: order.id, clientOrderId, tokenId: sdkTokenId },
        level: "error",
      });
      throw new Error(`Order rejected: Invalid token ID "${sdkTokenId}" — select a real Polymarket market first`);
    }

    const result = await liveTradingClient.placeOrder({
      tokenId: sdkTokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      negRisk: params.negRisk ?? false,
      tickSize: params.tickSize ?? "0.01",
    });

    if (!result.success) {
      await storage.updateOrderStatus(order.id, "REJECTED");
      await storage.createEvent({
        type: "ORDER_REJECTED",
        message: `[LIVE] Order rejected: ${result.errorMsg}`,
        data: { orderId: order.id, clientOrderId, error: result.errorMsg },
        level: "error",
      });
      throw new Error(`Order rejected: ${result.errorMsg}`);
    }

    if (result.orderID) {
      await storage.updateOrderExchangeId(order.id, result.orderID);
    }
    await storage.updateOrderStatus(order.id, "OPEN");

    await storage.createEvent({
      type: "ORDER_PLACED",
      message: `[LIVE] ${params.side} order placed: ${params.size} @ $${params.price.toFixed(4)} (exchange: ${result.orderID})`,
      data: { orderId: order.id, clientOrderId, exchangeOrderId: result.orderID, side: params.side, price: params.price, size: params.size },
      level: "warn",
    });

    this.setOrderTimeout(order.id);
    return (await storage.getOrderById(order.id))!;
  }

  async cancelOrder(orderId: string): Promise<Order | undefined> {
    if (this.orderTimeouts.has(orderId)) {
      clearTimeout(this.orderTimeouts.get(orderId)!);
      this.orderTimeouts.delete(orderId);
    }

    const order = await storage.getOrderById(orderId);
    if (!order) return undefined;
    if (order.status !== "OPEN" && order.status !== "PENDING" && order.status !== "PARTIALLY_FILLED") {
      return order;
    }

    if (!order.isPaperTrade && order.exchangeOrderId) {
      const result = await liveTradingClient.cancelOrder(order.exchangeOrderId);
      if (!result.success) {
        await storage.createEvent({
          type: "ERROR",
          message: `[LIVE] Failed to cancel order on exchange: ${result.errorMsg}`,
          data: { orderId, exchangeOrderId: order.exchangeOrderId, error: result.errorMsg },
          level: "error",
        });
      }
    }

    const updated = await storage.updateOrderStatus(orderId, "CANCELLED");

    await storage.createEvent({
      type: "ORDER_CANCELLED",
      message: `${order.isPaperTrade ? "[PAPER]" : "[LIVE]"} Order cancelled: ${order.clientOrderId}`,
      data: { orderId, clientOrderId: order.clientOrderId },
      level: "info",
    });

    return updated;
  }

  async cancelAllOrders(): Promise<void> {
    const activeOrders = await storage.getActiveOrders();
    const hasLiveOrders = activeOrders.some(o => !o.isPaperTrade);

    if (hasLiveOrders && liveTradingClient.isInitialized()) {
      const result = await liveTradingClient.cancelAllOrders();
      if (!result.success) {
        await storage.createEvent({
          type: "ERROR",
          message: `[LIVE] Failed to cancel all on exchange: ${result.errorMsg}`,
          data: { error: result.errorMsg },
          level: "error",
        });
      }
    }

    await storage.cancelAllOpenOrders();
    await storage.createEvent({
      type: "ORDER_CANCELLED",
      message: "All open orders cancelled",
      data: { hadLiveOrders: hasLiveOrders },
      level: "warn",
    });
  }

  async pollLiveOrderStatuses(): Promise<{ filled: boolean; pnl: number }[]> {
    const results: { filled: boolean; pnl: number }[] = [];

    if (!liveTradingClient.isInitialized()) return results;

    const activeOrders = await storage.getActiveOrders();
    const liveOrders = activeOrders.filter(o => !o.isPaperTrade && o.exchangeOrderId);

    if (liveOrders.length === 0) return results;

    const exchangeOrders = await liveTradingClient.getOpenOrders();
    const exchangeMap = new Map<string, any>();
    for (const o of exchangeOrders) {
      exchangeMap.set(o.id, o);
    }

    for (const order of liveOrders) {
      if (!order.exchangeOrderId) continue;

      const exchangeOrder = exchangeMap.get(order.exchangeOrderId);

      if (exchangeOrder) {
        const sizeMatched = parseFloat(exchangeOrder.size_matched || "0");
        if (sizeMatched > order.filledSize) {
          const newFillSize = sizeMatched - order.filledSize;
          const fillPrice = order.price;
          const fee = parseFloat((newFillSize * fillPrice * 0.001).toFixed(4));

          await storage.createFill({
            orderId: order.id,
            marketId: order.marketId,
            side: order.side,
            price: fillPrice,
            size: newFillSize,
            fee,
            isPaperTrade: false,
          });

          await storage.updateOrderStatus(order.id, "PARTIALLY_FILLED", sizeMatched);

          await storage.createEvent({
            type: "ORDER_FILLED",
            message: `[LIVE] Partial fill: ${newFillSize.toFixed(2)} @ $${fillPrice.toFixed(4)} (${order.side})`,
            data: { orderId: order.id, fillPrice, fillSize: newFillSize, side: order.side, fee, totalMatched: sizeMatched },
            level: "info",
          });

          const pnl = await this.updatePosition(order.marketId, order.side, newFillSize, fillPrice, fee);
          results.push({ filled: true, pnl });
        }
      } else {
        const orderInfo = await liveTradingClient.getOrderStatus(order.exchangeOrderId);
        const sizeMatched = parseFloat(orderInfo?.size_matched || "0");
        const originalSize = parseFloat(orderInfo?.original_size || String(order.size));

        if (sizeMatched > order.filledSize) {
          const newFillSize = sizeMatched - order.filledSize;
          const fillPrice = order.price;
          const fee = parseFloat((newFillSize * fillPrice * 0.001).toFixed(4));

          await storage.createFill({
            orderId: order.id,
            marketId: order.marketId,
            side: order.side,
            price: fillPrice,
            size: newFillSize,
            fee,
            isPaperTrade: false,
          });

          const pnl = await this.updatePosition(order.marketId, order.side, newFillSize, fillPrice, fee);
          results.push({ filled: true, pnl });
        }

        const totalFilled = Math.max(sizeMatched, order.filledSize);
        if (totalFilled >= originalSize * 0.99) {
          await storage.updateOrderStatus(order.id, "FILLED", totalFilled);
          await storage.createEvent({
            type: "ORDER_FILLED",
            message: `[LIVE] Order fully filled: ${totalFilled.toFixed(2)} @ $${order.price.toFixed(4)} (${order.side})`,
            data: { orderId: order.id, totalFilled },
            level: "info",
          });
        } else {
          await storage.updateOrderStatus(order.id, "CANCELLED", totalFilled);
          await storage.createEvent({
            type: "ORDER_CANCELLED",
            message: `[LIVE] Order cancelled by exchange (filled: ${totalFilled.toFixed(2)}/${originalSize.toFixed(2)})`,
            data: { orderId: order.id, totalFilled, originalSize },
            level: "warn",
          });
        }
      }
    }

    return results;
  }

  async handleWsFill(fillData: {
    orderId: string;
    side: string;
    price: number;
    sizeMatched: number;
    status: string;
    timestamp: number;
  }): Promise<void> {
    const activeOrders = await storage.getActiveOrders();
    const matchingOrder = activeOrders.find(
      o => o.exchangeOrderId === fillData.orderId && !o.isPaperTrade,
    );

    if (!matchingOrder) return;

    const newFillSize = fillData.sizeMatched - matchingOrder.filledSize;
    if (newFillSize <= 0) return;

    const fillPrice = fillData.price > 0 ? fillData.price : matchingOrder.price;
    const fee = parseFloat((newFillSize * fillPrice * 0.001).toFixed(4));

    await storage.createFill({
      orderId: matchingOrder.id,
      marketId: matchingOrder.marketId,
      side: matchingOrder.side,
      price: fillPrice,
      size: newFillSize,
      fee,
      isPaperTrade: false,
    });

    const totalFilled = matchingOrder.filledSize + newFillSize;
    const isFull = totalFilled >= matchingOrder.size * 0.99;
    const newStatus = isFull ? "FILLED" : "PARTIALLY_FILLED";

    await storage.updateOrderStatus(matchingOrder.id, newStatus, totalFilled);

    await storage.createEvent({
      type: "ORDER_FILLED",
      message: `[LIVE/WS] ${isFull ? "Full" : "Partial"} fill: ${newFillSize.toFixed(2)} @ $${fillPrice.toFixed(4)} (${matchingOrder.side})`,
      data: {
        orderId: matchingOrder.id,
        exchangeOrderId: fillData.orderId,
        fillPrice,
        fillSize: newFillSize,
        totalFilled,
        side: matchingOrder.side,
        fee,
        source: "websocket",
      },
      level: "info",
    });

    const pnl = await this.updatePosition(matchingOrder.marketId, matchingOrder.side, newFillSize, fillPrice, fee);
    if (pnl !== 0) {
      console.log(`[OrderManager/WS] Fill processed: ${matchingOrder.side} ${newFillSize} @ ${fillPrice}, PnL: ${pnl}`);
    }

    if (fillData.status === "CANCELLED" || fillData.status === "DEAD") {
      if (!isFull) {
        await storage.updateOrderStatus(matchingOrder.id, "CANCELLED", totalFilled);
        await storage.createEvent({
          type: "ORDER_CANCELLED",
          message: `[LIVE/WS] Order cancelled by exchange after partial fill (${totalFilled.toFixed(2)}/${matchingOrder.size.toFixed(2)})`,
          data: { orderId: matchingOrder.id, totalFilled, originalSize: matchingOrder.size },
          level: "warn",
        });
      }
    }
  }

  async simulateFill(orderId: string): Promise<{ filled: boolean; pnl: number }> {
    const order = await storage.getOrderById(orderId);
    if (!order || order.status === "FILLED" || order.status === "CANCELLED" || order.status === "REJECTED") {
      return { filled: false, pnl: 0 };
    }

    const fillChance = Math.random();
    if (fillChance < 0.3) return { filled: false, pnl: 0 };

    const fillSize = order.size - order.filledSize;
    const slippage = (Math.random() - 0.5) * 0.002;
    const fillPrice = parseFloat((order.price + slippage).toFixed(4));
    const fee = parseFloat((fillSize * fillPrice * 0.001).toFixed(4));

    await storage.createFill({
      orderId: order.id,
      marketId: order.marketId,
      side: order.side,
      price: fillPrice,
      size: fillSize,
      fee,
      isPaperTrade: order.isPaperTrade,
    });

    await storage.updateOrderStatus(orderId, "FILLED", order.size);

    await storage.createEvent({
      type: "ORDER_FILLED",
      message: `[PAPER] Order filled: ${fillSize.toFixed(2)} @ $${fillPrice.toFixed(4)} (${order.side})`,
      data: { orderId, fillPrice, fillSize, side: order.side, fee },
      level: "info",
    });

    const pnl = await this.updatePosition(order.marketId, order.side, fillSize, fillPrice, fee);
    return { filled: true, pnl };
  }

  private async updatePosition(marketId: string, side: string, fillSize: number, fillPrice: number, fee: number): Promise<number> {
    if (side === "BUY") {
      const existing = await storage.getPositionByMarket(marketId, "BUY");
      if (existing) {
        const newSize = existing.size + fillSize;
        const newCost = existing.size * existing.avgEntryPrice + fillSize * fillPrice;
        const newAvg = newCost / newSize;
        await storage.upsertPosition({
          marketId,
          side: "BUY",
          size: parseFloat(newSize.toFixed(4)),
          avgEntryPrice: parseFloat(newAvg.toFixed(4)),
          unrealizedPnl: existing.unrealizedPnl,
          realizedPnl: existing.realizedPnl,
        });
      } else {
        await storage.upsertPosition({
          marketId,
          side: "BUY",
          size: fillSize,
          avgEntryPrice: fillPrice,
          unrealizedPnl: 0,
          realizedPnl: 0,
        });
      }

      await storage.createEvent({
        type: "POSITION_UPDATE",
        message: `Position opened/increased: BUY ${fillSize.toFixed(2)} @ $${fillPrice.toFixed(4)}`,
        data: { marketId, side: "BUY", fillSize, fillPrice },
        level: "info",
      });

      return 0;
    } else {
      const buyPos = await storage.getPositionByMarket(marketId, "BUY");
      let realizedPnl = 0;

      if (buyPos && buyPos.size > 0) {
        const closeSize = Math.min(fillSize, buyPos.size);
        realizedPnl = parseFloat(((fillPrice - buyPos.avgEntryPrice) * closeSize - fee).toFixed(4));
        const remainingSize = parseFloat((buyPos.size - closeSize).toFixed(4));

        if (remainingSize <= 0.001) {
          await storage.deletePosition(buyPos.id);
        } else {
          await storage.upsertPosition({
            marketId,
            side: "BUY",
            size: remainingSize,
            avgEntryPrice: buyPos.avgEntryPrice,
            unrealizedPnl: 0,
            realizedPnl: parseFloat((buyPos.realizedPnl + realizedPnl).toFixed(4)),
          });
        }

        await storage.createEvent({
          type: "PNL_UPDATE",
          message: `Trade closed: ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(4)} realized PnL`,
          data: {
            marketId,
            entryPrice: buyPos.avgEntryPrice,
            exitPrice: fillPrice,
            size: closeSize,
            realizedPnl,
          },
          level: realizedPnl >= 0 ? "info" : "warn",
        });
      }

      return realizedPnl;
    }
  }

  async getActiveOrders(): Promise<Order[]> {
    return storage.getActiveOrders();
  }
}
