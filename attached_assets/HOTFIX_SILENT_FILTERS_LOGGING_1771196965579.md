# HOTFIX — Agregar logs de diagnóstico a filtros silenciosos en executeStrategy

## CONTEXTO
El bot no coloca órdenes en paper trading y no genera NINGÚN log que explique por qué. Hay 5 puntos en `executeStrategy()` donde el bot hace `return` sin generar evento. Necesitamos agregar un log a CADA uno para diagnosticar en tiempo real cuál filtro está bloqueando.

## CAMBIOS — Archivo: `server/bot/strategy-engine.ts`

### Fix 1: Log cuando spread es insuficiente
Reemplazar:
```typescript
if (!this.marketData.isSpreadSufficient(config.minSpread)) {
  return;
}
```
Con:
```typescript
if (!this.marketData.isSpreadSufficient(config.minSpread)) {
  const lastData = this.marketData.getLastData();
  await storage.createEvent({
    type: "INFO",
    message: `[FILTER] Spread insuficiente: ${lastData?.spread?.toFixed(4) ?? "N/A"} < min ${config.minSpread} — no trade`,
    data: { filter: "spread", spread: lastData?.spread, minSpread: config.minSpread },
    level: "info",
  });
  return;
}
```

### Fix 2: Log cuando mercado no está activo
Reemplazar:
```typescript
if (!this.marketData.isMarketActive()) {
  return;
}
```
Con:
```typescript
if (!this.marketData.isMarketActive()) {
  const lastData = this.marketData.getLastData();
  await storage.createEvent({
    type: "INFO",
    message: `[FILTER] Mercado inactivo: bidDepth=${lastData?.bidDepth?.toFixed(0) ?? "0"} askDepth=${lastData?.askDepth?.toFixed(0) ?? "0"} (min 10) — no trade`,
    data: { filter: "marketActive", bidDepth: lastData?.bidDepth, askDepth: lastData?.askDepth },
    level: "info",
  });
  return;
}
```

### Fix 3: Log cuando regime filter bloquea
Reemplazar:
```typescript
const regimeResult = marketRegimeFilter.getRegime(data);
if (!regimeResult.tradeable) {
  return;
}
```
Con:
```typescript
const regimeResult = marketRegimeFilter.getRegime(data);
if (!regimeResult.tradeable) {
  await storage.createEvent({
    type: "INFO",
    message: `[FILTER] Regime ${regimeResult.regime}: ${regimeResult.reason} — no trade`,
    data: { filter: "regime", regime: regimeResult.regime, reason: regimeResult.reason, volatility: regimeResult.volatility, depth: regimeResult.depth, spread: regimeResult.spread },
    level: "info",
  });
  return;
}
```

### Fix 4: Log cuando Oracle dice NEUTRAL
Reemplazar:
```typescript
if (binanceOracle.isConnected() && !oracleResult.side) {
  return;
}
```
Con:
```typescript
if (binanceOracle.isConnected() && !oracleResult.side) {
  await storage.createEvent({
    type: "INFO",
    message: `[FILTER] Oracle NEUTRAL: direction=${oracleSignal.direction} strength=${oracleSignal.strength} delta=$${oracleSignal.delta.toFixed(2)} conf=${(oracleSignal.confidence * 100).toFixed(0)}% — no trade`,
    data: { filter: "oracle", direction: oracleSignal.direction, strength: oracleSignal.strength, delta: oracleSignal.delta, confidence: oracleSignal.confidence },
    level: "info",
  });
  return;
}
```

### Fix 5: Log cuando risk check bloquea
Buscar:
```typescript
const riskCheck = await this.riskManager.checkPreTrade(config, effectiveSize * data.bestBid);
if (!riskCheck.allowed) {
  return;
}
```
Reemplazar con:
```typescript
const riskCheck = await this.riskManager.checkPreTrade(config, effectiveSize * data.bestBid);
if (!riskCheck.allowed) {
  await storage.createEvent({
    type: "RISK_ALERT",
    message: `[FILTER] Risk check blocked: ${riskCheck.reason} — no trade`,
    data: { filter: "risk", reason: riskCheck.reason, warnings: riskCheck.warnings },
    level: "warn",
  });
  return;
}
```

## IMPORTANTE
- Estos logs se van a generar cada 2-3 segundos (cada tick). Para evitar spam, puedes agregar un throttle: solo logear cada 30 segundos. Pero para diagnóstico inicial déjalos sin throttle y después los removemos.
- NO cambies ninguna otra lógica, solo agrega los logs.
