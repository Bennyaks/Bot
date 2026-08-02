import type { Candle, ExecutedTrade, RejectedTrade, SessionMetrics } from '../../lib/types';
import { DecisionEngine } from '../decision/DecisionEngine';
import { RiskManager } from '../risk/RiskManager';
import { PositionSizer, type PositionSizingRules } from '../risk/PositionSizer';
import { PositionManager } from '../position/PositionManager';
import { advancePosition } from '../position/PositionLifecycle';
import { getInstrumentSpec, spreadInPrice } from '../../lib/instruments';
import { TradeAnalytics, type AnalyticsSummary } from '../analytics/TradeAnalytics';
import type { PortfolioState, Strategy } from '../interfaces';

export interface BacktestOptions {
  instrument: string;
  sessionMetrics: SessionMetrics[];
  /** Candles fed to Strategy.evaluate() on each step — a rolling window, not the whole history (no lookahead). */
  windowSize?: number;
  /** Bars to look ahead for a stop/target hit before force-closing at the last available close. */
  maxHoldBars?: number;
  /** Starting account equity the backtest sizes every position against. */
  startingEquity?: number;
  /** Overrides PositionSizer's default risk-per-trade / max-lot rules. */
  positionSizing?: PositionSizingRules;
  /** Price the instrument's typical spread into fills and the Decision Engine's spread_cost gate. Default true. */
  applySpreadCost?: boolean;
}

export interface BacktestResult {
  trades: ExecutedTrade[];
  rejections: RejectedTrade[];
  rejectionsByModule: Record<string, number>;
  summary: AnalyticsSummary;
  equityCurve: { tradeId: string; timestamp: string; cumulativeR: number }[];
  /** $ equity curve — reflects real per-trade risk sizing, not just R multiples. */
  equityCurveUsd: { tradeId: string; timestamp: string; equity: number }[];
  startingEquity: number;
  finalEquity: number;
  netProfitUsd: number;
}

interface OpenPosition {
  trade: ExecutedTrade;
  entryIndex: number;
  /** Stop distance at entry, kept separately from trade.stop (which breakeven/trailing may move) so a trailing-stop exit can be labelled distinctly from a straight stop-out. */
  initialStop: number;
}

/**
 * core/backtest/BacktestHarness
 * --------------------------------
 * Phase 14. Runs a Strategy through the *exact same* DecisionEngine,
 * RiskManager, and PositionManager classes used live — this is what makes
 * it a real backtest rather than a second, drifting implementation of the
 * rules. It never touches Storage, Notifier, or a real Broker: fills are
 * computed directly (candidate.entry, walked forward against subsequent
 * candle highs/lows) since a backtest has no execution latency to simulate.
 *
 * Every open position's per-bar management/exit decision goes through
 * core/position/PositionLifecycle's advancePosition() — the exact same
 * function the live pipeline calls (SystemOrchestrator.manageOpenPosition).
 * This harness's own job is now just what a simulation engine should do:
 * provide candles, advance time, and hand each bar to the engine. Whether
 * a trade exits on a stop, a trailing stop, a target, or a timeout — and
 * whether breakeven/trailing moved the stop along the way — is a decision
 * PositionLifecycle makes once, not something this loop re-implements.
 */
export class BacktestHarness {
  private decisionEngine: DecisionEngine;
  private riskManager: RiskManager;
  private analytics: TradeAnalytics;
  private positionSizer: PositionSizer;
  private positionManager: PositionManager;

  constructor(
    private strategy: Strategy,
    deps: {
      decisionEngine?: DecisionEngine;
      riskManager?: RiskManager;
      analytics?: TradeAnalytics;
      positionSizer?: PositionSizer;
      positionManager?: PositionManager;
    } = {}
  ) {
    this.decisionEngine = deps.decisionEngine ?? new DecisionEngine();
    this.riskManager = deps.riskManager ?? new RiskManager();
    this.analytics = deps.analytics ?? new TradeAnalytics();
    this.positionSizer = deps.positionSizer ?? new PositionSizer();
    this.positionManager = deps.positionManager ?? new PositionManager();
  }

  /** Realize $ pnl for a just-closed trade against running equity, so the next trade's size reflects the account actually growing/shrinking. */
  private realizePnl(trade: ExecutedTrade, exitPrice: number, spec: ReturnType<typeof getInstrumentSpec>): number {
    const priceMove = trade.side === 'LONG' ? exitPrice - trade.entry : trade.entry - exitPrice;
    const pips = priceMove / spec.pipSize;
    return Number((pips * spec.pipValuePerStandardLot * trade.lotSize).toFixed(2));
  }

  run(candles: Candle[], options: BacktestOptions): BacktestResult {
    const windowSize = options.windowSize ?? 60;
    const maxHoldBars = options.maxHoldBars ?? 40;
    const startingEquity = options.startingEquity ?? 10_000;
    const applySpreadCost = options.applySpreadCost ?? true;
    // Use the constructor-injected sizer (so a caller who wired one via deps
    // gets it) unless this specific run wants different sizing rules.
    const sizer = options.positionSizing ? new PositionSizer(options.positionSizing) : this.positionSizer;
    const spec = getInstrumentSpec(options.instrument);
    const spread = applySpreadCost ? spreadInPrice(options.instrument) : 0;

    let equity = startingEquity;
    const closedTrades: ExecutedTrade[] = [];
    const openPositions: OpenPosition[] = [];
    const rejections: RejectedTrade[] = [];
    const rejectionsByModule: Record<string, number> = {};
    const equityCurveUsd: BacktestResult['equityCurveUsd'] = [];

    const recordRejection = (rejection: RejectedTrade, module: string) => {
      rejections.push(rejection);
      rejectionsByModule[module] = (rejectionsByModule[module] ?? 0) + 1;
    };

    for (let i = windowSize; i < candles.length; i++) {
      const candle = candles[i];

      // 1. Manage every currently open trade against this bar first — a
      // position can't be both entered and exited on data it hasn't
      // reached yet. advancePosition runs breakeven/trailing (via the same
      // PositionManager instance every bar, so a moved stop persists) and
      // then checks the resulting stop/target/timeout — the single shared
      // decision the live pipeline uses too.
      for (let j = openPositions.length - 1; j >= 0; j--) {
        const position = openPositions[j];
        const result = advancePosition(position.trade, candle, this.positionManager, {
          entryIndex: position.entryIndex,
          barIndex: i,
          maxHoldBars,
          initialStop: position.initialStop,
        });

        if (!result.closed) {
          position.trade = result.trade;
          continue;
        }

        closedTrades.push(result.trade);
        const pnlUsd = this.realizePnl(result.trade, result.trade.exitPrice ?? result.trade.entry, spec);
        equity = Number((equity + pnlUsd).toFixed(2));
        equityCurveUsd.push({
          tradeId: result.trade.id,
          timestamp: result.trade.exitTime ?? result.trade.timestamp,
          equity,
        });
        openPositions.splice(j, 1);
      }

      // 2. Look for a new candidate on this bar's window (no lookahead: only candles up to and including i).
      const window = candles.slice(Math.max(0, i - windowSize), i + 1);
      const candidate = this.strategy.evaluate(options.instrument, window);
      if (!candidate) continue;

      const decision = this.decisionEngine.evaluate(candidate, {
        sessionMetrics: options.sessionMetrics,
        spread,
      });
      if (!decision.approved) {
        recordRejection(decision.rejection, 'DecisionEngine');
        continue;
      }

      const portfolio: PortfolioState = {
        openPositions: openPositions.map((p) => p.trade),
        closedToday: closedTrades,
        session: candidate.session,
      };
      const verdict = this.riskManager.evaluate(candidate, portfolio);
      if (!verdict.approved) {
        recordRejection(this.riskManager.explain(candidate, verdict), 'RiskManager');
        continue;
      }

      const sizing = sizer.calculate({
        equity,
        entry: candidate.entry,
        stop: candidate.stop,
        instrument: options.instrument,
        spread,
      });

      const halfSpread = spread / 2;
      const fillPrice = candidate.side === 'LONG' ? candidate.entry + halfSpread : candidate.entry - halfSpread;

      const opened: ExecutedTrade = {
        id: `BT-${i}-${candidate.id}`,
        timestamp: new Date(candle.time).toISOString(),
        instrument: candidate.instrument,
        timeframe: candidate.timeframe,
        side: candidate.side,
        entry: fillPrice,
        stop: candidate.stop,
        target: candidate.target,
        lotSize: sizing.lotSize,
        rMultiple: null,
        status: 'OPEN',
        session: candidate.session,
        confidence: candidate.confidence,
        strategyVersion: candidate.strategyVersion,
        explanation: `Backtest fill from candidate ${candidate.id} · ${sizing.lotSize} lots · risking $${sizing.riskAmountUsd}`,
      };
      this.positionManager.open(opened);
      openPositions.push({ trade: opened, entryIndex: i, initialStop: opened.stop });
    }

    // Anything still open at the end of the series is force-closed against
    // the last candle — maxHoldBars: 0 guarantees the timeout branch fires,
    // but a genuine stop/target hit on this final candle still takes
    // priority inside advancePosition, same as any other bar.
    const lastCandle = candles[candles.length - 1];
    for (const position of openPositions) {
      const result = advancePosition(position.trade, lastCandle, this.positionManager, {
        entryIndex: position.entryIndex,
        barIndex: candles.length,
        maxHoldBars: 0,
        initialStop: position.initialStop,
      });
      const closed = result.trade;
      closedTrades.push(closed);
      const pnlUsd = this.realizePnl(closed, closed.exitPrice ?? closed.entry, spec);
      equity = Number((equity + pnlUsd).toFixed(2));
      equityCurveUsd.push({ tradeId: closed.id, timestamp: closed.exitTime ?? closed.timestamp, equity });
    }

    return {
      trades: closedTrades,
      rejections,
      rejectionsByModule,
      summary: this.analytics.summarize(closedTrades),
      equityCurve: this.analytics.equityCurve(closedTrades),
      equityCurveUsd,
      startingEquity,
      finalEquity: equity,
      netProfitUsd: Number((equity - startingEquity).toFixed(2)),
    };
  }
}
