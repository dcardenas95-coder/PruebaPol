import { Router } from "express";
import { db } from "../../db";
import { dualEntryConfig, dualEntryCycles, updateDualEntryConfigSchema } from "@shared/schema";
import { desc, sql, eq, and, isNotNull } from "drizzle-orm";
import { dualEntry5mEngine } from "./engine";
import { fetchCurrent5mMarket, fetchCurrentIntervalMarket, fetchUpcoming5mMarkets, computeNextIntervalSlug, type AssetType, type IntervalType } from "./market-5m-discovery";

export const dualEntryRouter = Router();

dualEntryRouter.get("/config", async (_req, res) => {
  try {
    const rows = await db.select().from(dualEntryConfig).limit(1);
    if (rows.length === 0) {
      const [created] = await db.insert(dualEntryConfig).values({}).returning();
      return res.json(created);
    }
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dualEntryRouter.post("/config", async (req, res) => {
  try {
    const parsed = updateDualEntryConfigSchema.parse(req.body);

    const rows = await db.select().from(dualEntryConfig).limit(1);
    if (rows.length === 0) {
      const [created] = await db.insert(dualEntryConfig).values({ ...parsed, updatedAt: new Date() }).returning();
      return res.json(created);
    }

    const [updated] = await db.update(dualEntryConfig)
      .set({ ...parsed, updatedAt: new Date() })
      .returning();
    res.json(updated);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

dualEntryRouter.post("/start", async (_req, res) => {
  try {
    const { storage } = await import("../../storage");
    const botConfig = await storage.getBotConfig();
    if (botConfig?.isActive) {
      return res.status(400).json({ success: false, error: "Cannot start Dual-Entry 5m while the main FSM bot is active (hold-to-resolution strategy conflict — SELL orders would be placed)" });
    }
    const result = await dualEntry5mEngine.start();
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

dualEntryRouter.post("/stop", async (_req, res) => {
  try {
    await dualEntry5mEngine.stop();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

dualEntryRouter.get("/status", async (_req, res) => {
  try {
    const status = dualEntry5mEngine.getStatus();
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dualEntryRouter.get("/cycles", async (_req, res) => {
  try {
    const cycles = await db.select().from(dualEntryCycles).orderBy(desc(dualEntryCycles.createdAt)).limit(50);
    res.json(cycles);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dualEntryRouter.get("/analytics", async (_req, res) => {
  try {
    const completedCycles = await db.select().from(dualEntryCycles)
      .where(and(
        eq(dualEntryCycles.state, "DONE"),
        isNotNull(dualEntryCycles.hourOfDay),
        isNotNull(dualEntryCycles.outcome),
      ))
      .orderBy(desc(dualEntryCycles.createdAt))
      .limit(500);

    const hourlyStats: Record<number, { total: number; wins: number; pnl: number; avgVol: number; volCount: number }> = {};
    for (let h = 0; h < 24; h++) {
      hourlyStats[h] = { total: 0, wins: 0, pnl: 0, avgVol: 0, volCount: 0 };
    }

    let totalCycles = 0;
    let totalWins = 0;
    let totalPnl = 0;
    let totalFlat = 0;
    let totalPartial = 0;

    for (const c of completedCycles) {
      const hour = c.hourOfDay ?? 0;
      const isWin = c.outcome === "TP_HIT" || c.outcome === "FULL_EXIT";
      const pnl = c.pnl ?? 0;

      hourlyStats[hour].total++;
      if (isWin) hourlyStats[hour].wins++;
      hourlyStats[hour].pnl += pnl;
      if (c.btcVolatility != null) {
        hourlyStats[hour].avgVol += c.btcVolatility;
        hourlyStats[hour].volCount++;
      }

      totalCycles++;
      if (isWin) totalWins++;
      totalPnl += pnl;
      if (c.outcome === "FLAT") totalFlat++;
      if (c.outcome === "PARTIAL_EXIT") totalPartial++;
    }

    for (const h of Object.keys(hourlyStats)) {
      const s = hourlyStats[parseInt(h)];
      if (s.volCount > 0) s.avgVol = s.avgVol / s.volCount;
    }

    const dayStats: Record<number, { total: number; wins: number; pnl: number }> = {};
    for (let d = 0; d < 7; d++) {
      dayStats[d] = { total: 0, wins: 0, pnl: 0 };
    }
    for (const c of completedCycles) {
      const day = c.dayOfWeek ?? 0;
      dayStats[day].total++;
      if (c.outcome === "TP_HIT" || c.outcome === "FULL_EXIT") dayStats[day].wins++;
      dayStats[day].pnl += c.pnl ?? 0;
    }

    const entryMethodStats: Record<string, { total: number; wins: number; pnl: number }> = {};
    for (const c of completedCycles) {
      const method = c.entryMethod ?? "fixed";
      if (!entryMethodStats[method]) entryMethodStats[method] = { total: 0, wins: 0, pnl: 0 };
      entryMethodStats[method].total++;
      if (c.outcome === "TP_HIT" || c.outcome === "FULL_EXIT") entryMethodStats[method].wins++;
      entryMethodStats[method].pnl += c.pnl ?? 0;
    }

    res.json({
      summary: {
        totalCycles,
        totalWins,
        winRate: totalCycles > 0 ? (totalWins / totalCycles * 100).toFixed(1) : "0",
        totalPnl: totalPnl.toFixed(4),
        totalFlat,
        totalPartial,
      },
      hourlyStats,
      dayStats,
      entryMethodStats,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dualEntryRouter.get("/5m/current", async (req, res) => {
  try {
    const asset = (req.query.asset as AssetType) || "btc";
    const interval = (req.query.interval as IntervalType) || "5m";
    const market = await fetchCurrentIntervalMarket(asset, interval);
    if (!market) {
      return res.json({ found: false, market: null, next: computeNextIntervalSlug(asset, interval) });
    }
    res.json({ found: true, market, next: computeNextIntervalSlug(asset, interval) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dualEntryRouter.get("/5m/upcoming", async (req, res) => {
  try {
    const asset = (req.query.asset as AssetType) || "btc";
    const count = Math.min(parseInt(req.query.count as string) || 3, 5);
    const markets = await fetchUpcoming5mMarkets(asset, count);
    res.json({ markets, next: computeNextIntervalSlug(asset) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dualEntryRouter.post("/5m/select", async (req, res) => {
  try {
    const asset = (req.query.asset as AssetType) || "btc";
    const interval = (req.query.interval as IntervalType) || "5m";
    const market = await fetchCurrentIntervalMarket(asset, interval);
    if (!market) {
      return res.status(404).json({ error: `No active ${interval} market found` });
    }

    const rows = await db.select().from(dualEntryConfig).limit(1);
    const updateData = {
      marketTokenYes: market.tokenUp,
      marketTokenNo: market.tokenDown,
      marketSlug: market.slug,
      marketQuestion: market.question,
      negRisk: market.negRisk,
      tickSize: String(market.tickSize),
      updatedAt: new Date(),
    };

    if (rows.length === 0) {
      const [created] = await db.insert(dualEntryConfig).values(updateData).returning();
      return res.json({ success: true, market, config: created });
    }

    const [updated] = await db.update(dualEntryConfig)
      .set(updateData)
      .returning();
    res.json({ success: true, market, config: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
