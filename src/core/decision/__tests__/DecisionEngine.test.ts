import { describe, it, expect } from 'vitest';
import { DecisionEngine } from '../DecisionEngine';
import type { TradeCandidate } from '../../interfaces';
import type { SessionMetrics } from '../../../lib/types';

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

const poorSessionMetrics: SessionMetrics[] = [
  {
    ...goodSessionMetrics[0],
    session: 'Asian',
    winRate: 30,
    profitFactor: 0.8,
    averageR: -0.1,
  },
];

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    id: 'SIG-TEST',
    timestamp: new Date().toISOString(),
    instrument: 'EURUSD',
    timeframe: '15m',
    side: 'LONG',
    entry: 1.085,
    stop: 1.083,
    target: 1.089,
    confidence: 0.75,
    session: 'London',
    marketRegime: 'TRENDING_BULL',
    strategyVersion: 'breakout-v1',
    riskReward: 2,
    indicators: {},
    structure: 'BOS bullish · broke 1.0845 at bar 40',
    setupStage: 'SIGNAL_READY',
    status: 'PENDING',
    ...overrides,
  };
}

describe('DecisionEngine', () => {
  it('approves a candidate that clears every gate', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(makeCandidate(), { sessionMetrics: goodSessionMetrics });
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.approval.passedGates.length).toBe(7);
      expect(result.approval.score).toBe(1);
    }
  });

  it('rejects on low confidence with an explainable reason', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(makeCandidate({ confidence: 0.2 }), { sessionMetrics: goodSessionMetrics });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejection.reasons.some((r) => r.includes('Confidence'))).toBe(true);
    }
  });

  it('rejects on poor reward:risk', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(makeCandidate({ riskReward: 1.1 }), { sessionMetrics: goodSessionMetrics });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejection.reasons.some((r) => r.includes('Reward'))).toBe(true);
    }
  });

  it('rejects when session evidence is weak', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(makeCandidate({ session: 'Asian' }), { sessionMetrics: poorSessionMetrics });
    expect(result.approved).toBe(false);
  });

  it('rejects a NEWS_EVENT regime regardless of everything else', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(makeCandidate({ marketRegime: 'NEWS_EVENT' }), {
      sessionMetrics: goodSessionMetrics,
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejection.reasons.some((r) => r.includes('news'))).toBe(true);
    }
  });

  it('passes the spread_cost gate when no spread data is supplied', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(makeCandidate(), { sessionMetrics: goodSessionMetrics });
    expect(result.approved).toBe(true);
  });

  it('rejects when spread cost pushes net reward:risk below the minimum', () => {
    const engine = new DecisionEngine();
    // risk = 0.002, reward = 0.004 -> raw RR = 2.0 (passes reward_risk gate),
    // but a 0.0015 spread widens risk to 0.0035 and shrinks reward to 0.0025,
    // netRR ~0.71 — should fail spread_cost even though the raw candidate looked fine.
    const result = engine.evaluate(
      makeCandidate({ entry: 1.085, stop: 1.083, target: 1.089, riskReward: 2 }),
      { sessionMetrics: goodSessionMetrics, spread: 0.0015 }
    );
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejection.reasons.some((r) => r.includes('spread'))).toBe(true);
    }
  });

  it('approves through spread_cost when the spread is small relative to the setup', () => {
    const engine = new DecisionEngine();
    const result = engine.evaluate(
      makeCandidate({ entry: 1.085, stop: 1.083, target: 1.089, riskReward: 2 }),
      { sessionMetrics: goodSessionMetrics, spread: 0.00005 }
    );
    expect(result.approved).toBe(true);
  });

  it('supports registering an additional gate without editing the class', () => {
    const engine = new DecisionEngine();
    engine.registerGate({
      id: 'custom_gate',
      label: 'Custom gate',
      evaluate: () => false,
    });
    const result = engine.evaluate(makeCandidate(), { sessionMetrics: goodSessionMetrics });
    expect(result.approved).toBe(false);
  });
});
