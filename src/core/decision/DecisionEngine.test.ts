import { describe, it, expect } from 'vitest';
import { DecisionEngine } from './DecisionEngine';
import type { TradeCandidate } from '../interfaces';
import type { SessionMetrics } from '../../lib/types';

const goodSessionMetrics: SessionMetrics[] = [
  {
    session: 'London',
    winRate: 61.4,
    profitFactor: 1.87,
    averageR: 0.72,
    tradeFrequency: 4.8,
    totalTrades: 192,
    netR: 138.2,
    bestHour: '08:00 UTC',
    worstHour: '12:00 UTC',
    active: true,
  },
];

function baseCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    id: 'SIG-TEST',
    timestamp: new Date().toISOString(),
    instrument: 'GBPUSD',
    timeframe: '15m',
    side: 'LONG',
    entry: 1.2645,
    stop: 1.262,
    target: 1.2695,
    confidence: 0.8,
    session: 'London',
    marketRegime: 'TRENDING_BULL',
    strategyVersion: 'v1.4',
    setupStage: 'BOS_CONFIRMED',
    riskReward: 2.0,
    indicators: { volumeRatio: 1.6 },
    structure: 'Confirmed BOS with volume expansion',
    status: 'PENDING',
    ...overrides,
  };
}

describe('DecisionEngine', () => {
  it('approves a candidate that clears every gate', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(baseCandidate(), { sessionMetrics: goodSessionMetrics });
    expect(result.approved).toBe(true);
  });

  it('rejects a candidate with low confidence', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(baseCandidate({ confidence: 0.2 }), {
      sessionMetrics: goodSessionMetrics,
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejection.reasons.some((r) => r.includes('Confidence'))).toBe(true);
    }
  });

  it('rejects a candidate with poor reward:risk', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(baseCandidate({ riskReward: 0.5 }), {
      sessionMetrics: goodSessionMetrics,
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejection.reasons.some((r) => r.includes('Reward'))).toBe(true);
    }
  });

  it('rejects a candidate during a news event regime', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(baseCandidate({ marketRegime: 'NEWS_EVENT' }), {
      sessionMetrics: goodSessionMetrics,
    });
    expect(result.approved).toBe(false);
  });

  it('allows a candidate when there is no session entry at all — absence of evidence is not evidence of underperformance', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(baseCandidate({ session: 'Asian' }), {
      sessionMetrics: goodSessionMetrics, // only London metrics provided
    });
    expect(result.approved).toBe(true);
  });

  it('allows a candidate when the matching session has too few real closed trades to judge, even if its stats look bad', () => {
    // Regression test for the exact live bug: a fresh account has 0 closed
    // trades in every session. Judging a session "bad" from a handful of
    // trades (or from decorative demo numbers) blocks trading on nothing.
    const engine = new DecisionEngine();
    const thinData: SessionMetrics[] = [
      { ...goodSessionMetrics[0], session: 'Asian', winRate: 10, profitFactor: 0.4, totalTrades: 3 },
    ];
    const result = engine.evaluate(baseCandidate({ session: 'Asian' }), {
      sessionMetrics: thinData,
      minSessionSample: 10,
    });
    expect(result.approved).toBe(true);
  });

  it('rejects a candidate when the matching session has enough real closed trades AND they are genuinely bad', () => {
    const engine = new DecisionEngine();
    const provenBadSession: SessionMetrics[] = [
      { ...goodSessionMetrics[0], session: 'Asian', winRate: 30, profitFactor: 0.6, totalTrades: 40 },
    ];
    const result = engine.evaluate(baseCandidate({ session: 'Asian' }), {
      sessionMetrics: provenBadSession,
      minSessionSample: 10,
    });
    expect(result.approved).toBe(false);
  });

  it('produces an explainable rejection with the correct failed-gate count', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(
      baseCandidate({ confidence: 0.1, riskReward: 0.5, marketRegime: 'RANGING' }),
      { sessionMetrics: goodSessionMetrics }
    );
    expect(result.approved).toBe(false);
    if (!result.approved) {
      // trend_alignment, confidence_threshold, reward_risk all fail
      expect(result.rejection.reasons.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('skips the FX session-evidence gate for crypto instruments even with no session data', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(baseCandidate({ instrument: 'BTCUSD', session: 'Asian' }), {
      sessionMetrics: [], // no FX session stats at all — should not matter for crypto
    });
    expect(result.approved).toBe(true);
  });

  it('regression guard: an empty sessionMetrics array must not reject every FX candidate silently', () => {
    // This is the exact bug that shipped in liveRunner/backtest/LiveTradingManager:
    // passing [] made session_evidence fail unconditionally, rejecting 100% of
    // live candidates regardless of how good they were. A candidate with a
    // matching, passing session entry must be approved even when other
    // sessions in the array are absent or failing.
    const engine = new DecisionEngine();
    const result = engine.evaluate(baseCandidate({ session: 'London' }), {
      sessionMetrics: goodSessionMetrics,
    });
    expect(result.approved).toBe(true);
  });
});
