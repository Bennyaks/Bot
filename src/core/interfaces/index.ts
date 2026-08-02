/**
 * core/interfaces
 * ----------------
 * Every major subsystem in the platform is defined here as a contract
 * (interface) before it is implemented anywhere. Nothing in `core/`
 * imports a concrete class — only these interfaces.
 *
 * Concrete implementations live in sibling trees, e.g.:
 *   providers/replay/ReplayMarketProvider.ts   implements MarketProvider
 *   execution/paper/PaperBroker.ts             implements ExecutionProvider, Broker
 *
 * This is what makes brokers, data sources, and strategies swappable
 * without touching the engine that orchestrates them.
 */

import type {
  Candle,
  ExecutedTrade,
  HealthComponent,
  LogEntry,
  RejectedTrade,
  SafetyCheck,
  SessionName,
  TradeSignal,
} from '../../lib/types';

/** A candidate produced by a strategy. It is a *proposal*, never an order. */
export type TradeCandidate = TradeSignal;

/** Emitted by the Decision Engine when every mandatory gate passes. */
export interface TradeApproval {
  candidateId: string;
  approvedAt: string;
  score: number;
  passedGates: string[];
}

/** Portfolio-level facts the Risk Manager needs to make a call. */
export interface PortfolioState {
  openPositions: ExecutedTrade[];
  closedToday: ExecutedTrade[];
  session: SessionName;
}

export interface RiskVerdict {
  approved: boolean;
  reason: string;
  ruleId?: string;
}

/** core/interfaces/market_provider.ts */
export interface MarketProvider {
  id: string;
  getCandles(instrument: string, timeframe: string, count: number): Candle[];
  getSpread(instrument: string): number;
  subscribe(instrument: string, onCandle: (candle: Candle) => void): () => void;
}

/** core/interfaces/strategy.ts — a strategy only ever produces candidates. */
export interface Strategy {
  id: string;
  version: string;
  evaluate(instrument: string, candles: Candle[]): TradeCandidate | null;
}

/** core/interfaces/risk_manager.ts — absolute veto authority over every candidate. */
export interface RiskManagerContract {
  evaluate(candidate: TradeCandidate, portfolio: PortfolioState): RiskVerdict;
}

/** core/interfaces/execution_provider.ts — how an approved candidate becomes a filled order. */
export interface ExecutionProvider {
  id: string;
  /**
   * `lotSize` is mandatory: the caller (SystemOrchestrator/BacktestHarness) is
   * responsible for computing it via PositionSizer against real account
   * equity before a candidate is ever filled — no ExecutionProvider is
   * allowed to invent its own size. `spread` (price units, not pips) is
   * optional context a provider can use to model a realistic fill price;
   * omit it and the provider fills at the candidate's raw entry.
   */
  submit(candidate: TradeCandidate, lotSize: number, spread?: number): Promise<ExecutedTrade> | ExecutedTrade;
  close(trade: ExecutedTrade, exitPrice: number): ExecutedTrade;
}

/** core/interfaces/broker.ts — connectivity + account-level concerns, distinct from execution. */
export interface Broker {
  id: string;
  isConnected(): boolean;
  runSafetyChecks(): SafetyCheck[];
  accountEquity(): number;
}

/** core/interfaces/position_manager.ts — everything about a position after it opens. */
export interface PositionManagerContract {
  open(trade: ExecutedTrade): void;
  manage(trade: ExecutedTrade, currentPrice: number): ExecutedTrade;
  close(trade: ExecutedTrade, exitPrice: number, reason: string): ExecutedTrade;
  openPositions(): ExecutedTrade[];
}

/** core/interfaces/storage.ts */
export interface Storage {
  saveTrade(trade: ExecutedTrade): void;
  saveRejection(rejection: RejectedTrade): void;
  loadTrades(): ExecutedTrade[];
  loadRejections(): RejectedTrade[];
  /**
   * Audit trail beyond the in-memory rolling 200-line log buffer. Optional
   * so existing Storage implementations/tests that predate this keep
   * compiling — SystemOrchestrator checks for the method before calling it.
   */
  saveLog?(entry: LogEntry): void;
  loadLogs?(): LogEntry[];
  clear(): void;
}

/** core/interfaces/notifier.ts — the only thing allowed to reach the UI/log surface. */
export interface Notifier {
  log(entry: Omit<LogEntry, 'id'>): void;
}

/** core/interfaces/analytics.ts */
export interface Analytics {
  winRate(trades: ExecutedTrade[]): number;
  profitFactor(trades: ExecutedTrade[]): number;
  expectancy(trades: ExecutedTrade[]): number;
}

/** health-check contributors register themselves against this contract. */
export interface HealthSource {
  id: string;
  check(): HealthComponent;
}
