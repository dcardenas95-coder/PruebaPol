# PolyMaker - Asymmetric Market Making Bot

## Overview
PolyMaker is a professional asymmetric market making bot designed for Polymarket BTC binary markets. It integrates with Polymarket's CLOB API for real-time orderbook data and supports both paper trading (simulated fills) and live trading (real orders via `@polymarket/clob-client` SDK). The project aims to provide a robust, secure, and efficient platform for automated market making, featuring a comprehensive admin dashboard for monitoring, control, and risk management. Key capabilities include state-machine-driven strategies, real-time data feeds via WebSockets, and stringent safety controls.

## User Preferences
- Dark mode default (trading terminal aesthetic)
- Monospace fonts for numerical data (JetBrains Mono)
- Inter for UI text
- Professional, information-dense layout
- Speaks Spanish
- Cuando se habla de base de datos, servidor, terminal o producción, SIEMPRE se refiere al servidor de DigitalOcean Toronto (138.197.139.58), no al entorno de Replit

## System Architecture

### UI/UX
- **Frontend**: Developed with React and Vite, featuring a dashboard for overview, order management, position tracking, PnL analytics, and configuration.
- **Design**: Professional, information-dense layout with a dark mode default. Uses JetBrains Mono for numerical data and Inter for UI text.

### Technical Implementations
- **Backend**: Built with Express and TypeScript, serving as the core of the bot.
- **Primary Strategy Engine**: A Finite State Machine (FSM) with states: MAKING → UNWIND → CLOSE_ONLY → HEDGE_LOCK → DONE. Supports auto-rotation to new markets upon cycle completion.
- **Secondary Strategy Engine**: A Dual-Entry 5m engine with separate auto-rotation.
- **Order Manager**: Handles both paper trading (simulated fills) and live trading (real CLOB orders) with idempotency, position tracking, and order timeouts.
- **Risk Manager**: Implements max exposure limits, daily loss limits, consecutive loss stops, and proximity alerts.
- **Market Data Module**: Fetches live data from Polymarket, with a robust WebSocket primary connection and REST polling fallback for resilience.
- **Rate Limiter & Circuit Breaker**: Manages API request rates (8 req/sec, 100 req/min) and implements a circuit breaker (opens on 5 consecutive API errors for 30s) for robust API interaction.
- **Order Reconciliation**: On startup, synchronizes database orders with exchange state, detects orphaned orders, and manages partial fills.
- **Health Monitor**: Periodically checks the health of RPC, CLOB API, WebSocket, and Database connections, providing overall system status.
- **Alert Manager**: Detects and notifies critical connection issues (RPC down, CLOB API down, WebSocket disconnected, circuit breaker open), with Telegram notification support.
- **RPC Infrastructure**: Utilizes multiple RPC endpoints with intelligent rotation, provider caching, and exponential backoff for rate limits.

### Feature Specifications
- **Dashboard**: Provides a real-time overview of the bot's status, order activity, positions, and performance.
- **Configuration**: Allows users to select markets, configure strategy parameters, set risk limits, toggle paper/live mode, and manage the kill switch. Includes a live test button and rate limiter status.
- **Logging**: Structured event logging with filtering capabilities.
- **Paper Trading**: Realistic simulation of fills based on real orderbook structure, including adverse slippage and Polymarket fee simulation.

## External Dependencies

- **Polymarket CLOB API**: For public market data (orderbook, prices, spread) via `https://clob.polymarket.com`.
- **Polymarket Gamma API**: For market discovery and searching via `https://gamma-api.polymarket.com`.
- **Polymarket CLOB Client SDK**: `@polymarket/clob-client` for authenticated operations such as order signing, placement, cancellation, and balance checking.
- **Polymarket WebSockets**:
    - `wss://ws-subscriptions-clob.polymarket.com/ws/market` for real-time market orderbook data.
    - `wss://ws-subscriptions-clob.polymarket.com/ws/user` for user-specific fill notifications.
- **PostgreSQL**: Used as the database for storing bot configurations, orders, fills, positions, PnL records, and bot events.
- **Drizzle ORM**: Object-Relational Mapper for interacting with the PostgreSQL database.
- **Ethers.js**: Used by the `@polymarket/clob-client` SDK for wallet integration and transaction signing.
- **QuickNode**: Premium RPC service used as a primary endpoint for blockchain interactions.
- **Telegram API**: For sending critical and warning alerts via configurable bot tokens and chat IDs.

## Deployment (Servidor DigitalOcean Toronto - 138.197.139.58)

Siempre ejecutar estos comandos para desplegar cambios:

```bash
cd /home/polymaker/app
git pull origin main
npm install
NODE_OPTIONS="--max-old-space-size=768" npm run build
npm run db:push
pm2 restart polymaker
```

- El servidor tiene 1GB de RAM, por eso se limita Node a 768MB con NODE_OPTIONS durante el build
- PM2 ejecuta `dist/index.cjs` (archivo compilado), nunca el codigo fuente directamente
- Logs: `pm2 logs polymaker` o en `/var/log/polymaker/`

## API Endpoints

- `GET /api/config` - Get bot configuration
- `POST /api/config` - Update bot configuration
- `GET /api/bot/status` - Bot status (state, active, paper mode)
- `POST /api/bot/start` - Start bot
- `POST /api/bot/stop` - Stop bot
- `GET /api/orders` - List orders with pagination
- `GET /api/positions` - Current positions
- `GET /api/pnl` - PnL analytics
- `GET /api/events` - Bot event log
- `GET /api/markets/search` - Search Polymarket markets
- `GET /api/connection/status` - Check Polymarket connection status (includes wallet info)
- `POST /api/trading/init-live` - Initialize live trading client with wallet
- `GET /api/trading/balance/:tokenId` - Check USDC balance for token
- `POST /api/trading/test-live` - End-to-end test: place min order, verify, cancel
- `GET /api/trading/pre-checks` - Pre-approval checks (POL balance, fund location, sigType)
- `POST /api/trading/approve` - Execute all 6 token approvals
- `GET /api/trading/approval-status` - Check current approval status
- `GET /api/ws/health` - WebSocket connection health (status, reconnects, last message)
- `GET /api/rate-limiter/status` - Rate limiter and circuit breaker status
- `GET /api/health` - Full system health check (RPC, CLOB, WS, DB, rate limiter) with overall status
- `GET /api/alerts` - Active and historical alerts with summary
- `POST /api/alerts/telegram/configure` - Configure Telegram bot notifications (botToken, chatId)
- `POST /api/alerts/telegram/test` - Send test message to Telegram
- `GET /api/data-source/status` - Market data source status (websocket/rest_polling/simulation)

## Key Files
- `server/bot/health-monitor.ts` - System health checks (RPC, CLOB, WS, DB) with 30s periodic monitoring
- `server/bot/alert-manager.ts` - Connection alerts with Telegram notification support
- `server/bot/market-data.ts` - Market data with WebSocket primary + REST polling fallback
- `server/bot/live-trading-client.ts` - CLOB client, approvals, order placement, balance checks
- `server/bot/strategy-engine.ts` - FSM strategy engine with auto-rotation
- `server/bot/order-manager.ts` - Order management, paper/live fills, position tracking

## Core Strategy: Hold-to-Resolution
- **NO TP orders**: Positions are held until market resolves at $1.00 or $0.00
- **Dual-Layer Sizing**: L1-STRONG (5% capital, conf>=70%, strong signal), L2-MODERATE (3% capital, conf>=55%, weak signal), L3 skipped
- **Entry Price Filter**: Only enters at $0.10-$0.52 (favorable R:R ratio)
- **1 Entry Per Market**: No accumulation — single position per market cycle
- **UNWIND/HEDGE_LOCK**: Only cancel pending orders, never sell positions
- **Stop-Loss**: Alerts logged but no selling (positions resolve naturally)
- **Settlement**: PnL calculated at market rotation via `settleMarketResolution()`

## Future Plans
- **Win Rate Analysis**: Collect data over 100+ trades to validate Oracle edge (need >47% WR at avg $0.48 entry)

## Recent Changes
- 2026-02-16: **Dual Buy Pre-Market**: New module (`dual-buy-manager.ts`) places 2 limit BUY orders (YES + NO) at configurable price ($0.45 default) exactly N seconds before each new market opens. Integrated into FSM tick loop in parallel (does not interfere with Oracle-based strategy). Config fields: `dualBuyEnabled`, `dualBuyPrice`, `dualBuySize`, `dualBuyLeadSeconds`. UI panel in Overview with toggle, editable price/size/lead, countdown to next placement, cost/profit display.
- 2026-02-16: **Order Outcome Tracking**: Added `outcome` column (WON/LOST/null) to orders table. Settlement logic now marks filled orders as WON or LOST based on whether the tokenSide prediction matched the market resolution (BTC direction). Orders page shows Outcome column in history tab with colored badges (green WON, red LOST, gray Pending) and summary stats card (Filled/Won/Lost/Win Rate).
- 2026-02-16: **Latency Widget**: Real-time latency monitor in global header bar. Measures Polymarket REST API round-trip and Binance WS ping/pong RTT every 15s. Shows "PM: XXms | BN: XXms" with color indicators (green <100ms, yellow <300ms, red >300ms), SVG sparklines for last 20 samples, and tooltip with details. Endpoint: `/api/latency`.
- 2026-02-16: **Oracle Permissive Thresholds (Camino A)**: Lowered Oracle to capture early signals: weakThreshold 10→8 ($8 BTC delta), minConfidence 0.50→0.35, STRONG confidence gate 0.75→0.55. MAX_ENTRY_PRICE raised $0.52→$0.58. Dual-layer: L1-STRONG (conf>=0.55, 5%), L2-EARLY (any strength, conf>=0.35, 3%). minSpread default 0.03→0.005 (0.5%).
- 2026-02-16: **STRATEGY PIVOT: Hold-to-Resolution**: Replaced TP-scalping with hold-until-resolve. Disabled TP callback/orders, added $0.10-$0.52 price filter, dual-layer sizing (L1-STRONG 5%/L2-MODERATE 3%/L3 skip), 1 entry per market, UNWIND+HEDGE_LOCK only cancel orders (no selling), stop-loss logs only (no selling). FSM timing: UNWIND 60s, CLOSE_ONLY 30s, HEDGE_LOCK 15s. Oracle thresholds lowered (strong=20, weak=10, minConf=0.50). Math: at $0.50 entry need >50% WR, at $0.40 need >40%.
- 2026-02-16: **Oracle Multi-Source Fallback**: Binance Oracle now tries multiple WebSocket sources (binance.com → binance.us → coincap.io), with REST polling fallback via Coinbase API when all WS endpoints are geo-blocked (error 451). Includes 8s connection timeout per endpoint, geo-block tracking, and `source` field in status.
- 2026-02-16: **Health Monitor Fix**: WebSocket disconnection alert no longer fires when bot is STOPPED (false alarm). WS status only reports error/degraded when bot is actively running.
- 2026-02-16: **WebSocket Asset Filter**: Fixed critical bug where bot bought both YES and NO tokens by subscribing to both asset IDs. Now only subscribes to tokenUp, filters all messages by activeAssetId, drops messages without asset_id. Added $0.20 price jump sanity check.
- 2026-02-15: **PnL Calculation Fix**: Added `tokenId` column to orders/fills/positions, positions now tracked per-token (tokenUp vs tokenDown separately) instead of per-market. Fixed HEDGE_LOCK exit logic to use position's own tokenId. Added market resolution settlement (settles at $1.00/$0.00 based on Oracle BTC direction). Fixed simulateFill to flip orderbook for tokenDown. Added orphan SELL detection/warning.
- 2026-02-15: **Oracle-Informed Trading**: Binance BTC WebSocket oracle (`binance-oracle.ts`) with STRONG/WEAK signal detection ($30/$15 thresholds), integrated into Legacy FSM for directional entry decisions
- 2026-02-15: **Progressive Position Sizing**: 3-level graduated sizing (L1: $1 for 1-20 trades, L2: $5 for 21-50 if WR>55%, L3: $10-20 for 51+ based on WR) via `progressive-sizer.ts`
- 2026-02-15: **Stop-Loss Protection**: Per-trade 15% max loss, trailing stops from high-water mark, time-decay via `stop-loss-manager.ts`
- 2026-02-15: **Market Regime Filter**: TRENDING/RANGING/VOLATILE/DEAD classification, blocks trading in unfavorable conditions via `market-regime-filter.ts`
- 2026-02-15: **HEDGE_LOCK Refactor**: Eliminated cascade pattern (no more 12-order fractionation), single aggressive exit per position with re-pricing at 5s/10s intervals (max 3 attempts), final fire sale at $0.01/$0.99
- 2026-02-15: **Dashboard UI**: Oracle panel (BTC price, delta, signal, confidence), Smart Trading Modules panel (Progressive Sizer, Stop-Loss, Market Regime status)
- 2026-02-15: **API Routes**: `/api/oracle/status`, `/api/oracle/connect`, `/api/oracle/disconnect`, `/api/stop-loss/status`, `/api/progressive-sizer/status`, `/api/market-regime/status`
- 2026-02-15: Enhanced approval process: POL balance check before approvals (blocks if <0.05 POL), fund location verification (warns if USDC.e in wrong wallet for sigType), individual retry per approval step (3 attempts each), POLYMARKET_SIG_TYPE env var for explicit sigType override
- 2026-02-15: Added /api/trading/pre-checks endpoint: returns POL balance, gas sufficiency, USDC.e location, sigType info before approvals
- 2026-02-15: Updated ApprovalCard UI: shows pre-check panel (POL balance, sigType, USDC.e locations) with warnings for insufficient gas or misplaced funds
- 2026-02-15: Added comprehensive health monitor, connection alerts with Telegram, REST polling fallback, System Health dashboard panel
- 2026-02-15: Overhauled RPC infrastructure: 6 endpoints with rotation, caching, exponential backoff
- 2026-02-15: Auto-detect signature type, enhanced WebSocket resilience, all 6 token approvals