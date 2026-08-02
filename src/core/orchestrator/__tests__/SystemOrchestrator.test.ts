import { describe, it, expect, vi } from 'vitest';
import { SystemOrchestrator } from '../SystemOrchestrator';
import { PaperBroker } from '../../../execution/paper/PaperBroker';
import { InMemoryStorage } from '../../storage/LocalStorage';
import type { Notifier, TradeCandidate } from '../../interfaces';
import type { SafetyCheck, Candle, SessionMetrics } from '../../../lib/types';

const allSafetyPassed: SafetyCheck[] = [
  { id: 'connection', label: 'Connection', description: 'Broker connection healthy', passed: true, detail: 'OK', critical: true },
];

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

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    id: 'C1',
    timestamp: new Date().toISOString(),
    instrument: 'EURUSD',
    timeframe: '15m',
    side: 'LONG',
    entry: 1.1,
    stop: 1.098,
    target: 1.106,
    riskReward: 3,
    confidence: 0.7,
    session: 'London',
    marketRegime: 'TRENDING_BULL',
    structure: 'test breakout',
    strategyVersion: 'test-v1',
    setupStage: 'RISK_APPROVED',
    indicators: {},
    status: 'APPROVED',
    ...overrides,
  };
}

function c(open: number, high: number, low: number, close: number, time = 0): Candle {
  return { time, open, high, low, close, volume: 1000 };
}

function makeOrchestrator() {
  const broker = new PaperBroker(() => allSafetyPassed);
  const notifier: Notifier = { log: vi.fn() };
  const orchestrator = new SystemOrchestrator({
    broker,
    execution: broker,
    notifier,
    storage: new InMemoryStorage(),
  });
  return { orchestrator, broker };
}

describe('SystemOrchestrator', () => {
  it('fillCandidate sizes the trade against real account equity, not a hardcoded lot', async () => {
    const { orchestrator } = makeOrchestrator();
    const trade = await orchestrator.fillCandidate(makeCandidate());
    expect(trade.lotSize).toBeGreaterThan(0);
    expect(trade.status).toBe('OPEN');
  });

  it('manageOpenPosition leaves a trade open and emits nothing when price stays inside stop/target', async () => {
    const { orchestrator } = makeOrchestrator();
    const trade = await orchestrator.fillCandidate(makeCandidate());
    const managedSpy = vi.fn();
    const closedSpy = vi.fn();
    orchestrator.bus.on('PositionManaged', managedSpy);
    orchestrator.bus.on('PositionClosed', closedSpy);

    const result = orchestrator.manageOpenPosition(trade, c(1.099, 1.1005, 1.0985, 1.0995));
    expect(result.closed).toBe(false);
    expect(managedSpy).not.toHaveBeenCalled();
    expect(closedSpy).not.toHaveBeenCalled();
  });

  it('manageOpenPosition emits PositionManaged when breakeven moves the stop without closing', async () => {
    const { orchestrator } = makeOrchestrator();
    const trade = await orchestrator.fillCandidate(makeCandidate());
    const managedSpy = vi.fn();
    orchestrator.bus.on('PositionManaged', managedSpy);

    // Risk = entry - stop; drive price to +1R to trigger breakeven.
    const oneR = trade.entry - trade.stop;
    const target = trade.entry + oneR;
    const result = orchestrator.manageOpenPosition(trade, c(trade.entry, target + 0.0005, target - 0.0005, target));

    expect(result.closed).toBe(false);
    expect(managedSpy).toHaveBeenCalledTimes(1);
  });

  it('manageOpenPosition emits PositionClosed + TradeArchived and persists the trade when the target is hit', async () => {
    const { orchestrator } = makeOrchestrator();
    const trade = await orchestrator.fillCandidate(makeCandidate());
    const closedSpy = vi.fn();
    const archivedSpy = vi.fn();
    orchestrator.bus.on('PositionClosed', closedSpy);
    orchestrator.bus.on('TradeArchived', archivedSpy);

    const result = orchestrator.manageOpenPosition(
      trade,
      c(trade.target - 0.0005, trade.target + 0.0005, trade.target - 0.0005, trade.target)
    );

    expect(result.closed).toBe(true);
    expect(result.trade.status).toBe('WIN');
    expect(closedSpy).toHaveBeenCalledTimes(1);
    expect(archivedSpy).toHaveBeenCalledTimes(1);
    expect(orchestrator.loadPersistedTrades().some((t) => t.id === trade.id)).toBe(true);
  });

  it('a real stop-driven exit through manageOpenPosition matches what BacktestHarness would have decided (same shared function)', async () => {
    const { orchestrator } = makeOrchestrator();
    const trade = await orchestrator.fillCandidate(makeCandidate());
    const result = orchestrator.manageOpenPosition(
      trade,
      c(trade.stop + 0.0005, trade.stop + 0.001, trade.stop - 0.0002, trade.stop)
    );
    expect(result.closed).toBe(true);
    expect(result.trade.status).toBe('LOSS');
    expect(result.trade.exitPrice).toBe(trade.stop);
  });

  it('fillCandidate rejects and emits OrderRejected when the ExecutionProvider genuinely rejects the submit', async () => {
    const rejectingBroker = new PaperBroker(() => allSafetyPassed, { rejectionProbability: 1, random: () => 0 });
    const notifier: Notifier = { log: vi.fn() };
    const orchestrator = new SystemOrchestrator({
      broker: rejectingBroker,
      execution: rejectingBroker,
      notifier,
      storage: new InMemoryStorage(),
    });
    const rejectedSpy = vi.fn();
    orchestrator.bus.on('OrderRejected', rejectedSpy);

    await expect(orchestrator.fillCandidate(makeCandidate())).rejects.toThrow();
    expect(rejectedSpy).toHaveBeenCalledTimes(1);
    expect(notifier.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'ERROR', module: 'ExecutionManager' }));
  });

  describe('lifecycle tracking', () => {
    it('submitCandidate takes an approved candidate through CANDIDATE -> DECISION_APPROVED -> RISK_APPROVED', () => {
      const { orchestrator } = makeOrchestrator();
      const candidate = makeCandidate();
      const result = orchestrator.submitCandidate(candidate, {
        safety: allSafetyPassed,
        sessionMetrics: goodSessionMetrics,
        openPositions: [],
        closedToday: [],
      });
      expect(result.outcome).toBe('approved');
      expect(orchestrator.lifecycleStateOf(candidate.id)).toBe('RISK_APPROVED');
      expect(orchestrator.lifecycleHistoryOf(candidate.id).map((h) => h.to)).toEqual([
        'CANDIDATE',
        'DECISION_APPROVED',
        'RISK_APPROVED',
      ]);
    });

    it('submitCandidate stops a Decision Engine rejection at DECISION_REJECTED', () => {
      const { orchestrator } = makeOrchestrator();
      const candidate = makeCandidate({ confidence: 0.01 }); // fails confidence_threshold
      const result = orchestrator.submitCandidate(candidate, {
        safety: allSafetyPassed,
        sessionMetrics: goodSessionMetrics,
        openPositions: [],
        closedToday: [],
      });
      expect(result.outcome).toBe('rejected_decision');
      expect(orchestrator.lifecycleStateOf(candidate.id)).toBe('DECISION_REJECTED');
    });

    it('emits LifecycleTransition for every hop', () => {
      const { orchestrator } = makeOrchestrator();
      const events: string[] = [];
      orchestrator.bus.on('LifecycleTransition', ({ transition }) => events.push(transition.to));
      orchestrator.submitCandidate(makeCandidate(), {
        safety: allSafetyPassed,
        sessionMetrics: goodSessionMetrics,
        openPositions: [],
        closedToday: [],
      });
      expect(events).toEqual(['CANDIDATE', 'DECISION_APPROVED', 'RISK_APPROVED']);
    });

    it('fillCandidate carries lifecycle through SUBMITTED -> FILLED -> MANAGING under the trade id (rekeyed from the candidate id)', async () => {
      const { orchestrator } = makeOrchestrator();
      const candidate = makeCandidate();
      orchestrator.submitCandidate(candidate, {
        safety: allSafetyPassed,
        sessionMetrics: goodSessionMetrics,
        openPositions: [],
        closedToday: [],
      });
      const trade = await orchestrator.fillCandidate(candidate);

      // The old candidate.id is no longer tracked — it moved to trade.id.
      expect(orchestrator.lifecycleStateOf(candidate.id)).toBeNull();
      expect(orchestrator.lifecycleStateOf(trade.id)).toBe('MANAGING');
      expect(orchestrator.lifecycleHistoryOf(trade.id).map((h) => h.to)).toEqual([
        'CANDIDATE',
        'DECISION_APPROVED',
        'RISK_APPROVED',
        'SUBMITTED',
        'FILLED',
        'MANAGING',
      ]);
    });

    it('fillCandidate called directly (no prior submitCandidate) synthesizes the pre-fill states instead of throwing', async () => {
      const { orchestrator } = makeOrchestrator();
      const trade = await orchestrator.fillCandidate(makeCandidate());
      expect(orchestrator.lifecycleStateOf(trade.id)).toBe('MANAGING');
    });

    it('manageOpenPosition transitions to BREAKEVEN when the stop moves to entry', async () => {
      const { orchestrator } = makeOrchestrator();
      const trade = await orchestrator.fillCandidate(makeCandidate());
      const oneR = trade.entry - trade.stop;
      const target = trade.entry + oneR;
      orchestrator.manageOpenPosition(trade, c(trade.entry, target + 0.0005, target - 0.0005, target));
      expect(orchestrator.lifecycleStateOf(trade.id)).toBe('BREAKEVEN');
    });

    it('manageOpenPosition transitions to CLOSED when the target is hit, and to ARCHIVED once persisted', async () => {
      const { orchestrator } = makeOrchestrator();
      const trade = await orchestrator.fillCandidate(makeCandidate());
      orchestrator.manageOpenPosition(
        trade,
        c(trade.target - 0.0005, trade.target + 0.0005, trade.target - 0.0005, trade.target)
      );
      expect(orchestrator.lifecycleStateOf(trade.id)).toBe('ARCHIVED');
      const history = orchestrator.lifecycleHistoryOf(trade.id).map((h) => h.to);
      expect(history[history.length - 2]).toBe('CLOSED');
      expect(history[history.length - 1]).toBe('ARCHIVED');
    });

    it('closePosition (manual close) also transitions to CLOSED -> ARCHIVED', async () => {
      const { orchestrator } = makeOrchestrator();
      const trade = await orchestrator.fillCandidate(makeCandidate());
      orchestrator.closePosition(trade, trade.entry, 'manual close');
      expect(orchestrator.lifecycleStateOf(trade.id)).toBe('ARCHIVED');
    });

    it('an untracked id passed to manageOpenPosition resumes gracefully instead of throwing', () => {
      const { orchestrator } = makeOrchestrator();
      const untrackedTrade = {
        id: 'RESUMED-1',
        timestamp: new Date().toISOString(),
        instrument: 'EURUSD',
        timeframe: '15m',
        side: 'LONG' as const,
        entry: 1.1,
        stop: 1.098,
        target: 1.106,
        lotSize: 0.1,
        rMultiple: null,
        status: 'OPEN' as const,
        session: 'London' as const,
        confidence: 0.7,
        strategyVersion: 'test-v1',
        explanation: 'resumed from storage',
      };
      expect(() =>
        orchestrator.manageOpenPosition(untrackedTrade, c(1.099, 1.1005, 1.0985, 1.0995))
      ).not.toThrow();
      expect(orchestrator.lifecycleStateOf('RESUMED-1')).toBe('MANAGING');
    });
  });
});
