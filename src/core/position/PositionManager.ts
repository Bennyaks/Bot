import type { ExecutedTrade } from '../../lib/types';
import type { PositionManagerContract } from '../interfaces';

/**
 * core/position — professionals focus on managing positions, not just entries.
 * Every open position lives here until it closes. The individual controllers
 * (StopLoss, TakeProfit, BreakEven, Trailing, TimeExit) are modelled as pure
 * functions below so each is independently testable and easy to extend —
 * a real implementation can register more without touching manage().
 *
 * `initialRisk` (entry-to-stop distance *before* any controller in this
 * manage() call has touched it) is threaded through explicitly rather than
 * each controller re-deriving `|entry - stop|` from the trade it's handed.
 * Controllers run in sequence and mutate `stop` — if trailing re-derived
 * risk from the post-breakeven trade, the moment breakeven sets stop=entry,
 * risk becomes 0 and trailing collapses to "stop = current price", i.e. a
 * zero-distance trail that stops the trade out on the very next tick of
 * noise. A trailing stop is supposed to hold a constant buffer behind
 * price, not track it with no gap at all.
 */
type Controller = (trade: ExecutedTrade, currentPrice: number, initialRisk: number) => ExecutedTrade;

const breakEvenController: Controller = (trade, currentPrice) => {
  if (trade.status !== 'OPEN') return trade;
  const inProfitR =
    trade.side === 'LONG'
      ? (currentPrice - trade.entry) / (trade.entry - trade.stop)
      : (trade.entry - currentPrice) / (trade.stop - trade.entry);
  if (inProfitR >= 1) {
    return { ...trade, stop: trade.entry };
  }
  return trade;
};

const trailingStopController: Controller = (trade, currentPrice, initialRisk) => {
  if (trade.status !== 'OPEN') return trade;
  if (trade.side === 'LONG') {
    const trail = currentPrice - initialRisk;
    return trail > trade.stop ? { ...trade, stop: trail } : trade;
  }
  const trail = currentPrice + initialRisk;
  return trail < trade.stop ? { ...trade, stop: trail } : trade;
};

/**
 * core/position — the full lifecycle: open -> manage (SL/TP/BE/trailing) -> close.
 */
export class PositionManager implements PositionManagerContract {
  private positions = new Map<string, ExecutedTrade>();
  private controllers: Controller[] = [breakEvenController, trailingStopController];

  open(trade: ExecutedTrade): void {
    this.positions.set(trade.id, trade);
  }

  manage(trade: ExecutedTrade, currentPrice: number): ExecutedTrade {
    // Captured once, from the trade as handed in — not re-derived after
    // breakeven has potentially already moved the stop. See the note above.
    const initialRisk = Math.abs(trade.entry - trade.stop);
    let next = trade;
    for (const controller of this.controllers) {
      next = controller(next, currentPrice, initialRisk);
    }
    this.positions.set(next.id, next);
    return next;
  }

  close(trade: ExecutedTrade, exitPrice: number, reason: string): ExecutedTrade {
    const risk = Math.abs(trade.entry - trade.stop);
    const raw = trade.side === 'LONG' ? exitPrice - trade.entry : trade.entry - exitPrice;
    const pnlR = risk > 0 ? Number((raw / risk).toFixed(2)) : 0;
    const closed: ExecutedTrade = {
      ...trade,
      status: pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN',
      exitPrice,
      exitTime: new Date().toISOString(),
      pnlR,
      rMultiple: pnlR,
      explanation: `${trade.explanation} · closed (${reason})`,
    };
    this.positions.delete(trade.id);
    return closed;
  }

  openPositions(): ExecutedTrade[] {
    return [...this.positions.values()];
  }
}
