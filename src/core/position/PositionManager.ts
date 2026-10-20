import type { ExecutedTrade } from '../../lib/types';
import type { PositionManagerContract } from '../interfaces';

/**
 * core/position — professionals focus on managing positions, not just entries.
 * Every open position lives here until it closes. The individual controllers
 * (StopLoss, TakeProfit, BreakEven, Trailing, TimeExit) are modelled as pure
 * functions below so each is independently testable and easy to extend —
 * a real implementation can register more without touching manage().
 *
 * `risk` is always the ORIGINAL entry-to-stop distance captured once at
 * open() — never recomputed from the trade's current (possibly already
 * trailed) stop. Recomputing it from a moving stop is what let earlier
 * controllers silently erase later ones' progress.
 */
type Controller = (trade: ExecutedTrade, currentPrice: number, risk: number) => ExecutedTrade;

const breakEvenController: Controller = (trade, currentPrice, risk) => {
  if (trade.status !== 'OPEN' || risk <= 0) return trade;
  const inProfitR =
    trade.side === 'LONG' ? (currentPrice - trade.entry) / risk : (trade.entry - currentPrice) / risk;
  if (inProfitR < 1) return trade;
  // Only tighten toward breakeven — never loosen a stop that trailing has already moved further.
  if (trade.side === 'LONG' && trade.stop < trade.entry) return { ...trade, stop: trade.entry };
  if (trade.side === 'SHORT' && trade.stop > trade.entry) return { ...trade, stop: trade.entry };
  return trade;
};

const trailingStopController: Controller = (trade, currentPrice, risk) => {
  if (trade.status !== 'OPEN' || risk <= 0) return trade;
  // Only start trailing once the position has reached the same 1R threshold
  // break-even uses — otherwise this would tighten the stop from the very
  // first tick, before breakeven has even had a chance to run.
  if (trade.side === 'LONG') {
    if (currentPrice - trade.entry < risk) return trade;
    const trail = currentPrice - risk;
    return trail > trade.stop ? { ...trade, stop: trail } : trade;
  }
  if (trade.entry - currentPrice < risk) return trade;
  const trail = currentPrice + risk;
  return trail < trade.stop ? { ...trade, stop: trail } : trade;
};

/**
 * core/position — the full lifecycle: open -> manage (SL/TP/BE/trailing) -> close.
 */
export class PositionManager implements PositionManagerContract {
  private positions = new Map<string, ExecutedTrade>();
  private initialRisk = new Map<string, number>();
  private controllers: Controller[] = [breakEvenController, trailingStopController];

  open(trade: ExecutedTrade): void {
    this.positions.set(trade.id, trade);
    this.initialRisk.set(trade.id, Math.abs(trade.entry - trade.stop));
  }

  manage(trade: ExecutedTrade, currentPrice: number): ExecutedTrade {
    const risk = this.initialRisk.get(trade.id) ?? Math.abs(trade.entry - trade.stop);
    let next = trade;
    for (const controller of this.controllers) {
      next = controller(next, currentPrice, risk);
    }
    this.positions.set(next.id, next);
    return next;
  }

  close(trade: ExecutedTrade, exitPrice: number, reason: string): ExecutedTrade {
    const risk = this.initialRisk.get(trade.id) ?? Math.abs(trade.entry - trade.stop);
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
    this.initialRisk.delete(trade.id);
    return closed;
  }

  openPositions(): ExecutedTrade[] {
    return [...this.positions.values()];
  }

  /**
   * The ORIGINAL entry-to-stop risk captured at open() — used by
   * managePartialProfits() (liveTradingManager) so a partial-take-profit
   * check is measured against the trade's real risk basis even if a
   * breakeven/trailing controller has already moved `trade.stop` by the
   * time the check runs in the same scan cycle. Returns undefined for an
   * unknown trade id — callers should fall back to entry/stop directly.
   */
  initialRiskFor(tradeId: string): number | undefined {
    return this.initialRisk.get(tradeId);
  }
}
