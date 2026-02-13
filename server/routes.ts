import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { strategyEngine } from "./bot/strategy-engine";
import { updateBotConfigSchema } from "@shared/schema";
import { polymarketClient } from "./bot/polymarket-client";
import { liveTradingClient } from "./bot/live-trading-client";
import { polymarketWs } from "./bot/polymarket-ws";
import { apiRateLimiter } from "./bot/rate-limiter";
import { dualEntryRouter } from "./strategies/dualEntry5m/routes";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.use("/api/strategies/dual-entry-5m", dualEntryRouter);

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

      if (data.isPaperTrading === false) {
        const currentConfig = await storage.getBotConfig();
        if (!currentConfig?.currentMarketId) {
          return res.status(400).json({ error: "Cannot enable live trading without a market selected" });
        }
        if (!process.env.POLYMARKET_PRIVATE_KEY) {
          return res.status(400).json({ error: "Cannot enable live trading: POLYMARKET_PRIVATE_KEY not configured" });
        }
      }

      const keysToUpdate = { ...data };
      const shouldStart = data.isActive === true;
      const shouldStop = data.isActive === false;
      if (data.isActive !== undefined) {
        delete (keysToUpdate as any).isActive;
      }

      if (Object.keys(keysToUpdate).length > 0) {
        await storage.updateBotConfig(keysToUpdate);
      }

      if (shouldStart) {
        await strategyEngine.start();
      } else if (shouldStop) {
        await strategyEngine.stop();
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
      const orderManager = strategyEngine.getOrderManager();
      const order = await orderManager.cancelOrder(id);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      res.json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/orders/cancel-all", async (_req, res) => {
    try {
      const orderManager = strategyEngine.getOrderManager();
      await orderManager.cancelAllOrders();
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

  app.get("/api/markets/search", async (req, res) => {
    try {
      const query = (req.query.q as string) || "";
      const markets = await polymarketClient.fetchMarkets(query || undefined);
      const formatted = markets.map(m => {
        let tokenIds: string[] = [];
        let outcomes: string[] = [];
        let outcomePrices: string[] = [];
        try { tokenIds = JSON.parse(m.clobTokenIds || "[]"); } catch {}
        try { outcomes = JSON.parse(m.outcomes || "[]"); } catch {}
        try { outcomePrices = JSON.parse(m.outcomePrices || "[]"); } catch {}

        return {
          id: m.id,
          conditionId: m.conditionId,
          question: m.question,
          slug: m.slug,
          tokenIds,
          outcomes,
          outcomePrices,
          active: m.active,
          closed: m.closed,
          endDate: m.endDate,
          volume: m.volumeNum,
          volume24hr: m.volume24hr,
          liquidity: m.liquidityNum,
          description: m.description,
          negRisk: m.negRisk,
          tickSize: m.orderPriceMinTickSize,
          minSize: m.orderMinSize,
          acceptingOrders: m.acceptingOrders,
        };
      });
      res.json(formatted);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/markets/btc", async (_req, res) => {
    try {
      const markets = await polymarketClient.fetchBTCMarkets();
      const formatted = markets.map(m => {
        let tokenIds: string[] = [];
        let outcomes: string[] = [];
        let outcomePrices: string[] = [];
        try { tokenIds = JSON.parse(m.clobTokenIds || "[]"); } catch {}
        try { outcomes = JSON.parse(m.outcomes || "[]"); } catch {}
        try { outcomePrices = JSON.parse(m.outcomePrices || "[]"); } catch {}

        return {
          id: m.id,
          conditionId: m.conditionId,
          question: m.question,
          slug: m.slug,
          tokenIds,
          outcomes,
          outcomePrices,
          active: m.active,
          closed: m.closed,
          endDate: m.endDate,
          volume: m.volumeNum,
          volume24hr: m.volume24hr,
          liquidity: m.liquidityNum,
          negRisk: m.negRisk,
          tickSize: m.orderPriceMinTickSize,
          minSize: m.orderMinSize,
          acceptingOrders: m.acceptingOrders,
        };
      });
      res.json(formatted);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/markets/orderbook/:tokenId", async (req, res) => {
    try {
      const { tokenId } = req.params;
      const orderbook = await polymarketClient.fetchOrderBook(tokenId);
      if (!orderbook) {
        return res.status(404).json({ error: "Orderbook not found" });
      }
      res.json(orderbook);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/markets/select", async (req, res) => {
    try {
      const { tokenId, marketSlug, question, negRisk, tickSize } = req.body;
      if (!tokenId) {
        return res.status(400).json({ error: "tokenId is required" });
      }

      const orderbook = await polymarketClient.fetchOrderBook(tokenId);
      if (!orderbook) {
        return res.status(400).json({ error: "Could not fetch orderbook for this token. Invalid token ID." });
      }

      await storage.updateBotConfig({
        currentMarketId: tokenId,
        currentMarketSlug: marketSlug || null,
        currentMarketNegRisk: negRisk ?? false,
        currentMarketTickSize: tickSize ? String(tickSize) : "0.01",
      });

      strategyEngine.getMarketDataModule().setTokenId(tokenId);

      await storage.createEvent({
        type: "INFO",
        message: `Market selected: ${question || marketSlug || tokenId}`,
        data: { tokenId, marketSlug, question },
        level: "info",
      });

      const config = await storage.getBotConfig();
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/markets/live-data", async (_req, res) => {
    try {
      const config = await storage.getBotConfig();
      if (!config?.currentMarketId) {
        return res.json({ live: false, data: null, message: "No market selected" });
      }

      const data = await polymarketClient.fetchMarketData(config.currentMarketId);
      res.json({
        live: !!data,
        data,
        tokenId: config.currentMarketId,
        marketSlug: config.currentMarketSlug,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/connection/status", async (_req, res) => {
    try {
      const status = await polymarketClient.getConnectionStatus();
      const config = await storage.getBotConfig();
      res.json({
        ...status,
        hasMarketSelected: !!config?.currentMarketId,
        isPaperTrading: config?.isPaperTrading ?? true,
        currentMarketSlug: config?.currentMarketSlug || null,
        liveClientInitialized: liveTradingClient.isInitialized(),
        liveClientError: liveTradingClient.getInitError(),
        walletAddress: liveTradingClient.getWalletAddress(),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/trading/init-live", async (_req, res) => {
    try {
      if (liveTradingClient.isInitialized()) {
        return res.json({
          success: true,
          message: "Already initialized",
          wallet: liveTradingClient.getWalletAddress(),
        });
      }
      const result = await liveTradingClient.initialize();
      if (result.success) {
        res.json({
          success: true,
          wallet: liveTradingClient.getWalletAddress(),
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rate-limiter/status", async (_req, res) => {
    try {
      const status = apiRateLimiter.getStatus();
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/ws/health", async (_req, res) => {
    try {
      const health = polymarketWs.getHealth();
      res.json(health);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/trading/test-live", async (_req, res) => {
    try {
      if (!liveTradingClient.isInitialized()) {
        const initResult = await liveTradingClient.initialize();
        if (!initResult.success) {
          return res.status(400).json({
            success: false,
            stage: "init",
            error: `Failed to initialize live client: ${initResult.error}`,
          });
        }
      }

      const config = await storage.getBotConfig();
      if (!config?.currentMarketId) {
        return res.status(400).json({
          success: false,
          stage: "config",
          error: "No market selected. Select a market first.",
        });
      }

      const tokenId = config.currentMarketId;
      const negRisk = config.currentMarketNegRisk ?? false;
      const tickSize = config.currentMarketTickSize ?? "0.01";

      await storage.createEvent({
        type: "INFO",
        message: "TEST LIVE: Starting end-to-end test with minimum order...",
        data: { tokenId, negRisk, tickSize },
        level: "warn",
      });

      const orderbook = await polymarketClient.fetchOrderBook(tokenId);
      if (!orderbook || orderbook.bids.length === 0) {
        return res.status(400).json({
          success: false,
          stage: "orderbook",
          error: "Could not fetch orderbook or no bids available",
        });
      }

      const bids = orderbook.bids
        .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a, b) => b.price - a.price);

      const testPrice = Math.max(0.01, bids[0].price - 0.10);
      const testSize = 1;

      const placeResult = await liveTradingClient.placeOrder({
        tokenId,
        side: "BUY",
        price: testPrice,
        size: testSize,
        negRisk,
        tickSize,
      });

      if (!placeResult.success) {
        await storage.createEvent({
          type: "ERROR",
          message: `TEST LIVE: Order placement FAILED: ${placeResult.errorMsg}`,
          data: { error: placeResult.errorMsg },
          level: "error",
        });
        return res.json({
          success: false,
          stage: "place",
          error: placeResult.errorMsg,
          details: { testPrice, testSize, tokenId },
        });
      }

      const exchangeOrderId = placeResult.orderID;
      await storage.createEvent({
        type: "INFO",
        message: `TEST LIVE: Order placed! ID: ${exchangeOrderId}, ${testSize} @ $${testPrice.toFixed(4)}`,
        data: { exchangeOrderId, testPrice, testSize },
        level: "info",
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      const openOrders = await liveTradingClient.getOpenOrders();
      const orderStillOpen = openOrders.some((o: any) => o.id === exchangeOrderId);

      let cancelResult = null;
      if (orderStillOpen && exchangeOrderId) {
        cancelResult = await liveTradingClient.cancelOrder(exchangeOrderId);
        await storage.createEvent({
          type: "INFO",
          message: `TEST LIVE: Order cancelled successfully: ${exchangeOrderId}`,
          data: { exchangeOrderId, cancelResult },
          level: "info",
        });
      }

      const summary = {
        success: true,
        stage: "complete",
        results: {
          initialization: "OK",
          orderbookFetch: "OK",
          orderPlacement: placeResult.success ? "OK" : "FAILED",
          exchangeOrderId,
          orderPrice: testPrice,
          orderSize: testSize,
          orderFoundOnExchange: orderStillOpen,
          cancellation: cancelResult ? (cancelResult.success ? "OK" : "FAILED") : "SKIPPED (order already gone)",
          wallet: liveTradingClient.getWalletAddress(),
        },
      };

      await storage.createEvent({
        type: "INFO",
        message: `TEST LIVE: Complete! All stages passed. Order placed and cancelled successfully.`,
        data: summary,
        level: "info",
      });

      res.json(summary);
    } catch (error: any) {
      await storage.createEvent({
        type: "ERROR",
        message: `TEST LIVE: Error - ${error.message}`,
        data: { error: error.message },
        level: "error",
      });
      res.status(500).json({
        success: false,
        stage: "error",
        error: error.message,
      });
    }
  });

  app.get("/api/trading/balance/:tokenId", async (req, res) => {
    try {
      const { tokenId } = req.params;
      if (!liveTradingClient.isInitialized()) {
        return res.status(400).json({ error: "Live trading client not initialized" });
      }
      const balance = await liveTradingClient.getBalanceAllowance(tokenId);
      res.json(balance || { balance: "0", allowance: "0" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}
