import { Router } from "express";
import { db } from "../../db";
import { dualEntryConfig, dualEntryCycles, updateDualEntryConfigSchema } from "@shared/schema";
import { desc } from "drizzle-orm";
import { dualEntry5mEngine } from "./engine";

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
    const cycles = await db.select().from(dualEntryCycles).orderBy(desc(dualEntryCycles.createdAt)).limit(20);
    res.json(cycles);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
