import { storage } from "../storage";
import { randomUUID } from "crypto";
import type { Order, InsertOrder } from "@shared/schema";

export class OrderManager {
  async placeOrder(params: {
    marketId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    isPaperTrade: boolean;
  }): Promise<Order> {
    const clientOrderId = `pm-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const existing = await storage.getOrderByClientId(clientOrderId);
    if (existing) {
      return existing;
    }

    const order = await storage.createOrder({
      clientOrderId,
      marketId: params.marketId,
      side: params.side,
      price: params.price,
      size: params.size,
      filledSize: 0,
      status: "OPEN",
      isPaperTrade: params.isPaperTrade,
    });

    await storage.createEvent({
      type: "ORDER_PLACED",
      message: `${params.side} order placed: ${params.size} @ $${params.price.toFixed(4)}`,
      data: { orderId: order.id, clientOrderId, side: params.side, price: params.price, size: params.size },
      level: "info",
    });

    return order;
  }

  async cancelOrder(orderId: string): Promise<Order | undefined> {
    const order = await storage.getOrderById(orderId);
    if (!order) return undefined;
    if (order.status !== "OPEN" && order.status !== "PENDING" && order.status !== "PARTIALLY_FILLED") {
      return order;
    }

    const updated = await storage.updateOrderStatus(orderId, "CANCELLED");

    await storage.createEvent({
      type: "ORDER_CANCELLED",
      message: `Order cancelled: ${order.clientOrderId}`,
      data: { orderId, clientOrderId: order.clientOrderId },
      level: "info",
    });

    return updated;
  }

  async cancelAllOrders(): Promise<void> {
    await storage.cancelAllOpenOrders();
    await storage.createEvent({
      type: "ORDER_CANCELLED",
      message: "All open orders cancelled",
      data: {},
      level: "warn",
    });
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
      message: `Order filled: ${fillSize.toFixed(2)} @ $${fillPrice.toFixed(4)} (${order.side})`,
      data: { orderId, fillPrice, fillSize, side: order.side, fee },
      level: "info",
    });

    if (order.side === "BUY") {
      const existing = await storage.getPositionByMarket(order.marketId, "BUY");
      if (existing) {
        const newSize = existing.size + fillSize;
        const newCost = existing.size * existing.avgEntryPrice + fillSize * fillPrice;
        const newAvg = newCost / newSize;
        await storage.upsertPosition({
          marketId: order.marketId,
          side: "BUY",
          size: parseFloat(newSize.toFixed(4)),
          avgEntryPrice: parseFloat(newAvg.toFixed(4)),
          unrealizedPnl: existing.unrealizedPnl,
          realizedPnl: existing.realizedPnl,
        });
      } else {
        await storage.upsertPosition({
          marketId: order.marketId,
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
        data: { marketId: order.marketId, side: "BUY", fillSize, fillPrice },
        level: "info",
      });

      return { filled: true, pnl: 0 };
    } else {
      const buyPos = await storage.getPositionByMarket(order.marketId, "BUY");
      let realizedPnl = 0;

      if (buyPos && buyPos.size > 0) {
        const closeSize = Math.min(fillSize, buyPos.size);
        realizedPnl = parseFloat(((fillPrice - buyPos.avgEntryPrice) * closeSize - fee).toFixed(4));
        const remainingSize = parseFloat((buyPos.size - closeSize).toFixed(4));

        if (remainingSize <= 0.001) {
          await storage.deletePosition(buyPos.id);
        } else {
          await storage.upsertPosition({
            marketId: order.marketId,
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
            marketId: order.marketId,
            entryPrice: buyPos.avgEntryPrice,
            exitPrice: fillPrice,
            size: closeSize,
            realizedPnl,
          },
          level: realizedPnl >= 0 ? "info" : "warn",
        });
      }

      return { filled: true, pnl: realizedPnl };
    }
  }

  async getActiveOrders(): Promise<Order[]> {
    return storage.getActiveOrders();
  }
}
