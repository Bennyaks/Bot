import { describe, it, expect } from 'vitest';
import { RiskManager } from '../RiskManager';
import type { PortfolioState, TradeCandidate } from '../../interfaces';
import type { ExecutedTrade } from '../../../lib/types';

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
    structure: 'BOS bullish',
    setupStage: 'SIGNAL_READY',
    status: 'PENDING',
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    id: 'T1',
    timestamp: new Date().toISOString(),
    instrument: 'EURUSD',
    timeframe: '15m',
    side: 'LONG',
    entry: 1.085,
    stop: 1.083,
    target: 1.089,
    lotSize: 0.1,
    rMultiple: null,
    status: 'OPEN',
    session: 'London',
    confidence: 0.75,
    strategyVersion: 'breakout-v1',
    explanation: 'test trade',
    ...overrides,
  };
}

const emptyPortfolio: PortfolioState = { openPositions: [], closedToday: [], session: 'London' };

describe('RiskManager', () => {
  it('approves a clean candidate against an empty portfolio', () => {
    const risk = new RiskManager();
    const verdict = risk.evaluate(makeCandidate(), emptyPortfolio);
    expect(verdict.approved).toBe(true);
  });

  it('vetoes when max open positions is reached', () => {
    const risk = new RiskManager({
      maxOpenPositions: 1,
      maxDailyLossR: -4,
      maxConsecutiveLosses: 3,
      maxExposurePerSymbol: 5,
      minRiskReward: 1.5,
      maxCurrencyExposure: 5,
    });
    const portfolio: PortfolioState = { ...emptyPortfolio, openPositions: [makeTrade()] };
    const verdict = risk.evaluate(makeCandidate(), portfolio);
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_open_positions');
  });

  it('vetoes on a consecutive-loss streak', () => {
    const risk = new RiskManager();
    const portfolio: PortfolioState = {
      ...emptyPortfolio,
      closedToday: [
        makeTrade({ id: 'L1', status: 'LOSS', pnlR: -1 }),
        makeTrade({ id: 'L2', status: 'LOSS', pnlR: -1 }),
        makeTrade({ id: 'L3', status: 'LOSS', pnlR: -1 }),
      ],
    };
    const verdict = risk.evaluate(makeCandidate(), portfolio);
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_consecutive_losses');
  });

  it('does not count a loss streak broken by a win', () => {
    const risk = new RiskManager();
    const portfolio: PortfolioState = {
      ...emptyPortfolio,
      // Most recent trade first — a win immediately resets the streak.
      closedToday: [
        makeTrade({ id: 'W1', status: 'WIN', pnlR: 1.5 }),
        makeTrade({ id: 'L1', status: 'LOSS', pnlR: -1 }),
        makeTrade({ id: 'L2', status: 'LOSS', pnlR: -1 }),
        makeTrade({ id: 'L3', status: 'LOSS', pnlR: -1 }),
      ],
    };
    const verdict = risk.evaluate(makeCandidate(), portfolio);
    expect(verdict.approved).toBe(true);
  });

  it('vetoes when the daily loss limit is hit', () => {
    const risk = new RiskManager();
    const portfolio: PortfolioState = {
      ...emptyPortfolio,
      closedToday: [makeTrade({ id: 'L1', status: 'LOSS', pnlR: -5 })],
    };
    const verdict = risk.evaluate(makeCandidate(), portfolio);
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_daily_loss');
  });

  it('vetoes on excess exposure to the same symbol', () => {
    const risk = new RiskManager({
      maxOpenPositions: 5,
      maxDailyLossR: -4,
      maxConsecutiveLosses: 3,
      maxExposurePerSymbol: 1,
      minRiskReward: 1.5,
      maxCurrencyExposure: 5,
    });
    const portfolio: PortfolioState = {
      ...emptyPortfolio,
      openPositions: [makeTrade({ instrument: 'EURUSD' })],
    };
    const verdict = risk.evaluate(makeCandidate({ instrument: 'EURUSD' }), portfolio);
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('max_symbol_exposure');
  });

  it('vetoes below the minimum reward:risk', () => {
    const risk = new RiskManager();
    const verdict = risk.evaluate(makeCandidate({ riskReward: 1.0 }), emptyPortfolio);
    expect(verdict.approved).toBe(false);
    expect(verdict.ruleId).toBe('min_risk_reward');
  });

  it('explain() produces a RejectedTrade the Journal can render', () => {
    const risk = new RiskManager();
    const verdict = risk.evaluate(makeCandidate({ riskReward: 1.0 }), emptyPortfolio);
    const rejection = risk.explain(makeCandidate({ riskReward: 1.0 }), verdict);
    expect(rejection.failedRules[0]).toContain('Risk Manager');
    expect(rejection.setupStage).toBe('RISK_EVAL');
  });

  describe('correlation exposure', () => {
    it('vetoes a third correlated USD position that would push net USD exposure past the limit', () => {
      // maxOpenPositions/maxExposurePerSymbol raised so those gates don't
      // fire first — this test is specifically about currency correlation.
      const risk = new RiskManager({
        maxOpenPositions: 10,
        maxDailyLossR: -10,
        maxConsecutiveLosses: 10,
        maxExposurePerSymbol: 10,
        minRiskReward: 1.0,
        maxCurrencyExposure: 2,
      });
      const portfolio: PortfolioState = {
        ...emptyPortfolio,
        openPositions: [
          makeTrade({ id: 'P1', instrument: 'EURUSD', side: 'LONG' }),
          makeTrade({ id: 'P2', instrument: 'GBPUSD', side: 'LONG' }),
        ],
      };
      // Short USDJPY is -1 USD on top of the -2 USD already open from the
      // two LONG EUR/GBP positions — net -3 USD, over the limit of 2.
      const verdict = risk.evaluate(
        makeCandidate({ instrument: 'USDJPY', side: 'SHORT', riskReward: 2 }),
        portfolio
      );
      expect(verdict.approved).toBe(false);
      expect(verdict.ruleId).toBe('correlation_exposure');
    });

    it('allows a position that keeps net currency exposure within the limit', () => {
      const risk = new RiskManager({
        maxOpenPositions: 10,
        maxDailyLossR: -10,
        maxConsecutiveLosses: 10,
        maxExposurePerSymbol: 10,
        minRiskReward: 1.0,
        maxCurrencyExposure: 2,
      });
      const portfolio: PortfolioState = {
        ...emptyPortfolio,
        openPositions: [makeTrade({ id: 'P1', instrument: 'EURUSD', side: 'LONG' })],
      };
      const verdict = risk.evaluate(
        makeCandidate({ instrument: 'GBPUSD', side: 'LONG', riskReward: 2 }),
        portfolio
      );
      expect(verdict.approved).toBe(true);
    });

    it('does not flag exposure to an unrelated currency', () => {
      const risk = new RiskManager({
        maxOpenPositions: 10,
        maxDailyLossR: -10,
        maxConsecutiveLosses: 10,
        maxExposurePerSymbol: 10,
        minRiskReward: 1.0,
        maxCurrencyExposure: 1,
      });
      const portfolio: PortfolioState = {
        ...emptyPortfolio,
        openPositions: [
          makeTrade({ id: 'P1', instrument: 'EURUSD', side: 'LONG' }),
          makeTrade({ id: 'P2', instrument: 'EURUSD', side: 'LONG' }),
        ],
      };
      // BTCUSD shares no currency with EURUSD beyond USD itself — check that
      // a completely unrelated base currency (BTC) isn't affected by EUR exposure.
      const verdict = risk.evaluate(
        makeCandidate({ instrument: 'BTCUSD', side: 'SHORT', riskReward: 2 }),
        portfolio
      );
      // BTC leg is untouched by the EURUSD positions (only USD overlaps) —
      // BTC exposure alone (1 unit) should not trip the limit.
      expect(verdict.ruleId).not.toBe('correlation_exposure');
    });
  });
});
