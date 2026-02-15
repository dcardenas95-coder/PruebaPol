# PolyMaker - Asymmetric Market Making Bot

## Overview
Professional asymmetric market making bot for Polymarket BTC binary markets. Connected to Polymarket's CLOB API for live orderbook data. Supports both paper trading (simulated fills with real prices) and live trading (real orders via @polymarket/clob-client SDK). Full admin dashboard for monitoring and control. WebSocket-based real-time data feeds with comprehensive safety controls.

## Architecture

### Frontend (React + Vite)
- **Dashboard**: Overview with legacy FSM strategy (MAKING→UNWIND→CLOSE_ONLY→HEDGE_LOCK→DONE), auto-rotate controls, wallet balance, WebSocket health
- **Orders**: Active and historical order management with cancel capabilities
- **Positions**: Current inventory tracking with PnL
- **PnL**: Performance analytics with cumulative and daily charts
- **Configuration**: Market selector (Polymarket integration), strategy parameters, risk limits, kill switch, paper/live mode toggle with confirmation, live test button, rate limiter status
- **Logs**: Structured event logging with filtering

### Backend (Express + TypeScript)
- **Primary Strategy Engine**: FSM with states MAKING → UNWIND → CLOSE_ONLY → HEDGE_LOCK → DONE, with auto-rotation to new 5m/15m markets on cycle completion. Dashboard Start/Stop controls this engine.
- **Secondary Strategy Engine**: Dual-Entry 5m engine with separate auto-rotation (dedicated page at /strategies/dual-entry-5m)
- **Order Manager**: Dual-mode - paper (simulated fills) and live (real CLOB orders). Idempotent with clientOrderId, position tracking on fills, order timeout system
- **Risk Manager**: Max exposure, daily loss limits, consecutive loss stops, proximity alerts (80% exposure, 70% loss)
- **Live Trading Client**: `@polymarket/clob-client` SDK integration for order signing, placement, cancellation, and balance checking
- **Polymarket Client**: REST client for public CLOB API (orderbook, prices, spread) and Gamma API (market discovery)
- **Polymarket WebSocket**: Real-time market data (orderbook) and user channel (order fills) via wss://ws-subscriptions-clob.polymarket.com with ping/pong heartbeat, exponential backoff reconnection
- **Market Data Module**: Fetches live data from Polymarket with fallback to simulation
- **Paper Trading**: Conservative fill simulation using real orderbook structure
- **Rate Limiter**: 8 req/sec, 100 req/min limits with sliding window tracking
- **Circuit Breaker**: Opens on 5 consecutive API errors, 30-second cooldown period
- **Order Reconciliation**: On startup, syncs DB orders with exchange state, detects orphaned orders, handles partial fills

### Polymarket Integration
- **Public API (no auth)**: Market discovery, orderbook, prices, spread, midpoint via `https://clob.polymarket.com`
- **Gamma API**: Market search and BTC market discovery via `https://gamma-api.polymarket.com`
- **Authenticated API**: Order creation/signing via `@polymarket/clob-client` SDK with ethers.js wallet
- **WebSocket (public)**: wss://ws-subscriptions-clob.polymarket.com/ws/market for real-time orderbook
- **WebSocket (auth)**: wss://ws-subscriptions-clob.polymarket.com/ws/user for fill notifications
- **Market Selection**: Users select a market token; config stores tokenId, negRisk, tickSize for order signing
- **Live Trading**: Uses `POLYMARKET_PRIVATE_KEY` secret for wallet initialization and API key derivation

### Database (PostgreSQL + Drizzle ORM)
Tables: bot_config (with negRisk/tickSize), orders (with exchangeOrderId), fills, positions, pnl_records, bot_events

## Key Files
- `shared/schema.ts` - All data models and types
- `server/bot/strategy-engine.ts` - Core FSM strategy (paper + live modes, reconciliation, order timeouts)
- `server/bot/order-manager.ts` - Order lifecycle management (paper simulation + live CLOB)
- `server/bot/live-trading-client.ts` - @polymarket/clob-client SDK wrapper
- `server/bot/risk-manager.ts` - Risk checks, limits, and proximity alerts
- `server/bot/market-data.ts` - Market data with live/simulated modes
- `server/bot/polymarket-client.ts` - Polymarket REST API client (public endpoints)
- `server/bot/polymarket-ws.ts` - WebSocket client for real-time market and user data
- `server/bot/rate-limiter.ts` - API rate limiter and circuit breaker
- `server/routes.ts` - API endpoints including market discovery, live trading, WebSocket health
- `server/storage.ts` - Database storage layer
- `client/src/pages/config.tsx` - Configuration with market selector, live mode toggle, test button, rate limiter
- `client/src/pages/overview.tsx` - Dashboard with WebSocket health indicators
- `client/src/pages/` - All dashboard pages

## API Endpoints
- `GET /api/bot/status` - Bot status with live data flag
- `GET /api/bot/config` - Bot configuration
- `PATCH /api/bot/config` - Update configuration
- `POST /api/bot/kill-switch` - Toggle kill switch
- `GET /api/markets/search?q=` - Search Polymarket markets
- `GET /api/markets/btc` - Get BTC-related markets
- `GET /api/markets/orderbook/:tokenId` - Get live orderbook
- `POST /api/markets/select` - Select a market for trading (saves negRisk/tickSize)
- `GET /api/markets/live-data` - Get current live market data
- `GET /api/connection/status` - Check Polymarket connection status (includes wallet info)
- `POST /api/trading/init-live` - Initialize live trading client with wallet
- `GET /api/trading/balance/:tokenId` - Check USDC balance for token
- `POST /api/trading/test-live` - End-to-end test: place min order, verify, cancel
- `GET /api/ws/health` - WebSocket connection health (status, reconnects, last message)
- `GET /api/rate-limiter/status` - Rate limiter and circuit breaker status

## User Preferences
- Dark mode default (trading terminal aesthetic)
- Monospace fonts for numerical data (JetBrains Mono)
- Inter for UI text
- Professional, information-dense layout
- Speaks Spanish

## Future Plans
- **HEDGE_LOCK condicional**: Cuando el bot entra en HEDGE_LOCK (últimos 45s) y tiene posiciones abiertas, evaluar el precio actual antes de liquidar. Si el valor actual es >$0.90 a favor de la posición, dejar correr para capturar el payout completo ($1.00) en lugar de liquidar agresivamente. Solo cruzar el spread para forzar salida cuando la posición está en zona de riesgo ($0.30-$0.70). Evaluar después de tener datos de win rate con la estrategia actual.

## Recent Changes
- 2026-02-15: Realistic paper trading simulator: fills only when price crosses order (BUY fills when bestAsk <= order price, SELL fills when bestBid >= order price), requires 2 consecutive crossing ticks before fill, depth-based fill probability, adverse slippage, 0.1% Polymarket fee simulation
- 2026-02-15: Added optimization analytics panel in Configuration page - shows win rate, PnL/trade, TP fill rate, BUY fill rate, spread captured, forced exit rate, and auto-generates parameter suggestions based on real trading data
- 2026-02-15: Added /api/analytics/optimization endpoint computing performance metrics from orders, fills, and pnl_records tables
- 2026-02-15: Graceful liquidation on manual stop - when bot is stopped with open positions, enters LIQUIDATING mode: cancels BUY orders, attempts break-even exit for 60s, then force-crosses spread. Bot only transitions to STOPPED when all positions are closed. Dashboard shows orange liquidation banner with progress bar.
- 2026-02-15: Fixed take-profit strategy: TP orders now placed proactively on BUY fill (not reactively waiting for price), deterministic TP price (no more random), separated entry/TP order limits, per-position TP coverage tracking with stale TP cancellation
- 2026-02-15: Added targetExitPrice column to positions table for persistent TP price tracking
- 2026-02-15: Added onBuyFill callback in OrderManager for immediate TP placement after fills
- 2026-02-15: Fixed market timing alignment - FSM states now sync to actual Polymarket market boundaries using epoch-based interval calculation
- 2026-02-15: Aggressive liquidation in HEDGE_LOCK (last 45s) - cancels all orders and crosses spread to force position exit before market determination
- 2026-02-15: Added countdown timer to Market Data panel showing time remaining with color-coded progress bar and expected state label
- 2026-02-15: Added marketRemainingMs and marketDurationMs to BotStatus API response
- 2026-02-15: State transition events now include remaining time for debugging
- 2026-02-15: Added auto-rotation to legacy FSM strategy - on DONE, discovers next 5m/15m market automatically and starts new cycle
- 2026-02-15: Restored Overview to legacy FSM strategy display (MAKING→UNWIND→CLOSE_ONLY→HEDGE_LOCK→DONE) with auto-rotate controls
- 2026-02-15: Added autoRotate, autoRotateAsset, autoRotateInterval fields to bot_config
- 2026-02-15: Added DualEntry5mInfo to BotStatus type for unified status API
- 2026-02-15: Fixed WebSocket INVALID OPERATION with resilient retry and asset ID refresh
- 2026-02-13: Added rate limiter (8/sec, 100/min) and circuit breaker (5 errors → 30s pause)
- 2026-02-13: Added pre-order balance verification and risk proximity alerts
- 2026-02-13: Created /api/trading/test-live endpoint with dashboard UI
- 2026-02-13: Added order timeout system with configurable TTL (5min default)
- 2026-02-13: Implemented startup order reconciliation (sync DB ↔ exchange)
- 2026-02-13: Built WebSocket module for real-time market data and user fills
- 2026-02-13: Integrated WebSocket into strategy engine replacing polling
- 2026-02-13: Updated dashboard with WebSocket health, rate limiter status, test button
- 2026-02-13: Implemented live trading via @polymarket/clob-client SDK with order signing
- 2026-02-13: Added market selector in Configuration page with Gamma API market discovery
- 2026-02-13: Initial MVP build with full dashboard, bot engine, paper trading mode
