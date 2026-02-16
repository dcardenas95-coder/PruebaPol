const GAMMA_BASE = "https://gamma-api.polymarket.com";

export interface Market5mInfo {
  slug: string;
  title: string;
  question: string;
  conditionId: string;
  tokenUp: string;
  tokenDown: string;
  outcomes: string[];
  outcomePrices: number[];
  negRisk: boolean;
  tickSize: number;
  intervalStart: number;
  intervalEnd: number;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  timeRemainingMs: number;
}

export type AssetType = "btc" | "eth" | "sol" | "xrp" | "doge" | "bnb" | "link" | "mstr";

export type IntervalType = "5m" | "15m";

function getSlugPrefix(asset: AssetType, interval: IntervalType = "5m"): string {
  return `${asset}-updown-${interval}`;
}

function getIntervalSeconds(interval: IntervalType): number {
  return interval === "15m" ? 900 : 300;
}

function getCurrentIntervalTimestamp(interval: IntervalType = "5m"): number {
  const now = Math.floor(Date.now() / 1000);
  const sec = getIntervalSeconds(interval);
  return now - (now % sec);
}

function getNextIntervalTimestamp(interval: IntervalType = "5m"): number {
  return getCurrentIntervalTimestamp(interval) + getIntervalSeconds(interval);
}

async function fetchEventBySlug(slug: string): Promise<any | null> {
  try {
    const response = await fetch(`${GAMMA_BASE}/events?slug=${slug}`);
    if (!response.ok) return null;
    const events = await response.json();
    if (!events || events.length === 0) return null;
    return events[0];
  } catch (err: any) {
    console.error(`[Market5mDiscovery] fetchEventBySlug error: ${err.message} | slug=${slug} | URL: ${GAMMA_BASE}/events?slug=${slug}`);
    return null;
  }
}

function parseEvent(event: any, interval: IntervalType = "5m"): Market5mInfo | null {
  if (!event || !event.markets || event.markets.length === 0) return null;

  const market = event.markets[0];
  let tokenIds: string[] = [];
  let outcomes: string[] = [];
  let prices: number[] = [];

  try {
    tokenIds = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds || [];
  } catch { tokenIds = market.clobTokenIds || []; }

  try {
    outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes || [];
  } catch { outcomes = market.outcomes || []; }

  try {
    const rawPrices = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices || [];
    prices = rawPrices.map((p: any) => parseFloat(p));
  } catch { prices = [0.5, 0.5]; }

  if (tokenIds.length < 2) return null;

  const slugParts = event.slug?.split("-") || [];
  const timestamp = parseInt(slugParts[slugParts.length - 1]) || 0;
  const intervalEnd = timestamp + getIntervalSeconds(interval);
  const now = Math.floor(Date.now() / 1000);

  return {
    slug: event.slug,
    title: event.title || market.question || "",
    question: market.question || event.title || "",
    conditionId: market.conditionId || "",
    tokenUp: tokenIds[0],
    tokenDown: tokenIds[1],
    outcomes,
    outcomePrices: prices,
    negRisk: market.negRisk === true || market.negRisk === "true",
    tickSize: market.orderPriceMinTickSize || 0.01,
    intervalStart: timestamp,
    intervalEnd,
    active: market.active !== false,
    closed: market.closed === true,
    acceptingOrders: market.acceptingOrders !== false,
    timeRemainingMs: Math.max(0, (intervalEnd - now) * 1000),
  };
}

export async function fetchCurrentIntervalMarket(asset: AssetType = "btc", interval: IntervalType = "5m"): Promise<Market5mInfo | null> {
  const prefix = getSlugPrefix(asset, interval);
  const sec = getIntervalSeconds(interval);
  const currentTs = getCurrentIntervalTimestamp(interval);
  const nextTs = getNextIntervalTimestamp(interval);

  const currentSlug = `${prefix}-${currentTs}`;
  let event = await fetchEventBySlug(currentSlug);
  if (event) {
    const info = parseEvent(event, interval);
    if (info && !info.closed) return info;
  }

  const nextSlug = `${prefix}-${nextTs}`;
  event = await fetchEventBySlug(nextSlug);
  if (event) {
    const info = parseEvent(event, interval);
    if (info) return info;
  }

  const prevTs = currentTs - sec;
  const prevSlug = `${prefix}-${prevTs}`;
  event = await fetchEventBySlug(prevSlug);
  if (event) {
    const info = parseEvent(event, interval);
    if (info && !info.closed) return info;
  }

  console.log(`[MarketDiscovery] No active ${interval} market found for ${asset}. Tried: ${currentSlug}, ${nextSlug}, ${prevSlug}`);
  return null;
}

export async function fetchCurrent5mMarket(asset: AssetType = "btc"): Promise<Market5mInfo | null> {
  return fetchCurrentIntervalMarket(asset, "5m");
}

export async function fetchUpcoming5mMarkets(asset: AssetType = "btc", count: number = 3): Promise<Market5mInfo[]> {
  const prefix = getSlugPrefix(asset);
  const currentTs = getCurrentIntervalTimestamp();
  const results: Market5mInfo[] = [];

  for (let i = 0; i < count + 2; i++) {
    const ts = currentTs + (i * 300);
    const slug = `${prefix}-${ts}`;
    const event = await fetchEventBySlug(slug);
    if (event) {
      const info = parseEvent(event);
      if (info && !info.closed) {
        results.push(info);
        if (results.length >= count) break;
      }
    }
  }

  return results;
}

export async function fetchNextIntervalMarket(asset: AssetType = "btc", interval: IntervalType = "5m"): Promise<Market5mInfo | null> {
  const prefix = getSlugPrefix(asset, interval);
  const nextTs = getNextIntervalTimestamp(interval);
  const slug = `${prefix}-${nextTs}`;
  const event = await fetchEventBySlug(slug);
  if (event) {
    const info = parseEvent(event, interval);
    if (info) return info;
  }
  return null;
}

export function computeNextIntervalSlug(asset: AssetType = "btc", interval: IntervalType = "5m"): { slug: string; startsInMs: number; intervalStart: number } {
  const prefix = getSlugPrefix(asset, interval);
  const nextTs = getNextIntervalTimestamp(interval);
  const now = Math.floor(Date.now() / 1000);
  return {
    slug: `${prefix}-${nextTs}`,
    startsInMs: (nextTs - now) * 1000,
    intervalStart: nextTs,
  };
}
