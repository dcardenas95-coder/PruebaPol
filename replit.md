# PolyMaker - Asymmetric Market Making Bot

## Overview
Professional asymmetric market making bot for Polymarket BTC 5-minute binary markets. The system captures micro-spreads and rotates capital with high frequency using a FSM (Finite State Machine) approach. Includes a full admin dashboard for monitoring and control.

## Architecture

### Frontend (React + Vite)
- **Dashboard**: Overview with bot status, FSM state, market data, and risk parameters
- **Orders**: Active and historical order management with cancel capabilities
- **Positions**: Current inventory tracking with PnL
- **PnL**: Performance analytics with cumulative and daily charts
- **Configuration**: Strategy parameters, risk limits, and kill switch
- **Logs**: Structured event logging with filtering

### Backend (Express + TypeScript)
- **Strategy Engine**: FSM with states MAKING → UNWIND → CLOSE_ONLY → HEDGE_LOCK → DONE
- **Order Manager**: Idempotent order placement/cancellation with clientOrderId
- **Risk Manager**: Max exposure, daily loss limits, consecutive loss stops
- **Market Data Module**: Orderbook simulation (ready for real API integration)
- **Paper Trading**: Conservative fill simulation using real market structure

### Database (PostgreSQL + Drizzle ORM)
Tables: bot_config, orders, fills, positions, pnl_records, bot_events

## Key Files
- `shared/schema.ts` - All data models and types
- `server/bot/strategy-engine.ts` - Core FSM strategy
- `server/bot/order-manager.ts` - Order lifecycle management
- `server/bot/risk-manager.ts` - Risk checks and limits
- `server/bot/market-data.ts` - Market data handling
- `server/routes.ts` - API endpoints
- `server/storage.ts` - Database storage layer
- `client/src/pages/` - All dashboard pages

## User Preferences
- Dark mode default (trading terminal aesthetic)
- Monospace fonts for numerical data (JetBrains Mono)
- Inter for UI text
- Professional, information-dense layout

## Recent Changes
- 2026-02-13: Initial MVP build with full dashboard, bot engine, paper trading mode, and seed data
