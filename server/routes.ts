import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { strategyEngine } from "./bot/strategy-engine";
import { updateBotConfigSchema } from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/bot/status", async (_req, res) => {
    try {
      const status = await strategyEngine.getStatus();
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/bot/config", async (_req, res) => {
    try {
      let config = await storage.getBotConfig();
      if (!config) {
        config = await storage.upsertBotConfig({
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
        });
      }
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/bot/config", async (req, res) => {
    try {
      const parsed = updateBotConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.message });
      }

      const data = parsed.data;

      if (data.isActive === true) {
        await strategyEngine.start();
      } else if (data.isActive === false) {
        await strategyEngine.stop();
      }

      const keysToUpdate = { ...data };
      if (data.isActive !== undefined) {
        delete (keysToUpdate as any).isActive;
      }

      if (Object.keys(keysToUpdate).length > 0) {
        await storage.updateBotConfig(keysToUpdate);
      }

      const config = await storage.getBotConfig();
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/bot/kill-switch", async (_req, res) => {
    try {
      const config = await storage.getBotConfig();
      if (config?.killSwitchActive) {
        await strategyEngine.deactivateKillSwitch();
      } else {
        await strategyEngine.killSwitch();
      }
      const updated = await storage.getBotConfig();
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/orders", async (_req, res) => {
    try {
      const allOrders = await storage.getOrders();
      res.json(allOrders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/orders/:id/cancel", async (req, res) => {
    try {
      const { id } = req.params;
      const order = await storage.updateOrderStatus(id, "CANCELLED");
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      await storage.createEvent({
        type: "ORDER_CANCELLED",
        message: `Order ${order.clientOrderId} manually cancelled`,
        data: { orderId: id },
        level: "info",
      });
      res.json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/orders/cancel-all", async (_req, res) => {
    try {
      await storage.cancelAllOpenOrders();
      await storage.createEvent({
        type: "ORDER_CANCELLED",
        message: "All open orders manually cancelled",
        data: {},
        level: "warn",
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/positions", async (_req, res) => {
    try {
      const allPositions = await storage.getPositions();
      res.json(allPositions);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/pnl", async (_req, res) => {
    try {
      const records = await storage.getPnlRecords();
      res.json(records);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/events", async (_req, res) => {
    try {
      const events = await storage.getEvents(300);
      res.json(events);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}
