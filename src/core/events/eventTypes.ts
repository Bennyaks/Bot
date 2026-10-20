import type { ExecutedTrade, HealthComponent, RejectedTrade, SystemMode } from '../../lib/types';
import type { PortfolioState, RiskVerdict, TradeApproval, TradeCandidate } from '../interfaces';
import type { Swing, StructureLevel, StructureBreak } from '../pipeline/MarketPipeline';

/**
 * The canonical event chain for the platform:
 *
 *   TickReceived -> CandleClosed -> SwingDetected -> LevelDetected ->
 *   BreakoutDetected (BOS/CHoCH) -> TradeCandidateCreated ->
 *   TradeApproved | TradeRejected -> RiskApproved | RiskRejected ->
 *   OrderSubmitted -> OrderFilled -> PositionOpened -> PositionClosed ->
 *   TradeArchived
 *
 * The Market Pipeline (core/pipeline/MarketPipeline.ts) publishes the
 * structure events; the SystemOrchestrator publishes everything from
 * TradeCandidateCreated down.
 */
export interface PlatformEvents {
  SwingDetected: { swing: Swing };
  LevelDetected: { level: StructureLevel };
  BOSDetected: { brk: StructureBreak };
  CHoCHDetected: { brk: StructureBreak };
  LiquiditySweepDetected: { levels: StructureLevel[] };
  TradeCandidateCreated: { candidate: TradeCandidate };
  TradeApproved: { candidate: TradeCandidate; approval: TradeApproval };
  TradeRejected: { candidate: TradeCandidate; rejection: RejectedTrade };
  RiskApproved: { candidate: TradeCandidate; verdict: RiskVerdict; portfolio: PortfolioState };
  RiskRejected: { candidate: TradeCandidate; verdict: RiskVerdict; rejection: RejectedTrade };
  OrderSubmitted: { candidate: TradeCandidate };
  OrderFilled: { trade: ExecutedTrade };
  PositionOpened: { trade: ExecutedTrade };
  PositionClosed: { trade: ExecutedTrade };
  TradeArchived: { trade: ExecutedTrade };
  SystemModeChanged: { mode: SystemMode; reason: string; criticalFailures: string[] };
  HealthChanged: { health: HealthComponent[] };
}

export type PlatformEventName = keyof PlatformEvents;
