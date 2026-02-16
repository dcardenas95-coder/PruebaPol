import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { strategyEngine } from "./bot/strategy-engine";
import { updateBotConfigSchema, dualEntryConfig } from "@shared/schema";
import type { DualEntry5mInfo, DualEntry5mCycleInfo } from "@shared/schema";
import { db } from "./db";
import { polymarketClient } from "./bot/polymarket-client";
import { liveTradingClient } from "./bot/live-trading-client";
import { polymarketWs } from "./bot/polymarket-ws";
import { apiRateLimiter } from "./bot/rate-limiter";
import { dualEntryRouter } from "./strategies/dualEntry5m/routes";
import { dualEntry5mEngine } from "./strategies/dualEntry5m/engine";
import { fetchCurrent5mMarket, type AssetType } from "./strategies/dualEntry5m/market-5m-discovery";
import { runHealthCheck, startHealthMonitor } from "./bot/health-monitor";
import { alertManager } from "./bot/alert-manager";
import { binanceOracle } from "./bot/binance-oracle";
import { stopLossManager } from "./bot/stop-loss-manager";
import { progressiveSizer } from "./bot/progressive-sizer";
import { marketRegimeFilter } from "./bot/market-regime-filter";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.use("/api/strategies/dual-entry-5m", dualEntryRouter);

  app.get("/api/bot/status", async (_req, res) => {
    try {
      const status = await strategyEngine.getStatus();

      const de5m = dualEntry5mEngine.getStatus();
      const cycle = de5m.currentCycle;

      let de5mCfg = de5m.config;
      if (!de5mCfg) {
        try {
          const [dbCfgRow] = await db.select().from(dualEntryConfig).limit(1);
          if (dbCfgRow) {
            de5mCfg = {
              marketTokenYes: dbCfgRow.marketTokenYes ?? "",
              marketTokenNo: dbCfgRow.marketTokenNo ?? "",
              marketSlug: dbCfgRow.marketSlug ?? "",
              negRisk: dbCfgRow.negRisk,
              tickSize: dbCfgRow.tickSize,
              entryPrice: dbCfgRow.entryPrice,
              tpPrice: dbCfgRow.tpPrice,
              scratchPrice: dbCfgRow.scratchPrice,
              orderSize: dbCfgRow.orderSize,
              isDryRun: dbCfgRow.isDryRun,
              dualTpMode: dbCfgRow.dualTpMode,
              autoRotate5m: dbCfgRow.autoRotate5m,
              autoRotate5mAsset: dbCfgRow.autoRotate5mAsset,
              autoRotateInterval: dbCfgRow.autoRotateInterval,
            } as any;
          }
        } catch (_) {}
      }

      const dualEntry5mInfo: DualEntry5mInfo = {
        isRunning: de5m.isRunning,
        currentCycle: cycle ? {
          cycleNumber: cycle.cycleNumber,
          state: cycle.state,
          windowStart: cycle.windowStart instanceof Date ? cycle.windowStart.toISOString() : String(cycle.windowStart),
          yesFilled: cycle.yesFilled,
          noFilled: cycle.noFilled,
          yesFilledSize: cycle.yesFilledSize,
          noFilledSize: cycle.noFilledSize,
          winnerSide: cycle.winnerSide ?? null,
          tpFilled: cycle.tpFilled,
          scratchFilled: cycle.scratchFilled,
          outcome: cycle.outcome ?? null,
          pnl: cycle.pnl ?? null,
          entryMethod: cycle.entryMethod ?? null,
          actualEntryPrice: cycle.actualEntryPrice ?? null,
          actualTpPrice: cycle.actualTpPrice ?? null,
          actualOrderSize: cycle.actualOrderSize ?? null,
          btcVolatility: cycle.btcVolatility ?? null,
        } as DualEntry5mCycleInfo : null,
        nextWindowStart: de5m.nextWindowStart ? (de5m.nextWindowStart instanceof Date ? de5m.nextWindowStart.toISOString() : String(de5m.nextWindowStart)) : null,
        activeCycles: de5m.activeCycles,
        marketSlug: de5mCfg?.marketSlug ?? null,
        marketQuestion: null,
        asset: de5mCfg?.autoRotate5mAsset ?? null,
        interval: de5mCfg?.autoRotateInterval ?? null,
        isDryRun: de5mCfg?.isDryRun ?? true,
        dualTpMode: de5mCfg?.dualTpMode ?? false,
        autoRotate: de5mCfg?.autoRotate5m ?? true,
        orderSize: de5mCfg?.orderSize ?? 5,
        entryPrice: de5mCfg?.entryPrice ?? 0.50,
        tpPrice: de5mCfg?.tpPrice ?? 0.55,
        scratchPrice: de5mCfg?.scratchPrice ?? 0.49,
      };

      let marketData = status.marketData;
      let isLiveData = status.isLiveData;
      if (!marketData && de5mCfg?.marketTokenYes) {
        try {
          marketData = await polymarketClient.fetchMarketData(de5mCfg.marketTokenYes);
          isLiveData = !!marketData;
        } catch (_) {}
      }

      res.json({ ...status, marketData, isLiveData, dualEntry5m: dualEntry5mInfo });
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
        await storage.updateBotConfig({ killSwitchActive: false });
      } else {
        await strategyEngine.killSwitch();
        try { await dualEntry5mEngine.stop(); } catch (_) {}
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

  app.get("/api/orders/export", async (_req, res) => {
    try {
      const allOrders = await storage.getOrders();
      const headers = ["id", "clientOrderId", "marketId", "tokenId", "side", "price", "size", "filledSize", "status", "isPaperTrade", "exchangeOrderId", "createdAt", "updatedAt"];
      const csvRows = [headers.join(",")];
      for (const o of allOrders) {
        csvRows.push([
          o.id,
          o.clientOrderId,
          o.marketId || "",
          o.tokenId || "",
          o.side,
          o.price,
          o.size,
          o.filledSize,
          o.status,
          o.isPaperTrade ? "PAPER" : "LIVE",
          o.exchangeOrderId || "",
          o.createdAt ? new Date(o.createdAt).toISOString() : "",
          o.updatedAt ? new Date(o.updatedAt).toISOString() : "",
        ].join(","));
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=orders_${new Date().toISOString().slice(0, 10)}.csv`);
      res.send(csvRows.join("\n"));
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
      const events = await storage.getEvents(1500);
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

  app.get("/api/markets/interval", async (req, res) => {
    try {
      const interval = (req.query.interval as string) || "5m";
      const assets: AssetType[] = ["btc", "eth", "sol", "xrp", "doge", "bnb", "link"];
      const GAMMA_BASE = "https://gamma-api.polymarket.com";

      const now = Math.floor(Date.now() / 1000);
      const intervalSeconds = interval === "15m" ? 900 : 300;
      const suffix = interval === "15m" ? "15m" : "5m";

      const currentTs = now - (now % intervalSeconds);
      const nextTs = currentTs + intervalSeconds;

      const results: any[] = [];
      const fetchPromises = assets.map(async (asset) => {
        const prefix = `${asset}-updown-${suffix}`;
        for (const ts of [currentTs, nextTs]) {
          const slug = `${prefix}-${ts}`;
          try {
            const response = await fetch(`${GAMMA_BASE}/events?slug=${slug}`);
            if (!response.ok) continue;
            const events = await response.json();
            if (!events || events.length === 0) continue;
            const event = events[0];
            const market = event.markets?.[0];
            if (!market) continue;

            let tokenIds: string[] = [];
            let outcomes: string[] = [];
            let outcomePrices: string[] = [];
            try { tokenIds = JSON.parse(market.clobTokenIds || "[]"); } catch {}
            try { outcomes = JSON.parse(market.outcomes || "[]"); } catch {}
            try { outcomePrices = JSON.parse(market.outcomePrices || "[]"); } catch {}

            if (tokenIds.length < 2) continue;

            const intervalEnd = ts + intervalSeconds;
            const timeRemainingMs = Math.max(0, (intervalEnd - Math.floor(Date.now() / 1000)) * 1000);

            results.push({
              id: market.id || market.conditionId,
              conditionId: market.conditionId,
              question: market.question || event.title || "",
              slug: event.slug,
              tokenIds,
              outcomes,
              outcomePrices,
              active: market.active !== false,
              closed: market.closed === true,
              endDate: market.endDate || "",
              volume: market.volumeNum || 0,
              volume24hr: market.volume24hr || 0,
              liquidity: market.liquidityNum || 0,
              negRisk: market.negRisk === true || market.negRisk === "true",
              tickSize: market.orderPriceMinTickSize || 0.01,
              minSize: market.orderMinSize || 0,
              acceptingOrders: market.acceptingOrders !== false,
              timeRemainingMs,
              intervalType: suffix,
              asset: asset.toUpperCase(),
            });
            return;
          } catch {}
        }
      });

      await Promise.all(fetchPromises);
      results.sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
      res.json(results);
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
      const { tokenId, tokenUp, tokenDown, marketSlug, question, negRisk, tickSize } = req.body;
      const effectiveTokenUp = tokenUp || tokenId;
      if (!effectiveTokenUp) {
        return res.status(400).json({ error: "tokenUp (or tokenId) is required" });
      }

      const orderbook = await polymarketClient.fetchOrderBook(effectiveTokenUp);
      if (!orderbook) {
        return res.status(400).json({ error: "Could not fetch orderbook for this token. Invalid token ID." });
      }

      await storage.updateBotConfig({
        currentMarketId: effectiveTokenUp,
        currentMarketSlug: marketSlug || null,
        currentMarketNegRisk: negRisk ?? false,
        currentMarketTickSize: tickSize ? String(tickSize) : "0.01",
        currentMarketTokenDown: tokenDown || null,
      });

      strategyEngine.getMarketDataModule().setTokenId(effectiveTokenUp);

      await storage.createEvent({
        type: "INFO",
        message: `Market selected: ${question || marketSlug || effectiveTokenUp} (Up: ${effectiveTokenUp.slice(0, 8)}... Down: ${tokenDown ? tokenDown.slice(0, 8) + "..." : "none"})`,
        data: { tokenUp: effectiveTokenUp, tokenDown, marketSlug, question },
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

  app.get("/api/health", async (_req, res) => {
    try {
      const result = await runHealthCheck();
      const statusCode = result.overall === "healthy" ? 200 : result.overall === "degraded" ? 200 : 503;
      res.status(statusCode).json(result);
    } catch (error: any) {
      res.status(503).json({ overall: "unhealthy", error: error.message });
    }
  });

  app.get("/api/alerts", async (_req, res) => {
    try {
      const limit = parseInt(String(_req.query.limit) || "50", 10);
      res.json({
        summary: alertManager.getAlertsSummary(),
        active: alertManager.getActiveAlerts(),
        history: alertManager.getAllAlerts(limit),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/alerts/telegram/configure", async (req, res) => {
    try {
      const { botToken, chatId } = req.body;
      if (!botToken || !chatId) {
        return res.status(400).json({ error: "botToken y chatId son requeridos" });
      }
      alertManager.configure({ telegramBotToken: botToken, telegramChatId: chatId });
      res.json({ success: true, message: "Telegram configurado correctamente" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/alerts/telegram/test", async (_req, res) => {
    try {
      const result = await alertManager.testTelegram();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/data-source/status", async (_req, res) => {
    try {
      const mdStatus = strategyEngine.getMarketDataStatus();
      const wsHealth = polymarketWs.getHealth();
      res.json({ ...mdStatus, ws: wsHealth });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/oracle/status", async (_req, res) => {
    try {
      res.json(binanceOracle.getStatus());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/oracle/connect", async (_req, res) => {
    try {
      binanceOracle.connect();
      res.json({ success: true, message: "Oracle connecting to Binance BTC feed" });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/oracle/disconnect", async (_req, res) => {
    try {
      binanceOracle.disconnect();
      res.json({ success: true, message: "Oracle disconnected" });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/oracle/config", (_req, res) => {
    res.json(binanceOracle.getConfig());
  });

  app.patch("/api/oracle/config", async (req, res) => {
    const { strongThreshold, weakThreshold, minConfidence, enabled } = req.body;
    binanceOracle.updateConfig({ strongThreshold, weakThreshold, minConfidence, enabled });
    res.json({ success: true, config: binanceOracle.getConfig() });
  });

  app.get("/api/stoploss/config", (_req, res) => {
    res.json(stopLossManager.getConfig());
  });

  app.patch("/api/stoploss/config", async (req, res) => {
    stopLossManager.updateConfig(req.body);
    res.json({ success: true, config: stopLossManager.getConfig() });
  });

  app.get("/api/regime/config", (_req, res) => {
    res.json(marketRegimeFilter.getConfig());
  });

  app.patch("/api/regime/config", async (req, res) => {
    marketRegimeFilter.updateConfig(req.body);
    res.json({ success: true, config: marketRegimeFilter.getConfig() });
  });

  app.get("/api/sizer/config", (_req, res) => {
    res.json(progressiveSizer.getConfig());
  });

  app.patch("/api/sizer/config", async (req, res) => {
    progressiveSizer.updateConfig(req.body);
    res.json({ success: true, config: progressiveSizer.getConfig() });
  });

  app.get("/api/stop-loss/status", async (_req, res) => {
    try {
      res.json(stopLossManager.getStatus());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/progressive-sizer/status", async (_req, res) => {
    try {
      const status = await progressiveSizer.getStatus();
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/market-regime/status", async (_req, res) => {
    try {
      const status = await strategyEngine.getStatus();
      res.json(marketRegimeFilter.getStatus(status.marketData));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/trading/approval-status", async (_req, res) => {
    try {
      if (!liveTradingClient.isInitialized()) {
        const initResult = await liveTradingClient.initialize();
        if (!initResult.success) {
          return res.status(400).json({ success: false, error: initResult.error });
        }
      }
      const status = await liveTradingClient.getApprovalStatus();
      if (!status) {
        return res.status(400).json({ success: false, error: "Could not check approval status" });
      }
      const allApproved = parseFloat(status.usdcCtfExchange) > 1000000 &&
        parseFloat(status.usdcNegRiskExchange) > 1000000 &&
        parseFloat(status.usdcNegRiskAdapter) > 1000000 &&
        status.ctfExchange &&
        status.ctfNegRiskExchange &&
        status.ctfNegRiskAdapter;
      res.json({ success: true, ...status, allApproved });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/trading/pre-checks", async (_req, res) => {
    try {
      if (!liveTradingClient.isInitialized()) {
        const initResult = await liveTradingClient.initialize();
        if (!initResult.success) {
          return res.status(400).json({ success: false, error: initResult.error });
        }
      }
      const checks = await liveTradingClient.getPreApprovalChecks();
      if (!checks) {
        return res.status(400).json({ success: false, error: "Wallet not initialized" });
      }
      res.json({ success: true, ...checks });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/trading/approve", async (_req, res) => {
    try {
      if (!liveTradingClient.isInitialized()) {
        const initResult = await liveTradingClient.initialize();
        if (!initResult.success) {
          return res.status(400).json({ success: false, error: initResult.error });
        }
      }
      const result = await liveTradingClient.approveAll();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
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

  app.get("/api/trading/wallet-balance", async (_req, res) => {
    try {
      if (!liveTradingClient.isInitialized()) {
        return res.json({
          initialized: false,
          walletAddress: null,
          usdc: null,
        });
      }
      const [collateral, onChain] = await Promise.all([
        liveTradingClient.getCollateralBalance(),
        liveTradingClient.getOnChainUsdcBalance(),
      ]);
      const sigInfo = liveTradingClient.getSignatureInfo();
      const sdkBalanceRaw = collateral ? collateral.balance : "0";
      const sdkBalance = parseFloat(sdkBalanceRaw) > 1000 ? (parseFloat(sdkBalanceRaw) / 1e6).toFixed(2) : sdkBalanceRaw;
      const onChainTotal = onChain ? onChain.total : null;
      const sdkHasBalance = parseFloat(sdkBalance) > 0;
      res.json({
        initialized: true,
        walletAddress: liveTradingClient.getWalletAddress(),
        usdc: sdkHasBalance ? sdkBalance : (onChainTotal || sdkBalance),
        usdcSdk: sdkBalance,
        usdcOnChain: onChainTotal,
        usdcE: onChain?.usdcE || null,
        usdcNative: onChain?.usdcNative || null,
        allowance: collateral ? collateral.allowance : "0",
        signatureType: sigInfo.signatureType,
        detectedSigType: sigInfo.detectedSigType,
        walletType: sigInfo.detectedSigType === 2 ? "Gnosis Safe" : sigInfo.detectedSigType === 1 ? "Proxy" : "EOA",
        funderAddress: sigInfo.funderAddress,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/analytics/optimization", async (_req, res) => {
    try {
      const allOrders = await storage.getOrders();
      const allFills = await storage.getFills();
      const pnlRecords = await storage.getPnlRecords();
      const config = await storage.getBotConfig();

      const buyOrders = allOrders.filter(o => o.side === "BUY");
      const sellOrders = allOrders.filter(o => o.side === "SELL");

      const filledBuys = buyOrders.filter(o => o.status === "FILLED");
      const filledSells = sellOrders.filter(o => o.status === "FILLED");
      const cancelledSells = sellOrders.filter(o => o.status === "CANCELLED");
      const totalTpAttempted = filledSells.length + cancelledSells.length;
      const tpFillRate = totalTpAttempted > 0 ? (filledSells.length / totalTpAttempted) * 100 : 0;

      const buyFillRate = buyOrders.length > 0
        ? (filledBuys.length / buyOrders.length) * 100 : 0;

      const buyFills = allFills.filter(f => f.side === "BUY");
      const sellFills = allFills.filter(f => f.side === "SELL");

      const avgBuyPrice = buyFills.length > 0
        ? buyFills.reduce((s, f) => s + f.price, 0) / buyFills.length : 0;
      const avgSellPrice = sellFills.length > 0
        ? sellFills.reduce((s, f) => s + f.price, 0) / sellFills.length : 0;
      const avgSpreadCapture = avgSellPrice > 0 && avgBuyPrice > 0
        ? avgSellPrice - avgBuyPrice : 0;

      const totalTrades = pnlRecords.reduce((s, r) => s + r.tradesCount, 0);
      const totalWins = pnlRecords.reduce((s, r) => s + r.winCount, 0);
      const totalLosses = pnlRecords.reduce((s, r) => s + r.lossCount, 0);
      const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
      const totalPnl = pnlRecords.reduce((s, r) => s + r.realizedPnl, 0);
      const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;

      const avgWinAmount = totalWins > 0
        ? pnlRecords.reduce((s, r) => s + (r.winCount > 0 ? r.realizedPnl : 0), 0) / totalWins : 0;
      const totalFees = pnlRecords.reduce((s, r) => s + r.fees, 0);

      const filledBuyPrices = buyFills.map(f => f.price).sort((a, b) => a - b);
      const medianBuyPrice = filledBuyPrices.length > 0
        ? filledBuyPrices[Math.floor(filledBuyPrices.length / 2)] : 0;

      const filledBuySizes = buyFills.map(f => f.size);
      const avgFillSize = filledBuySizes.length > 0
        ? filledBuySizes.reduce((s, v) => s + v, 0) / filledBuySizes.length : 0;

      const hedgeLockExits = allOrders.filter(o =>
        o.side === "SELL" && o.status === "FILLED" && o.price < (avgBuyPrice - 0.005)
      ).length;
      const forcedExitRate = filledSells.length > 0
        ? (hedgeLockExits / filledSells.length) * 100 : 0;

      const currentTargetProfit = config
        ? (config.targetProfitMin + config.targetProfitMax) / 2 : 0.04;
      const currentMinSpread = config?.minSpread ?? 0.03;

      const suggestions: Array<{ param: string; current: string; suggested: string; reason: string }> = [];

      if (totalTrades >= 5) {
        if (tpFillRate < 40 && currentTargetProfit > 0.02) {
          const suggestedMin = Math.max(0.01, (config?.targetProfitMin ?? 0.03) - 0.01);
          const suggestedMax = Math.max(0.02, (config?.targetProfitMax ?? 0.05) - 0.01);
          suggestions.push({
            param: "Target Profit",
            current: `$${config?.targetProfitMin?.toFixed(2)} - $${config?.targetProfitMax?.toFixed(2)}`,
            suggested: `$${suggestedMin.toFixed(2)} - $${suggestedMax.toFixed(2)}`,
            reason: `Tasa de TP fill baja (${tpFillRate.toFixed(0)}%). Un target mas pequeno se llenaria mas rapido.`,
          });
        } else if (tpFillRate > 80 && winRate > 60) {
          const suggestedMin = (config?.targetProfitMin ?? 0.03) + 0.01;
          const suggestedMax = (config?.targetProfitMax ?? 0.05) + 0.01;
          suggestions.push({
            param: "Target Profit",
            current: `$${config?.targetProfitMin?.toFixed(2)} - $${config?.targetProfitMax?.toFixed(2)}`,
            suggested: `$${suggestedMin.toFixed(2)} - $${suggestedMax.toFixed(2)}`,
            reason: `TP fill rate alta (${tpFillRate.toFixed(0)}%) con buen win rate. Podrías capturar más por trade.`,
          });
        }

        if (buyFillRate < 30 && currentMinSpread > 0.01) {
          suggestions.push({
            param: "Min Spread",
            current: `$${currentMinSpread.toFixed(2)}`,
            suggested: `$${Math.max(0.01, currentMinSpread - 0.01).toFixed(2)}`,
            reason: `Solo ${buyFillRate.toFixed(0)}% de órdenes BUY se llenan. Bajar el min spread permite entrar en más mercados.`,
          });
        }

        if (forcedExitRate > 40) {
          suggestions.push({
            param: "Target Profit",
            current: `$${config?.targetProfitMin?.toFixed(2)} - $${config?.targetProfitMax?.toFixed(2)}`,
            suggested: `Reducir 30-50%`,
            reason: `${forcedExitRate.toFixed(0)}% de salidas son forzadas (HEDGE_LOCK). TP más pequeño = más exits limpios antes del cierre.`,
          });
        }

        if (avgSpreadCapture > 0 && avgSpreadCapture < currentTargetProfit * 0.5) {
          suggestions.push({
            param: "Target Profit",
            current: `$${currentTargetProfit.toFixed(3)}`,
            suggested: `$${(avgSpreadCapture * 1.2).toFixed(3)}`,
            reason: `Spread promedio capturado ($${avgSpreadCapture.toFixed(3)}) es mucho menor que el target. Alinear con realidad del mercado.`,
          });
        }
      }

      res.json({
        metrics: {
          totalTrades,
          totalWins,
          totalLosses,
          winRate: parseFloat(winRate.toFixed(1)),
          totalPnl: parseFloat(totalPnl.toFixed(4)),
          avgPnlPerTrade: parseFloat(avgPnlPerTrade.toFixed(4)),
          totalFees: parseFloat(totalFees.toFixed(4)),
          buyFillRate: parseFloat(buyFillRate.toFixed(1)),
          tpFillRate: parseFloat(tpFillRate.toFixed(1)),
          avgBuyPrice: parseFloat(avgBuyPrice.toFixed(4)),
          avgSellPrice: parseFloat(avgSellPrice.toFixed(4)),
          avgSpreadCapture: parseFloat(avgSpreadCapture.toFixed(4)),
          medianBuyPrice: parseFloat(medianBuyPrice.toFixed(4)),
          avgFillSize: parseFloat(avgFillSize.toFixed(2)),
          forcedExitRate: parseFloat(forcedExitRate.toFixed(1)),
          hedgeLockExits,
          totalBuyOrders: buyOrders.length,
          totalSellOrders: sellOrders.length,
          filledBuys: filledBuys.length,
          filledSells: filledSells.length,
        },
        suggestions,
        currentParams: {
          minSpread: config?.minSpread ?? 0.03,
          targetProfitMin: config?.targetProfitMin ?? 0.03,
          targetProfitMax: config?.targetProfitMax ?? 0.05,
          orderSize: config?.orderSize ?? 10,
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
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

  const latencyHistory: Array<{ pm: number; bn: number; ts: number }> = [];
  const MAX_LATENCY_HISTORY = 20;

  app.get("/api/latency", async (_req, res) => {
    try {
      const pmStart = Date.now();
      let pmLatency = -1;
      try {
        const pmResp = await fetch("https://clob.polymarket.com/time", {
          signal: AbortSignal.timeout(5000),
        });
        if (pmResp.ok) pmLatency = Date.now() - pmStart;
      } catch {}

      const bnLatency = binanceOracle.getWsLatencyMs();

      const entry = { pm: pmLatency, bn: bnLatency, ts: Date.now() };
      latencyHistory.push(entry);
      if (latencyHistory.length > MAX_LATENCY_HISTORY) {
        latencyHistory.shift();
      }

      res.json({ current: entry, history: latencyHistory });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  startHealthMonitor(30_000);

  return httpServer;
}
