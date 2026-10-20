import { describe, it, expect } from 'vitest';
import { RiskManager } from './RiskManager';
import type { PortfolioState, TradeCandidate } from '../interfaces';
import type { ExecutedTrade } from '../../lib/types';

function candidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    id: 'SIG-RISK',
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
    indicators: {},
    structure: 'Confirmed BOS',
    status: 'PENDING',
    ...overrides,
  };
}

function openTrade(instrument = 'GBPUSD'): ExecutedTrade {
  return {
    id: `T-${Math.random()}`,
    timestamp: new Date().toISOString(),
    instrument,
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
  };
}

function closedTrade(pnlR: number): ExecutedTrade {
  return { ...openTrade(), status: pnlR >= 0 ? 'WIN' : 'LOSS', pnlR, rMultiple: pnlR };
}

function portfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return { openPositions: [], closedToday: [], session: 'London', ...overrides };
}

describe('RiskManager', () => {
  it('approves a clean candidate with no portfolio history', () => {
    const risk = new RiskManager();
    const verdict = risk.evaluate(candidate(), portfolio());
    expect(verdict.approved).toBe(true);
  });

  it('rejects when max open positions is reached', () => {
    const risk = new RiskManager({
      maxOpenPositions: 2,
      maxDailyLossR: -10,
      maxConsecutiveLosses: 10,
      maxExposurePerSymbol: 10,
      minRiskReward: 0,
      maxPositionsPerCurrency: 10,
    });
    const verdict = risk.evaluate(candidate(), portfolio({ openPositions: [openTrade(), openTrade()] }));
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_open_positions');
  });

  it('rejects after the max consecutive loss streak', () => {
    const risk = new RiskManager({
      maxOpenPositions: 10,
      maxDailyLossR: -10,
      maxConsecutiveLosses: 2,
      maxExposurePerSymbol: 10,
      minRiskReward: 0,
      maxPositionsPerCurrency: 10,
    });
    const verdict = risk.evaluate(
      candidate(),
      portfolio({ closedToday: [closedTrade(-1), closedTrade(-1)] })
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_consecutive_losses');
  });

  it('does not count a losing streak broken by a win', () => {
    const risk = new RiskManager({
      maxOpenPositions: 10,
      maxDailyLossR: -10,
      maxConsecutiveLosses: 2,
      maxExposurePerSymbol: 10,
      minRiskReward: 0,
      maxPositionsPerCurrency: 10,
    });
    // most recent trade first: a win, then two losses further back
    const verdict = risk.evaluate(
      candidate(),
      portfolio({ closedToday: [closedTrade(1), closedTrade(-1), closedTrade(-1)] })
    );
    expect(verdict.approved).toBe(true);
  });

  it('rejects when the daily loss limit is breached', () => {
    const risk = new RiskManager({
      maxOpenPositions: 10,
      maxDailyLossR: -3,
      maxConsecutiveLosses: 10,
      maxExposurePerSymbol: 10,
      minRiskReward: 0,
      maxPositionsPerCurrency: 10,
    });
    const verdict = risk.evaluate(
      candidate(),
      portfolio({ closedToday: [closedTrade(-2), closedTrade(-1.5)] })
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_daily_loss');
  });

  it('rejects when max exposure to the same symbol is already open', () => {
    const risk = new RiskManager({
      maxOpenPositions: 10,
      maxDailyLossR: -10,
      maxConsecutiveLosses: 10,
      maxExposurePerSymbol: 1,
      minRiskReward: 0,
      maxPositionsPerCurrency: 10,
    });
    const verdict = risk.evaluate(candidate(), portfolio({ openPositions: [openTrade('GBPUSD')] }));
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_symbol_exposure');
  });

  it('rejects a candidate below the minimum reward:risk', () => {
    const risk = new RiskManager({
      maxOpenPositions: 10,
      maxDailyLossR: -10,
      maxConsecutiveLosses: 10,
      maxExposurePerSymbol: 10,
      minRiskReward: 3,
      maxPositionsPerCurrency: 10,
    });
    const verdict = risk.evaluate(candidate({ riskReward: 2 }), portfolio());
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('min_risk_reward');
  });

  it('rejects a correlated bet — a different pair sharing a currency with one already open', () => {
    const risk = new RiskManager({
      maxOpenPositions: 10,
      maxDailyLossR: -10,
      maxConsecutiveLosses: 10,
      maxExposurePerSymbol: 10,
      minRiskReward: 0,
      maxPositionsPerCurrency: 1,
    });
    // EURUSD open, candidate is GBPUSD — different pair, same USD exposure.
    const verdict = risk.evaluate(candidate({ instrument: 'GBPUSD' }), portfolio({ openPositions: [openTrade('EURUSD')] }));
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_currency_correlation');
  });

  it('allows a candidate with no shared currency against what is already open', () => {
    const risk = new RiskManager({
      maxOpenPositions: 10,
      maxDailyLossR: -10,
      maxConsecutiveLosses: 10,
      maxExposurePerSymbol: 10,
      minRiskReward: 0,
      maxPositionsPerCurrency: 1,
    });
    // EURUSD open, candidate is GBPJPY — no shared currency at all.
    const verdict = risk.evaluate(candidate({ instrument: 'GBPJPY' }), portfolio({ openPositions: [openTrade('EURUSD')] }));
    expect(verdict.approved).toBe(true);
  });
});
