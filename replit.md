# PolyMaker - Asymmetric Market Making Bot

## Overview
PolyMaker is a professional asymmetric market making bot designed for Polymarket BTC binary markets. It integrates with Polymarket's CLOB API for real-time orderbook data and supports both paper trading (simulated fills) and live trading (real orders via `@polymarket/clob-client` SDK). The project aims to provide a robust, secure, and efficient platform for automated market making, featuring a comprehensive admin dashboard for monitoring, control, and risk management. Key capabilities include state-machine-driven strategies, real-time data feeds via WebSockets, and stringent safety controls.

## User Preferences
- Dark mode default (trading terminal aesthetic)
- Monospace fonts for numerical data (JetBrains Mono)
- Inter for UI text
- Professional, information-dense layout
- Speaks Spanish

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