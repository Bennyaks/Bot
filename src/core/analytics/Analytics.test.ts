import { describe, it, expect } from 'vitest';
import { TradeAnalytics, equityCurve, maxDrawdown } from './Analytics';
import type { ExecutedTrade } from '../../lib/types';

function trade(overrides: Partial<ExecutedTrade>): ExecutedTrade {
  return {
    id: `T-${Math.random()}`,
    timestamp: new Date().toISOString(),
    instrument: 'GBPUSD',
    timeframe: '15m',
    side: 'LONG',
    entry: 1.26,
    stop: 1.258,
    target: 1.264,
    lotSize: 0.1,
    rMultiple: null,
    status: 'OPEN',
    session: 'London',
    confidence: 0.8,
    strategyVersion: 'v1.4',
    explanation: 'test fixture',
    ...overrides,
  };
}

describe('TradeAnalytics', () => {
  const analytics = new TradeAnalytics();

  it('computes win rate from closed trades only', () => {
    const trades = [
      trade({ status: 'WIN', pnlR: 2 }),
      trade({ status: 'LOSS', pnlR: -1 }),
      trade({ status: 'WIN', pnlR: 1.5 }),
      trade({ status: 'OPEN', pnlR: undefined }), // excluded
    ];
    expect(analytics.winRate(trades)).toBeCloseTo(66.7, 1);
  });

  it('returns 0 win rate when there are no closed trades', () => {
    expect(analytics.winRate([trade({ status: 'OPEN', pnlR: undefined })])).toBe(0);
  });

  it('computes profit factor as gains over absolute losses', () => {
    const trades = [trade({ status: 'WIN', pnlR: 3 }), trade({ status: 'LOSS', pnlR: -1 })];
    expect(analytics.profitFactor(trades)).toBeCloseTo(3, 2);
  });

  it('computes expectancy as average R across closed trades', () => {
    const trades = [
      trade({ status: 'WIN', pnlR: 2 }),
      trade({ status: 'LOSS', pnlR: -1 }),
      trade({ status: 'WIN', pnlR: 1 }),
    ];
    expect(analytics.expectancy(trades)).toBeCloseTo(0.67, 1);
  });
});

describe('equityCurve / maxDrawdown', () => {
  it('builds a cumulative curve oldest-first from newest-first trades', () => {
    // executed list is newest-first, as the store stores it
    const trades = [
      trade({ status: 'LOSS', pnlR: -1 }), // most recent
      trade({ status: 'WIN', pnlR: 2 }), // oldest
    ];
    expect(equityCurve(trades)).toEqual([2, 1]);
  });

  it('finds the largest peak-to-trough decline', () => {
    const curve = [1, 2, 3, 1, 0, 4]; // peak 3 -> trough 0 = -3
    expect(maxDrawdown(curve)).toBe(-3);
  });

  it('returns 0 drawdown for a monotonically increasing curve', () => {
    expect(maxDrawdown([1, 2, 3, 4])).toBe(0);
  });
});
