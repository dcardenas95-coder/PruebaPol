# PROMPT PARA REPLIT AGENT — PolyMaker Mega-Fix v2.0

## CONTEXTO

Soy el desarrollador de PolyMaker, un bot de market making para Polymarket BTC Binary Markets (5m/15m). El proyecto fue auditado por un experto en trading algorítmico que encontró 12 bugs críticos, 8 debilidades estructurales y 15 oportunidades de optimización. Necesito que apliques TODOS los fixes descritos abajo. El proyecto usa TypeScript, Express, Drizzle ORM, PostgreSQL y React.

**REGLA FUNDAMENTAL:** No rompas nada que ya funcione. Cada fix debe ser quirúrgico. Si un archivo no está listado en un fix, no lo toques. Compila y verifica después de cada grupo de cambios.

---

## PARTE 1: 12 BUGS CRÍTICOS

### BUG-01 🔴 CRÍTICO — El bot SIEMPRE compra tokenUp sin importar la señal del Oracle

**Problema:** En `server/bot/strategy-engine.ts` línea ~856, el `entryPrice` SIEMPRE usa `data.bestBid` del token UP. Cuando el Oracle dice "DOWN → compra NO", el bot debería usar el tokenDown, pero usa tokenUp. Apuesta en contra de su propia señal.

**Fix:** Necesitamos que `botConfig` almacene el tokenDown. Luego en `executeStrategy`, cuando el Oracle dice NO, usamos ese token.

**Archivo: `shared/schema.ts`** — Agregar campo `currentMarketTokenDown` a `botConfig`:
```typescript
// Después de la línea que define currentMarketTickSize, agregar:
currentMarketTokenDown: text("current_market_token_down"),
```

**Archivo: `shared/schema.ts`** — Agregar al `updateBotConfigSchema`:
```typescript
currentMarketTokenDown: z.string().optional(),
```

**Archivo: `server/bot/strategy-engine.ts`** — En `executeStrategy()`, después de obtener `oracleResult` (~línea 805), determinar el tokenId correcto:
```typescript
// Reemplazar la línea: const entryPrice = data.bestBid;
// Con:
let effectiveTokenId = tokenId; // Default = tokenUp
if (binanceOracle.isConnected() && oracleResult.tokenSide === "NO") {
  const tokenDown = (config as any).currentMarketTokenDown;
  if (tokenDown && tokenDown.length > 10 && !tokenDown.includes("sim")) {
    effectiveTokenId = tokenDown;
  }
}
const entryPrice = data.bestBid;
```

Y en el `placeOrder` call (~línea 859), reemplazar `tokenId` con `effectiveTokenId`:
```typescript
await this.orderManager.placeOrder({
  marketId,
  tokenId: effectiveTokenId,  // ← CAMBIADO de tokenId
  side: "BUY",
  price: entryPrice,
  size: effectiveSize,
  isPaperTrade: config.isPaperTrading,
  negRisk,
  tickSize,
});
```

**Archivo: `server/bot/strategy-engine.ts`** — En `switchToMarket()` (~línea 1185), almacenar tokenDown:
```typescript
// Después de la línea: currentMarketId: market.tokenUp,
// Agregar:
currentMarketTokenDown: market.tokenDown,
```

**Archivo: `server/bot/strategy-engine.ts`** — En `start()` cuando se hace auto-rotate (~línea 93-98), también almacenar tokenDown:
```typescript
// Después de: currentMarketTickSize: String(market.tickSize),
// Agregar:
currentMarketTokenDown: market.tokenDown,
```

**Archivo: `server/bot/strategy-engine.ts`** — En `getStatus()` (al final), incluir tokenDown en la respuesta para el dashboard. En el default config fallback, agregar:
```typescript
currentMarketTokenDown: null,
```

Después ejecuta la migración de DB:
```bash
npx drizzle-kit generate
npx drizzle-kit push
```

---

### BUG-02 🔴 CRÍTICO — MarketData solo tiene datos del tokenUp, nunca del tokenDown

**Problema:** `MarketDataModule` solo trackea UN token. Cuando compras tokenDown no tienes su bid/ask real.

**Fix:** Agregar un segundo MarketData source para el tokenDown dentro de `strategy-engine.ts`. No vamos a cambiar MarketDataModule (demasiado riesgo), sino que consultamos el tokenDown directamente cuando lo necesitamos.

**Archivo: `server/bot/strategy-engine.ts`** — Agregar un método privado para obtener datos del token NO:
```typescript
// Agregar este método a la clase StrategyEngine
private async getTokenDownData(config: BotConfig): Promise<MarketData | null> {
  const tokenDown = (config as any).currentMarketTokenDown;
  if (!tokenDown || tokenDown.length < 10 || tokenDown.includes("sim")) return null;
  
  try {
    const { polymarketClient } = await import("./polymarket-client");
    return await polymarketClient.fetchMarketData(tokenDown);
  } catch (err: any) {
    console.error(`[StrategyEngine] Failed to fetch tokenDown data: ${err.message}`);
    return null;
  }
}
```

**Archivo: `server/bot/strategy-engine.ts`** — En `executeStrategy()`, cuando Oracle dice NO, usar datos del tokenDown para el precio:
```typescript
// Después de determinar effectiveTokenId (del fix BUG-01), agregar:
let entryPrice = data.bestBid;
if (effectiveTokenId !== tokenId) {
  // Estamos comprando tokenDown, necesitamos su precio
  const tokenDownData = await this.getTokenDownData(config);
  if (tokenDownData) {
    entryPrice = tokenDownData.bestBid;
  } else {
    // Sin datos del tokenDown, no podemos operar en ese lado
    await storage.createEvent({
      type: "INFO",
      message: `[ORACLE] Signal says NO but no tokenDown market data available — skipping`,
      data: { signal: oracleSignal.direction },
      level: "warn",
    });
    return;
  }
}
```

---

### BUG-03 🟡 ALTO — Stop-loss usa marketData que puede ser del token equivocado

**Archivo: `server/bot/strategy-engine.ts`** — En el bloque de stop-loss check dentro de `tick()` (~línea 660), agregar contexto del token correcto. Antes del `stopLossManager.checkAllPositions()` call, si hay posiciones en tokenDown, obtener esos datos:

```typescript
// Reemplazar:
// const stopLossResults = await stopLossManager.checkAllPositions(data, remaining, this.MARKET_DURATION);
// Con:
let stopLossData = data;
// Si tenemos posiciones que son de tokenDown, necesitamos datos de ese token para el stop-loss
const allPositions = await storage.getPositions();
const hasTokenDownPositions = allPositions.some(p => {
  const tokenDown = (config as any).currentMarketTokenDown;
  return p.size > 0 && tokenDown && p.marketId.includes("NO");
});
if (hasTokenDownPositions) {
  const tokenDownData = await this.getTokenDownData(config);
  if (tokenDownData) {
    stopLossData = tokenDownData;
  }
}
const stopLossResults = await stopLossManager.checkAllPositions(stopLossData, remaining, this.MARKET_DURATION);
```

---

### BUG-04 🟡 ALTO — Oracle opening price no se alinea con el boundary del intervalo de Polymarket

**Archivo: `server/bot/binance-oracle.ts`** — Reemplazar el método `markWindowStart()` completamente:

```typescript
markWindowStart(): void {
  // Calcular el boundary del intervalo de 5 minutos más cercano
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const intervalSec = 300; // 5 minutos
  const boundaryTimestamp = nowSec - (nowSec % intervalSec);
  const boundaryMs = boundaryTimestamp * 1000;
  
  // Buscar precio en el buffer más cercano al boundary (±5 segundos)
  const nearBoundary = this.priceBuffer.filter(
    p => Math.abs(p.ts - boundaryMs) < 5000
  );
  
  if (nearBoundary.length > 0) {
    // Usar el precio más cercano al boundary
    nearBoundary.sort((a, b) => Math.abs(a.ts - boundaryMs) - Math.abs(b.ts - boundaryMs));
    this.openingPrice = nearBoundary[0].price;
    this.windowStartTime = boundaryMs;
    console.log(`[BinanceOracle] Window start aligned to boundary: opening=$${this.openingPrice.toFixed(2)} (from buffer, ${Math.abs(nearBoundary[0].ts - boundaryMs)}ms from boundary)`);
  } else if (this.currentPrice > 0) {
    // Fallback: usar precio actual
    this.openingPrice = this.currentPrice;
    this.windowStartTime = nowMs;
    console.log(`[BinanceOracle] Window start marked (no boundary data): opening=$${this.openingPrice.toFixed(2)}`);
  }
}
```

---

### BUG-05 🟡 ALTO — Fee rate hardcodeado 0.1% cuando Polymarket cobra ~1.5% taker

**Archivo: `server/bot/order-manager.ts`** — Reemplazar el fee rate constante con un cálculo dinámico. 

Reemplazar la línea:
```typescript
private readonly POLYMARKET_FEE_RATE = 0.001;
```
Con:
```typescript
// Polymarket dynamic taker fee formula
// Maker orders pay 0 fees. Taker fee = p * (1-p) * 0.0222
// At $0.50: ~0.55%, at $0.30: ~0.47%, at $0.10: ~0.20%
private readonly IS_MAKER_ORDER = true; // Default: assume maker orders (limit orders on book)

private calculateFee(price: number, size: number, isMaker: boolean = this.IS_MAKER_ORDER): number {
  if (isMaker) return 0; // Maker orders pay zero fees on Polymarket
  const takerFeeRate = price * (1 - price) * 0.0222;
  return parseFloat((size * price * takerFeeRate).toFixed(6));
}
```

Then replace ALL occurrences of `fillSize * fillPrice * this.POLYMARKET_FEE_RATE` in the file with `this.calculateFee(fillPrice, fillSize)`. There are approximately 5-6 occurrences:

1. In `reconcileOnStartup()` (~line 60): `const fee = this.calculateFee(fillPrice, newFillSize);`
2. In `reconcileOnStartup()` second occurrence (~line 85): same
3. In `pollLiveOrderStatuses()` (~line 366): same
4. In `pollLiveOrderStatuses()` second occurrence (~line 398): same
5. In `handleWsFill()` (~line 457): same
6. In `simulateFill()` (~line 561): `const fee = this.calculateFee(fillPrice, fillSize, false);` ← Note: paper fills are taker fills (crossing price), so pass `false`

**IMPORTANT:** In `simulateFill()`, pass `false` as the third argument to `calculateFee` because simulated fills cross the spread (taker behavior). For all live order fills, use the default (maker), because our strategy should only place limit orders.

---

### BUG-06 🟡 ALTO — getExitPrice no considera spread ni Oracle

**Archivo: `server/bot/market-data.ts`** — Reemplazar el método `getExitPrice()`:

```typescript
getExitPrice(entryPrice: number, profitMin: number, profitMax: number): number {
  const target = (profitMin + profitMax) / 2;
  const rawExit = entryPrice + target;
  
  // Clamp to valid Polymarket range
  const clamped = Math.max(0.02, Math.min(0.99, rawExit));
  
  // If we have current market data, ensure TP is reasonable relative to current prices
  if (this.lastData) {
    // Don't set TP higher than current bestAsk + small buffer (it would be unfillable)
    const maxReasonableTP = this.lastData.bestAsk + 0.02;
    // Don't set TP lower than entry + 1 cent (minimum profit)
    const minTP = entryPrice + 0.01;
    return parseFloat(Math.max(minTP, Math.min(clamped, maxReasonableTP)).toFixed(4));
  }
  
  return parseFloat(clamped.toFixed(4));
}
```

---

### BUG-07 🟢 MEDIO — Paper fill simulation no distingue maker vs taker fees

**Archivo: `server/bot/order-manager.ts`** — En `simulateFill()`, ya manejado en BUG-05 fix. Asegurarse de que la línea de fee calcula con taker fee (tercer argumento `false`):

```typescript
const fee = this.calculateFee(fillPrice, fillSize, false); // Paper fills simulate taker behavior
```

---

### BUG-08 🟢 MEDIO — UNWIND vende solo 50% de la posición, creando cascada

**Archivo: `server/bot/strategy-engine.ts`** — En `executeUnwind()` (~línea 985), cambiar 0.5 a 1.0:

Reemplazar:
```typescript
size: parseFloat((pos.size * 0.5).toFixed(2)),
```
Con:
```typescript
size: parseFloat(pos.size.toFixed(2)), // Sell 100% — no fractional cascade
```

---

### BUG-09 🟢 MEDIO — Trailing stop no funciona correctamente para SHORT positions

**Archivo: `server/bot/stop-loss-manager.ts`** — En `updateHighWaterMark()` (~línea 43), agregar lógica para trackear LOW water mark para SELL positions:

Reemplazar:
```typescript
updateHighWaterMark(positionKey: string, currentPrice: number): void {
  const existing = this.highWaterMarks.get(positionKey) || 0;
  if (currentPrice > existing) {
    this.highWaterMarks.set(positionKey, currentPrice);
  }
}
```
Con:
```typescript
updateHighWaterMark(positionKey: string, currentPrice: number, side: string = "BUY"): void {
  const existing = this.highWaterMarks.get(positionKey) || (side === "BUY" ? 0 : Infinity);
  if (side === "BUY") {
    // For BUY positions, track HIGH water mark (price going up is good)
    if (currentPrice > existing) {
      this.highWaterMarks.set(positionKey, currentPrice);
    }
  } else {
    // For SELL positions, track LOW water mark (price going down is good)
    if (currentPrice < existing) {
      this.highWaterMarks.set(positionKey, currentPrice);
    }
  }
}
```

Also update the `checkStopLoss` method to pass `position.side` to `updateHighWaterMark`:
```typescript
// In checkStopLoss(), change:
this.updateHighWaterMark(posKey, currentPrice);
// To:
this.updateHighWaterMark(posKey, currentPrice, position.side);
```

---

### BUG-10 🟢 MEDIO — Progressive Sizer consecutive counts from wrong event window

**Archivo: `server/bot/progressive-sizer.ts`** — In `getStats()`, change the event query to only get PNL events:

Reemplazar:
```typescript
const recentEvents = await storage.getEvents(50);
const fillEvents = recentEvents.filter(e => e.type === "ORDER_FILLED" || e.type === "PNL_UPDATE");
```
Con:
```typescript
const recentEvents = await storage.getEvents(200); // Larger window to ensure we capture enough PNL events
const fillEvents = recentEvents.filter(e => e.type === "PNL_UPDATE"); // Only PNL events have reliable pnl data
```

---

### BUG-11 🟡 ALTO — Market Regime Filter blocks trading when volatility < 0.1%

**Archivo: `server/bot/market-regime-filter.ts`** — Change default minVolatility:

Reemplazar:
```typescript
const DEFAULT_CONFIG: RegimeConfig = {
  enabled: true,
  minDepth: 50,
  maxVolatility: 0.5,
  minVolatility: 0.1,
  maxSpread: 0.15,
};
```
Con:
```typescript
const DEFAULT_CONFIG: RegimeConfig = {
  enabled: true,
  minDepth: 30,       // Reduced: Polymarket 5m markets can have lower depth
  maxVolatility: 0.8,  // Increased: allow more volatile conditions with Oracle
  minVolatility: 0.01, // Reduced drastically: BTC often moves <0.1% in 5m
  maxSpread: 0.20,     // Increased: 5m markets can have wider spreads
};
```

Also, make the RANGING regime tradeable when Oracle has a signal. Change the RANGING block:
```typescript
if (vol <= this.config.minVolatility) {
  return {
    regime: "RANGING",
    tradeable: true,  // ← CHANGED from false. Let the Oracle decide in flat markets.
    reason: `Low volatility ${vol.toFixed(3)}% — Oracle-dependent`,
    volatility: vol,
    depth,
    spread,
  };
}
```

---

### BUG-12 🟢 MEDIO — Binance Oracle volatility measure is inconsistent

**Archivo: `server/bot/binance-oracle.ts`** — Add a second volatility measure (range-based) that's more intuitive:

Add this method after `getVolatility()`:
```typescript
// Range-based volatility: (max - min) / avg as percentage
getRangeVolatility(windowMinutes: number): number {
  const now = Date.now();
  const cutoff = now - windowMinutes * 60 * 1000;
  const prices = this.priceBuffer.filter(p => p.ts >= cutoff).map(p => p.price);
  
  if (prices.length < 3) return 0;
  
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  
  return parseFloat(((max - min) / avg * 100).toFixed(4));
}
```

Update `getSignal()` to include it in the return object. Add `rangeVolatility5m: this.getRangeVolatility(5),` to the PriceSignal return. Also add it to the PriceSignal interface:
```typescript
export interface PriceSignal {
  // ... existing fields ...
  rangeVolatility5m: number; // NEW
}
```

Update all places where PriceSignal is constructed to include this new field (in both the early return and the main return of `getSignal()`).

---

## PARTE 2: 8 DEBILIDADES ESTRUCTURALES

### STRUCT-01 — Bot opera sobre UN token pero necesita DOS (RESOLVED by BUG-01 + BUG-02)
Already handled above. No additional work needed.

---

### STRUCT-02 — No hay distinción entre maker y taker orders

**Archivo: `server/bot/order-manager.ts`** — Add `isMakerOrder` field to the order placement params and to the `orders` table.

**Archivo: `shared/schema.ts`** — Add to orders table:
```typescript
// After isPaperTrade in orders table:
isMakerOrder: boolean("is_maker_order").notNull().default(true),
```

Run migration after:
```bash
npx drizzle-kit generate
npx drizzle-kit push
```

**Archivo: `server/bot/order-manager.ts`** — In `placeOrder()` params, add `isMakerOrder?: boolean` (default `true`). Pass it through to the created order:
```typescript
// In the params type of placeOrder, add:
isMakerOrder?: boolean;

// In createOrder call, add:
isMakerOrder: params.isMakerOrder ?? true,
```

**Archivo: `server/bot/strategy-engine.ts`** — Entry orders (BUY) should be `isMakerOrder: true`. Exit orders in HEDGE_LOCK should be `isMakerOrder: false` (taker, crossing spread):
```typescript
// In executeHedgeLock placeOrder calls, add:
isMakerOrder: false, // Emergency exit crosses spread
```

---

### STRUCT-03 — Dual-Entry engine doesn't use Oracle/StopLoss/Sizer/Regime modules

**Archivo: `server/strategies/dualEntry5m/engine.ts`** — At the top of the file, add imports:
```typescript
import { binanceOracle } from "../../bot/binance-oracle";
import { marketRegimeFilter } from "../../bot/market-regime-filter";
```

In the `tick()` method or wherever entry decisions are made (`shouldEnterCycle` or equivalent), add Oracle check:
```typescript
// Before starting a new cycle, check Oracle and Regime
const signal = binanceOracle.getSignal();
if (binanceOracle.isConnected() && signal.strength === "NONE") {
  // No clear signal — skip this cycle
  return;
}
```

This is a lightweight integration. The full integration of stop-loss and sizer into Dual-Entry is lower priority and can be done later.

---

### STRUCT-04 — Risk Manager pierde state en restart

**Archivo: `server/bot/risk-manager.ts`** — Persist `dailyPnl` and `consecutiveLosses` to DB and restore on construction.

Add to constructor:
```typescript
constructor() {
  this.restoreFromDb();
}

private async restoreFromDb(): Promise<void> {
  try {
    const { format } = await import("date-fns");
    const { storage } = await import("../storage");
    const today = format(new Date(), "yyyy-MM-dd");
    const pnl = await storage.getPnlByDate(today);
    if (pnl) {
      this.dailyPnl = pnl.realizedPnl;
      // Approximate consecutive losses from recent events
      const events = await storage.getEvents(50);
      const pnlEvents = events.filter(e => e.type === "PNL_UPDATE");
      let consecutive = 0;
      for (const evt of pnlEvents) {
        const data = evt.data as any;
        if (data?.realizedPnl !== undefined && data.realizedPnl < 0) {
          consecutive++;
        } else {
          break;
        }
      }
      this.consecutiveLosses = consecutive;
      console.log(`[RiskManager] Restored from DB: dailyPnl=$${this.dailyPnl.toFixed(2)}, consecutiveLosses=${this.consecutiveLosses}`);
    }
  } catch (err: any) {
    console.error(`[RiskManager] Failed to restore from DB: ${err.message}`);
  }
}
```

---

### STRUCT-05 — No hay backtesting framework

This is a feature, not a bug fix. **Skip for now.** Add a TODO comment at the top of `strategy-engine.ts`:
```typescript
// TODO: Implement backtesting framework to validate strategy changes against historical data
// Priority: Phase 3 optimization
```

---

### STRUCT-06 — Volume in updateDailyPnl is abs(pnl) not trade value

**Archivo: `server/bot/strategy-engine.ts`** — In `updateDailyPnl()` method, the volume calculation is wrong.

This method needs a `tradeValue` parameter. Update the signature:
```typescript
private async updateDailyPnl(pnl: number, isWin: boolean, tradeValue?: number): Promise<void> {
```

Replace:
```typescript
volume: parseFloat((existing.volume + Math.abs(pnl)).toFixed(4)),
```
With:
```typescript
volume: parseFloat((existing.volume + (tradeValue || Math.abs(pnl))).toFixed(4)),
```

And the same in the `else` branch:
```typescript
volume: tradeValue || Math.abs(pnl),
```

Then update all callers of `updateDailyPnl` in `tick()` to pass the trade value. In the paper trading block (~line 622-625):
```typescript
if (result.filled && result.pnl !== 0) {
  this.riskManager.recordTradeResult(result.pnl);
  await this.updateDailyPnl(result.pnl, result.pnl > 0);
  // Note: tradeValue not available from simulateFill result — acceptable for now
}
```

---

### STRUCT-07 — getOracleAlignedSide always returns side="BUY" (clarification only)

This is correct behavior (we always BUY tokens, either YES or NO). But add a clarifying comment:

**Archivo: `server/bot/strategy-engine.ts`** — Add comment above `getOracleAlignedSide`:
```typescript
/**
 * Determines which token side to BUY based on Oracle signal.
 * side is always "BUY" because in binary markets we buy tokens (YES or NO).
 * tokenSide determines WHICH token to buy (YES = tokenUp, NO = tokenDown).
 */
```

---

### STRUCT-08 — WebSocket fills from previous market can arrive after rotation

**Archivo: `server/bot/strategy-engine.ts`** — In the `onFill` callback in `setupWebSocket()` and `RECONNECT_WS()`, add marketId filter:

In both places where `polymarketWs.onFill()` is registered, wrap the handler:
```typescript
polymarketWs.onFill(async (fillData) => {
  try {
    // Filter out fills from previous markets
    const currentConfig = await storage.getBotConfig();
    const currentMarketId = currentConfig?.currentMarketSlug || currentConfig?.currentMarketId;
    // Only process if we can't determine the market, or it matches current
    await this.orderManager.handleWsFill(fillData);
  } catch (err: any) {
    console.error(`[StrategyEngine] WS fill handler error: ${err.message}`);
  }
});
```

The real protection is already in `handleWsFill()` which matches by `exchangeOrderId`. This is just defense-in-depth.

---

## PARTE 3: 15 OPORTUNIDADES DE OPTIMIZACIÓN

### OPT-01 — Reduce tick interval from 3s to 2s for faster Oracle response
**Archivo: `server/bot/strategy-engine.ts`** — Change line 174:
```typescript
this.interval = setInterval(() => this.tick(), 2000); // Was 3000
```

---

### OPT-02 — Add Oracle confidence to TP calculation
**Archivo: `server/bot/strategy-engine.ts`** — In `setupTakeProfitCallback`, use Oracle confidence to adjust TP:
```typescript
// After calculating exitPrice:
const oracleSignal = binanceOracle.getSignal();
if (binanceOracle.isConnected() && oracleSignal.confidence > 0.7) {
  // High confidence: slightly more aggressive TP
  const confidenceBonus = (oracleSignal.confidence - 0.5) * 0.02; // max +1 cent
  exitPrice = parseFloat((exitPrice + confidenceBonus).toFixed(4));
}
```

---

### OPT-03 — Add configurable Oracle thresholds to dashboard
**Archivo: `server/routes.ts`** — Add API endpoint to update Oracle config:
```typescript
// Add endpoint: PATCH /api/oracle/config
app.patch("/api/oracle/config", async (req, res) => {
  const { strongThreshold, weakThreshold, minConfidence, enabled } = req.body;
  binanceOracle.updateConfig({ strongThreshold, weakThreshold, minConfidence, enabled });
  res.json({ success: true, config: binanceOracle.getConfig() });
});
```

Also add GET endpoint:
```typescript
app.get("/api/oracle/config", (req, res) => {
  res.json(binanceOracle.getConfig());
});
```

Import `binanceOracle` at the top of routes.ts if not already imported.

---

### OPT-04 — Add configurable stop-loss config to dashboard
**Archivo: `server/routes.ts`** — Similar to OPT-03:
```typescript
app.patch("/api/stoploss/config", async (req, res) => {
  stopLossManager.updateConfig(req.body);
  res.json({ success: true, config: stopLossManager.getConfig() });
});
app.get("/api/stoploss/config", (req, res) => {
  res.json(stopLossManager.getConfig());
});
```

Import `stopLossManager` at the top of routes.ts.

---

### OPT-05 — Add configurable regime filter config to dashboard
**Archivo: `server/routes.ts`**:
```typescript
app.patch("/api/regime/config", async (req, res) => {
  marketRegimeFilter.updateConfig(req.body);
  res.json({ success: true, config: marketRegimeFilter.getConfig() });
});
app.get("/api/regime/config", (req, res) => {
  res.json(marketRegimeFilter.getConfig());
});
```

Import `marketRegimeFilter` at the top of routes.ts.

---

### OPT-06 — Add configurable progressive sizer config to dashboard
**Archivo: `server/routes.ts`**:
```typescript
app.patch("/api/sizer/config", async (req, res) => {
  progressiveSizer.updateConfig(req.body);
  progressiveSizer.invalidateCache();
  res.json({ success: true, config: progressiveSizer.getConfig() });
});
app.get("/api/sizer/config", (req, res) => {
  res.json(progressiveSizer.getConfig());
});
```

Import `progressiveSizer` at the top of routes.ts.

---

### OPT-07 — Log Oracle signal with every trade for post-analysis
**Already partially implemented** in strategy-engine.ts ~line 870-877. Enhance it to also log tokenSide:
```typescript
// In the existing Oracle log event, add tokenSide:
data: { oracle: oracleSignal, sizer: sizerLevel, regime: regimeResult.regime, effectiveSize, tokenSide: oracleResult.tokenSide, effectiveTokenId },
```

---

### OPT-08 — Add fee tracking per day to PnL records

**Archivo: `server/bot/strategy-engine.ts`** — In `updateDailyPnl()`, add fee parameter:
```typescript
private async updateDailyPnl(pnl: number, isWin: boolean, tradeValue?: number, fee?: number): Promise<void> {
```

In the update block, add:
```typescript
fees: parseFloat((existing.fees + (fee || 0)).toFixed(4)),
```

And in the create block:
```typescript
fees: fee || 0,
```

---

### OPT-09 — Binance Oracle should auto-reconnect more aggressively

**Archivo: `server/bot/binance-oracle.ts`** — Reduce max reconnect delay:
```typescript
// Change:
private readonly RECONNECT_MAX_MS = 30000;
// To:
private readonly RECONNECT_MAX_MS = 10000; // Max 10s between reconnects
```

---

### OPT-10 — Add health check for Binance Oracle in health-monitor

**Archivo: `server/bot/health-monitor.ts`** — Import binanceOracle and add a check:
```typescript
import { binanceOracle } from "./binance-oracle";

// In the health check method, add:
const oracleHealthy = binanceOracle.isConnected();
// Include in the checks array
```

If Oracle is disconnected for more than 60s, emit warning alert.

---

### OPT-11 — Improve WebSocket stale threshold for faster fallback

**Archivo: `server/bot/market-data.ts`** — Reduce stale threshold:
```typescript
// Change:
private readonly WS_STALE_THRESHOLD = 15_000;
// To:
private readonly WS_STALE_THRESHOLD = 10_000; // 10s instead of 15s
```

---

### OPT-12 — Rate limiter should have separate limits for different operations

This is a nice-to-have. **Add a TODO comment** in `rate-limiter.ts`:
```typescript
// TODO: Implement separate rate limit buckets for:
// - Market data queries (higher limit)
// - Order placement (lower limit, more important)
// - Balance checks (lowest priority)
```

---

### OPT-13 — Add "dry run counter" to show how many cycles would have been profitable

**Archivo: `server/bot/strategy-engine.ts`** — Add counter in getStatus():
```typescript
// In getStatus(), add to the return object:
cycleCount: this.cycleCount,
```

Make sure `cycleCount` is already defined (it is, at line 24).

---

### OPT-14 — Ensure Binance Oracle connects at bot import, not just at start()

**Archivo: `server/bot/binance-oracle.ts`** — Add auto-connect on module load:
```typescript
// At the very end of the file, after the export:
// Auto-connect on import so price buffer starts filling immediately
setTimeout(() => {
  if (!binanceOracle.isConnected()) {
    binanceOracle.connect();
    console.log("[BinanceOracle] Auto-connected on module load");
  }
}, 2000);
```

---

### OPT-15 — Add market direction persistence for analytics

**Archivo: `shared/schema.ts`** — Add `oracleDirection` and `oracleConfidence` to orders table:
```typescript
// After isMakerOrder in orders table:
oracleDirection: text("oracle_direction"),     // "UP", "DOWN", "NEUTRAL"
oracleConfidence: real("oracle_confidence"),    // 0.0 - 1.0
```

Run migration:
```bash
npx drizzle-kit generate
npx drizzle-kit push
```

**Archivo: `server/bot/order-manager.ts`** — In `placeOrder()` params, add optional fields:
```typescript
oracleDirection?: string;
oracleConfidence?: number;
```

Pass them through to `createOrder`:
```typescript
oracleDirection: params.oracleDirection,
oracleConfidence: params.oracleConfidence,
```

**Archivo: `server/bot/strategy-engine.ts`** — In `executeStrategy()`, pass Oracle data to placeOrder:
```typescript
await this.orderManager.placeOrder({
  // ... existing params ...
  oracleDirection: oracleSignal.direction,
  oracleConfidence: oracleSignal.confidence,
});
```

---

## PARTE 4: POST-IMPLEMENTATION CHECKLIST

After applying all changes:

1. Run `npx drizzle-kit generate` then `npx drizzle-kit push` to apply DB migrations
2. Verify the app compiles: `npx tsc --noEmit`
3. Start the app and verify:
   - Dashboard loads correctly
   - Bot can start in PAPER mode
   - Oracle shows connected with BTC price
   - Stop-loss status shows in dashboard
   - Progressive sizer shows level 1
   - Market regime shows current state
4. Run paper trading for at least 30 minutes and verify:
   - Orders are placed on the correct token side (YES or NO)
   - Stop-loss triggers at configured threshold
   - Fee calculation shows 0 for maker orders
   - UNWIND sells 100% not 50%
   - No cascading sells
5. Check logs for any TypeScript errors or runtime crashes

---

## RESUMEN DE ARCHIVOS MODIFICADOS

| Archivo | Cambios |
|---------|---------|
| `shared/schema.ts` | Add `currentMarketTokenDown` to botConfig, `isMakerOrder`/`oracleDirection`/`oracleConfidence` to orders |
| `server/bot/strategy-engine.ts` | BUG-01 (token selection), BUG-02 (tokenDown data), BUG-03 (stop-loss data), BUG-08 (UNWIND 100%), STRUCT-06 (volume), STRUCT-07 (comment), STRUCT-08 (fill filter), OPT-01 (tick 2s), OPT-02 (TP confidence), OPT-07 (log tokenSide), OPT-08 (fee tracking), OPT-13 (cycleCount), OPT-15 (oracle in orders) |
| `server/bot/binance-oracle.ts` | BUG-04 (boundary alignment), BUG-12 (range volatility), OPT-09 (reconnect), OPT-14 (auto-connect) |
| `server/bot/order-manager.ts` | BUG-05 (dynamic fees), BUG-07 (maker/taker fees), STRUCT-02 (isMakerOrder), OPT-15 (oracle fields) |
| `server/bot/market-data.ts` | BUG-06 (exit price), OPT-11 (stale threshold) |
| `server/bot/stop-loss-manager.ts` | BUG-09 (trailing for shorts) |
| `server/bot/progressive-sizer.ts` | BUG-10 (event window) |
| `server/bot/market-regime-filter.ts` | BUG-11 (thresholds + RANGING tradeable) |
| `server/bot/risk-manager.ts` | STRUCT-04 (persist to DB) |
| `server/bot/health-monitor.ts` | OPT-10 (Oracle health) |
| `server/bot/rate-limiter.ts` | OPT-12 (TODO comment) |
| `server/strategies/dualEntry5m/engine.ts` | STRUCT-03 (Oracle integration) |
| `server/routes.ts` | OPT-03/04/05/06 (config endpoints) |
