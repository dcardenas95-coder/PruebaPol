import { storage } from "./storage";
import { db } from "./db";
import { orders, fills, positions, pnlRecords, botEvents } from "@shared/schema";

export async function seedDatabase() {
  const config = await storage.getBotConfig();

  if (!config) {
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
    console.log("Database initialized with default config");
  }

  const existingRecords = await storage.getPnlRecords();
  const hasSeedData = existingRecords.some(r => r.date <= "2026-02-14");
  if (hasSeedData) {
    await db.delete(pnlRecords);
    await db.delete(fills);
    await db.delete(orders);
    await db.delete(positions);
    await db.delete(botEvents);
    console.log("Cleaned all legacy/seed data from database");
  }
}
