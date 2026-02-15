# PolyMaker — Informe Técnico de Estrategia para Auditoría

**Versión:** 1.1  
**Fecha:** 15 de febrero de 2026  
**Sistema:** PolyMaker — Bot de Market Making Asimétrico  
**Mercado objetivo:** Polymarket BTC Binary Markets (Up/Down 5m y 15m)  
**Blockchain:** Polygon PoS (Chain ID: 137)  
**Wallet:** EOA directo (sigType=0)  
**Protocolo:** Polymarket CLOB (Central Limit Order Book)

---

## Tabla de Contenidos

1. [Resumen Ejecutivo](#1-resumen-ejecutivo)
2. [Arquitectura General](#2-arquitectura-general)
3. [Estrategia 1: Legacy FSM (Máquina de Estados Finita)](#3-estrategia-1-legacy-fsm)
4. [Estrategia 2: Dual-Entry 5m](#4-estrategia-2-dual-entry-5m)
5. [Gestión de Órdenes (Order Manager)](#5-gestión-de-órdenes)
6. [Gestión de Riesgo (Risk Manager)](#6-gestión-de-riesgo)
7. [Infraestructura de Datos de Mercado](#7-infraestructura-de-datos-de-mercado)
8. [Infraestructura RPC y Blockchain](#8-infraestructura-rpc-y-blockchain)
9. [Rate Limiter y Circuit Breaker](#9-rate-limiter-y-circuit-breaker)
10. [Monitor de Salud (Health Monitor)](#10-monitor-de-salud)
11. [Sistema de Alertas](#11-sistema-de-alertas)
12. [Descubrimiento y Rotación de Mercados](#12-descubrimiento-y-rotación-de-mercados)
13. [Reconciliación de Órdenes](#13-reconciliación-de-órdenes)
14. [Cálculo de PnL](#14-cálculo-de-pnl)
15. [Modos de Operación: Paper vs Live](#15-modos-de-operación)
16. [Mecanismos de Seguridad y Kill Switch](#16-mecanismos-de-seguridad)
17. [Contratos y Aprobaciones On-Chain](#17-contratos-y-aprobaciones-on-chain)
18. [Proceso de Liquidación Ordenada](#18-proceso-de-liquidación-ordenada)
19. [Flujo de Datos WebSocket](#19-flujo-de-datos-websocket)
20. [Consideraciones de Auditoría](#20-consideraciones-de-auditoría)

---

## 1. Resumen Ejecutivo

PolyMaker es un bot de market making asimétrico diseñado para operar en mercados binarios de BTC en Polymarket. Los mercados binarios de Polymarket para BTC funcionan con intervalos de 5 y 15 minutos, donde los traders apuestan si el precio de BTC subirá ("Up/Yes") o bajará ("Down/No") dentro del intervalo.

El bot implementa dos estrategias independientes:

1. **Legacy FSM**: Market making direccional con máquina de estados finita que gestiona el ciclo de vida completo de un mercado de 5m/15m — desde la entrada (MAKING) hasta la salida forzada (HEDGE_LOCK).

2. **Dual-Entry 5m**: Estrategia delta-neutral que compra simultáneamente ambos lados (YES y NO) de un mercado binario, buscando beneficiarse cuando uno de los lados sube de precio por encima del costo combinado.

Ambas estrategias soportan auto-rotación automática entre mercados consecutivos.

---

## 2. Arquitectura General

```
┌──────────────────────────────────────────────────────────────────┐
│                     CAPA DE PRESENTACIÓN                         │
│              Dashboard React (Admin Panel)                       │
│     Overview │ Orders │ Positions │ PnL │ Config │ Logs          │
└──────────────────────┬───────────────────────────────────────────┘
                       │ REST API (Express)
┌──────────────────────┴───────────────────────────────────────────┐
│                     CAPA DE LÓGICA                               │
│                                                                   │
│  ┌─────────────────┐    ┌──────────────────────────┐             │
│  │  Strategy Engine │    │  Dual-Entry 5m Engine    │             │
│  │  (Legacy FSM)    │    │  (Ciclos independientes)  │             │
│  └────────┬────────┘    └──────────┬───────────────┘             │
│           │                        │                              │
│  ┌────────┴────────────────────────┴───────────────┐             │
│  │              Order Manager                       │             │
│  │    (Paper fills / Live CLOB orders)              │             │
│  └────────┬─────────────────────────────────────────┘             │
│           │                                                       │
│  ┌────────┴────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │  Risk Manager   │  │ Rate Limiter │  │  Health Monitor  │    │
│  │  (Pre-trade)    │  │ + Circuit Bkr│  │  + Alert Manager │    │
│  └─────────────────┘  └──────────────┘  └──────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                       │
┌──────────────────────┴───────────────────────────────────────────┐
│                     CAPA DE DATOS                                │
│                                                                   │
│  ┌─────────────────┐  ┌────────────────────┐  ┌───────────────┐ │
│  │  Market Data    │  │  Live Trading      │  │  Polymarket   │ │
│  │  Module         │  │  Client            │  │  WebSocket    │ │
│  │  WS > REST >    │  │  (CLOB SDK)        │  │  Market+User  │ │
│  │  Simulation     │  │                    │  │               │ │
│  └─────────────────┘  └────────────────────┘  └───────────────┘ │
│                                                                   │
│  ┌─────────────────┐  ┌────────────────────┐                    │
│  │  PostgreSQL     │  │  Polygon RPC       │                    │
│  │  (Drizzle ORM)  │  │  (QuickNode +      │                    │
│  │                 │  │   6 fallbacks)     │                    │
│  └─────────────────┘  └────────────────────┘                    │
└──────────────────────────────────────────────────────────────────┘
```

### Archivos Clave

| Módulo | Archivo | Líneas |
|--------|---------|--------|
| Strategy Engine (FSM) | `server/bot/strategy-engine.ts` | ~1232 |
| Dual-Entry 5m Engine | `server/strategies/dualEntry5m/engine.ts` | ~1066 |
| Order Manager | `server/bot/order-manager.ts` | ~674 |
| Risk Manager | `server/bot/risk-manager.ts` | ~100 |
| Market Data Module | `server/bot/market-data.ts` | ~193 |
| Live Trading Client | `server/bot/live-trading-client.ts` | ~1107 |
| Rate Limiter | `server/bot/rate-limiter.ts` | ~136 |
| Health Monitor | `server/bot/health-monitor.ts` | ~219 |
| Alert Manager | `server/bot/alert-manager.ts` | variable |
| Market Discovery | `server/strategies/dualEntry5m/market-5m-discovery.ts` | ~172 |
| Volatility Tracker | `server/strategies/dualEntry5m/volatility-tracker.ts` | variable |

---

## 3. Estrategia 1: Legacy FSM

### 3.1 Concepto

La estrategia Legacy FSM implementa market making direccional asimétrico. El bot opera como un market maker que:

1. Identifica el lado con mayor profundidad en el orderbook (bid depth vs ask depth)
2. Coloca órdenes de compra (BUY) en el lado favorecido
3. Al recibir un fill, coloca inmediatamente una orden de take-profit (SELL) a un precio calculado
4. Gestiona todo el ciclo de vida del mercado (5m o 15m) a través de una máquina de estados finita

### 3.2 Máquina de Estados Finita (FSM)

```
                    remainingMs > 120s
                   ┌──────────────────┐
                   │                  │
                   ▼                  │
              ┌─────────┐            │
    Start ──▶ │ MAKING  │ ───────────┘
              └────┬────┘
                   │ remainingMs ≤ 120s
                   ▼
              ┌─────────┐
              │ UNWIND  │
              └────┬────┘
                   │ remainingMs ≤ 60s
                   ▼
              ┌──────────┐
              │CLOSE_ONLY│    (cancela todas las órdenes abiertas)
              └────┬─────┘
                   │ remainingMs ≤ 45s
                   ▼
              ┌──────────┐
              │HEDGE_LOCK│    (salida forzada agresiva)
              └────┬─────┘
                   │ remainingMs ≤ 0s
                   ▼
              ┌─────────┐
              │  DONE   │ ──▶ Auto-rotación al siguiente mercado
              └─────────┘
```

#### Función de Transición de Estado

```typescript
calculateState(current: BotState, remainingMs: number): BotState {
  if (current === "STOPPED") return current;
  if (current === "DONE") return current;
  if (remainingMs <= 0)     return "DONE";
  if (remainingMs <= 45000) return "HEDGE_LOCK";
  if (remainingMs <= 60000) return "CLOSE_ONLY";
  if (remainingMs <= 120000) return "UNWIND";
  return "MAKING";
}
```

### 3.3 Estado MAKING (t > 120s restantes)

**Propósito:** Fase activa de market making — colocar órdenes de entrada y take-profit.

**Lógica de ejecución (cada tick de 3s):**

1. **Verificar spread mínimo:** `spread >= config.minSpread` (valor configurable por usuario). Si no se cumple, se omite el tick. → `market-data.ts:172-174 isSpreadSufficient()`
2. **Verificar actividad del mercado:** `bidDepth > 10 AND askDepth > 10`. Mercados con baja liquidez se ignoran. → `market-data.ts:177-180 isMarketActive()`
3. **Verificar órdenes activas:** No se colocan nuevas entradas si ya hay ≥ 3 BUY orders activas. → `strategy-engine.ts:733`
4. **Risk check pre-trade:** Evaluación completa del Risk Manager (exposición, pérdida diaria, pérdidas consecutivas). → `risk-manager.ts:16-63 checkPreTrade()`
5. **Balance check (solo live):** Consulta USDC.e disponible y verifica que cubre el costo de la orden. → `strategy-engine.ts:740-773`
6. **Determinar lado óptimo:** → `market-data.ts:182-187 getBestSide()`
   - Si `bidDepth > askDepth * 1.2` → BUY
   - Si `askDepth > bidDepth * 1.2` → SELL
   - Default → BUY
7. **Colocar orden:** BUY al precio `bestBid` con tamaño `config.orderSize`. → `strategy-engine.ts:780-802`

**Take-Profit inmediato (callback onBuyFill):**

Cuando un BUY se llena (callback registrado en `strategy-engine.ts:163-223 setupTakeProfitCallback()`):
1. Calcular precio de salida: `exitPrice = avgEntryPrice + (targetProfitMin + targetProfitMax) / 2` → `market-data.ts:189-192 getExitPrice()`
2. Verificar cobertura: Si ya existen TP orders cubriendo la posición, no duplicar → `strategy-engine.ts:196-199`
3. Máximo 4 TP orders simultáneas → `strategy-engine.ts:194`
4. Solo se coloca TP si tamaño descubierto ≥ 0.5 contratos → `strategy-engine.ts:199`
5. Colocar SELL al `exitPrice` calculado

**Ejemplo numérico:**
- `targetProfitMin = 0.03`, `targetProfitMax = 0.05`
- Entrada BUY @ $0.48
- Target profit = (0.03 + 0.05) / 2 = $0.04
- TP SELL @ $0.52

### 3.4 Estado UNWIND (60s < t ≤ 120s)

**Propósito:** Reducir exposición gradualmente antes del fin del mercado.

**Lógica:**
- Para cada posición abierta con `size > 0`:
  - Calcular precio de salida: `bestAsk - 0.01` (para posiciones BUY)
  - Colocar orden SELL por **50% del tamaño de la posición** (reducción gradual)
  - Máximo 2 órdenes activas simultáneas

### 3.5 Estado CLOSE_ONLY (45s < t ≤ 60s)

**Propósito:** No se abren nuevas posiciones. Se cancelan todas las órdenes abiertas.

**Acción al entrar:** `cancelAllOrders()` — cancela todas las órdenes activas tanto en paper como en el exchange CLOB.

### 3.6 Estado HEDGE_LOCK (0s < t ≤ 45s)

**Propósito:** Salida forzada agresiva de todas las posiciones antes de que el mercado se resuelva.

**Lógica de urgencia escalonada:**

| Tiempo restante | Precio de salida (BUY pos) | Agresividad |
|-----------------|---------------------------|-------------|
| 30s < t ≤ 45s | `bestBid` (pasivo) | Baja |
| 20s < t ≤ 30s | `bestBid - 0.005` | Media |
| t ≤ 20s | `bestBid - 0.01` | Alta (cruzando spread) |

**Secuencia:**
1. Cancelar **todas** las órdenes existentes
2. Para cada posición abierta, colocar orden de salida con precio según urgencia
3. Clamping: `max(0.01, min(0.99, exitPrice))`

### 3.7 Estado DONE (t = 0)

**Propósito:** Ciclo de mercado completado.

**Acción:**
1. Cancelar órdenes residuales
2. Si `autoRotate = true`: buscar siguiente mercado y rotar
3. Si `autoRotate = false`: reiniciar ciclo en el mismo mercado

### 3.8 Alineación Temporal del Ciclo

El bot sincroniza su reloj interno con los boundaries de los mercados:

```typescript
alignCycleStartToMarketBoundary(): void {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const intervalSec = MARKET_DURATION / 1000; // 300 (5m) o 900 (15m)
  const elapsedInCurrentInterval = (nowSec % intervalSec) * 1000;
  this.marketCycleStart = nowMs - elapsedInCurrentInterval;
}
```

También puede alinearse usando el `timeRemainingMs` reportado por la API de Polymarket.

### 3.9 Loop Principal

```
Intervalo: 3000ms (cada 3 segundos)

tick() {
  1. Reset diario de contadores de riesgo (si cambió el día UTC)
  2. Verificar: config activa, kill switch inactivo
  3. Circuit breaker check
  4. Rate limiter check
  5. Obtener datos de mercado (WS > REST > Simulación)
  6. Calcular estado FSM basado en tiempo restante
  7. Si hubo transición de estado → ejecutar lógica de transición
  8. Procesar fills (paper: simulación / live: polling exchange)
  9. Verificar límites de riesgo post-trade
  10. Ejecutar lógica del estado actual (MAKING/UNWIND/HEDGE_LOCK/DONE)
}
```

---

## 4. Estrategia 2: Dual-Entry 5m

### 4.1 Concepto

La estrategia Dual-Entry es una estrategia delta-neutral que opera en mercados binarios de BTC 5m/15m. La tesis central:

> En un mercado binario con dos outcomes (YES y NO), si compras ambos lados por debajo de $0.50, tu costo combinado es menor a $1.00. Cuando el mercado se resuelve, uno de los lados paga $1.00. Si vendes el lado ganador antes de la resolución a un precio superior al costo de entrada (TP), la diferencia cubre la pérdida del lado perdedor y genera profit.

### 4.2 Máquina de Estados del Ciclo

```
              ┌────────┐
   Armar  ──▶ │ ARMED  │
              └───┬────┘
                  │ Colocar BUY YES + BUY NO
                  ▼
          ┌───────────────┐
          │ ENTRY_WORKING │
          └───┬─────┬─────┘
              │     │
    Solo 1    │     │ Ambos llenados
    llenado   │     │
              ▼     ▼
     ┌──────────┐  ┌────────┐
     │PARTIAL   │  │ HEDGED │
     │FILL      │  │        │
     └────┬─────┘  └───┬────┘
          │            │ Colocar TP + Scratch
          │            ▼
          │    ┌──────────────┐
          │    │ EXIT_WORKING │
          │    └──────┬───────┘
          │           │
          ▼           ▼
     ┌─────────┐  ┌─────────┐
     │ CLEANUP │  │  DONE   │
     └─────────┘  └─────────┘
```

### 4.3 Estados del Ciclo

| Estado | Descripción |
|--------|-------------|
| `IDLE` | Sin ciclo activo |
| `ARMED` | Ciclo preparado, esperando ventana temporal |
| `ENTRY_WORKING` | Órdenes de entrada colocadas (BUY YES + BUY NO) |
| `PARTIAL_FILL` | Solo uno de los dos lados se llenó |
| `HEDGED` | Ambos lados llenados — posición delta-neutral |
| `EXIT_WORKING` | Órdenes de salida (TP y/o Scratch) colocadas |
| `DONE` | Ciclo completado |
| `CLEANUP` | Cancelando órdenes residuales |
| `FAILSAFE` | Emergencia — limpieza forzada |

### 4.4 Flujo de un Ciclo Completo

#### Fase 1: Armado (ARMED)

**Timing:** El ciclo se arma `entryLeadSecondsPrimary` segundos antes del inicio de la ventana (ej: 60s antes).

**Filtros pre-ciclo:**
1. **Filtro de hora (hourFilter):** Solo opera en horas UTC específicas (configurable).
2. **Filtro de volatilidad (volFilter):** Verifica que la volatilidad actual del BTC esté dentro del rango `[volMinThreshold, volMaxThreshold]`. Si no hay suficientes datos de precio (< 3 muestras), se permite.

#### Fase 2: Colocación de Entradas (ENTRY_WORKING)

Se colocan simultáneamente dos órdenes:
- **BUY YES** @ `entryPrice` × `orderSize`
- **BUY NO** @ `entryPrice` × `orderSize`

**Entry Price dinámico (si `dynamicEntryEnabled = true`):**

```
spread = |yesPrice - noPrice|

Si spread > 0.20 → entryPrice = dynamicEntryMin (más conservador)
Si spread < 0.05 → entryPrice = dynamicEntryMax (más agresivo)
Si 0.05 ≤ spread ≤ 0.20 → interpolación lineal entre max y min
```

**Tamaño dinámico (si `dynamicSizeEnabled = true`):**

```
volatility = getVolatility(volWindowMinutes)

Si vol < 0.5%  → size = dynamicSizeMin
Si vol > 3.0%  → size = dynamicSizeMax
Si 0.5% ≤ vol ≤ 3.0% → interpolación lineal
```

#### Fase 3: Refresh de Órdenes

A `entryLeadSecondsRefresh` segundos antes de la ventana (ej: T-30s):
- Cancelar órdenes no llenadas
- Re-colocarlas al precio actualizado

#### Fase 4: Post-Start Cleanup

A `postStartCleanupSeconds` después del inicio de la ventana (ej: T+10s):

- **0 fills:** Cancelar todo → ciclo termina como FLAT
- **1 fill (PARTIAL_FILL):** Cancelar el lado no llenado → salir del lado llenado al `bestBid` o `scratchPrice`
- **2 fills (HEDGED):** Proceder a fase de salida

#### Fase 5: Salida — Modo Clásico (dualTpMode = false)

1. **Determinar ganador:** Consultar midpoint de YES y NO. El lado con mayor midpoint es el "ganador".
2. **Colocar TP en ganador:** SELL `winnerToken` @ `tpPrice`
3. **Colocar Scratch en perdedor:** SELL `loserToken` @ `scratchPrice`

**Smart Scratch Cancel:** Si `smartScratchCancel = true` y el TP se llena primero, se cancela automáticamente la orden scratch del lado perdedor.

#### Fase 5 (alternativa): Salida — Modo Dual TP (dualTpMode = true)

Se colocan TP en **ambos** lados:
- SELL YES @ `tpPrice`
- SELL NO @ `tpPrice`

El ciclo termina cuando **ambos** TP se llenan.

### 4.5 Cálculo de PnL por Ciclo

**Modo clásico:**
```
entryCost = (yesFilledSize × entryPrice) + (noFilledSize × entryPrice)
exitRevenue = (winnerSize × tpPrice) + (loserSize × scratchPrice)
PnL = exitRevenue - entryCost
```

**Modo Dual TP:**
```
entryCost = (yesFilledSize × entryPrice) + (noFilledSize × entryPrice)
exitRevenue = (yesFilledSize × tpPrice) + (noFilledSize × tpPrice)
PnL = exitRevenue - entryCost
```

**Ejemplo numérico (Modo clásico):**
- Entry price: $0.45 por lado, orderSize: 10 contratos
- TP price: $0.65, Scratch price: $0.40
- Costo total: (10 × $0.45) + (10 × $0.45) = $9.00
- Revenue: (10 × $0.65) + (10 × $0.40) = $10.50
- PnL: $10.50 - $9.00 = **+$1.50 por ciclo**

**Escenario de pérdida (solo partial fill):**
- Solo YES se llenó, NO no se llenó
- Exit YES @ scratch: 10 × $0.40 = $4.00
- Costo: 10 × $0.45 = $4.50
- PnL: $4.00 - $4.50 = **-$0.50**

### 4.6 Exit TTL y FAILSAFE

**Exit TTL** (`exitTtlSeconds`, configurable): Si las órdenes de salida (TP/Scratch) no se llenan dentro de este período, el ciclo se limpia forzadamente. → `engine.ts:441-443`

```
Si exitElapsed > exitTtlSeconds → CLEANUP (cancelar órdenes restantes + finalizar ciclo)
```

**FAILSAFE** (`CycleState = "FAILSAFE"`): Estado de emergencia que se activa cuando se necesita limpieza forzada. Al entrar en FAILSAFE:
1. Se limpian todos los timers del ciclo → `engine.ts:996-1000 clearCycleTimers()`
2. Se persiste el estado del ciclo
3. Se elimina el ciclo del mapa activo → `engine.ts:451-456`

**CLEANUP** (limpieza ordenada) → `engine.ts:876-899`:
1. Cancelar orden YES si no se llenó
2. Cancelar orden NO si no se llenó
3. Cancelar TP si no se llenó
4. Cancelar Scratch si no se llenó
5. Cancelar TP YES/NO (modo dual) si no se llenaron
6. Marcar outcome como `"CLEANUP: {razón}"`
7. Transicionar a DONE

### 4.7 Dedupe Keys

El motor usa un Set de dedupe keys para prevenir duplicación de operaciones dentro de un ciclo:

```
entry-yes-{cycleNumber}       → Previene BUY YES duplicado
entry-no-{cycleNumber}        → Previene BUY NO duplicado
refresh-{cycleNumber}         → Previene refresh duplicado
refresh-yes-{cycleNumber}     → Previene refresh YES duplicado
refresh-no-{cycleNumber}      → Previene refresh NO duplicado
tp-{cycleNumber}              → Previene TP duplicado (modo clásico)
tp-yes-{cycleNumber}          → Previene TP YES duplicado (modo dual)
tp-no-{cycleNumber}           → Previene TP NO duplicado (modo dual)
scratch-{cycleNumber}         → Previene Scratch duplicado
cleanup-{cycleNumber}         → Previene cleanup duplicado
partial-exit-{cycleNumber}    → Previene partial exit duplicado
```

Las dedupe keys se limpian al iniciar el motor (`this.dedupeKeys.clear()` en `start()`).

→ `engine.ts:19, 463-467, 515-517, 606-627, 652-674, 760-762, 775-776`

### 4.8 Módulos Inteligentes

#### Volatility Tracker
- Rastrea precios YES y NO en tiempo real
- Calcula volatilidad en ventanas configurables (`volWindowMinutes`)
- Proporciona momentum (dirección y fuerza del movimiento)
- Alimenta decisiones de: entrada dinámica, TP dinámico, tamaño dinámico

#### TP Dinámico por Momentum (`momentumTpEnabled`)
```
momentum = getMomentum(momentumWindowMinutes)

Si momentum = "flat"   → tp = momentumTpMin
Si momentum = "strong" → tp = momentumTpMin + (strength × range)
Rango = [momentumTpMin, momentumTpMax]
```

### 4.9 Loop Principal

```
Intervalo: 2000ms (cada 2 segundos)

tick() {
  1. Si autoRotate5m → maybeRotateMarket() cada 10s
  2. Para cada market slot:
     a. Si no hay ciclo activo:
        - Calcular armTime = nextWindow - entryLeadSecondsPrimary
        - Si now >= armTime Y shouldEnterCycle() → startNewCycle()
     b. Si hay ciclo activo → processCycleState()
}
```

---

## 5. Gestión de Órdenes

### 5.1 Order Manager

El Order Manager es compartido por la estrategia Legacy FSM. La estrategia Dual-Entry 5m usa el `liveTradingClient` directamente.

**Funciones principales:**

| Función | Descripción |
|---------|-------------|
| `placeOrder()` | Colocar orden (paper o live) con idempotencia por `clientOrderId` |
| `cancelOrder()` | Cancelar orden individual (local + exchange) |
| `cancelAllOrders()` | Cancelar todas las órdenes activas |
| `simulateFill()` | Simulación de fill para paper trading |
| `pollLiveOrderStatuses()` | Polling de estado de órdenes live contra el exchange |
| `handleWsFill()` | Procesar fill recibido por WebSocket |
| `reconcileOnStartup()` | Sincronizar estado de órdenes al arrancar |

### 5.2 Idempotencia

Cada orden tiene un `clientOrderId` único generado como:
```
clientOrderId = `pm-${Date.now()}-${randomUUID().slice(0, 8)}`
```

Antes de crear una orden, se verifica si ya existe una con ese `clientOrderId`. La estrategia Dual-Entry usa dedupe keys adicionales:
```
dedupeKey = `entry-yes-${cycleNumber}` | `entry-no-${cycleNumber}` | `tp-${cycleNumber}` | `scratch-${cycleNumber}`
```

### 5.3 Order Timeout

Todas las órdenes tienen un TTL (Time To Live) de **5 minutos** por defecto. Al expirar:
1. Se verifica que la orden aún esté activa
2. Se registra evento de timeout
3. Se cancela la orden

### 5.4 Simulación de Fills (Paper Trading)

La simulación replica condiciones realistas del mercado:

1. **Price Crossing:** La orden solo puede llenarse si el precio cruza el nivel de la orden:
   - BUY: `bestAsk ≤ order.price`
   - SELL: `bestBid ≥ order.price`

2. **Ticks de confirmación:** Se requieren **2 ticks consecutivos** con price crossing antes de ejecutar el fill (`REQUIRED_CROSSING_TICKS = 2`).

3. **Probabilidad basada en profundidad:** 
   ```
   depthFactor = min(1, depth / 100)
   Si random() > depthFactor → no fill (insuficiente liquidez)
   ```

4. **Slippage adverso:**
   - BUY: `fillPrice = min(order.price + slippage, bestAsk)` donde `slippage ∈ [0.001, 0.003]`
   - SELL: `fillPrice = max(order.price - slippage, bestBid)` donde `slippage ∈ [0.001, 0.003]`

5. **Fee de Polymarket:** `fee = fillSize × fillPrice × 0.001` (0.1% del valor)

### 5.5 Órdenes Live (CLOB SDK)

Para órdenes reales:
1. Se valida que el `tokenId` sea un token real (no simulado, no menor a 10 caracteres)
2. Se envía la orden al CLOB via `liveTradingClient.placeOrder()`
3. Se almacena el `exchangeOrderId` retornado
4. Estado inicial: `PENDING` → `OPEN` (tras confirmación)

**Detección de geo-bloqueo:**
Si la respuesta contiene "regional restriction", "Access restricted" o "GEO-BLOCKED":
- Se registra evento de error
- Se cambia automáticamente a paper trading
- Se registra en el log

---

## 6. Gestión de Riesgo

### 6.1 Risk Manager — Checks Pre-Trade

Antes de cada orden de entrada, se ejecutan las siguientes verificaciones:

| Check | Condición de bloqueo | Parámetro |
|-------|---------------------|-----------|
| Kill Switch | `killSwitchActive = true` | Global |
| Bot inactivo | `isActive = false` | Global |
| Estado restrictivo | `state ∈ {CLOSE_ONLY, DONE, STOPPED}` | FSM State |
| Exposición máxima | `totalExposure + orderValue > maxNetExposure` | `maxNetExposure` (default: $100) |
| Pérdida diaria máxima | `abs(dailyPnl) >= maxDailyLoss AND dailyPnl < 0` | `maxDailyLoss` (default: $50) |
| Pérdidas consecutivas | `consecutiveLosses >= maxConsecutiveLosses` | `maxConsecutiveLosses` (default: 3) |

### 6.2 Alertas de Proximidad

Se emiten alertas (con cooldown de 60s) cuando:
- Exposición ≥ 80% del límite
- Pérdida diaria ≥ 70% del límite
- Pérdidas consecutivas ≥ 67% del límite

### 6.3 Acciones Automáticas Post-Trade

Después de cada fill, el tick verifica:
1. Si `consecutiveLosses >= maxConsecutiveLosses` → **Stop automático del bot**
2. Si `dailyPnl <= -maxDailyLoss` → **Stop automático del bot**

### 6.4 Reset Diario

Los contadores de riesgo (`dailyPnl`, `consecutiveLosses`) se resetean a las 00:00 UTC.

### 6.5 Cálculo de Exposición

```
totalExposure = Σ (position.size × position.avgEntryPrice) para todas las posiciones abiertas
```

---

## 7. Infraestructura de Datos de Mercado

### 7.1 Jerarquía de Fuentes de Datos

El módulo de Market Data implementa una cascada de 3 niveles:

```
Prioridad 1: WebSocket (tiempo real)
    │ Stale threshold: 15 segundos sin mensaje
    ▼
Prioridad 2: REST API Polling (fallback)
    │ Polling interval: 3000ms
    │ Max errores consecutivos: 5
    ▼
Prioridad 3: Simulación (último recurso)
    Precio base aleatorio: $0.45 - $0.55
    Spread aleatorio: $0.02 - $0.08
```

### 7.2 WebSocket

**Endpoint Market:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Suscripción por `asset_id` (token IDs del mercado)
- Recibe actualizaciones de orderbook en tiempo real

**Endpoint User:** `wss://ws-subscriptions-clob.polymarket.com/ws/user`
- Requiere autenticación (API credentials)
- Recibe notificaciones de fills en tiempo real

### 7.3 REST Polling

- Se activa cuando WebSocket está inactivo (stale > 15s)
- Intervalo: 3000ms
- Se pausa automáticamente cuando WebSocket se recupera
- Usa `polymarketClient.fetchMarketData(tokenId)` que consulta el CLOB orderbook

### 7.4 Datos de Mercado (MarketData)

```typescript
interface MarketData {
  bestBid: number;      // Mejor precio de compra
  bestAsk: number;      // Mejor precio de venta
  spread: number;       // bestAsk - bestBid
  midpoint: number;     // (bestBid + bestAsk) / 2
  bidDepth: number;     // Liquidez total en bids ($)
  askDepth: number;     // Liquidez total en asks ($)
  lastPrice: number;    // Último precio transaccionado
  volume24h: number;    // Volumen 24h
}
```

### 7.5 Validaciones de Mercado

| Validación | Condición | Uso |
|------------|-----------|-----|
| Spread suficiente | `spread >= minSpread` | Gate para MAKING |
| Mercado activo | `bidDepth > 10 AND askDepth > 10` | Gate para MAKING |
| Mejor lado | `bidDepth > askDepth × 1.2` → BUY | Selección de dirección |

---

## 8. Infraestructura RPC y Blockchain

### 8.1 Endpoints RPC

El bot usa una arquitectura de RPC con 7 endpoints y rotación automática:

| # | Endpoint | Tipo |
|---|----------|------|
| 0 | QuickNode (custom) | Premium (prioridad) |
| 1 | Ankr | Público |
| 2 | BlockPi | Público |
| 3 | PublicNode | Público |
| 4 | LlamaRPC | Público |
| 5 | Polygon RPC | Público |
| 6 | QuikNode Public | Público |

### 8.2 StaticJsonRpcProvider

Se usa `StaticJsonRpcProvider` (no `JsonRpcProvider`) para:
- **Evitar llamadas `eth_chainId` automáticas** que causan errores "could not detect network"
- Chain ID explícito: `137` (Polygon PoS)
- Timeout de conexión: `12000ms`

### 8.3 Rotación y Cache

```typescript
PROVIDER_CACHE_TTL = 60000ms   // Cache de proveedor por 60s
Rotación: Ante error RPC, se rota al siguiente endpoint
Cooldown: 30s entre rotaciones
Backoff: 15s para errores 429 (rate limit)
```

### 8.4 Errores Retriable

Se consideran retriable y disparan rotación:
- "Too many requests" / "rate limit"
- "could not detect network" / "NETWORK_ERROR"
- "SERVER_ERROR" / "failed to meet quorum"
- "timeout" / "ETIMEDOUT" / "ECONNREFUSED"

---

## 9. Rate Limiter y Circuit Breaker

### 9.1 Rate Limiter

| Parámetro | Valor |
|-----------|-------|
| Max requests/segundo | 8 |
| Max requests/minuto | 100 |
| Ventana de tracking | 60 segundos (sliding window) |

El rate limiter usa un array de timestamps para tracking:
```
canProceed() {
  1. Filtrar timestamps > 60s
  2. Si requests en último segundo >= 8 → BLOCKED
  3. Si requests en último minuto >= 100 → BLOCKED
  4. → ALLOWED
}
```

### 9.2 Circuit Breaker

| Parámetro | Valor |
|-----------|-------|
| Threshold de apertura | 5 errores consecutivos |
| Cooldown | 30 segundos |

**Flujo:**
1. Cada error de API incrementa `consecutiveErrors`
2. Al alcanzar 5 errores → circuito se ABRE
3. Durante circuito abierto, todas las operaciones se bloquean
4. Después de 30s → circuito se CIERRA, contador se resetea

---

## 10. Monitor de Salud

### 10.1 Checks Periódicos (cada 30s)

| Componente | Método | Timeout |
|------------|--------|---------|
| RPC | `eth_blockNumber` via HTTP POST | 8s |
| CLOB API | GET `https://clob.polymarket.com/time` | 8s |
| WebSocket | Verificar `marketConnected` + `userConnected` + edad último mensaje | — |
| Database | `storage.getBotConfig()` query | — |
| Rate Limiter | Check estado del circuito | — |

### 10.2 Determinación de Estado Overall

```
"healthy"   → Todos los checks OK
"degraded"  → 1-2 checks con problemas
"unhealthy" → ≥3 checks fallidos O consecutiveUnhealthy >= 3
```

### 10.3 Escalación

Si `consecutiveUnhealthy >= 3`:
- Se emite alerta CRITICAL via Alert Manager
- Se notifica por Telegram (si configurado)

---

## 11. Sistema de Alertas

### 11.1 Alert Manager

Detecta y notifica automáticamente:
- RPC caído
- CLOB API no disponible
- WebSocket desconectado
- Circuit breaker abierto

### 11.2 Niveles de Alerta

| Nivel | Descripción |
|-------|-------------|
| `warning` | Componente degradado pero funcional |
| `critical` | Componente no funcional, requiere atención |

### 11.3 Telegram

Soporte para notificaciones via Telegram Bot API:
- Configuración: `botToken` + `chatId`
- Se envían alertas critical automáticamente
- Endpoint de prueba: `POST /api/alerts/telegram/test`

---

## 12. Descubrimiento y Rotación de Mercados

### 12.1 Market Discovery

**API:** Polymarket Gamma API (`https://gamma-api.polymarket.com`)

**Formato de slug:** `{asset}-updown-{interval}-{timestamp}`
- Ejemplo: `btc-updown-5m-1739656200`

**Proceso de búsqueda (3 intentos):**
1. Intervalo actual: `currentTimestamp`
2. Próximo intervalo: `currentTimestamp + intervalSeconds`
3. Intervalo anterior: `currentTimestamp - intervalSeconds`

**Assets soportados:** BTC, ETH, SOL, XRP, DOGE, BNB, LINK, MSTR

### 12.2 Auto-Rotación (Legacy FSM)

Cuando un ciclo termina (estado DONE):
1. Buscar siguiente mercado activo
2. Verificar: `!closed AND acceptingOrders AND timeRemaining > minRemaining`
   - 5m: mínimo 45s restantes
   - 15m: mínimo 90s restantes
3. Si se encuentra → actualizar config + reconectar WebSocket + reiniciar en MAKING
4. Si no se encuentra → polling cada 5s hasta encontrar mercado

### 12.3 Auto-Rotación (Dual-Entry 5m)

Verificación cada 10s (solo si no hay ciclos activos):
1. Buscar mercado actual para el asset/intervalo configurado
2. Si es diferente al mercado actual → rotar
3. Mínimo restante: 30s (5m) / 60s (15m)
4. Actualizar: tokens, slug, config en DB, volatility tracker

---

## 13. Reconciliación de Órdenes

### 13.1 On Startup (Legacy FSM)

Al arrancar en modo live:
1. Obtener órdenes activas de la DB
2. Obtener órdenes abiertas del exchange
3. Para cada orden en DB:
   - Si existe en exchange → verificar `size_matched` y registrar fills faltantes
   - Si no existe en exchange → consultar estado individual → marcar como FILLED o CANCELLED
4. Registrar estadísticas: reconciled, fills encontrados, orphans cancelados

### 13.2 Detección de Fills Parciales

```
Si sizeMatched > dbOrder.filledSize → hay fill no registrado
  newFillSize = sizeMatched - filledSize
  fee = newFillSize × fillPrice × 0.001
  → Crear fill record + actualizar posición
```

### 13.3 Criterio de Fill Completo

```
Si totalFilled >= originalSize × 0.99 → FILLED (tolerancia 1%)
Si no → CANCELLED (partially filled)
```

---

## 14. Cálculo de PnL

### 14.1 Posiciones

**Apertura (BUY fill):**
```
newSize = existingSize + fillSize
newAvgPrice = (existingSize × existingAvg + fillSize × fillPrice) / newSize
```

**Cierre (SELL fill):**
```
closeSize = min(fillSize, buyPosition.size)
realizedPnl = (fillPrice - avgEntryPrice) × closeSize - fee
remainingSize = position.size - closeSize
```

Si `remainingSize <= 0.001` → posición se elimina completamente.

### 14.2 PnL Diario

Se persiste en tabla `pnl_records`:
```typescript
{
  date: "YYYY-MM-DD",
  realizedPnl: number,
  unrealizedPnl: number,
  totalPnl: number,
  tradesCount: number,
  winCount: number,
  lossCount: number,
  volume: number,
  fees: number,
}
```

Se actualiza con cada fill que genera PnL.

---

## 15. Modos de Operación

### 15.1 Paper Trading (Simulación)

- Órdenes se crean en DB con `isPaperTrade = true`
- Fills se simulan en cada tick usando datos reales del orderbook
- Requiere 2 ticks de confirmación + probabilidad basada en profundidad
- Slippage adverso simulado: 0.1% - 0.3%
- Fees de Polymarket simulados: 0.1%

### 15.2 Live Trading (Órdenes Reales)

- Requiere `POLYMARKET_PRIVATE_KEY` configurada
- Requiere inicialización del CLOB client
- Requiere 6 aprobaciones de tokens on-chain
- Órdenes se envían al CLOB exchange
- Fills se detectan por: WebSocket (primario) + REST polling (fallback)
- Balance check pre-orden: verifica USDC.e suficiente

### 15.3 Dry Run (Dual-Entry 5m)

Similar a paper trading pero específico de la estrategia Dual-Entry:
- Órdenes generan fake IDs (`dry-${timestamp}-${random}`)
- Se loguea la actividad pero no se envía al exchange
- Cancelaciones son no-ops logueadas

---

## 16. Mecanismos de Seguridad

### 16.1 Kill Switch

**Activación:**
1. Detiene inmediatamente el bot
2. Cancela todas las órdenes activas (paper + live)
3. Desconecta WebSockets
4. Establece `killSwitchActive = true`
5. No se puede reanudar trading hasta desactivar manualmente

### 16.2 Auto-Switch a Paper

Si se detecta geo-bloqueo en una orden live:
```
Error contiene: "regional restriction" | "Access restricted" | "GEO-BLOCKED"
→ Automáticamente: isPaperTrading = true
→ Log: "GEO-BLOCKED: Polymarket rechazó la orden por restricción regional"
```

### 16.3 Circuit Breaker

5 errores consecutivos de API → todas las operaciones se pausan por 30s.

### 16.4 Validación de Token ID

Antes de colocar órdenes live:
```
Si tokenId contiene "sim" O tokenId.length < 10 → RECHAZADA
→ "Order rejected: Invalid token ID — cannot place live orders with simulated tokens"
```

### 16.5 Balance Check Pre-Orden

En modo live, antes de cada orden de entrada:
1. Consultar balance USDC.e (collateral API o on-chain)
2. Si `balance < orderCost` → orden no se coloca + alerta de riesgo

### 16.6 Liquidación Ordenada al Detener

Ver sección 18.

---

## 17. Contratos y Aprobaciones On-Chain

### 17.1 Contratos Involucrados

| Contrato | Dirección | Función |
|----------|-----------|---------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Token de pago |
| CTF (Conditional Token Framework) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | Token ERC-1155 de posiciones |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | Exchange principal |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | Exchange para neg risk markets |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Adaptador neg risk |

### 17.2 Aprobaciones Requeridas (6 total)

**ERC-20 (USDC.e → approve):**
1. USDC.e → CTF Exchange (gasto ilimitado)
2. USDC.e → Neg Risk CTF Exchange
3. USDC.e → Neg Risk Adapter

**ERC-1155 (CTF → setApprovalForAll):**
4. CTF → CTF Exchange
5. CTF → Neg Risk CTF Exchange
6. CTF → Neg Risk Adapter

### 17.3 Pre-checks de Aprobación

Antes de ejecutar aprobaciones:
1. **Balance POL:** Mínimo 0.05 POL para gas. Si insuficiente → bloquear aprobaciones.
2. **Ubicación de fondos:** Verificar que USDC.e esté en la wallet EOA, no en proxy de Polymarket.
3. **sigType:** Se detecta automáticamente o se configura via `POLYMARKET_SIG_TYPE`.

### 17.4 Retry de Aprobaciones

Cada aprobación se intenta hasta 3 veces con:
- `gasLimit = 100000` en cada intento
- `2s delay` entre verificaciones de allowance
- `15s backoff` para errores 429 (rate limit)
- Solo se invalida cache de provider en reintentos (no en primer intento)

---

## 18. Proceso de Liquidación Ordenada

Cuando el usuario solicita detener el bot y existen posiciones abiertas:

### Fase 1: Paciencia (0-60 segundos)

1. Marcar bot como inactivo (`isActive = false`)
2. Cancelar todas las órdenes BUY (no queremos más exposición)
3. Desconectar WebSocket y detener polling
4. Para cada posición abierta:
   - Calcular `exitPrice = max(avgEntryPrice, bestBid)` (intento break-even)
   - Colocar orden de salida al mejor precio posible sin pérdida

### Fase 2: Fuerza (después de 60 segundos)

Si aún quedan posiciones abiertas:
1. Cancelar TODAS las órdenes existentes
2. Para cada posición abierta:
   - `exitPrice = bestBid - 0.01` (cruzar spread agresivamente)
   - Clamping: `max(0.01, min(0.99, exitPrice))`
   - Colocar orden de salida forzada

### Posiciones Simuladas

Si el token es simulado (`includes("sim")` o `length < 10`):
- Zerear posiciones directamente en DB
- No se intentan órdenes en exchange

### Tick de Liquidación

Intervalo: 3000ms. En cada tick:
1. Verificar fills pendientes
2. Si todas las posiciones cerradas → stop completo
3. Si no → reintentar según fase (paciencia o fuerza)

---

## 19. Flujo de Datos WebSocket

### 19.1 Conexiones

```
┌─────────────┐     ┌──────────────────────────┐
│ Market WS   │────▶│ Orderbook updates        │
│ (público)   │     │ Bid/Ask/Depth changes     │
└─────────────┘     └──────────────────────────┘

┌─────────────┐     ┌──────────────────────────┐
│ User WS     │────▶│ Fill notifications        │
│ (auth)      │     │ Order status changes      │
└─────────────┘     └──────────────────────────┘
```

### 19.2 Fill Processing (WebSocket)

Cuando se recibe un fill via WS:
1. Buscar orden matching por `exchangeOrderId`
2. Calcular `newFillSize = sizeMatched - order.filledSize`
3. Si `newFillSize <= 0` → duplicado, ignorar
4. Crear fill record en DB
5. Actualizar estado de orden: `PARTIALLY_FILLED` o `FILLED` (si `totalFilled >= size × 0.99`)
6. Actualizar posición y calcular PnL si es SELL

### 19.3 Reconnect on Market Rotation

Cuando el bot rota a un nuevo mercado:
1. `disconnectAll()` — cerrar conexiones WS existentes
2. `connectMarket(newAssetIds)` — nueva suscripción de mercado
3. `connectUser(newAssetIds, creds)` — nueva suscripción de usuario (si live)
4. Registrar callbacks de market data y fills

### 19.4 Stale Detection

```
WS_STALE_THRESHOLD = 15000ms

isWsActive() {
  return Date.now() - lastWsUpdate < 15000
}
```

Si WS está stale → REST polling se activa como fallback automático.

---

## 20. Consideraciones de Auditoría

### 20.1 Vectores de Riesgo Financiero

| Riesgo | Mitigación | Nivel |
|--------|------------|-------|
| Pérdida ilimitada | `maxNetExposure`, `maxDailyLoss`, `maxConsecutiveLosses` | ✅ Implementado |
| Posiciones huérfanas al cerrar | Liquidación ordenada con paciencia + fuerza | ✅ Implementado |
| Geo-bloqueo en producción | Auto-switch a paper + detección automática | ✅ Implementado |
| API down durante operación | Circuit breaker + REST fallback | ✅ Implementado |
| Slippage en paper trading | Simulación adversa de slippage + depth factor | ✅ Implementado |
| Órdenes duplicadas | Idempotencia por clientOrderId + dedupe keys | ✅ Implementado |
| Balance insuficiente | Balance check pre-orden (live) | ✅ Implementado |
| Token ID inválido | Validación de longitud y contenido | ✅ Implementado |

### 20.2 Vectores de Riesgo Técnico

| Riesgo | Mitigación | Nivel |
|--------|------------|-------|
| RPC caído | 7 endpoints con rotación + cache + backoff | ✅ Implementado |
| WebSocket desconectado | REST polling fallback automático | ✅ Implementado |
| DB inaccesible | Health check periódico + alertas | ✅ Implementado |
| Rate limiting de API | Rate limiter client-side (8/s, 100/min) | ✅ Implementado |
| Errores cascada | Circuit breaker (5 errores → 30s pausa) | ✅ Implementado |
| Desincronización de órdenes | Reconciliación on startup | ✅ Implementado |
| Fill no detectado | Dual detection: WS + REST polling | ✅ Implementado |

### 20.3 Parámetros Configurables Críticos

**Nota:** Todos los valores default provienen de `bot_config` (Legacy FSM) o `dual_entry_config` (Dual-Entry) en la base de datos. Los defaults listados son los valores iniciales del getStatus() fallback en `strategy-engine.ts:1191-1211`. El usuario puede modificar todos estos valores desde el dashboard.

| Parámetro | Default inicial | Fuente | Impacto |
|-----------|----------------|--------|---------|
| `orderSize` | 10 | `bot_config.orderSize` | Tamaño de posición por orden |
| `maxNetExposure` | $100 | `bot_config.maxNetExposure` | Exposición total máxima |
| `maxDailyLoss` | $50 | `bot_config.maxDailyLoss` | Pérdida máxima diaria antes de stop |
| `maxConsecutiveLosses` | 3 | `bot_config.maxConsecutiveLosses` | Pérdidas seguidas antes de stop |
| `minSpread` | 0.03 | `bot_config.minSpread` | Spread mínimo para operar (FSM) |
| `targetProfitMin` | 0.03 | `bot_config.targetProfitMin` | Profit mínimo por trade (FSM) |
| `targetProfitMax` | 0.05 | `bot_config.targetProfitMax` | Profit máximo por trade (FSM) |
| `entryPrice` (Dual) | configurable | `dual_entry_config.entryPrice` | Precio de entrada por lado |
| `tpPrice` (Dual) | configurable | `dual_entry_config.tpPrice` | Precio de take-profit |
| `scratchPrice` (Dual) | configurable | `dual_entry_config.scratchPrice` | Precio de scratch del perdedor |
| `entryLeadSecondsPrimary` | configurable | `dual_entry_config` | Segundos antes de ventana para armar |
| `entryLeadSecondsRefresh` | configurable | `dual_entry_config` | Segundos antes de ventana para refresh |
| `postStartCleanupSeconds` | configurable | `dual_entry_config` | Segundos post-inicio para cleanup |
| `exitTtlSeconds` | configurable | `dual_entry_config` | TTL máximo para órdenes de salida |

**Constantes hardcodeadas en el código:**

| Constante | Valor | Archivo:Línea |
|-----------|-------|---------------|
| Tick interval (FSM) | 3000ms | `strategy-engine.ts:160` |
| Tick interval (Dual) | 2000ms | `engine.ts:89` |
| Order TTL | 300000ms (5 min) | `order-manager.ts:10` |
| WS stale threshold | 15000ms | `market-data.ts:13` |
| REST poll interval | 3000ms | `market-data.ts:16` |
| Max errors before sim | 5 | `market-data.ts:10` |
| Paper fill ticks | 2 | `order-manager.ts:510` |
| Polymarket fee rate | 0.001 (0.1%) | `order-manager.ts:511` |
| Rate limit per second | 8 | `rate-limiter.ts:3` |
| Rate limit per minute | 100 | `rate-limiter.ts:4` |
| Circuit breaker threshold | 5 errors | `rate-limiter.ts:5` |
| Circuit breaker cooldown | 30000ms | `rate-limiter.ts:6` |
| Liquidation patience | 60000ms | `strategy-engine.ts:28` |
| Provider cache TTL | 60000ms | `live-trading-client.ts:50` |
| Market active depth min | 10 | `market-data.ts:179` |
| Side ratio threshold | 1.2× | `market-data.ts:184` |
| Max concurrent BUY orders | 3 | `strategy-engine.ts:733` |
| Max concurrent TP orders | 4 | `strategy-engine.ts:194,856` |
| HEDGE_LOCK threshold | 45000ms | `strategy-engine.ts:682` |
| CLOSE_ONLY threshold | 60000ms | `strategy-engine.ts:683` |
| UNWIND threshold | 120000ms | `strategy-engine.ts:684` |
| Proximity alert cooldown | 60000ms | `risk-manager.ts:14` |
| Health check interval | 30000ms | `health-monitor.ts` |

### 20.4 Persistencia de Datos

Todos los datos operativos se persisten en PostgreSQL via Drizzle ORM:

| Tabla | Datos |
|-------|-------|
| `bot_config` | Configuración general del bot |
| `orders` | Historial completo de órdenes |
| `fills` | Registro de cada ejecución |
| `positions` | Posiciones abiertas actuales |
| `pnl_records` | PnL diario agregado |
| `bot_events` | Log completo de eventos |
| `dual_entry_config` | Config de estrategia Dual-Entry |
| `dual_entry_cycles` | Historial de ciclos Dual-Entry |

### 20.5 Flujo de Fondos

```
┌─────────────┐         ┌──────────────────┐
│ EOA Wallet  │◀───────▶│ Polymarket CLOB  │
│ (MetaMask)  │ USDC.e  │ Exchange         │
│ 0xe419...   │ ◀──────▶│ Orders/Fills     │
│             │ CTF     │                  │
│ sigType=0   │ tokens  │                  │
└─────────────┘         └──────────────────┘
         │
         │ POL (gas fees)
         ▼
   Polygon Network
   (Chain ID: 137)
```

**Importante:** Los fondos deben estar en la wallet EOA directa, NO en la cuenta de Polymarket.com (que usa un contrato proxy separado).

---

*Documento generado para auditoría técnica por IA. Toda la información es extraída directamente del código fuente del sistema PolyMaker.*
