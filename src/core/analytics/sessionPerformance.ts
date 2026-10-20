import type { ExecutedTrade, SessionMetrics, SessionName } from '../../lib/types';

const SESSIONS: SessionName[] = ['Asian', 'London', 'NewYork'];

/**
 * core/analytics/sessionPerformance
 * ------------------------------------
 * Real per-session stats from the account's OWN closed trades — this is
 * what a live account should be judged against, never the demo
 * dashboard's decorative `lib/data.ts#sessionMetrics` (those numbers exist
 * purely to make the Sessions page look populated and were never meant to
 * gate real trading decisions).
 *
 * A fresh account starts with zero closed trades in every session, so
 * every entry here starts at totalTrades: 0 — combined with
 * DecisionEngine's minSessionSample check, that reads as "no evidence
 * yet" (allow) rather than "every session has failed" (reject), which is
 * what happened when the demo dataset was used for live decisions.
 */
export function computeSessionMetrics(trades: ExecutedTrade[]): SessionMetrics[] {
  return SESSIONS.map((session) => {
    const closed = trades.filter((t) => t.session === session && t.status !== 'OPEN' && t.pnlR !== undefined);
    const wins = closed.filter((t) => t.status === 'WIN').length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

    const gains = closed.filter((t) => (t.pnlR ?? 0) > 0).reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const losses = Math.abs(closed.filter((t) => (t.pnlR ?? 0) < 0).reduce((s, t) => s + (t.pnlR ?? 0), 0));
    const profitFactor = losses === 0 ? (gains > 0 ? 2 : 1) : gains / losses;

    const netR = closed.reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const averageR = closed.length > 0 ? netR / closed.length : 0;

    return {
      session,
      winRate: Number(winRate.toFixed(1)),
      profitFactor: Number(profitFactor.toFixed(2)),
      averageR: Number(averageR.toFixed(2)),
      tradeFrequency: 0,
      totalTrades: closed.length,
      netR: Number(netR.toFixed(2)),
      bestHour: '—',
      worstHour: '—',
      active: false,
    };
  });
}
