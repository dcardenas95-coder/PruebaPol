# PolyMaker - Asymmetric Market Making Bot

## Overview
Professional asymmetric market making bot for Polymarket BTC binary markets. Connected to Polymarket's CLOB API for live orderbook data. Supports both paper trading (simulated fills with real prices) and live trading (real orders via @polymarket/clob-client SDK). Full admin dashboard for monitoring and control.

## Architecture

### Frontend (React + Vite)
- **Dashboard**: Overview with bot status, FSM state, LIVE/Paper/Simulated indicator, risk parameters
- **Orders**: Active and historical order management with cancel capabilities
- **Positions**: Current inventory tracking with PnL
- **PnL**: Performance analytics with cumulative and daily charts
- **Configuration**: Market selector (Polymarket integration), strategy parameters, risk limits, kill switch, paper/live mode toggle with confirmation
- **Logs**: Structured event logging with filtering

### Backend (Express + TypeScript)
- **Strategy Engine**: FSM with states MAKING → UNWIND → CLOSE_ONLY → HEDGE_LOCK → DONE
- **Order Manager**: Dual-mode - paper (simulated fills) and live (real CLOB orders). Idempotent with clientOrderId, position tracking on fills
- **Risk Manager**: Max exposure, daily loss limits, consecutive loss stops
- **Live Trading Client**: `@polymarket/clob-client` SDK integration for order signing, placement, cancellation, and balance checking
- **Polymarket Client**: REST client for public CLOB API (orderbook, prices, spread) and Gamma API (market discovery)
- **Market Data Module**: Fetches live data from Polymarket with fallback to simulation
- **Paper Trading**: Conservative fill simulation using real orderbook structure

### Polymarket Integration
- **Public API (no auth)**: Market discovery, orderbook, prices, spread, midpoint via `https://clob.polymarket.com`
- **Gamma API**: Market search and BTC market discovery via `https://gamma-api.polymarket.com`
- **Authenticated API**: Order creation/signing via `@polymarket/clob-client` SDK with ethers.js wallet
- **Market Selection**: Users select a market token; config stores tokenId, negRisk, tickSize for order signing
- **Live Trading**: Uses `POLYMARKET_PRIVATE_KEY` secret for wallet initialization and API key derivation

### Database (PostgreSQL + Drizzle ORM)
Tables: bot_config (with negRisk/tickSize), orders (with exchangeOrderId), fills, positions, pnl_records, bot_events

## Key Files
- `shared/schema.ts` - All data models and types
- `server/bot/strategy-engine.ts` - Core FSM strategy (paper + live modes)
- `server/bot/order-manager.ts` - Order lifecycle management (paper simulation + live CLOB)
- `server/bot/live-trading-client.ts` - @polymarket/clob-client SDK wrapper
- `server/bot/risk-manager.ts` - Risk checks and limits
- `server/bot/market-data.ts` - Market data with live/simulated modes
- `server/bot/polymarket-client.ts` - Polymarket REST API client (public endpoints)
- `server/routes.ts` - API endpoints including market discovery and live trading
- `server/storage.ts` - Database storage layer
- `client/src/pages/config.tsx` - Configuration with market selector and live mode toggle
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

## User Preferences
- Dark mode default (trading terminal aesthetic)
- Monospace fonts for numerical data (JetBrains Mono)
- Inter for UI text
- Professional, information-dense layout
- Speaks Spanish

## Recent Changes
- 2026-02-13: Implemented live trading via @polymarket/clob-client SDK with order signing
- 2026-02-13: Added live trading client initialization, balance checking, order placement/cancellation
- 2026-02-13: OrderManager now routes to live CLOB or paper simulation based on isPaperTrading
- 2026-02-13: Strategy engine initializes live client on start, polls live order statuses
- 2026-02-13: Added negRisk/tickSize to bot config for proper order signing
- 2026-02-13: Added safety controls: live mode confirmation dialog, prominent warnings
- 2026-02-13: Integrated Polymarket CLOB API for live orderbook data
- 2026-02-13: Added market selector in Configuration page with Gamma API market discovery
- 2026-02-13: Initial MVP build with full dashboard, bot engine, paper trading mode
