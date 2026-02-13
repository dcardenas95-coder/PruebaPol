import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { storage } from "../storage";
import { apiRateLimiter } from "./rate-limiter";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 0;

export interface LiveOrderResult {
  success: boolean;
  orderID?: string;
  errorMsg?: string;
  transactID?: string;
}

export interface LiveCancelResult {
  success: boolean;
  errorMsg?: string;
}

export interface BalanceInfo {
  balance: string;
  allowance: string;
}

export class LiveTradingClient {
  private client: ClobClient | null = null;
  private creds: ApiKeyCreds | null = null;
  private wallet: Wallet | null = null;
  private initialized = false;
  private initError: string | null = null;

  async initialize(): Promise<{ success: boolean; error?: string }> {
    try {
      const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
      if (!privateKey) {
        this.initError = "POLYMARKET_PRIVATE_KEY not set";
        return { success: false, error: this.initError };
      }

      const cleanKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
      this.wallet = new Wallet(cleanKey);
      const walletAddress = await this.wallet.getAddress();

      console.log(`[LiveTrading] Initializing with wallet: ${walletAddress}`);

      const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, this.wallet);

      try {
        this.creds = await tempClient.deriveApiKey();
        console.log("[LiveTrading] Derived existing API key");
      } catch {
        console.log("[LiveTrading] Creating new API key...");
        this.creds = await tempClient.createApiKey();
        console.log("[LiveTrading] Created new API key");
      }

      this.client = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        this.wallet,
        this.creds,
        SIGNATURE_TYPE,
      );

      const ok = await this.client.getOk();
      console.log("[LiveTrading] CLOB connection test:", ok);

      this.initialized = true;
      this.initError = null;

      await storage.createEvent({
        type: "INFO",
        message: `Live trading client initialized. Wallet: ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
        data: { wallet: walletAddress },
        level: "info",
      });

      return { success: true };
    } catch (error: any) {
      this.initError = error.message;
      console.error("[LiveTrading] Initialization error:", error.message);
      await storage.createEvent({
        type: "ERROR",
        message: `Live trading initialization failed: ${error.message}`,
        data: { error: error.message },
        level: "error",
      });
      return { success: false, error: error.message };
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getInitError(): string | null {
    return this.initError;
  }

  getWalletAddress(): string | null {
    if (!this.wallet) return null;
    return this.wallet.address;
  }

  getApiCreds(): { apiKey: string; secret: string; passphrase: string } | null {
    if (!this.creds) return null;
    return {
      apiKey: this.creds.key,
      secret: this.creds.secret,
      passphrase: this.creds.passphrase,
    };
  }

  async getBalanceAllowance(tokenId: string): Promise<BalanceInfo | null> {
    if (!this.client || !this.initialized) return null;
    try {
      const result = await this.client.getBalanceAllowance({
        asset_type: "CONDITIONAL",
        token_id: tokenId,
      } as any);
      return {
        balance: result?.balance ?? "0",
        allowance: result?.allowance ?? "0",
      };
    } catch (error: any) {
      console.error("[LiveTrading] Balance check error:", error.message);
      return null;
    }
  }

  async getCollateralBalance(): Promise<BalanceInfo | null> {
    if (!this.client || !this.initialized) return null;
    try {
      const result = await this.client.getBalanceAllowance({
        asset_type: "COLLATERAL",
      } as any);
      return {
        balance: result?.balance ?? "0",
        allowance: result?.allowance ?? "0",
      };
    } catch (error: any) {
      console.error("[LiveTrading] Collateral balance check error:", error.message);
      return null;
    }
  }

  async placeOrder(params: {
    tokenId: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    negRisk: boolean;
    tickSize: string;
  }): Promise<LiveOrderResult> {
    if (!this.client || !this.initialized) {
      return { success: false, errorMsg: "Client not initialized" };
    }

    try {
      const side = params.side === "BUY" ? Side.BUY : Side.SELL;

      const roundedPrice = this.roundToTickSize(params.price, params.tickSize);
      const roundedSize = Math.max(1, Math.round(params.size));

      console.log(`[LiveTrading] Placing ${params.side} order: ${roundedSize} @ $${roundedPrice} (tick: ${params.tickSize}, negRisk: ${params.negRisk})`);

      await storage.createEvent({
        type: "INFO",
        message: `LIVE ORDER: ${params.side} ${roundedSize} @ $${roundedPrice}`,
        data: { ...params, roundedPrice, roundedSize },
        level: "warn",
      });

      const response = await this.client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price: roundedPrice,
          side,
          size: roundedSize,
        },
        {
          tickSize: params.tickSize,
          negRisk: params.negRisk,
        } as any,
        OrderType.GTC,
      );

      console.log("[LiveTrading] Order response:", JSON.stringify(response));

      const orderID = response?.orderID || response?.id || response?.orderHash;

      if (response?.success === false || response?.errorMsg) {
        await storage.createEvent({
          type: "ORDER_REJECTED",
          message: `LIVE ORDER REJECTED: ${response.errorMsg || "Unknown error"}`,
          data: { response },
          level: "error",
        });
        return {
          success: false,
          errorMsg: response.errorMsg || "Order rejected by exchange",
        };
      }

      await storage.createEvent({
        type: "ORDER_PLACED",
        message: `LIVE ORDER ACCEPTED: ${params.side} ${roundedSize} @ $${roundedPrice} (ID: ${orderID})`,
        data: { orderID, response },
        level: "info",
      });

      apiRateLimiter.recordSuccess();
      return {
        success: true,
        orderID,
        transactID: response?.transactID,
      };
    } catch (error: any) {
      console.error("[LiveTrading] Place order error:", error.message);
      await apiRateLimiter.recordError(error.message);
      await storage.createEvent({
        type: "ERROR",
        message: `LIVE ORDER ERROR: ${error.message}`,
        data: { error: error.message, params },
        level: "error",
      });
      return { success: false, errorMsg: error.message };
    }
  }

  async cancelOrder(orderHash: string): Promise<LiveCancelResult> {
    if (!this.client || !this.initialized) {
      return { success: false, errorMsg: "Client not initialized" };
    }

    try {
      console.log(`[LiveTrading] Cancelling order: ${orderHash}`);
      await this.client.cancelOrder({ orderID: orderHash } as any);

      await storage.createEvent({
        type: "ORDER_CANCELLED",
        message: `LIVE ORDER CANCELLED: ${orderHash}`,
        data: { orderHash },
        level: "info",
      });

      return { success: true };
    } catch (error: any) {
      console.error("[LiveTrading] Cancel order error:", error.message);
      return { success: false, errorMsg: error.message };
    }
  }

  async cancelAllOrders(): Promise<LiveCancelResult> {
    if (!this.client || !this.initialized) {
      return { success: false, errorMsg: "Client not initialized" };
    }

    try {
      console.log("[LiveTrading] Cancelling ALL orders");
      await this.client.cancelAll();

      await storage.createEvent({
        type: "ORDER_CANCELLED",
        message: "ALL LIVE ORDERS CANCELLED",
        data: {},
        level: "warn",
      });

      return { success: true };
    } catch (error: any) {
      console.error("[LiveTrading] Cancel all orders error:", error.message);
      return { success: false, errorMsg: error.message };
    }
  }

  async getOpenOrders(): Promise<any[]> {
    if (!this.client || !this.initialized) return [];

    try {
      const response = await this.client.getOpenOrders();
      return Array.isArray(response) ? response : [];
    } catch (error: any) {
      console.error("[LiveTrading] Get open orders error:", error.message);
      return [];
    }
  }

  async getOrderStatus(orderHash: string): Promise<any | null> {
    if (!this.client || !this.initialized) return null;

    try {
      const openOrders = await this.client.getOpenOrders({ id: orderHash } as any);
      const orders = Array.isArray(openOrders) ? openOrders : [];
      if (orders.length > 0) return orders[0];

      const allOrders = await this.client.getOpenOrders();
      const allOrdersList = Array.isArray(allOrders) ? allOrders : [];
      const found = allOrdersList.find((o: any) => o.id === orderHash);
      return found || { id: orderHash, status: "NOT_FOUND", size_matched: "0", original_size: "0" };
    } catch (error: any) {
      console.error("[LiveTrading] Get order status error:", error.message);
      return null;
    }
  }

  async getTradesForOrder(orderHash: string): Promise<any[]> {
    if (!this.client || !this.initialized) return [];

    try {
      const trades = await (this.client as any).getTrades?.({ id: orderHash }) || [];
      return Array.isArray(trades) ? trades : [];
    } catch {
      return [];
    }
  }

  private roundToTickSize(price: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (tick <= 0) return price;
    const rounded = Math.round(price / tick) * tick;
    const decimals = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
    return parseFloat(rounded.toFixed(decimals));
  }
}

export const liveTradingClient = new LiveTradingClient();
