import type { ExecutedTrade, HealthComponent, SafetyCheck, SessionMetrics } from '../../lib/types';
import { evaluateSystemMode, runBrokerSafety } from '../../lib/engine';
import { DecisionEngine } from '../decision/DecisionEngine';
import { RiskManager } from '../risk/RiskManager';
import { PositionManager } from '../position/PositionManager';
import { EventBus } from '../events/EventBus';
import type { Broker, ExecutionProvider, Notifier, PortfolioState, TradeCandidate } from '../interfaces';

export interface SubmitResult {
  candidate: TradeCandidate;
  outcome: 'rejected_safety' | 'rejected_decision' | 'rejected_risk' | 'approved';
  rejectionReasons?: string[];
  rejectionModule?: string;
}

export interface OrchestratorDeps {
  broker: Broker;
  execution: ExecutionProvider;
  notifier: Notifier;
  decisionEngine?: DecisionEngine;
  riskManager?: RiskManager;
  positionManager?: PositionManager;
}

/**
 * core/orchestrator/SystemOrchestrator
 * --------------------------------------
 * Everything reports to it: MarketProvider, EventBus, DecisionEngine,
 * RiskManager, ExecutionManager, PositionManager, Notifier. It performs
 * NO business logic itself — it only wires dependencies together, runs
 * the candidate pipeline in order, and publishes what happened onto the
 * EventBus so the Journal/Analytics/Dashboard can subscribe.
 *
 * This is the one module the review flagged as missing. Nothing else in
 * the app should construct a DecisionEngine or RiskManager directly —
 * they come in through this constructor (dependency injection, Phase 1).
 */
export class SystemOrchestrator {
  readonly bus = new EventBus();
  private decisionEngine: DecisionEngine;
  private riskManager: RiskManager;
  private positionManager: PositionManager;
  private broker: Broker;
  private execution: ExecutionProvider;
  private notifier: Notifier;

  constructor(deps: OrchestratorDeps) {
    this.broker = deps.broker;
    this.execution = deps.execution;
    this.notifier = deps.notifier;
    this.decisionEngine = deps.decisionEngine ?? new DecisionEngine();
    this.riskManager = deps.riskManager ?? new RiskManager();
    this.positionManager = deps.positionManager ?? new PositionManager();
  }

  /** Diagnostics -> SAFE_MODE if any critical component fails. Publishes SystemModeChanged. */
  checkHealth(health: HealthComponent[]) {
    const evalResult = evaluateSystemMode(health);
    this.bus.emit('SystemModeChanged', evalResult);
    this.bus.emit('HealthChanged', { health });
    return evalResult;
  }

  /**
   * Runs a TradeCandidate through the full pipeline:
   * Broker Safety -> Decision Engine -> Risk Manager -> Execution.
   * Every stage publishes an event; the caller (UI store) only needs the
   * final SubmitResult to update its own view state.
   */
  submitCandidate(
    candidate: TradeCandidate,
    ctx: {
      safety: SafetyCheck[];
      sessionMetrics: SessionMetrics[];
      openPositions: ExecutedTrade[];
      closedToday: ExecutedTrade[];
    }
  ): SubmitResult {
    this.bus.emit('TradeCandidateCreated', { candidate });

    const safety = runBrokerSafety(ctx.safety);
    if (!safety.passed) {
      this.notifier.log({
        timestamp: new Date().toISOString(),
        level: 'REJECT',
        module: 'BrokerSafety',
        message: `Candidate ${candidate.id} rejected by broker safety`,
        data: { failed: safety.failed },
        reproducible: true,
      });
      return { candidate, outcome: 'rejected_safety', rejectionReasons: safety.failed, rejectionModule: 'BrokerSafety' };
    }

    const decision = this.decisionEngine.evaluate(candidate, { sessionMetrics: ctx.sessionMetrics });
    if (!decision.approved) {
      this.bus.emit('TradeRejected', { candidate, rejection: decision.rejection });
      this.notifier.log({
        timestamp: new Date().toISOString(),
        level: 'REJECT',
        module: 'DecisionEngine',
        message: `Candidate ${candidate.id} rejected · ${decision.rejection.reasons.join(', ')}`,
        data: { reasons: decision.rejection.reasons },
        reproducible: true,
      });
      return {
        candidate,
        outcome: 'rejected_decision',
        rejectionReasons: decision.rejection.reasons,
        rejectionModule: 'DecisionEngine',
      };
    }
    this.bus.emit('TradeApproved', { candidate, approval: decision.approval });

    const portfolio: PortfolioState = {
      openPositions: ctx.openPositions,
      closedToday: ctx.closedToday,
      session: candidate.session,
    };
    const riskVerdict = this.riskManager.evaluate(candidate, portfolio);
    if (!riskVerdict.approved) {
      const rejection = this.riskManager.explain(candidate, riskVerdict);
      this.bus.emit('RiskRejected', { candidate, verdict: riskVerdict, rejection });
      this.notifier.log({
        timestamp: new Date().toISOString(),
        level: 'REJECT',
        module: 'RiskManager',
        message: `Candidate ${candidate.id} vetoed · ${riskVerdict.reason}`,
        data: { ruleId: riskVerdict.ruleId },
        reproducible: true,
      });
      return {
        candidate,
        outcome: 'rejected_risk',
        rejectionReasons: [riskVerdict.reason],
        rejectionModule: 'RiskManager',
      };
    }
    this.bus.emit('RiskApproved', { candidate, verdict: riskVerdict, portfolio });

    this.bus.emit('OrderSubmitted', { candidate });
    this.notifier.log({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      module: 'ExecutionManager',
      message: `Candidate ${candidate.id} risk-approved · forwarded to ${this.execution.id}`,
      reproducible: true,
    });

    return { candidate, outcome: 'approved' };
  }

  /** Fill an approved candidate via the injected ExecutionProvider and open it in the Position Manager. */
  fillCandidate(candidate: TradeCandidate): ExecutedTrade {
    const trade = this.execution.submit(candidate) as ExecutedTrade;
    this.positionManager.open(trade);
    this.bus.emit('OrderFilled', { trade });
    this.bus.emit('PositionOpened', { trade });
    return trade;
  }

  closePosition(trade: ExecutedTrade, exitPrice: number, reason: string): ExecutedTrade {
    const closed = this.positionManager.close(trade, exitPrice, reason);
    this.bus.emit('PositionClosed', { trade: closed });
    this.bus.emit('TradeArchived', { trade: closed });
    return closed;
  }

  brokerStatus() {
    return { connected: this.broker.isConnected(), equity: this.broker.accountEquity() };
  }
}
