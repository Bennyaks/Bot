import { describe, it, expect } from 'vitest';
import { TradeAnalytics } from '../TradeAnalytics';
import type { ExecutedTrade } from '../../../lib/types';

function trade(overrides: Partial<ExecutedTrade>): ExecutedTrade {
  return {
    id: 'T',
    timestamp: new Date().toISOString(),
    instrument: 'EURUSD',
    timeframe: '15m',
    side: 'LONG',
    entry: 1.1,
    stop: 1.098,
    target: 1.106,
    lotSize: 0.1,
    rMultiple: null,
    status: 'OPEN',
    session: 'London',
    confidence: 0.8,
    strategyVersion: 'breakout-v1',
    explanation: 'test',
    ...overrides,
  };
}

describe('TradeAnalytics', () => {
  const analytics = new TradeAnalytics();

  const trades: ExecutedTrade[] = [
    trade({ id: 'W1', status: 'WIN', pnlR: 2, session: 'London' }),
    trade({ id: 'W2', status: 'WIN', pnlR: 1.5, session: 'London' }),
    trade({ id: 'L1', status: 'LOSS', pnlR: -1, session: 'NewYork' }),
    trade({ id: 'OPEN1', status: 'OPEN', session: 'London' }), // excluded from every metric
  ];

  it('computes win rate over closed trades only', () => {
    expect(analytics.winRate(trades)).toBe(66.7);
  });

  it('computes profit factor as gross win / gross loss', () => {
    expect(analytics.profitFactor(trades)).toBe(3.5); // 3.5 / 1
  });

  it('computes expectancy as average R over closed trades', () => {
    expect(analytics.expectancy(trades)).toBe(0.83); // (2+1.5-1)/3
  });

  it('returns zeros for an empty trade list rather than NaN', () => {
    expect(analytics.winRate([])).toBe(0);
    expect(analytics.profitFactor([])).toBe(0);
    expect(analytics.expectancy([])).toBe(0);
  });

  it('summarize() bundles all three plus sample size, excluding OPEN trades', () => {
    const summary = analytics.summarize(trades);
    expect(summary.sampleSize).toBe(3);
    expect(summary.winRate).toBe(66.7);
  });

  it('bySession() slices metrics per session', () => {
    const breakdown = analytics.bySession(trades);
    const london = breakdown.find((b) => b.session === 'London');
    const newYork = breakdown.find((b) => b.session === 'NewYork');
    expect(london?.sampleSize).toBe(2);
    expect(newYork?.sampleSize).toBe(1);
  });

  it('equityCurve() produces a monotonically-ordered cumulative R series', () => {
    const curve = analytics.equityCurve(trades);
    expect(curve).toHaveLength(3);
    expect(curve[curve.length - 1].cumulativeR).toBe(2.5);
  });

  it('mostCommonReasons() ranks rejection reasons by frequency', () => {
    const ranked = analytics.mostCommonReasons([
      ['Confidence threshold', 'Reward:risk quality'],
      ['Confidence threshold'],
      ['Reward:risk quality'],
      ['Confidence threshold'],
    ]);
    expect(ranked[0]).toEqual({ reason: 'Confidence threshold', count: 3 });
  });
});
