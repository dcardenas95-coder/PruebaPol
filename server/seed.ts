import { storage } from "./storage";
import { format, subDays } from "date-fns";

export async function seedDatabase() {
  const config = await storage.getBotConfig();
  if (config) return;

  await storage.upsertBotConfig({
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
    currentMarketSlug: "btc-5min-up-or-down",
  });

  const today = new Date();
  const pnlData = [
    { daysAgo: 6, realized: 2.35, trades: 12, wins: 8, losses: 4, volume: 120 },
    { daysAgo: 5, realized: -1.15, trades: 8, wins: 3, losses: 5, volume: 80 },
    { daysAgo: 4, realized: 4.22, trades: 15, wins: 11, losses: 4, volume: 150 },
    { daysAgo: 3, realized: 1.87, trades: 10, wins: 7, losses: 3, volume: 100 },
    { daysAgo: 2, realized: -0.45, trades: 6, wins: 2, losses: 4, volume: 60 },
    { daysAgo: 1, realized: 3.10, trades: 14, wins: 10, losses: 4, volume: 140 },
    { daysAgo: 0, realized: 0.95, trades: 5, wins: 3, losses: 2, volume: 50 },
  ];

  for (const d of pnlData) {
    const date = format(subDays(today, d.daysAgo), "yyyy-MM-dd");
    await storage.upsertPnlRecord({
      date,
      realizedPnl: d.realized,
      unrealizedPnl: parseFloat((Math.random() * 0.5 - 0.25).toFixed(2)),
      totalPnl: d.realized,
      tradesCount: d.trades,
      winCount: d.wins,
      lossCount: d.losses,
      volume: d.volume,
      fees: parseFloat((d.volume * 0.001).toFixed(2)),
    });
  }

  const sampleOrders = [
    { side: "BUY" as const, price: 0.4520, size: 10, status: "FILLED" as const, filledSize: 10 },
    { side: "SELL" as const, price: 0.4850, size: 10, status: "FILLED" as const, filledSize: 10 },
    { side: "BUY" as const, price: 0.4610, size: 10, status: "FILLED" as const, filledSize: 10 },
    { side: "SELL" as const, price: 0.4910, size: 10, status: "CANCELLED" as const, filledSize: 0 },
    { side: "BUY" as const, price: 0.4480, size: 10, status: "FILLED" as const, filledSize: 10 },
  ];

  for (const o of sampleOrders) {
    await storage.createOrder({
      clientOrderId: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      marketId: "btc-5min-sim",
      side: o.side,
      price: o.price,
      size: o.size,
      filledSize: o.filledSize,
      status: o.status,
      isPaperTrade: true,
    });
  }

  await storage.upsertPosition({
    marketId: "btc-5min-sim",
    side: "BUY",
    size: 10,
    avgEntryPrice: 0.4610,
    unrealizedPnl: 0.12,
    realizedPnl: 0.33,
  });

  const eventTypes = [
    { type: "INFO" as const, message: "Bot initialized in paper trading mode", level: "info" },
    { type: "STATE_CHANGE" as const, message: "State transition: STOPPED -> MAKING", level: "info" },
    { type: "ORDER_PLACED" as const, message: "BUY order placed: 10 @ $0.4520", level: "info" },
    { type: "ORDER_FILLED" as const, message: "Order filled: 10 @ $0.4518", level: "info" },
    { type: "ORDER_PLACED" as const, message: "SELL order placed: 10 @ $0.4850", level: "info" },
    { type: "ORDER_FILLED" as const, message: "Order filled: 10 @ $0.4852", level: "info" },
    { type: "PNL_UPDATE" as const, message: "Trade closed: +$0.33 realized PnL", level: "info" },
    { type: "STATE_CHANGE" as const, message: "State transition: MAKING -> UNWIND", level: "info" },
    { type: "STATE_CHANGE" as const, message: "State transition: UNWIND -> CLOSE_ONLY", level: "warn" },
    { type: "RISK_ALERT" as const, message: "Approaching daily loss limit", level: "warn" },
    { type: "STATE_CHANGE" as const, message: "Market cycle 1 completed, starting new cycle", level: "info" },
    { type: "ORDER_PLACED" as const, message: "BUY order placed: 10 @ $0.4610", level: "info" },
  ];

  for (const e of eventTypes) {
    await storage.createEvent({
      type: e.type,
      message: e.message,
      level: e.level,
      data: {},
    });
  }

  console.log("Database seeded with sample data");
}
