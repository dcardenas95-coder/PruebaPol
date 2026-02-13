export type CycleState = "IDLE" | "ARMED" | "ENTRY_WORKING" | "PARTIAL_FILL" | "HEDGED" | "EXIT_WORKING" | "DONE" | "CLEANUP" | "FAILSAFE";

export interface CycleLogEntry {
  ts: number;
  event: string;
  detail?: string;
  data?: any;
}

export interface CycleContext {
  cycleId: string;
  cycleNumber: number;
  windowStart: Date;
  state: CycleState;
  yesOrderId?: string;
  noOrderId?: string;
  yesExchangeOrderId?: string;
  noExchangeOrderId?: string;
  yesFilled: boolean;
  noFilled: boolean;
  yesFilledSize: number;
  noFilledSize: number;
  yesFilledPrice?: number;
  noFilledPrice?: number;
  winnerSide?: "YES" | "NO";
  tpOrderId?: string;
  scratchOrderId?: string;
  tpExchangeOrderId?: string;
  scratchExchangeOrderId?: string;
  tpYesExchangeOrderId?: string;
  tpNoExchangeOrderId?: string;
  tpYesFilled: boolean;
  tpNoFilled: boolean;
  tpFilled: boolean;
  scratchFilled: boolean;
  outcome?: string;
  pnl?: number;
  logs: CycleLogEntry[];
  timers: NodeJS.Timeout[];
  actualEntryPrice?: number;
  actualTpPrice?: number;
  actualOrderSize?: number;
  btcVolatility?: number;
  entryMethod?: string;
  marketTokenYes?: string;
  marketTokenNo?: string;
}

export interface StrategyConfig {
  marketTokenYes: string;
  marketTokenNo: string;
  marketSlug: string;
  negRisk: boolean;
  tickSize: string;
  entryPrice: number;
  tpPrice: number;
  scratchPrice: number;
  entryLeadSecondsPrimary: number;
  entryLeadSecondsRefresh: number;
  postStartCleanupSeconds: number;
  exitTtlSeconds: number;
  orderSize: number;
  isDryRun: boolean;
  smartScratchCancel: boolean;
  volFilterEnabled: boolean;
  volMinThreshold: number;
  volMaxThreshold: number;
  volWindowMinutes: number;
  dynamicEntryEnabled: boolean;
  dynamicEntryMin: number;
  dynamicEntryMax: number;
  momentumTpEnabled: boolean;
  momentumTpMin: number;
  momentumTpMax: number;
  momentumWindowMinutes: number;
  dynamicSizeEnabled: boolean;
  dynamicSizeMin: number;
  dynamicSizeMax: number;
  hourFilterEnabled: boolean;
  hourFilterAllowed: number[];
  multiMarketEnabled: boolean;
  additionalMarkets: MarketSlot[];
  dualTpMode: boolean;
  autoRotate5m: boolean;
  autoRotate5mAsset: string;
}

export interface MarketSlot {
  tokenYes: string;
  tokenNo: string;
  slug: string;
  question: string;
  negRisk: boolean;
  tickSize: string;
}

export interface EngineStatus {
  isRunning: boolean;
  currentCycle: CycleContext | null;
  config: StrategyConfig | null;
  nextWindowStart: Date | null;
  volatility: VolatilitySnapshot | null;
  activeCycles: number;
}

export interface VolatilitySnapshot {
  current: number;
  windowMinutes: number;
  withinRange: boolean;
  min: number;
  max: number;
  priceCount: number;
}
