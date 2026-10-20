import { describe, it, expect } from 'vitest';
import { computeSessionMetrics } from './sessionPerformance';
import type { ExecutedTrade } from '../../lib/types';

function trade(overrides: Partial<ExecutedTrade>): ExecutedTrade {
  return {
    id: `T-${Math.random()}`,
    timestamp: new Date().toISOString(),
    instrument: 'EURUSD',
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

describe('computeSessionMetrics', () => {
  it('returns all three sessions with zero trades for a fresh account', () => {
    const result = computeSessionMetrics([]);
    expect(result).toHaveLength(3);
    expect(result.every((m) => m.totalTrades === 0)).toBe(true);
    expect(result.map((m) => m.session).sort()).toEqual(['Asian', 'London', 'NewYork']);
  });

  it('ignores open positions — only closed trades with a pnlR count as evidence', () => {
    const result = computeSessionMetrics([trade({ status: 'OPEN', pnlR: undefined, session: 'London' })]);
    const london = result.find((m) => m.session === 'London')!;
    expect(london.totalTrades).toBe(0);
  });

  it('computes real win rate and profit factor for a session from its own closed trades', () => {
    const trades = [
      trade({ status: 'WIN', pnlR: 2, session: 'Asian' }),
      trade({ status: 'LOSS', pnlR: -1, session: 'Asian' }),
      trade({ status: 'WIN', pnlR: 1, session: 'Asian' }),
    ];
    const result = computeSessionMetrics(trades);
    const asian = result.find((m) => m.session === 'Asian')!;
    expect(asian.totalTrades).toBe(3);
    expect(asian.winRate).toBeCloseTo(66.7, 1);
    expect(asian.profitFactor).toBeCloseTo(3, 1); // gains 3 / losses 1
  });

  it('keeps sessions independent of each other', () => {
    const trades = [
      trade({ status: 'WIN', pnlR: 2, session: 'Asian' }),
      trade({ status: 'LOSS', pnlR: -3, session: 'NewYork' }),
    ];
    const result = computeSessionMetrics(trades);
    expect(result.find((m) => m.session === 'Asian')!.totalTrades).toBe(1);
    expect(result.find((m) => m.session === 'NewYork')!.totalTrades).toBe(1);
    expect(result.find((m) => m.session === 'London')!.totalTrades).toBe(0);
  });
});
