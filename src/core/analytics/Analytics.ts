import type { ExecutedTrade } from '../../lib/types';
import type { Analytics } from '../interfaces';

function closedTrades(trades: ExecutedTrade[]): ExecutedTrade[] {
  return trades.filter((t) => t.status !== 'OPEN' && t.pnlR !== undefined);
}

/**
 * core/analytics/TradeAnalytics
 * --------------------------------
 * Implements the Analytics contract. Daily/weekly/monthly rollups are
 * exported as standalone functions below so the Dashboard (Phase 12) or
 * any other consumer can call them without instantiating the class.
 */
export class TradeAnalytics implements Analytics {
  winRate(trades: ExecutedTrade[]): number {
    const closed = closedTrades(trades);
    if (closed.length === 0) return 0;
    const wins = closed.filter((t) => t.status === 'WIN').length;
    return Number(((wins / closed.length) * 100).toFixed(1));
  }

  profitFactor(trades: ExecutedTrade[]): number {
    const closed = closedTrades(trades);
    const gains = closed.filter((t) => (t.pnlR ?? 0) > 0).reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const losses = Math.abs(closed.filter((t) => (t.pnlR ?? 0) < 0).reduce((s, t) => s + (t.pnlR ?? 0), 0));
    if (losses === 0) return gains > 0 ? Infinity : 0;
    return Number((gains / losses).toFixed(2));
  }

  expectancy(trades: ExecutedTrade[]): number {
    const closed = closedTrades(trades);
    if (closed.length === 0) return 0;
    const total = closed.reduce((s, t) => s + (t.pnlR ?? 0), 0);
    return Number((total / closed.length).toFixed(2));
  }
}

/** Cumulative R-multiple over time, oldest first — the raw material for an equity curve. */
export function equityCurve(trades: ExecutedTrade[]): number[] {
  const closed = [...closedTrades(trades)].reverse();
  let running = 0;
  return closed.map((t) => (running += t.pnlR ?? 0));
}

/** Largest peak-to-trough decline in the equity curve, expressed in R. */
export function maxDrawdown(curve: number[]): number {
  let peak = 0;
  let worst = 0;
  for (const value of curve) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value - peak);
  }
  return Number(worst.toFixed(2));
}

/** Simplistic Sharpe-style ratio: mean return over the standard deviation of returns. */
export function sharpeRatio(trades: ExecutedTrade[]): number {
  const returns = closedTrades(trades).map((t) => t.pnlR ?? 0);
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return Number(((mean / stdDev) * Math.sqrt(returns.length)).toFixed(2));
}

export function mostCommonRejectionReason(rejectedReasons: string[][]): string | null {
  const counts = new Map<string, number>();
  for (const reasons of rejectedReasons) {
    for (const reason of reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}
