import {
  type BotConfig, type InsertBotConfig,
  type Order, type InsertOrder,
  type Fill, type InsertFill,
  type Position, type InsertPosition,
  type PnlRecord, type InsertPnlRecord,
  type BotEvent, type InsertBotEvent,
  type UpdateBotConfig,
  botConfig, orders, fills, positions, pnlRecords, botEvents,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, inArray } from "drizzle-orm";

export interface IStorage {
  getBotConfig(): Promise<BotConfig | undefined>;
  upsertBotConfig(config: InsertBotConfig): Promise<BotConfig>;
  updateBotConfig(updates: UpdateBotConfig): Promise<BotConfig>;

  getOrders(): Promise<Order[]>;
  getOrderById(id: string): Promise<Order | undefined>;
  getOrderByClientId(clientOrderId: string): Promise<Order | undefined>;
  getActiveOrders(): Promise<Order[]>;
  createOrder(order: InsertOrder): Promise<Order>;
  updateOrderStatus(id: string, status: string, filledSize?: number): Promise<Order | undefined>;
  updateOrderExchangeId(id: string, exchangeOrderId: string): Promise<Order | undefined>;
  cancelAllOpenOrders(): Promise<void>;

  getFills(): Promise<Fill[]>;
  getFillsByOrderId(orderId: string): Promise<Fill[]>;
  createFill(fill: InsertFill): Promise<Fill>;

  getPositions(): Promise<Position[]>;
  getPositionByMarket(marketId: string, side: string): Promise<Position | undefined>;
  getPositionByToken(tokenId: string, side: string): Promise<Position | undefined>;
  upsertPosition(position: InsertPosition): Promise<Position>;
  deletePosition(id: string): Promise<void>;

  getPnlRecords(): Promise<PnlRecord[]>;
  getPnlByDate(date: string): Promise<PnlRecord | undefined>;
  upsertPnlRecord(record: InsertPnlRecord): Promise<PnlRecord>;

  getEvents(limit?: number): Promise<BotEvent[]>;
  createEvent(event: InsertBotEvent): Promise<BotEvent>;
}

export class DatabaseStorage implements IStorage {
  async getBotConfig(): Promise<BotConfig | undefined> {
    const [config] = await db.select().from(botConfig).limit(1);
    return config || undefined;
  }

  async upsertBotConfig(config: InsertBotConfig): Promise<BotConfig> {
    const existing = await this.getBotConfig();
    if (existing) {
      const [updated] = await db.update(botConfig)
        .set({ ...config, updatedAt: new Date() })
        .where(eq(botConfig.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(botConfig).values(config).returning();
    return created;
  }

  async updateBotConfig(updates: UpdateBotConfig): Promise<BotConfig> {
    const existing = await this.getBotConfig();
    if (!existing) {
      const [created] = await db.insert(botConfig).values({
        ...updates,
        updatedAt: new Date(),
      } as any).returning();
      return created;
    }
    const [updated] = await db.update(botConfig)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(botConfig.id, existing.id))
      .returning();
    return updated;
  }

  async getOrders(): Promise<Order[]> {
    return db.select().from(orders).orderBy(desc(orders.createdAt));
  }

  async getOrderById(id: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    return order || undefined;
  }

  async getOrderByClientId(clientOrderId: string): Promise<Order | undefined> {
    const [order] = await db.select().from(orders).where(eq(orders.clientOrderId, clientOrderId));
    return order || undefined;
  }

  async getActiveOrders(): Promise<Order[]> {
    return db.select().from(orders).where(
      inArray(orders.status, ["OPEN", "PENDING", "PARTIALLY_FILLED"])
    );
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    const [created] = await db.insert(orders).values(order).returning();
    return created;
  }

  async updateOrderStatus(id: string, status: string, filledSize?: number): Promise<Order | undefined> {
    const updateData: any = { status, updatedAt: new Date() };
    if (filledSize !== undefined) updateData.filledSize = filledSize;
    const [updated] = await db.update(orders)
      .set(updateData)
      .where(eq(orders.id, id))
      .returning();
    return updated || undefined;
  }

  async updateOrderExchangeId(id: string, exchangeOrderId: string): Promise<Order | undefined> {
    const [updated] = await db.update(orders)
      .set({ exchangeOrderId, updatedAt: new Date() })
      .where(eq(orders.id, id))
      .returning();
    return updated || undefined;
  }

  async cancelAllOpenOrders(): Promise<void> {
    await db.update(orders)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(inArray(orders.status, ["OPEN", "PENDING", "PARTIALLY_FILLED"]));
  }

  async getFills(): Promise<Fill[]> {
    return db.select().from(fills).orderBy(desc(fills.createdAt)).limit(200);
  }

  async getFillsByOrderId(orderId: string): Promise<Fill[]> {
    return db.select().from(fills).where(eq(fills.orderId, orderId));
  }

  async createFill(fill: InsertFill): Promise<Fill> {
    const [created] = await db.insert(fills).values(fill).returning();
    return created;
  }

  async getPositions(): Promise<Position[]> {
    return db.select().from(positions);
  }

  async getPositionByMarket(marketId: string, side: string): Promise<Position | undefined> {
    const [pos] = await db.select().from(positions)
      .where(and(eq(positions.marketId, marketId), eq(positions.side, side as any)));
    return pos || undefined;
  }

  async getPositionByToken(tokenId: string, side: string): Promise<Position | undefined> {
    const [pos] = await db.select().from(positions)
      .where(and(eq(positions.tokenId, tokenId), eq(positions.side, side as any)));
    return pos || undefined;
  }

  async upsertPosition(position: InsertPosition): Promise<Position> {
    const existing = position.tokenId
      ? await this.getPositionByToken(position.tokenId, position.side)
      : await this.getPositionByMarket(position.marketId, position.side);
    if (existing) {
      const [updated] = await db.update(positions)
        .set({ ...position, updatedAt: new Date() })
        .where(eq(positions.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(positions).values(position).returning();
    return created;
  }

  async deletePosition(id: string): Promise<void> {
    await db.delete(positions).where(eq(positions.id, id));
  }

  async getPnlRecords(): Promise<PnlRecord[]> {
    return db.select().from(pnlRecords).orderBy(desc(pnlRecords.date));
  }

  async getPnlByDate(date: string): Promise<PnlRecord | undefined> {
    const [record] = await db.select().from(pnlRecords).where(eq(pnlRecords.date, date));
    return record || undefined;
  }

  async upsertPnlRecord(record: InsertPnlRecord): Promise<PnlRecord> {
    const existing = await this.getPnlByDate(record.date);
    if (existing) {
      const [updated] = await db.update(pnlRecords)
        .set(record)
        .where(eq(pnlRecords.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(pnlRecords).values(record).returning();
    return created;
  }

  async getEvents(limit = 200): Promise<BotEvent[]> {
    return db.select().from(botEvents).orderBy(desc(botEvents.createdAt)).limit(limit);
  }

  async createEvent(event: InsertBotEvent): Promise<BotEvent> {
    const [created] = await db.insert(botEvents).values(event).returning();
    return created;
  }
}

export const storage = new DatabaseStorage();
