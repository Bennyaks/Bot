import type { ExecutedTrade, SafetyCheck } from '../../lib/types';
import type { Broker, ExecutionProvider } from '../../core/interfaces';

/**
 * Execution realism knobs — all default to "off" (0 / [1,1]) so existing
 * callers that don't pass any config get the old, perfectly-clean fill
 * behavior. A real broker is never perfectly clean: spreads widen, orders
 * occasionally get rejected (margin, liquidity, a requote), and nothing is
 * instantaneous — this makes paper trading exercise those same failure
 * modes instead of only ever exercising the happy path.
 */
export interface PaperBrokerRealism {
  /** Extra adverse slippage on top of spread, uniform in [0, maxSlippage] price units. */
  maxSlippage?: number;
  /** Multiplies the spread passed into submit() by a random factor in this range — simulates spread widening around news/thin liquidity instead of a perfectly constant spread. */
  spreadJitterRange?: [number, number];
  /** Probability (0-1) a submit is rejected outright, mirroring a real broker occasionally saying no. */
  rejectionProbability?: number;
  /** Simulated network/execution latency before the fill resolves, in ms. */
  latencyMs?: number;
  /** Injectable RNG so rejection/jitter/slippage are deterministic in tests. */
  random?: () => number;
}

const DEFAULT_REALISM: Required<PaperBrokerRealism> = {
  maxSlippage: 0,
  spreadJitterRange: [1, 1],
  rejectionProbability: 0,
  latencyMs: 0,
  random: Math.random,
};

/**
 * execution/paper/PaperBroker
 * ----------------------------
 * Implements both ExecutionProvider (order fills) and Broker (connectivity /
 * safety) so the rest of the platform is agnostic to which is wired in.
 * A future execution/mt5/MT5Broker would implement the exact same two
 * interfaces — nothing upstream of ExecutionProvider needs to change.
 *
 * submit() is async and can genuinely reject (see rejectionProbability) —
 * this is what surfaced a real bug: ExecutionProvider.submit's return type
 * was already `Promise<ExecutedTrade> | ExecutedTrade`, but
 * SystemOrchestrator.fillCandidate never awaited it, just force-cast the
 * result with `as ExecutedTrade`. Any execution provider that was actually
 * asynchronous (a real broker bridge always is) would have silently
 * produced a broken position. Fixed alongside this.
 */
export class PaperBroker implements ExecutionProvider, Broker {
  id = 'paper-broker';
  private realism: Required<PaperBrokerRealism>;

  constructor(private safetyChecks: () => SafetyCheck[], realism: PaperBrokerRealism = {}) {
    this.realism = { ...DEFAULT_REALISM, ...realism };
  }

  isConnected(): boolean {
    return true;
  }

  runSafetyChecks(): SafetyCheck[] {
    return this.safetyChecks();
  }

  accountEquity(): number {
    return 10_000;
  }

  async submit(candidate: Parameters<ExecutionProvider['submit']>[0], lotSize: number, spread = 0): Promise<ExecutedTrade> {
    const r = this.realism;

    if (r.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, r.latencyMs));
    }

    if (r.rejectionProbability > 0 && r.random() < r.rejectionProbability) {
      throw new Error(`${this.id}: order rejected (simulated — margin/liquidity/requote)`);
    }

    const [jitterMin, jitterMax] = r.spreadJitterRange;
    const jitter = jitterMin + r.random() * (jitterMax - jitterMin);
    const effectiveSpread = spread * jitter;
    const slippageMagnitude = r.maxSlippage * r.random();

    // A real fill pays the spread: buying crosses the ask (entry + half
    // spread), selling crosses the bid (entry - half spread). Slippage
    // always moves the price further against the trader, same convention
    // MT5Broker uses, regardless of side.
    const halfSpread = effectiveSpread / 2;
    const slippage = candidate.side === 'LONG' ? slippageMagnitude : -slippageMagnitude;
    const fillPrice =
      candidate.side === 'LONG' ? candidate.entry + halfSpread + slippage : candidate.entry - halfSpread - slippage;

    return {
      id: `PB-${Date.now().toString(36).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      instrument: candidate.instrument,
      timeframe: candidate.timeframe,
      side: candidate.side,
      entry: fillPrice,
      stop: candidate.stop,
      target: candidate.target,
      lotSize,
      rMultiple: null,
      status: 'OPEN',
      session: candidate.session,
      confidence: candidate.confidence,
      strategyVersion: candidate.strategyVersion,
      explanation: `Filled by PaperBroker from candidate ${candidate.id} · ${lotSize} lots${spread ? ` · spread ${(effectiveSpread * 1e5).toFixed(1)}pip (${jitter.toFixed(2)}x)` : ''}${slippageMagnitude ? ` · slippage ${(slippageMagnitude * 1e5).toFixed(1)}pip` : ''}`,
    };
  }

  close(trade: ExecutedTrade, exitPrice: number): ExecutedTrade {
    const risk = Math.abs(trade.entry - trade.stop);
    const raw = trade.side === 'LONG' ? exitPrice - trade.entry : trade.entry - exitPrice;
    const pnlR = risk > 0 ? Number((raw / risk).toFixed(2)) : 0;
    return {
      ...trade,
      status: pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN',
      exitPrice,
      exitTime: new Date().toISOString(),
      pnlR,
      rMultiple: pnlR,
    };
  }
}
