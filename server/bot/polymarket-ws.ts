import WebSocket from "ws";
import { storage } from "../storage";
import type { MarketData } from "@shared/schema";

const WS_MARKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const WS_USER_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";

const PING_INTERVAL = 30_000;
const INITIAL_RECONNECT_DELAY = 2_000;
const MAX_RECONNECT_DELAY = 60_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const MAX_RECONNECT_ATTEMPTS = 15;

export interface WsConnectionHealth {
  marketConnected: boolean;
  userConnected: boolean;
  marketLastMessage: number | null;
  userLastMessage: number | null;
  marketReconnects: number;
  userReconnects: number;
  marketSubscribedAssets: string[];
  userSubscribedAssets: string[];
}

export type FillCallback = (data: {
  orderId: string;
  side: string;
  price: number;
  sizeMatched: number;
  status: string;
  timestamp: number;
}) => void;

export type MarketDataCallback = (data: MarketData) => void;

export class PolymarketWebSocket {
  private marketWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private marketPingTimer: ReturnType<typeof setInterval> | null = null;
  private userPingTimer: ReturnType<typeof setInterval> | null = null;
  private marketReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private userReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private marketReconnectDelay = INITIAL_RECONNECT_DELAY;
  private userReconnectDelay = INITIAL_RECONNECT_DELAY;
  private marketReconnects = 0;
  private userReconnects = 0;
  private marketLastMessage = 0;
  private userLastMessage = 0;

  private subscribedMarketAssets: string[] = [];
  private subscribedUserAssets: string[] = [];
  private apiCreds: { apiKey: string; secret: string; passphrase: string } | null = null;

  private marketConnected = false;
  private userConnected = false;
  private shouldReconnectMarket = false;
  private shouldReconnectUser = false;
  private invalidOpCountMarket = 0;
  private invalidOpCountUser = 0;

  private onFillCallbacks: FillCallback[] = [];
  private onMarketDataCallbacks: MarketDataCallback[] = [];
  private lastMarketData: MarketData | null = null;
  private onRefreshAssetIdsCallback: (() => Promise<string[]>) | null = null;

  onFill(cb: FillCallback) {
    this.onFillCallbacks.push(cb);
  }

  onMarketData(cb: MarketDataCallback) {
    this.onMarketDataCallbacks.push(cb);
  }

  onRefreshAssetIds(cb: () => Promise<string[]>) {
    this.onRefreshAssetIdsCallback = cb;
  }

  getHealth(): WsConnectionHealth {
    return {
      marketConnected: this.marketConnected,
      userConnected: this.userConnected,
      marketLastMessage: this.marketLastMessage || null,
      userLastMessage: this.userLastMessage || null,
      marketReconnects: this.marketReconnects,
      userReconnects: this.userReconnects,
      marketSubscribedAssets: [...this.subscribedMarketAssets],
      userSubscribedAssets: [...this.subscribedUserAssets],
    };
  }

  getLastMarketData(): MarketData | null {
    return this.lastMarketData;
  }

  private isValidAssetId(id: string): boolean {
    return id.length > 20 && !id.includes("sim") && !id.includes("test") && !id.includes("fake");
  }

  private filterValidAssets(ids: string[]): string[] {
    return ids.filter(id => this.isValidAssetId(id));
  }

  connectMarket(assetIds: string[]): void {
    const validIds = this.filterValidAssets(assetIds);
    if (validIds.length === 0) {
      this.log("warn", `Market WS: Skipping connection — no valid asset IDs (received: ${assetIds.join(", ")})`);
      return;
    }
    this.subscribedMarketAssets = validIds;
    this.shouldReconnectMarket = true;
    this.invalidOpCountMarket = 0;
    this.marketReconnects = 0;
    this.marketReconnectDelay = INITIAL_RECONNECT_DELAY;
    this._connectMarket();
  }

  connectUser(assetIds: string[], creds: { apiKey: string; secret: string; passphrase: string }): void {
    const validIds = this.filterValidAssets(assetIds);
    if (validIds.length === 0) {
      this.log("warn", `User WS: Skipping connection — no valid asset IDs (received: ${assetIds.join(", ")})`);
      return;
    }
    this.subscribedUserAssets = validIds;
    this.apiCreds = creds;
    this.shouldReconnectUser = true;
    this.invalidOpCountUser = 0;
    this.userReconnects = 0;
    this.userReconnectDelay = INITIAL_RECONNECT_DELAY;
    this._connectUser();
  }

  disconnectAll(): void {
    this.shouldReconnectMarket = false;
    this.shouldReconnectUser = false;
    this._cleanupMarket();
    this._cleanupUser();
    this.onFillCallbacks = [];
    this.onMarketDataCallbacks = [];
    this.onRefreshAssetIdsCallback = null;
    this.onRefreshApiCredsCallback = null;
    this.log("info", "All WebSocket connections closed");
  }

  updateMarketSubscription(assetIds: string[]): void {
    const validIds = this.filterValidAssets(assetIds);
    if (validIds.length === 0) {
      this.log("warn", `Market WS: Skipping subscription update — no valid asset IDs`);
      return;
    }
    this.subscribedMarketAssets = validIds;
    if (this.marketWs?.readyState === WebSocket.OPEN) {
      this.marketWs.send(JSON.stringify({
        assets_ids: validIds,
        type: "market",
      }));
      this.log("info", `Market WS: Updated subscription to ${validIds.length} assets`);
    }
  }

  updateUserSubscription(assetIds: string[]): void {
    const validIds = this.filterValidAssets(assetIds);
    if (validIds.length === 0) {
      this.log("warn", `User WS: Skipping subscription update — no valid asset IDs`);
      return;
    }
    this.subscribedUserAssets = validIds;
    if (this.userWs?.readyState === WebSocket.OPEN && this.apiCreds) {
      this.userWs.send(JSON.stringify({
        assets_ids: validIds,
        type: "user",
        auth: {
          apiKey: this.apiCreds.apiKey,
          apikey: this.apiCreds.apiKey,
          secret: this.apiCreds.secret,
          passphrase: this.apiCreds.passphrase,
        },
      }));
      this.log("info", `User WS: Updated subscription to ${validIds.length} assets`);
    }
  }

  private _connectMarket(): void {
    this._cleanupMarket();

    try {
      this.log("info", `Market WS: Connecting to ${WS_MARKET_URL}...`);
      this.marketWs = new WebSocket(WS_MARKET_URL);

      this.marketWs.on("open", () => {
        this.marketConnected = true;
        this.marketReconnectDelay = INITIAL_RECONNECT_DELAY;
        this.log("info", `Market WS: Connected (reconnects: ${this.marketReconnects})`);

        if (this.subscribedMarketAssets.length > 0) {
          const subscribeMsg = {
            assets_ids: this.subscribedMarketAssets,
            type: "market",
          };
          this.marketWs!.send(JSON.stringify(subscribeMsg));
          this.log("info", `Market WS: Subscribed to ${this.subscribedMarketAssets.length} assets: ${this.subscribedMarketAssets.map(id => id.slice(0, 12) + '...').join(', ')}`);
        }

        this.marketPingTimer = setInterval(() => {
          if (this.marketWs?.readyState === WebSocket.OPEN) {
            this.marketWs.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL);
      });

      this.marketWs.on("message", (raw: Buffer) => {
        this.marketLastMessage = Date.now();
        const rawStr = raw.toString();

        if (rawStr === "INVALID OPERATION" || rawStr.startsWith("INVALID")) {
          this.invalidOpCountMarket++;
          this.log("warn", `Market WS: Received "${rawStr}" (attempt ${this.invalidOpCountMarket}/3). Reconnecting with backoff...`);
          if (this.invalidOpCountMarket >= 3) {
            this.log("warn", `Market WS: ${this.invalidOpCountMarket} consecutive INVALID OPERATION responses. Stopping reconnection.`);
            this.shouldReconnectMarket = false;
          }
          this._cleanupMarket();
          if (this.shouldReconnectMarket) {
            this._refreshAndReconnectMarket();
          }
          return;
        }
        this.invalidOpCountMarket = 0;

        try {
          const data = JSON.parse(rawStr);
          this._handleMarketMessage(data);
        } catch (e: any) {
          this.log("warn", `Market WS: Failed to parse message: ${e.message}`);
        }
      });

      this.marketWs.on("close", (code: number, reason: Buffer) => {
        this.marketConnected = false;
        this.log("warn", `Market WS: Disconnected (code: ${code}, reason: ${reason.toString()})`);
        this._scheduleMarketReconnect();
      });

      this.marketWs.on("error", (err: Error) => {
        this.log("error", `Market WS: Error - ${err.message}`);
      });
    } catch (err: any) {
      this.log("error", `Market WS: Connection failed - ${err.message}`);
      this._scheduleMarketReconnect();
    }
  }

  private _connectUser(): void {
    if (!this.apiCreds) {
      this.log("error", "User WS: Cannot connect without API credentials");
      return;
    }

    this._cleanupUser();

    try {
      this.log("info", `User WS: Connecting to ${WS_USER_URL}...`);
      this.userWs = new WebSocket(WS_USER_URL);

      this.userWs.on("open", () => {
        this.userConnected = true;
        this.userReconnectDelay = INITIAL_RECONNECT_DELAY;
        this.log("info", `User WS: Connected (reconnects: ${this.userReconnects})`);

        if (this.subscribedUserAssets.length > 0 && this.apiCreds) {
          this.userWs!.send(JSON.stringify({
            assets_ids: this.subscribedUserAssets,
            type: "user",
            auth: {
              apiKey: this.apiCreds.apiKey,
              apikey: this.apiCreds.apiKey,
              secret: this.apiCreds.secret,
              passphrase: this.apiCreds.passphrase,
            },
          }));
          this.log("info", `User WS: Subscribed to ${this.subscribedUserAssets.length} assets`);
        }

        this.userPingTimer = setInterval(() => {
          if (this.userWs?.readyState === WebSocket.OPEN) {
            this.userWs.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL);
      });

      this.userWs.on("message", (raw: Buffer) => {
        this.userLastMessage = Date.now();
        const rawStr = raw.toString();

        if (rawStr === "INVALID OPERATION" || rawStr.startsWith("INVALID")) {
          this.invalidOpCountUser++;
          this.log("warn", `User WS: Received "${rawStr}" (attempt ${this.invalidOpCountUser}/3). Reconnecting with backoff...`);
          if (this.invalidOpCountUser >= 3) {
            this.log("warn", `User WS: ${this.invalidOpCountUser} consecutive INVALID OPERATION responses. Stopping reconnection.`);
            this.shouldReconnectUser = false;
          }
          this._cleanupUser();
          if (this.shouldReconnectUser) {
            this._scheduleUserReconnect();
          }
          return;
        }
        this.invalidOpCountUser = 0;

        try {
          const data = JSON.parse(rawStr);
          this._handleUserMessage(data);
        } catch (e: any) {
          this.log("warn", `User WS: Failed to parse message: ${e.message}`);
        }
      });

      this.userWs.on("close", (code: number, reason: Buffer) => {
        this.userConnected = false;
        this.log("warn", `User WS: Disconnected (code: ${code}, reason: ${reason.toString()})`);
        this._scheduleUserReconnect();
      });

      this.userWs.on("error", (err: Error) => {
        this.log("error", `User WS: Error - ${err.message}`);
      });
    } catch (err: any) {
      this.log("error", `User WS: Connection failed - ${err.message}`);
      this._scheduleUserReconnect();
    }
  }

  private _handleMarketMessage(data: any): void {
    if (!data || typeof data !== "object") return;

    const eventType = data.event_type;

    if (eventType === "book") {
      const bids = (data.bids || []).map((b: any) => ({
        price: parseFloat(b.price || b[0] || "0"),
        size: parseFloat(b.size || b[1] || "0"),
      })).sort((a: any, b: any) => b.price - a.price);

      const asks = (data.asks || []).map((a: any) => ({
        price: parseFloat(a.price || a[0] || "0"),
        size: parseFloat(a.size || a[1] || "0"),
      })).sort((a: any, b: any) => a.price - b.price);

      const bestBid = bids.length > 0 ? bids[0].price : 0;
      const bestAsk = asks.length > 0 ? asks[0].price : 1;
      const spread = bestAsk - bestBid;
      const midpoint = (bestBid + bestAsk) / 2;
      const bidDepth = bids.reduce((s: number, b: any) => s + b.size, 0);
      const askDepth = asks.reduce((s: number, a: any) => s + a.size, 0);

      this.lastMarketData = {
        bestBid: parseFloat(bestBid.toFixed(4)),
        bestAsk: parseFloat(bestAsk.toFixed(4)),
        spread: parseFloat(spread.toFixed(4)),
        midpoint: parseFloat(midpoint.toFixed(4)),
        bidDepth: parseFloat(bidDepth.toFixed(2)),
        askDepth: parseFloat(askDepth.toFixed(2)),
        lastPrice: parseFloat(midpoint.toFixed(4)),
        volume24h: 0,
      };

      for (const cb of this.onMarketDataCallbacks) {
        try { cb(this.lastMarketData); } catch {}
      }
    } else if (eventType === "price_change") {
      const changes = data.price_changes || data.changes || [];
      for (const change of changes) {
        const bestBid = parseFloat(change.best_bid || change.bid || "0");
        const bestAsk = parseFloat(change.best_ask || change.ask || "0");
        if (bestBid > 0 && bestAsk > 0) {
          const spread = bestAsk - bestBid;
          const midpoint = (bestBid + bestAsk) / 2;

          if (this.lastMarketData) {
            this.lastMarketData.bestBid = parseFloat(bestBid.toFixed(4));
            this.lastMarketData.bestAsk = parseFloat(bestAsk.toFixed(4));
            this.lastMarketData.spread = parseFloat(spread.toFixed(4));
            this.lastMarketData.midpoint = parseFloat(midpoint.toFixed(4));
            this.lastMarketData.lastPrice = parseFloat(midpoint.toFixed(4));
          }

          for (const cb of this.onMarketDataCallbacks) {
            try { cb(this.lastMarketData!); } catch {}
          }
        }
      }
    } else if (eventType === "last_trade_price") {
      const price = parseFloat(data.price || "0");
      if (price > 0 && this.lastMarketData) {
        this.lastMarketData.lastPrice = parseFloat(price.toFixed(4));
      }
    }
  }

  private _handleUserMessage(data: any): void {
    if (!data || typeof data !== "object") return;

    const eventType = data.event_type;

    if (eventType === "order") {
      const orderId = data.id || data.order_id || data.orderID;
      const status = data.status || "";
      const sizeMatched = parseFloat(data.size_matched || data.matched || "0");
      const price = parseFloat(data.price || "0");
      const side = data.side || "";
      const ts = data.timestamp || Date.now();

      this.log("info", `User WS: Order update - ${orderId} status=${status} matched=${sizeMatched}`);

      for (const cb of this.onFillCallbacks) {
        try {
          cb({
            orderId,
            side,
            price,
            sizeMatched,
            status,
            timestamp: typeof ts === "number" ? ts : Date.now(),
          });
        } catch {}
      }
    } else if (eventType === "trade") {
      const orderId = data.taker_order_id || data.maker_order_id || data.order_id || "";
      const price = parseFloat(data.price || "0");
      const size = parseFloat(data.size || data.amount || "0");
      const side = data.side || "";
      const ts = data.timestamp || Date.now();

      this.log("info", `User WS: Trade executed - ${side} ${size} @ $${price} (order: ${orderId})`);

      for (const cb of this.onFillCallbacks) {
        try {
          cb({
            orderId,
            side,
            price,
            sizeMatched: size,
            status: "MATCHED",
            timestamp: typeof ts === "number" ? ts : Date.now(),
          });
        } catch {}
      }
    }
  }

  private async _refreshAndReconnectMarket(): Promise<void> {
    if (this.onRefreshAssetIdsCallback) {
      try {
        const freshIds = await this.onRefreshAssetIdsCallback();
        const validIds = this.filterValidAssets(freshIds);
        if (validIds.length > 0) {
          this.subscribedMarketAssets = validIds;
          this.log("info", `Market WS: Refreshed asset IDs: ${validIds.map(id => id.slice(0, 12) + '...').join(', ')}`);
        }
      } catch (err: any) {
        this.log("warn", `Market WS: Failed to refresh asset IDs: ${err.message}`);
      }
    }
    this._scheduleMarketReconnect();
  }

  private _scheduleMarketReconnect(): void {
    if (!this.shouldReconnectMarket) return;

    this.marketReconnects++;
    if (this.marketReconnects > MAX_RECONNECT_ATTEMPTS) {
      this.log("error", `Market WS: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping.`);
      this.shouldReconnectMarket = false;
      return;
    }

    const delay = Math.min(this.marketReconnectDelay, MAX_RECONNECT_DELAY);
    this.log("info", `Market WS: Reconnecting in ${delay}ms (attempt #${this.marketReconnects}/${MAX_RECONNECT_ATTEMPTS})`);

    this.marketReconnectTimer = setTimeout(() => {
      this.marketReconnectDelay = Math.min(
        this.marketReconnectDelay * RECONNECT_BACKOFF_FACTOR,
        MAX_RECONNECT_DELAY,
      );
      this._connectMarket();
    }, delay);
  }

  private onRefreshApiCredsCallback: (() => Promise<{ apiKey: string; secret: string; passphrase: string } | null>) | null = null;

  onRefreshApiCreds(cb: () => Promise<{ apiKey: string; secret: string; passphrase: string } | null>): void {
    this.onRefreshApiCredsCallback = cb;
  }

  private _scheduleUserReconnect(): void {
    if (!this.shouldReconnectUser) return;

    this.userReconnects++;
    if (this.userReconnects > MAX_RECONNECT_ATTEMPTS) {
      this.log("error", `User WS: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping.`);
      this.shouldReconnectUser = false;
      return;
    }

    const delay = Math.min(this.userReconnectDelay, MAX_RECONNECT_DELAY);
    this.log("info", `User WS: Reconnecting in ${delay}ms (attempt #${this.userReconnects}/${MAX_RECONNECT_ATTEMPTS})`);

    this.userReconnectTimer = setTimeout(async () => {
      this.userReconnectDelay = Math.min(
        this.userReconnectDelay * RECONNECT_BACKOFF_FACTOR,
        MAX_RECONNECT_DELAY,
      );
      if (this.userReconnects >= 3 && this.onRefreshApiCredsCallback) {
        try {
          const freshCreds = await this.onRefreshApiCredsCallback();
          if (freshCreds) {
            this.apiCreds = freshCreds;
            this.log("info", `User WS: Refreshed API credentials before reconnect`);
          }
        } catch (err: any) {
          this.log("warn", `User WS: Failed to refresh API credentials: ${err.message}`);
        }
      }
      this._connectUser();
    }, delay);
  }

  private _cleanupMarket(): void {
    if (this.marketPingTimer) {
      clearInterval(this.marketPingTimer);
      this.marketPingTimer = null;
    }
    if (this.marketReconnectTimer) {
      clearTimeout(this.marketReconnectTimer);
      this.marketReconnectTimer = null;
    }
    if (this.marketWs) {
      try { this.marketWs.close(); } catch {}
      this.marketWs = null;
    }
    this.marketConnected = false;
  }

  private _cleanupUser(): void {
    if (this.userPingTimer) {
      clearInterval(this.userPingTimer);
      this.userPingTimer = null;
    }
    if (this.userReconnectTimer) {
      clearTimeout(this.userReconnectTimer);
      this.userReconnectTimer = null;
    }
    if (this.userWs) {
      try { this.userWs.close(); } catch {}
      this.userWs = null;
    }
    this.userConnected = false;
  }

  private async log(level: string, message: string): Promise<void> {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [WS]`;
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else if (level === "warn") {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }

    const eventType = level === "error" ? "ERROR" : "INFO";
    try {
      await storage.createEvent({
        type: eventType,
        message: `[WS] ${message}`,
        data: {
          timestamp: ts,
          level,
          marketConnected: this.marketConnected,
          userConnected: this.userConnected,
          marketReconnects: this.marketReconnects,
          userReconnects: this.userReconnects,
          subscribedMarketAssets: this.subscribedMarketAssets.length,
          subscribedUserAssets: this.subscribedUserAssets.length,
        },
        level,
      });
    } catch {}
  }
}

export const polymarketWs = new PolymarketWebSocket();
