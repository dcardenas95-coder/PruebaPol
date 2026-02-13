import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, real, boolean, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const botStateEnum = pgEnum("bot_state", ["MAKING", "UNWIND", "CLOSE_ONLY", "HEDGE_LOCK", "DONE", "STOPPED"]);
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
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientOrderId: text("client_order_id").notNull().unique(),
  exchangeOrderId: text("exchange_order_id"),
  marketId: text("market_id").notNull(),
  side: orderSideEnum("side").notNull(),
  price: real("price").notNull(),
  size: real("size").notNull(),
  filledSize: real("filled_size").notNull().default(0),
  status: orderStatusEnum("status").notNull().default("PENDING"),
  isPaperTrade: boolean("is_paper_trade").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const fills = pgTable("fills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: varchar("order_id").notNull(),
  marketId: text("market_id").notNull(),
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
  side: orderSideEnum("side").notNull(),
  size: real("size").notNull().default(0),
  avgEntryPrice: real("avg_entry_price").notNull().default(0),
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

export const updateBotConfigSchema = z.object({
  isActive: z.boolean().optional(),
  isPaperTrading: z.boolean().optional(),
  currentState: z.enum(["MAKING", "UNWIND", "CLOSE_ONLY", "HEDGE_LOCK", "DONE", "STOPPED"]).optional(),
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

export type BotStatus = {
  config: BotConfig;
  marketData: MarketData | null;
  activeOrders: number;
  openPositions: number;
  dailyPnl: number;
  consecutiveLosses: number;
  uptime: number;
};
