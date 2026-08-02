import type { ExecutedTrade, HealthComponent, SafetyCheck, SessionMetrics, Candle } from '../../lib/types';
import { evaluateSystemMode, runBrokerSafety } from '../../lib/engine';
import { DecisionEngine } from '../decision/DecisionEngine';
import { RiskManager } from '../risk/RiskManager';
import { PositionManager } from '../position/PositionManager';
import { advancePosition, type AdvanceOptions, type AdvanceResult } from '../position/PositionLifecycle';
import { TradeLifecycleTracker, type TradeLifecycleState, type LifecycleTransition } from '../lifecycle/TradeLifecycle';
import { PositionSizer } from '../risk/PositionSizer';
import { EventBus } from '../events/EventBus';
import { TradeAnalytics, type AnalyticsSummary } from '../analytics/TradeAnalytics';
import { InMemoryStorage } from '../storage/LocalStorage';
import type {
  Analytics,
  Broker,
  ExecutionProvider,
  MarketProvider,
  Notifier,
  PortfolioState,
  Storage,
  TradeCandidate,
} from '../interfaces';

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
  /** Phase 8/9 — optional so existing callers keep working; falls back to in-memory/no-op implementations. */
  storage?: Storage;
  analytics?: Analytics;
  /** Sizes every fill against real account equity instead of a hardcoded lot. */
  positionSizer?: PositionSizer;
  /**
   * Optional — if supplied, submitCandidate() prices spread into the
   * Decision Engine's spread_cost gate and fillCandidate() prices it into
   * the actual fill, instead of both running as if spread didn't exist.
   */
  marketProvider?: MarketProvider;
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
  private storage: Storage;
  private analytics: Analytics;
  private positionSizer: PositionSizer;
  private marketProvider?: MarketProvider;
  /** Every id's full state history — candidates and the trades they fill into. See core/lifecycle/TradeLifecycle. */
  private lifecycle = new TradeLifecycleTracker();
  /** Every trade ever archived, kept so getAnalyticsSummary() has something to compute over without the caller re-passing history each time. Hydrated from Storage on construction. */
  private archivedTrades: ExecutedTrade[];

  constructor(deps: OrchestratorDeps) {
    this.broker = deps.broker;
    this.execution = deps.execution;
    this.notifier = deps.notifier;
    this.decisionEngine = deps.decisionEngine ?? new DecisionEngine();
    this.riskManager = deps.riskManager ?? new RiskManager();
    this.positionManager = deps.positionManager ?? new PositionManager();
    this.storage = deps.storage ?? new InMemoryStorage();
    this.analytics = deps.analytics ?? new TradeAnalytics();
    this.positionSizer = deps.positionSizer ?? new PositionSizer();
    this.marketProvider = deps.marketProvider;
    this.archivedTrades = this.storage.loadTrades();

    // Persistence and analytics are pure subscribers — the pipeline below
    // (submitCandidate/fillCandidate/closePosition) has no idea they exist.
    // This is the EventBus doing its job: Storage and Analytics stay
    // decoupled from the code that generates the events they react to.
    this.bus.on('TradeRejected', ({ rejection }) => this.storage.saveRejection(rejection));
    this.bus.on('RiskRejected', ({ rejection }) => this.storage.saveRejection(rejection));
    this.bus.on('TradeArchived', ({ trade }) => {
      this.storage.saveTrade(trade);
      this.archivedTrades = [trade, ...this.archivedTrades.filter((t) => t.id !== trade.id)];
      this.bus.emit('AnalyticsUpdated', this.getAnalyticsSummary());
      // ARCHIVED specifically means "persisted" in this app, so it belongs
      // in this same handler rather than wherever TradeArchived happens to
      // be emitted from (manageOpenPosition, closePosition — two different
      // call sites that would otherwise each need to remember it).
      if (this.lifecycle.stateOf(trade.id) === 'CLOSED') {
        this.transitionLifecycle(trade.id, 'ARCHIVED');
      }
    });
  }

  /**
   * Transition `id` and emit LifecycleTransition in one step — every
   * lifecycle hop in this class goes through here so none are silently
   * un-observed. Never throws: the lifecycle tracker is an observability
   * layer, not part of the trading pipeline's control flow, so a
   * bookkeeping mismatch (e.g. an id that was never tracked from
   * CANDIDATE — a trade resumed from persisted storage, or a caller using
   * fillCandidate/manageOpenPosition directly without submitCandidate)
   * must never block a real fill, stop move, or close from happening. A
   * failed transition is logged as a warning instead of propagating.
   */
  private transitionLifecycle(id: string, to: TradeLifecycleState, reason?: string): LifecycleTransition | null {
    try {
      const transition = this.lifecycle.transition(id, to, reason);
      this.bus.emit('LifecycleTransition', { transition });
      return transition;
    } catch (err) {
      this.notifier.log({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        module: 'TradeLifecycle',
        message: `${id}: ${err instanceof Error ? err.message : String(err)}`,
        reproducible: true,
      });
      return null;
    }
  }

  /** If `id` has never been tracked (resumed from storage, or a caller going straight to fillCandidate/manageOpenPosition), synthesize a full pre-fill history up through MANAGING so its lifecycle from here on is complete instead of permanently missing. No-op if already tracked. */
  private resumeUntrackedAsManaging(id: string): void {
    if (this.lifecycle.stateOf(id) != null) return;
    this.transitionLifecycle(id, 'CANDIDATE', 'resumed — pre-fill history unavailable');
    this.transitionLifecycle(id, 'DECISION_APPROVED');
    this.transitionLifecycle(id, 'RISK_APPROVED');
    this.transitionLifecycle(id, 'SUBMITTED');
    this.transitionLifecycle(id, 'FILLED');
    this.transitionLifecycle(id, 'MANAGING');
  }

  /** Current lifecycle state for a candidate or trade id, or null if it isn't tracked (e.g. never went through submitCandidate). */
  lifecycleStateOf(id: string): TradeLifecycleState | null {
    return this.lifecycle.stateOf(id);
  }

  /** Full ordered transition history for an id — candidate rejections included. */
  lifecycleHistoryOf(id: string) {
    return this.lifecycle.historyOf(id);
  }

  /** Phase 9 — recompute win rate / profit factor / expectancy off everything archived so far. */
  getAnalyticsSummary(): AnalyticsSummary {
    if (this.analytics instanceof TradeAnalytics) {
      return this.analytics.summarize(this.archivedTrades);
    }
    return {
      winRate: this.analytics.winRate(this.archivedTrades),
      profitFactor: this.analytics.profitFactor(this.archivedTrades),
      expectancy: this.analytics.expectancy(this.archivedTrades),
      sampleSize: this.archivedTrades.filter((t) => t.status !== 'OPEN').length,
    };
  }

  /** Phase 8 — expose what's already persisted, e.g. to hydrate the store on first load. */
  loadPersistedTrades(): ExecutedTrade[] {
    return this.storage.loadTrades();
  }

  loadPersistedRejections() {
    return this.storage.loadRejections();
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
    this.transitionLifecycle(candidate.id, 'CANDIDATE');

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
      // Broker safety isn't a lifecycle state of its own — this candidate
      // never reaches decision evaluation, so it simply stays parked at
      // CANDIDATE; that alone is a meaningful, honest record of how far it got.
      return { candidate, outcome: 'rejected_safety', rejectionReasons: safety.failed, rejectionModule: 'BrokerSafety' };
    }

    const spread = this.marketProvider?.getSpread(candidate.instrument);
    const decision = this.decisionEngine.evaluate(candidate, { sessionMetrics: ctx.sessionMetrics, spread });
    if (!decision.approved) {
      this.bus.emit('TradeRejected', { candidate, rejection: decision.rejection });
      this.transitionLifecycle(candidate.id, 'DECISION_REJECTED', decision.rejection.reasons.join(', '));
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
    this.transitionLifecycle(candidate.id, 'DECISION_APPROVED');

    const portfolio: PortfolioState = {
      openPositions: ctx.openPositions,
      closedToday: ctx.closedToday,
      session: candidate.session,
    };
    const riskVerdict = this.riskManager.evaluate(candidate, portfolio);
    if (!riskVerdict.approved) {
      const rejection = this.riskManager.explain(candidate, riskVerdict);
      this.bus.emit('RiskRejected', { candidate, verdict: riskVerdict, rejection });
      this.transitionLifecycle(candidate.id, 'RISK_REJECTED', riskVerdict.reason);
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
    this.transitionLifecycle(candidate.id, 'RISK_APPROVED');

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

  /**
   * Fill an approved candidate via the injected ExecutionProvider and open
   * it in the Position Manager. Sizes against real account equity via
   * PositionSizer (equity * risk% / stop distance) instead of any
   * ExecutionProvider inventing its own lot size.
   *
   * ExecutionProvider.submit()'s return type has always been
   * `Promise<ExecutedTrade> | ExecutedTrade` — PaperBroker's rejection/
   * latency simulation made it genuinely async and able to reject, but this
   * method was still doing `execution.submit(...) as ExecutedTrade`
   * without awaiting it, so a real async provider would have silently
   * handed back an unresolved Promise wearing an ExecutedTrade's type.
   * fillCandidate is async now and actually awaits the fill; a rejected
   * submit throws, which the caller (the store's fillAndSimulateClose)
   * catches and logs instead of producing a broken "open" position.
   */
  async fillCandidate(candidate: TradeCandidate): Promise<ExecutedTrade> {
    if (this.lifecycle.stateOf(candidate.id) == null) {
      // fillCandidate can legitimately be called without submitCandidate
      // having run first in this same orchestrator instance (a caller
      // that already ran its own approval step, or a test exercising
      // fillCandidate directly) — synthesize the pre-fill states so
      // history from here on is complete instead of starting mid-chain.
      this.transitionLifecycle(candidate.id, 'CANDIDATE');
      this.transitionLifecycle(candidate.id, 'DECISION_APPROVED');
      this.transitionLifecycle(candidate.id, 'RISK_APPROVED');
    }
    this.transitionLifecycle(candidate.id, 'SUBMITTED');

    const equity = this.broker.accountEquity();
    const spread = this.marketProvider?.getSpread(candidate.instrument);
    const sizing = this.positionSizer.calculate({
      equity,
      entry: candidate.entry,
      stop: candidate.stop,
      instrument: candidate.instrument,
      spread,
    });

    this.notifier.log({
      timestamp: new Date().toISOString(),
      level: sizing.clamped ? 'WARN' : 'INFO',
      module: 'PositionSizer',
      message: `${candidate.instrument} sized at ${sizing.lotSize} lots · risking $${sizing.riskAmountUsd} (${sizing.effectiveRiskPercent}% of $${equity.toFixed(2)} equity)`,
      data: { lotSize: sizing.lotSize, riskAmountUsd: sizing.riskAmountUsd, warnings: sizing.warnings },
      reproducible: true,
    });

    let trade: ExecutedTrade;
    try {
      trade = await this.execution.submit(candidate, sizing.lotSize, spread);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.notifier.log({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ExecutionManager',
        message: `${candidate.id} submit rejected by ${this.execution.id} · ${message}`,
        reproducible: true,
      });
      this.transitionLifecycle(candidate.id, 'ORDER_REJECTED', message);
      this.bus.emit('OrderRejected', { candidate, reason: message });
      throw err;
    }

    this.positionManager.open(trade);
    // The order was submitted under candidate.id but the broker mints a
    // fresh id for the fill (PB-.../MT5-...) — same trade's lifecycle
    // continuing under a new identity, not a new trade starting, so it
    // gets carried over rather than starting a second, disconnected history.
    try {
      this.lifecycle.rekey(candidate.id, trade.id);
    } catch {
      // Extremely unlikely (trade.id collision, or candidate.id somehow
      // already un-tracked between the calls above and here) — fall back
      // to starting trade.id's own history fresh rather than losing tracking.
      this.resumeUntrackedAsManaging(trade.id);
    }
    this.transitionLifecycle(trade.id, 'FILLED');
    this.transitionLifecycle(trade.id, 'MANAGING');
    this.bus.emit('OrderFilled', { trade });
    this.bus.emit('PositionOpened', { trade });
    return trade;
  }

  /**
   * Live counterpart to what BacktestHarness's loop does per candle:
   * hands the open trade and a fresh price bar to the exact same
   * advancePosition() function, so breakeven/trailing/stop/target/timeout
   * are decided identically whether the candle came from historical replay
   * or a live feed. Previously the live/demo pipeline didn't call this at
   * all — trades were resolved with a random timer instead of real price
   * movement. Emits PositionManaged when the stop moves without closing,
   * and PositionClosed/TradeArchived when it does.
   */
  manageOpenPosition(trade: ExecutedTrade, candle: Candle, opts: AdvanceOptions = {}): AdvanceResult {
    this.resumeUntrackedAsManaging(trade.id);
    const result = advancePosition(trade, candle, this.positionManager, opts);

    if (result.actions.length > 0 && !result.closed) {
      this.bus.emit('PositionManaged', { trade: result.trade, actions: result.actions });
      const moveAction = result.actions.find((a) => a.type === 'MOVE_STOP');
      if (moveAction && moveAction.type === 'MOVE_STOP') {
        this.transitionLifecycle(
          trade.id,
          moveAction.reason === 'breakeven' ? 'BREAKEVEN' : 'TRAILING',
          `stop -> ${moveAction.to}`
        );
      }
    }
    if (result.closed) {
      this.bus.emit('PositionClosed', { trade: result.trade });
      const closeAction = result.actions.find((a) => a.type === 'CLOSE');
      this.transitionLifecycle(
        trade.id,
        'CLOSED',
        closeAction && closeAction.type === 'CLOSE' ? closeAction.reason : undefined
      );
      this.bus.emit('TradeArchived', { trade: result.trade });
    }
    return result;
  }

  /**
   * Manual/administrative close — bypasses price-driven advancePosition
   * entirely (e.g. an operator flattening a position, or a test wanting a
   * specific exit). manageOpenPosition is what the live pipeline uses for
   * ordinary price-driven exits; this stays for the cases that aren't that.
   */
  closePosition(trade: ExecutedTrade, exitPrice: number, reason: string): ExecutedTrade {
    this.resumeUntrackedAsManaging(trade.id);
    const closed = this.positionManager.close(trade, exitPrice, reason);
    this.bus.emit('PositionClosed', { trade: closed });
    this.transitionLifecycle(trade.id, 'CLOSED', reason);
    this.bus.emit('TradeArchived', { trade: closed });
    return closed;
  }

  brokerStatus() {
    return { connected: this.broker.isConnected(), equity: this.broker.accountEquity() };
  }

  /**
   * Phase 13 — swap the Broker/ExecutionProvider at runtime. This is the
   * whole point of building against interfaces instead of a concrete
   * PaperBroker: MT5Broker (or any future adapter) satisfies the exact
   * same contract, so switching is a two-line call, not a rewrite.
   */
  setBroker(broker: Broker) {
    this.broker = broker;
  }

  setExecution(execution: ExecutionProvider) {
    this.execution = execution;
  }

  currentBrokerId(): string {
    return this.broker.id;
  }
}
