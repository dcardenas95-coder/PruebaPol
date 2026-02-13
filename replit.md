# PolyMaker - Asymmetric Market Making Bot

## Overview
Professional asymmetric market making bot for Polymarket BTC binary markets. Connected to Polymarket's CLOB API for live orderbook data. Paper trading mode uses real market prices with simulated fills. Full admin dashboard for monitoring and control.

## Architecture

### Frontend (React + Vite)
- **Dashboard**: Overview with bot status, FSM state, live/simulated market data indicator, risk parameters
- **Orders**: Active and historical order management with cancel capabilities
- **Positions**: Current inventory tracking with PnL
- **PnL**: Performance analytics with cumulative and daily charts
- **Configuration**: Market selector (Polymarket integration), strategy parameters, risk limits, kill switch
- **Logs**: Structured event logging with filtering

### Backend (Express + TypeScript)
- **Strategy Engine**: FSM with states MAKING → UNWIND → CLOSE_ONLY → HEDGE_LOCK → DONE
- **Order Manager**: Idempotent order placement/cancellation with clientOrderId, position tracking on fills
- **Risk Manager**: Max exposure, daily loss limits, consecutive loss stops
- **Polymarket Client**: REST client for Polymarket CLOB API (orderbook, prices, spread) and Gamma API (market discovery)
- **Market Data Module**: Fetches live data from Polymarket with fallback to simulation
- **Paper Trading**: Conservative fill simulation using real orderbook structure

### Polymarket Integration
- **Public API (no auth)**: Market discovery, orderbook, prices, spread, midpoint via `https://clob.polymarket.com`
- **Gamma API**: Market search and BTC market discovery via `https://gamma-api.polymarket.com`
- **Market Selection**: Users select a market token from the dashboard; bot uses that token's live orderbook
- **Future Live Trading**: Will require `POLYMARKET_PRIVATE_KEY` secret for order signing via ethers.js

### Database (PostgreSQL + Drizzle ORM)
Tables: bot_config, orders, fills, positions, pnl_records, bot_events

## Key Files
- `shared/schema.ts` - All data models and types
- `server/bot/strategy-engine.ts` - Core FSM strategy
- `server/bot/order-manager.ts` - Order lifecycle management with position tracking
- `server/bot/risk-manager.ts` - Risk checks and limits
- `server/bot/market-data.ts` - Market data with live/simulated modes
- `server/bot/polymarket-client.ts` - Polymarket REST API client
- `server/routes.ts` - API endpoints including market discovery
- `server/storage.ts` - Database storage layer
- `client/src/pages/config.tsx` - Configuration with market selector
- `client/src/pages/` - All dashboard pages

## API Endpoints
- `GET /api/bot/status` - Bot status with live data flag
- `GET /api/bot/config` - Bot configuration
- `PATCH /api/bot/config` - Update configuration
- `POST /api/bot/kill-switch` - Toggle kill switch
- `GET /api/markets/search?q=` - Search Polymarket markets
- `GET /api/markets/btc` - Get BTC-related markets
- `GET /api/markets/orderbook/:tokenId` - Get live orderbook
- `POST /api/markets/select` - Select a market for trading
- `GET /api/markets/live-data` - Get current live market data
- `GET /api/connection/status` - Check Polymarket connection status

## User Preferences
- Dark mode default (trading terminal aesthetic)
- Monospace fonts for numerical data (JetBrains Mono)
- Inter for UI text
- Professional, information-dense layout
- Speaks Spanish

## Recent Changes
- 2026-02-13: Integrated Polymarket CLOB API for live orderbook data
- 2026-02-13: Added market selector in Configuration page with Gamma API market discovery
- 2026-02-13: Market data module now fetches real prices from Polymarket with fallback to simulation
- 2026-02-13: Dashboard shows LIVE/Simulated data source indicator
- 2026-02-13: Added connection status endpoint for monitoring API connectivity
- 2026-02-13: Initial MVP build with full dashboard, bot engine, paper trading mode, and seed data
