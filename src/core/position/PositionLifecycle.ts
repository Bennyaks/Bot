import type { Candle, ExecutedTrade } from '../../lib/types';
import type { PositionManagerContract } from '../interfaces';

export type PositionAction =
  | { type: 'MOVE_STOP'; from: number; to: number; reason: 'breakeven' | 'trailing-stop' }
  | { type: 'CLOSE'; exitPrice: number; reason: 'stop' | 'trailing-stop' | 'target' | 'timeout' | 'end-of-data' };

export interface AdvanceOptions {
  /** Bar index the trade was entered on, for maxHoldBars timeout math. */
  entryIndex?: number;
  /** Current bar index. */
  barIndex?: number;
  /** Force-close (timeout) once barIndex - entryIndex reaches this. */
  maxHoldBars?: number;
  /** Stop distance as it was the moment the trade opened — used only to label a stop-hit as 'stop' vs 'trailing-stop' in the action log; the exit check itself always uses the trade's *current* stop. */
  initialStop?: number;
}

export interface AdvanceResult {
  /** The trade as it stands after this bar — either still open (stop possibly moved) or closed (status/exitPrice/pnlR set). */
  trade: ExecutedTrade;
  actions: PositionAction[];
  closed: boolean;
}

/**
 * core/position/PositionLifecycle
 * ----------------------------------
 * The one place that decides what happens to an open position on a new bar
 * of price data. Previously BacktestHarness had its own inline
 * `candle.low <= trade.stop` check and the live/demo pipeline didn't check
 * price at all (it resolved trades with `Math.random() < confidence` on a
 * timer) — two different, disagreeing implementations of "did this trade
 * exit". Both now call this exact function, so a trade behaves identically
 * whether it's running through historical replay or the live pipeline; only
 * the MarketProvider supplying the candles differs.
 *
 * Order of operations per bar:
 *   1. PositionManager.manage() gets first look — breakeven-at-1R and the
 *      trailing stop may move `trade.stop` based on this bar's close.
 *   2. The (possibly just-moved) stop/target are checked against this bar's
 *      high/low. A real exit takes priority over anything else.
 *   3. maxHoldBars/timeout is checked last, only if nothing else exited —
 *      closes at this bar's close price, same as a broker's forced exit.
 *
 * PositionManager itself is untouched (still mutates-and-returns, matching
 * its existing unit tests) — this module wraps it to add the action log and
 * the stop/target/timeout decision that PositionManager doesn't make itself.
 */
export function advancePosition(
  trade: ExecutedTrade,
  candle: Candle,
  positionManager: PositionManagerContract,
  opts: AdvanceOptions = {}
): AdvanceResult {
  const actions: PositionAction[] = [];
  const stopBeforeThisBar = trade.stop;

  const managed = positionManager.manage(trade, candle.close);
  if (managed.stop !== stopBeforeThisBar) {
    actions.push({
      type: 'MOVE_STOP',
      from: stopBeforeThisBar,
      to: managed.stop,
      reason: managed.stop === managed.entry ? 'breakeven' : 'trailing-stop',
    });
  }

  const hitStop = managed.side === 'LONG' ? candle.low <= managed.stop : candle.high >= managed.stop;
  const hitTarget = managed.side === 'LONG' ? candle.high >= managed.target : candle.low <= managed.target;
  const timedOut =
    opts.maxHoldBars != null &&
    opts.entryIndex != null &&
    opts.barIndex != null &&
    opts.barIndex - opts.entryIndex >= opts.maxHoldBars;

  if (!hitStop && !hitTarget && !timedOut) {
    return { trade: managed, actions, closed: false };
  }

  const initialStop = opts.initialStop ?? stopBeforeThisBar;
  const exitPrice = hitStop ? managed.stop : hitTarget ? managed.target : candle.close;
  const stopMovedInTraderFavor =
    managed.side === 'LONG' ? managed.stop > initialStop : managed.stop < initialStop;
  const reason: PositionAction['reason'] = hitStop
    ? stopMovedInTraderFavor
      ? 'trailing-stop'
      : 'stop'
    : hitTarget
      ? 'target'
      : 'timeout';

  const closedTrade = positionManager.close(managed, exitPrice, reason);
  actions.push({ type: 'CLOSE', exitPrice, reason });

  return { trade: closedTrade, actions, closed: true };
}
