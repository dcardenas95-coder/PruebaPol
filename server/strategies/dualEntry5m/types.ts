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
  tpFilled: boolean;
  scratchFilled: boolean;
  outcome?: string;
  pnl?: number;
  logs: CycleLogEntry[];
  timers: NodeJS.Timeout[];
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
}

export interface EngineStatus {
  isRunning: boolean;
  currentCycle: CycleContext | null;
  config: StrategyConfig | null;
  nextWindowStart: Date | null;
}
