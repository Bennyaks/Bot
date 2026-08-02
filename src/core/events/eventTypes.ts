import type { ExecutedTrade, HealthComponent, RejectedTrade, SystemMode, Candle } from '../../lib/types';
import type { PortfolioState, RiskVerdict, TradeApproval, TradeCandidate } from '../interfaces';
import type { PositionAction } from '../position/PositionLifecycle';
import type { LifecycleTransition } from '../lifecycle/TradeLifecycle';

/**
 * The canonical event chain for the platform:
 *
 *   TickReceived -> CandleClosed -> SwingDetected -> LevelDetected ->
 *   BreakoutDetected -> TradeCandidateCreated -> TradeApproved | TradeRejected ->
 *   RiskApproved | RiskRejected -> OrderSubmitted -> OrderFilled ->
 *   PositionOpened -> PositionClosed -> TradeArchived
 *
 * Phase 2 (Market Pipeline) events are now real, published by
 * MarketStructureEngine — every downstream consumer (Strategy, Journal,
 * a future chart overlay) can subscribe instead of recomputing structure
 * itself.
 */
export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'high' | 'low';
}

export interface StructureBreak {
  direction: 'bullish' | 'bearish';
  kind: 'BOS' | 'CHoCH';
  index: number;
  time: number;
  price: number;
  brokenLevel: number;
}

export interface PlatformEvents {
  CandleClosed: { instrument: string; timeframe: string; candle: Candle };
  SwingDetected: { instrument: string; timeframe: string; swing: SwingPoint };
  LevelDetected: { instrument: string; timeframe: string; level: number; kind: 'support' | 'resistance' };
  BreakoutDetected: { instrument: string; timeframe: string; structureBreak: StructureBreak };
  TradeCandidateCreated: { candidate: TradeCandidate };
  TradeApproved: { candidate: TradeCandidate; approval: TradeApproval };
  TradeRejected: { candidate: TradeCandidate; rejection: RejectedTrade };
  RiskApproved: { candidate: TradeCandidate; verdict: RiskVerdict; portfolio: PortfolioState };
  RiskRejected: { candidate: TradeCandidate; verdict: RiskVerdict; rejection: RejectedTrade };
  OrderSubmitted: { candidate: TradeCandidate };
  OrderRejected: { candidate: TradeCandidate; reason: string };
  OrderFilled: { trade: ExecutedTrade };
  PositionOpened: { trade: ExecutedTrade };
  /** Emitted whenever advancePosition moves a stop (breakeven/trailing) without closing the trade — gives visibility into management decisions, not just open/close. */
  PositionManaged: { trade: ExecutedTrade; actions: PositionAction[] };
  /** Every hop of the trade lifecycle state machine, for any id being tracked — candidate rejections included, not just filled trades. */
  LifecycleTransition: { transition: LifecycleTransition };
  PositionClosed: { trade: ExecutedTrade };
  TradeArchived: { trade: ExecutedTrade };
  SystemModeChanged: { mode: SystemMode; reason: string; criticalFailures: string[] };
  HealthChanged: { health: HealthComponent[] };
  BrokerConnectionChanged: { connected: boolean; attempt: number; reason: string };
  AnalyticsUpdated: { winRate: number; profitFactor: number; expectancy: number; sampleSize: number };
}

export type PlatformEventName = keyof PlatformEvents;
