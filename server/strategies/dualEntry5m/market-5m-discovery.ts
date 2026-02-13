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

function getSlugPrefix(asset: AssetType): string {
  const prefixes: Record<AssetType, string> = {
    btc: "btc-updown-5m",
    eth: "eth-updown-5m",
    sol: "sol-updown-5m",
    xrp: "xrp-updown-5m",
    doge: "doge-updown-5m",
    bnb: "bnb-updown-5m",
    link: "link-updown-5m",
    mstr: "mstr-updown-5m",
  };
  return prefixes[asset] || "btc-updown-5m";
}

function getCurrentIntervalTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % 300);
}

function getNextIntervalTimestamp(): number {
  return getCurrentIntervalTimestamp() + 300;
}

async function fetchEventBySlug(slug: string): Promise<any | null> {
  try {
    const response = await fetch(`${GAMMA_BASE}/events?slug=${slug}`);
    if (!response.ok) return null;
    const events = await response.json();
    if (!events || events.length === 0) return null;
    return events[0];
  } catch (err: any) {
    console.error(`[Market5mDiscovery] fetchEventBySlug error for ${slug}:`, err.message);
    return null;
  }
}

function parseEvent(event: any): Market5mInfo | null {
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
  const intervalEnd = timestamp + 300;
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

export async function fetchCurrent5mMarket(asset: AssetType = "btc"): Promise<Market5mInfo | null> {
  const prefix = getSlugPrefix(asset);
  const currentTs = getCurrentIntervalTimestamp();
  const nextTs = getNextIntervalTimestamp();

  const currentSlug = `${prefix}-${currentTs}`;
  let event = await fetchEventBySlug(currentSlug);
  if (event) {
    const info = parseEvent(event);
    if (info && !info.closed) return info;
  }

  const nextSlug = `${prefix}-${nextTs}`;
  event = await fetchEventBySlug(nextSlug);
  if (event) {
    const info = parseEvent(event);
    if (info) return info;
  }

  const prevTs = currentTs - 300;
  const prevSlug = `${prefix}-${prevTs}`;
  event = await fetchEventBySlug(prevSlug);
  if (event) {
    const info = parseEvent(event);
    if (info && !info.closed) return info;
  }

  console.log(`[Market5mDiscovery] No active 5m market found for ${asset}. Tried: ${currentSlug}, ${nextSlug}, ${prevSlug}`);
  return null;
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

export function computeNextIntervalSlug(asset: AssetType = "btc"): { slug: string; startsInMs: number; intervalStart: number } {
  const prefix = getSlugPrefix(asset);
  const nextTs = getNextIntervalTimestamp();
  const now = Math.floor(Date.now() / 1000);
  return {
    slug: `${prefix}-${nextTs}`,
    startsInMs: (nextTs - now) * 1000,
    intervalStart: nextTs,
  };
}
