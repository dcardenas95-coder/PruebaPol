import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const botStateEnum = pgEnum("bot_state", ["MAKING", "UNWIND", "CLOSE_ONLY", "HEDGE_LOCK", "DONE", "STOPPED", "RUNNING"]);
export const orderStatusEnum = pgEnum("order_status", ["PENDING", "OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "REJECTED"]);
export const orderSideEnum = pgEnum("order_side", ["BUY", "SELL"]);
export const eventTypeEnum = pgEnum("event_type", [
  "ORDER_PLACED", "ORDER_FILLED", "ORDER_CANCELLED", "ORDER_REJECTED",
  "STATE_CHANGE", "RISK_ALERT", "KILL_SWITCH", "ERROR", "INFO",
  "RECONCILIATION", "POSITION_UPDATE", "PNL_UPDATE"
]);

export const botConfig = pgTable("bot_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  isActive: boolean("is_active").notNull().default(false),
  isPaperTrading: boolean("is_paper_trading").notNull().default(true),
  currentState: botStateEnum("current_state").notNull().default("STOPPED"),
  minSpread: real("min_spread").notNull().default(0.03),
  targetProfitMin: real("target_profit_min").notNull().default(0.03),
  targetProfitMax: real("target_profit_max").notNull().default(0.05),
  maxNetExposure: real("max_net_exposure").notNull().default(100),
  maxDailyLoss: real("max_daily_loss").notNull().default(50),
  maxConsecutiveLosses: integer("max_consecutive_losses").notNull().default(3),
  orderSize: real("order_size").notNull().default(10),
  killSwitchActive: boolean("kill_switch_active").notNull().default(false),
  currentMarketId: text("current_market_id"),
  currentMarketSlug: text("current_market_slug"),
  currentMarketNegRisk: boolean("current_market_neg_risk").notNull().default(false),
  currentMarketTickSize: text("current_market_tick_size").notNull().default("0.01"),
  currentMarketTokenDown: text("current_market_token_down"),
  autoRotate: boolean("auto_rotate").notNull().default(false),
  autoRotateAsset: text("auto_rotate_asset").notNull().default("btc"),
  autoRotateInterval: text("auto_rotate_interval").notNull().default("5m"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientOrderId: text("client_order_id").notNull().unique(),
  exchangeOrderId: text("exchange_order_id"),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id"),
  tokenSide: text("token_side"),
  side: orderSideEnum("side").notNull(),
  price: real("price").notNull(),
  size: real("size").notNull(),
  filledSize: real("filled_size").notNull().default(0),
  status: orderStatusEnum("status").notNull().default("PENDING"),
  isPaperTrade: boolean("is_paper_trade").notNull().default(true),
  isMakerOrder: boolean("is_maker_order").notNull().default(true),
  oracleDirection: text("oracle_direction"),
  oracleConfidence: real("oracle_confidence"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const fills = pgTable("fills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull(),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id"),
  tokenSide: text("token_side"),
  side: orderSideEnum("side").notNull(),
  price: real("price").notNull(),
  size: real("size").notNull(),
  fee: real("fee").notNull().default(0),
  isPaperTrade: boolean("is_paper_trade").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const positions = pgTable("positions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  marketId: text("market_id").notNull(),
  tokenId: text("token_id"),
  tokenSide: text("token_side"),
  side: orderSideEnum("side").notNull(),
  size: real("size").notNull().default(0),
  avgEntryPrice: real("avg_entry_price").notNull().default(0),
  targetExitPrice: real("target_exit_price"),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  realizedPnl: real("realized_pnl").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const pnlRecords = pgTable("pnl_records", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  date: text("date").notNull(),
  realizedPnl: real("realized_pnl").notNull().default(0),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  tradesCount: integer("trades_count").notNull().default(0),
  winCount: integer("win_count").notNull().default(0),
  lossCount: integer("loss_count").notNull().default(0),
  volume: real("volume").notNull().default(0),
  fees: real("fees").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const botEvents = pgTable("bot_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: eventTypeEnum("type").notNull(),
  message: text("message").notNull(),
  data: jsonb("data"),
  level: text("level").notNull().default("info"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const fillsRelations = relations(fills, ({ one }) => ({
  order: one(orders, { fields: [fills.orderId], references: [orders.id] }),
}));

export const ordersRelations = relations(orders, ({ many }) => ({
  fills: many(fills),
}));

export const insertBotConfigSchema = createInsertSchema(botConfig).omit({ id: true, updatedAt: true });
export const insertOrderSchema = createInsertSchema(orders).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFillSchema = createInsertSchema(fills).omit({ id: true, createdAt: true });
export const insertPositionSchema = createInsertSchema(positions).omit({ id: true, updatedAt: true });
export const insertPnlRecordSchema = createInsertSchema(pnlRecords).omit({ id: true, createdAt: true });
export const insertBotEventSchema = createInsertSchema(botEvents).omit({ id: true, createdAt: true });

export type BotConfig = typeof botConfig.$inferSelect;
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type Order = typeof orders.$inferSelect;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Fill = typeof fills.$inferSelect;
export type InsertFill = z.infer<typeof insertFillSchema>;
export type Position = typeof positions.$inferSelect;
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type PnlRecord = typeof pnlRecords.$inferSelect;
export type InsertPnlRecord = z.infer<typeof insertPnlRecordSchema>;
export type BotEvent = typeof botEvents.$inferSelect;
export type InsertBotEvent = z.infer<typeof insertBotEventSchema>;

export const dualEntryCycleStateEnum = pgEnum("dual_entry_cycle_state", [
  "IDLE", "ARMED", "ENTRY_WORKING", "PARTIAL_FILL", "HEDGED", "EXIT_WORKING", "DONE", "CLEANUP", "FAILSAFE"
]);

export const dualEntryConfig = pgTable("dual_entry_config", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  isActive: boolean("is_active").notNull().default(false),
  isDryRun: boolean("is_dry_run").notNull().default(true),
  marketTokenYes: text("market_token_yes"),
  marketTokenNo: text("market_token_no"),
  marketSlug: text("market_slug"),
  marketQuestion: text("market_question"),
  negRisk: boolean("neg_risk").notNull().default(false),
  tickSize: text("tick_size").notNull().default("0.01"),
  entryPrice: real("entry_price").notNull().default(0.45),
  tpPrice: real("tp_price").notNull().default(0.65),
  scratchPrice: real("scratch_price").notNull().default(0.45),
  entryLeadSecondsPrimary: integer("entry_lead_seconds_primary").notNull().default(180),
  entryLeadSecondsRefresh: integer("entry_lead_seconds_refresh").notNull().default(30),
  postStartCleanupSeconds: integer("post_start_cleanup_seconds").notNull().default(10),
  exitTtlSeconds: integer("exit_ttl_seconds").notNull().default(120),
  orderSize: real("order_size").notNull().default(5),
  maxConcurrentCycles: integer("max_concurrent_cycles").notNull().default(1),
  smartScratchCancel: boolean("smart_scratch_cancel").notNull().default(true),
  volFilterEnabled: boolean("vol_filter_enabled").notNull().default(false),
  volMinThreshold: real("vol_min_threshold").notNull().default(0.3),
  volMaxThreshold: real("vol_max_threshold").notNull().default(5.0),
  volWindowMinutes: integer("vol_window_minutes").notNull().default(15),
  dynamicEntryEnabled: boolean("dynamic_entry_enabled").notNull().default(false),
  dynamicEntryMin: real("dynamic_entry_min").notNull().default(0.40),
  dynamicEntryMax: real("dynamic_entry_max").notNull().default(0.48),
  momentumTpEnabled: boolean("momentum_tp_enabled").notNull().default(false),
  momentumTpMin: real("momentum_tp_min").notNull().default(0.55),
  momentumTpMax: real("momentum_tp_max").notNull().default(0.75),
  momentumWindowMinutes: integer("momentum_window_minutes").notNull().default(5),
  dynamicSizeEnabled: boolean("dynamic_size_enabled").notNull().default(false),
  dynamicSizeMin: real("dynamic_size_min").notNull().default(3),
  dynamicSizeMax: real("dynamic_size_max").notNull().default(20),
  hourFilterEnabled: boolean("hour_filter_enabled").notNull().default(false),
  hourFilterAllowed: jsonb("hour_filter_allowed").notNull().default([]),
  multiMarketEnabled: boolean("multi_market_enabled").notNull().default(false),
  additionalMarkets: jsonb("additional_markets").notNull().default([]),
  dualTpMode: boolean("dual_tp_mode").notNull().default(false),
  autoRotate5m: boolean("auto_rotate_5m").notNull().default(false),
  autoRotate5mAsset: text("auto_rotate_5m_asset").notNull().default("btc"),
  autoRotateInterval: text("auto_rotate_interval").notNull().default("5m"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const dualEntryCycles = pgTable("dual_entry_cycles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  cycleNumber: integer("cycle_number").notNull(),
  state: dualEntryCycleStateEnum("state").notNull().default("IDLE"),
  windowStart: timestamp("window_start").notNull(),
  windowEnd: timestamp("window_end"),
  yesOrderId: text("yes_order_id"),
  noOrderId: text("no_order_id"),
  yesExchangeOrderId: text("yes_exchange_order_id"),
  noExchangeOrderId: text("no_exchange_order_id"),
  yesFilled: boolean("yes_filled").notNull().default(false),
  noFilled: boolean("no_filled").notNull().default(false),
  yesFilledSize: real("yes_filled_size").notNull().default(0),
  noFilledSize: real("no_filled_size").notNull().default(0),
  yesFilledPrice: real("yes_filled_price"),
  noFilledPrice: real("no_filled_price"),
  winnerSide: text("winner_side"),
  tpOrderId: text("tp_order_id"),
  scratchOrderId: text("scratch_order_id"),
  tpExchangeOrderId: text("tp_exchange_order_id"),
  scratchExchangeOrderId: text("scratch_exchange_order_id"),
  tpFilled: boolean("tp_filled").notNull().default(false),
  scratchFilled: boolean("scratch_filled").notNull().default(false),
  outcome: text("outcome"),
  pnl: real("pnl"),
  logs: jsonb("logs").notNull().default([]),
  isDryRun: boolean("is_dry_run").notNull().default(true),
  hourOfDay: integer("hour_of_day"),
  dayOfWeek: integer("day_of_week"),
  btcVolatility: real("btc_volatility"),
  entryMethod: text("entry_method").notNull().default("fixed"),
  actualEntryPrice: real("actual_entry_price"),
  actualTpPrice: real("actual_tp_price"),
  actualOrderSize: real("actual_order_size"),
  marketTokenYes: text("market_token_yes"),
  marketTokenNo: text("market_token_no"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDualEntryConfigSchema = createInsertSchema(dualEntryConfig).omit({ id: true, updatedAt: true });
export const insertDualEntryCycleSchema = createInsertSchema(dualEntryCycles).omit({ id: true, createdAt: true, updatedAt: true });
export type DualEntryConfig = typeof dualEntryConfig.$inferSelect;
export type InsertDualEntryConfig = z.infer<typeof insertDualEntryConfigSchema>;
export type DualEntryCycle = typeof dualEntryCycles.$inferSelect;
export type InsertDualEntryCycle = z.infer<typeof insertDualEntryCycleSchema>;

export const updateDualEntryConfigSchema = z.object({
  isActive: z.boolean().optional(),
  isDryRun: z.boolean().optional(),
  marketTokenYes: z.string().optional(),
  marketTokenNo: z.string().optional(),
  marketSlug: z.string().optional(),
  marketQuestion: z.string().optional(),
  negRisk: z.boolean().optional(),
  tickSize: z.string().optional(),
  entryPrice: z.number().min(0.01).max(0.99).optional(),
  tpPrice: z.number().min(0.01).max(0.99).optional(),
  scratchPrice: z.number().min(0.01).max(0.99).optional(),
  entryLeadSecondsPrimary: z.number().min(10).max(600).optional(),
  entryLeadSecondsRefresh: z.number().min(5).max(300).optional(),
  postStartCleanupSeconds: z.number().min(1).max(120).optional(),
  exitTtlSeconds: z.number().min(30).max(600).optional(),
  orderSize: z.number().min(1).max(10000).optional(),
  maxConcurrentCycles: z.number().min(1).max(5).optional(),
  smartScratchCancel: z.boolean().optional(),
  volFilterEnabled: z.boolean().optional(),
  volMinThreshold: z.number().min(0).max(50).optional(),
  volMaxThreshold: z.number().min(0).max(50).optional(),
  volWindowMinutes: z.number().min(1).max(60).optional(),
  dynamicEntryEnabled: z.boolean().optional(),
  dynamicEntryMin: z.number().min(0.01).max(0.99).optional(),
  dynamicEntryMax: z.number().min(0.01).max(0.99).optional(),
  momentumTpEnabled: z.boolean().optional(),
  momentumTpMin: z.number().min(0.01).max(0.99).optional(),
  momentumTpMax: z.number().min(0.01).max(0.99).optional(),
  momentumWindowMinutes: z.number().min(1).max(60).optional(),
  dynamicSizeEnabled: z.boolean().optional(),
  dynamicSizeMin: z.number().min(1).max(10000).optional(),
  dynamicSizeMax: z.number().min(1).max(10000).optional(),
  hourFilterEnabled: z.boolean().optional(),
  hourFilterAllowed: z.array(z.number().min(0).max(23)).optional(),
  multiMarketEnabled: z.boolean().optional(),
  additionalMarkets: z.array(z.object({
    tokenYes: z.string(),
    tokenNo: z.string(),
    slug: z.string(),
    question: z.string(),
    negRisk: z.boolean(),
    tickSize: z.string(),
  })).optional(),
  dualTpMode: z.boolean().optional(),
  autoRotate5m: z.boolean().optional(),
  autoRotate5mAsset: z.string().optional(),
  autoRotateInterval: z.string().optional(),
});
export type UpdateDualEntryConfig = z.infer<typeof updateDualEntryConfigSchema>;

export const updateBotConfigSchema = z.object({
  isActive: z.boolean().optional(),
  isPaperTrading: z.boolean().optional(),
  currentState: z.enum(["MAKING", "UNWIND", "CLOSE_ONLY", "HEDGE_LOCK", "DONE", "STOPPED", "RUNNING"]).optional(),
  minSpread: z.number().min(0.01).max(0.5).optional(),
  targetProfitMin: z.number().min(0.01).max(0.5).optional(),
  targetProfitMax: z.number().min(0.01).max(1.0).optional(),
  maxNetExposure: z.number().min(1).max(10000).optional(),
  maxDailyLoss: z.number().min(1).max(10000).optional(),
  maxConsecutiveLosses: z.number().min(1).max(50).optional(),
  orderSize: z.number().min(1).max(1000).optional(),
  killSwitchActive: z.boolean().optional(),
  currentMarketId: z.string().optional(),
  currentMarketSlug: z.string().optional(),
  currentMarketNegRisk: z.boolean().optional(),
  currentMarketTickSize: z.string().optional(),
  currentMarketTokenDown: z.string().optional(),
  autoRotate: z.boolean().optional(),
  autoRotateAsset: z.string().optional(),
  autoRotateInterval: z.string().optional(),
});

export type UpdateBotConfig = z.infer<typeof updateBotConfigSchema>;

export type MarketData = {
  bestBid: number;
  bestAsk: number;
  spread: number;
  midpoint: number;
  bidDepth: number;
  askDepth: number;
  lastPrice: number;
  volume24h: number;
};

export type WsConnectionHealth = {
  marketConnected: boolean;
  userConnected: boolean;
  marketLastMessage: number | null;
  userLastMessage: number | null;
  marketReconnects: number;
  userReconnects: number;
  marketSubscribedAssets: string[];
  userSubscribedAssets: string[];
};

export type DualEntry5mCycleInfo = {
  cycleNumber: number;
  state: string;
  windowStart: string;
  yesFilled: boolean;
  noFilled: boolean;
  yesFilledSize: number;
  noFilledSize: number;
  winnerSide: string | null;
  tpFilled: boolean;
  scratchFilled: boolean;
  outcome: string | null;
  pnl: number | null;
  entryMethod: string | null;
  actualEntryPrice: number | null;
  actualTpPrice: number | null;
  actualOrderSize: number | null;
  btcVolatility: number | null;
};

export type DualEntry5mInfo = {
  isRunning: boolean;
  currentCycle: DualEntry5mCycleInfo | null;
  nextWindowStart: string | null;
  activeCycles: number;
  marketSlug: string | null;
  marketQuestion: string | null;
  asset: string | null;
  interval: string | null;
  isDryRun: boolean;
  dualTpMode: boolean;
  autoRotate: boolean;
  orderSize: number;
  entryPrice: number;
  tpPrice: number;
  scratchPrice: number;
};

export type OracleStatus = {
  connected: boolean;
  btcPrice: number;
  openingPrice: number;
  delta: number;
  bufferSize: number;
  volatility5m: number;
  signal: {
    direction: string;
    strength: string;
    confidence: number;
    delta: number;
    openingPrice: number;
    currentPrice: number;
    elapsedMs: number;
    btcPrice: number;
    volatility5m: number;
  };
};

export type StopLossStatus = {
  enabled: boolean;
  config: {
    enabled: boolean;
    maxLossPercent: number;
    trailingEnabled: boolean;
    trailingPercent: number;
    timeDecayEnabled: boolean;
  };
  trackedPositions: number;
  highWaterMarks: Record<string, number>;
};

export type ProgressiveSizerStatus = {
  enabled: boolean;
  currentLevel: {
    level: number;
    name: string;
    size: number;
    reason: string;
  };
  stats: {
    totalTrades: number;
    winRate: number;
    consecutiveWins: number;
    consecutiveLosses: number;
  };
};

export type MarketRegimeStatus = {
  enabled: boolean;
  currentRegime: {
    regime: string;
    tradeable: boolean;
    reason?: string;
    volatility: number;
    depth: number;
    spread: number;
  } | null;
};

export type BotStatus = {
  config: BotConfig;
  marketData: MarketData | null;
  marketDataNo: MarketData | null;
  activeOrders: number;
  openPositions: number;
  dailyPnl: number;
  consecutiveLosses: number;
  uptime: number;
  isLiveData?: boolean;
  currentTokenId?: string | null;
  wsHealth?: WsConnectionHealth;
  dualEntry5m?: DualEntry5mInfo;
  marketRemainingMs?: number;
  marketDurationMs?: number;
  isLiquidating?: boolean;
  cycleCount?: number;
  oracle?: OracleStatus;
  stopLoss?: StopLossStatus;
  progressiveSizer?: ProgressiveSizerStatus;
  marketRegime?: MarketRegimeStatus;
  lastEntry?: {
    tokenSide: "YES" | "NO";
    price: number;
    size: number;
  } | null;
};
