import type { MarketData } from "@shared/schema";

const CLOB_BASE = "https://clob.polymarket.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";

export interface PolymarketMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  endDateIso: string;
  volume: string;
  volumeNum: number;
  volume24hr: number;
  liquidity: string;
  liquidityNum: number;
  description: string;
  negRisk: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  acceptingOrders: boolean;
}

export interface OrderBookEntry {
  price: string;
  size: string;
}

export interface OrderBookResponse {
  market: string;
  asset_id: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  hash: string;
  timestamp: string;
}

export class PolymarketClient {
  private lastFetchTime = 0;
  private cachedData: MarketData | null = null;
  private readonly MIN_FETCH_INTERVAL = 2000;
  private orderbookErrorCount = 0;
  private lastOrderbookErrorLog = 0;

  async fetchMarkets(query?: string): Promise<PolymarketMarket[]> {
    const url = `${GAMMA_BASE}/markets`;
    try {
      const params = new URLSearchParams({
        closed: "false",
        active: "true",
        limit: "200",
        order: "volume24hr",
        ascending: "false",
        liquidity_num_min: "1000",
      });

      const response = await fetch(`${url}?${params.toString()}`);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(`[PolymarketClient] fetchMarkets failed: HTTP ${response.status} ${response.statusText} | URL: ${url} | body: ${body.slice(0, 200)}`);
        throw new Error(`Gamma API error: ${response.status}`);
      }
      const allMarkets: PolymarketMarket[] = await response.json();

      if (query) {
        const q = query.toLowerCase();
        return allMarkets
          .filter(m => {
            const question = (m.question || "").toLowerCase();
            const desc = (m.description || "").toLowerCase();
            return question.includes(q) || desc.includes(q);
          })
          .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
      }

      return allMarkets;
    } catch (error: any) {
      if (!error.message?.includes("Gamma API error")) {
        console.error(`[PolymarketClient] fetchMarkets network error: ${error.message} | URL: ${url}`);
      }
      return [];
    }
  }

  async fetchBTCMarkets(): Promise<PolymarketMarket[]> {
    try {
      const allMarkets = await this.fetchMarkets();
      const btcMarkets = allMarkets.filter(m => {
        const q = (m.question || "").toLowerCase();
        return (q.includes("bitcoin") || q.includes("btc"))
          && m.active && !m.closed && m.acceptingOrders;
      });
      return btcMarkets.sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
    } catch (error: any) {
      console.error(`[PolymarketClient] fetchBTCMarkets error: ${error.message}`);
      return [];
    }
  }

  async fetchOrderBook(tokenId: string): Promise<OrderBookResponse | null> {
    const url = `${CLOB_BASE}/book?token_id=${tokenId}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        this.orderbookErrorCount++;
        const now = Date.now();
        if (now - this.lastOrderbookErrorLog > 30_000 || this.orderbookErrorCount <= 3) {
          const body = await response.text().catch(() => "");
          console.error(`[PolymarketClient] fetchOrderBook HTTP ${response.status}: tokenId=${tokenId.slice(0, 12)}... | errors=${this.orderbookErrorCount} | body: ${body.slice(0, 150)}`);
          this.lastOrderbookErrorLog = now;
        }
        return null;
      }
      this.orderbookErrorCount = 0;
      return await response.json();
    } catch (error: any) {
      this.orderbookErrorCount++;
      const now = Date.now();
      if (now - this.lastOrderbookErrorLog > 30_000 || this.orderbookErrorCount <= 3) {
        console.error(`[PolymarketClient] fetchOrderBook network error: ${error.message} | tokenId=${tokenId.slice(0, 12)}... | errors=${this.orderbookErrorCount}`);
        this.lastOrderbookErrorLog = now;
      }
      return null;
    }
  }

  async fetchMidpoint(tokenId: string): Promise<number | null> {
    try {
      const response = await fetch(`${CLOB_BASE}/midpoint?token_id=${tokenId}`);
      if (!response.ok) {
        console.warn(`[PolymarketClient] fetchMidpoint HTTP ${response.status}: tokenId=${tokenId.slice(0, 12)}...`);
        return null;
      }
      const data = await response.json();
      return parseFloat(data.mid);
    } catch (error: any) {
      console.error(`[PolymarketClient] fetchMidpoint network error: ${error.message} | tokenId=${tokenId.slice(0, 12)}...`);
      return null;
    }
  }

  async fetchPrice(tokenId: string, side: "BUY" | "SELL"): Promise<number | null> {
    try {
      const response = await fetch(`${CLOB_BASE}/price?token_id=${tokenId}&side=${side}`);
      if (!response.ok) {
        console.warn(`[PolymarketClient] fetchPrice HTTP ${response.status}: tokenId=${tokenId.slice(0, 12)}... side=${side}`);
        return null;
      }
      const data = await response.json();
      return parseFloat(data.price);
    } catch (error: any) {
      console.error(`[PolymarketClient] fetchPrice network error: ${error.message} | tokenId=${tokenId.slice(0, 12)}... side=${side}`);
      return null;
    }
  }

  async fetchSpread(tokenId: string): Promise<{ spread: number } | null> {
    try {
      const response = await fetch(`${CLOB_BASE}/spread?token_id=${tokenId}`);
      if (!response.ok) {
        console.warn(`[PolymarketClient] fetchSpread HTTP ${response.status}: tokenId=${tokenId.slice(0, 12)}...`);
        return null;
      }
      const data = await response.json();
      return { spread: parseFloat(data.spread) };
    } catch (error: any) {
      console.error(`[PolymarketClient] fetchSpread network error: ${error.message} | tokenId=${tokenId.slice(0, 12)}...`);
      return null;
    }
  }

  async fetchMarketData(tokenId: string): Promise<MarketData | null> {
    const now = Date.now();
    if (now - this.lastFetchTime < this.MIN_FETCH_INTERVAL && this.cachedData) {
      return this.cachedData;
    }

    try {
      const orderBook = await this.fetchOrderBook(tokenId);
      if (!orderBook) return null;

      const bids = orderBook.bids
        .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a, b) => b.price - a.price);

      const asks = orderBook.asks
        .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a, b) => a.price - b.price);

      const bestBid = bids.length > 0 ? bids[0].price : 0;
      const bestAsk = asks.length > 0 ? asks[0].price : 1;
      const spread = bestAsk - bestBid;
      const midpoint = (bestBid + bestAsk) / 2;

      const bidDepth = bids.reduce((sum, b) => sum + b.size, 0);
      const askDepth = asks.reduce((sum, a) => sum + a.size, 0);

      this.cachedData = {
        bestBid: parseFloat(bestBid.toFixed(4)),
        bestAsk: parseFloat(bestAsk.toFixed(4)),
        spread: parseFloat(spread.toFixed(4)),
        midpoint: parseFloat(midpoint.toFixed(4)),
        bidDepth: parseFloat(bidDepth.toFixed(2)),
        askDepth: parseFloat(askDepth.toFixed(2)),
        lastPrice: parseFloat(midpoint.toFixed(4)),
        volume24h: 0,
      };

      this.lastFetchTime = now;
      return this.cachedData;
    } catch (error: any) {
      console.error(`[PolymarketClient] fetchMarketData error: ${error.message} | tokenId=${tokenId.slice(0, 12)}... | stack: ${error.stack?.split("\n")[1]?.trim() || "none"}`);
      return null;
    }
  }

  async getConnectionStatus(): Promise<{
    hasPrivateKey: boolean;
    publicEndpointsOk: boolean;
    canTradeLive: boolean;
  }> {
    const hasPrivateKey = !!process.env.POLYMARKET_PRIVATE_KEY;

    let publicEndpointsOk = false;
    try {
      const response = await fetch(`${CLOB_BASE}/time`);
      publicEndpointsOk = response.ok;
    } catch (error: any) {
      console.error(`[PolymarketClient] Connection check failed: ${error.message}`);
      publicEndpointsOk = false;
    }

    return {
      hasPrivateKey,
      publicEndpointsOk,
      canTradeLive: hasPrivateKey && publicEndpointsOk,
    };
  }
}

export const polymarketClient = new PolymarketClient();
