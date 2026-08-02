import type { ExecutedTrade, SessionName } from '../../lib/types';
import type { Analytics } from '../interfaces';

export interface AnalyticsSummary {
  winRate: number;
  profitFactor: number;
  expectancy: number;
  sampleSize: number;
}

export interface SessionBreakdown extends AnalyticsSummary {
  session: SessionName;
}

/**
 * core/analytics/TradeAnalytics
 * -------------------------------
 * Phase 9. Implements the Analytics contract over closed trades only —
 * an OPEN position has no realised R yet, so it is excluded from every
 * calculation here rather than silently counted as a scratch.
 *
 * Kept deliberately dependency-free (no React, no store) so it can be
 * reused by the Orchestrator (real-time AnalyticsUpdated events), a
 * future backtest harness (Phase 14), or a Node script — anything that
 * can hand it an ExecutedTrade[].
 */
export class TradeAnalytics implements Analytics {
  private closed(trades: ExecutedTrade[]): ExecutedTrade[] {
    return trades.filter((t) => t.status !== 'OPEN' && typeof t.pnlR === 'number');
  }

  winRate(trades: ExecutedTrade[]): number {
    const closed = this.closed(trades);
    if (closed.length === 0) return 0;
    const wins = closed.filter((t) => t.status === 'WIN').length;
    return Number(((wins / closed.length) * 100).toFixed(1));
  }

  profitFactor(trades: ExecutedTrade[]): number {
    const closed = this.closed(trades);
    const grossWin = closed.filter((t) => (t.pnlR ?? 0) > 0).reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const grossLoss = Math.abs(
      closed.filter((t) => (t.pnlR ?? 0) < 0).reduce((s, t) => s + (t.pnlR ?? 0), 0)
    );
    if (grossLoss === 0) return grossWin > 0 ? Number(grossWin.toFixed(2)) : 0;
    return Number((grossWin / grossLoss).toFixed(2));
  }

  expectancy(trades: ExecutedTrade[]): number {
    const closed = this.closed(trades);
    if (closed.length === 0) return 0;
    const totalR = closed.reduce((s, t) => s + (t.pnlR ?? 0), 0);
    return Number((totalR / closed.length).toFixed(2));
  }

  /** Convenience wrapper — the three interface methods bundled for the UI/EventBus. */
  summarize(trades: ExecutedTrade[]): AnalyticsSummary {
    return {
      winRate: this.winRate(trades),
      profitFactor: this.profitFactor(trades),
      expectancy: this.expectancy(trades),
      sampleSize: this.closed(trades).length,
    };
  }

  /** Same three metrics, sliced per session — feeds Sessions.tsx with real numbers instead of static demo data. */
  bySession(trades: ExecutedTrade[]): SessionBreakdown[] {
    const sessions = Array.from(new Set(trades.map((t) => t.session)));
    return sessions.map((session) => {
      const subset = trades.filter((t) => t.session === session);
      return { session, ...this.summarize(subset) };
    });
  }

  /** Cumulative R-multiple curve in trade-closed order — for an equity-curve chart. */
  equityCurve(trades: ExecutedTrade[]): { tradeId: string; timestamp: string; cumulativeR: number }[] {
    const closed = this.closed(trades)
      .slice()
      .sort((a, b) => new Date(a.exitTime ?? a.timestamp).getTime() - new Date(b.exitTime ?? b.timestamp).getTime());
    let running = 0;
    return closed.map((t) => {
      running += t.pnlR ?? 0;
      return { tradeId: t.id, timestamp: t.exitTime ?? t.timestamp, cumulativeR: Number(running.toFixed(2)) };
    });
  }

  /** Most frequent rejection reason strings — the "Most Common Rejection" stat the Journal/Diagnostics can surface. */
  mostCommonReasons(reasons: string[][], top = 3): { reason: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const set of reasons) {
      for (const reason of set) {
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([reason, count]) => ({ reason, count }));
  }
}
