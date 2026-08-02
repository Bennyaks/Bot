import { describe, it, expect } from 'vitest';
import { advancePosition } from '../PositionLifecycle';
import { PositionManager } from '../PositionManager';
import type { ExecutedTrade, Candle } from '../../../lib/types';

function makeTrade(overrides: Partial<ExecutedTrade> = {}): ExecutedTrade {
  return {
    id: 'T1',
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
    confidence: 0.7,
    strategyVersion: 'test-v1',
    explanation: 'test',
    ...overrides,
  };
}

function c(open: number, high: number, low: number, close: number, time = 0): Candle {
  return { time, open, high, low, close, volume: 1000 };
}

describe('advancePosition', () => {
  it('leaves an open trade untouched when price stays inside stop/target and below entry (no breakeven or trailing trigger)', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    const result = advancePosition(trade, c(1.099, 1.1005, 1.0985, 1.0995), pm);
    expect(result.closed).toBe(false);
    expect(result.trade.status).toBe('OPEN');
    expect(result.trade.stop).toBe(1.098);
  });

  it('moves the stop to breakeven and logs a MOVE_STOP action once price reaches 1R, without closing', () => {
    const pm = new PositionManager();
    const trade = makeTrade(); // risk = 0.002, so 1R = 1.102
    const result = advancePosition(trade, c(1.1, 1.1025, 1.101, 1.102), pm);
    expect(result.closed).toBe(false);
    expect(result.trade.stop).toBe(1.1); // moved to entry
    expect(result.actions).toContainEqual(
      expect.objectContaining({ type: 'MOVE_STOP', to: 1.1, reason: 'breakeven' })
    );
  });

  it('closes at target and reports reason "target"', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    const result = advancePosition(trade, c(1.105, 1.107, 1.1049, 1.1065), pm);
    expect(result.closed).toBe(true);
    expect(result.trade.status).toBe('WIN');
    expect(result.trade.exitPrice).toBe(trade.target);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'CLOSE', reason: 'target' }));
  });

  it('closes at the original stop and reports reason "stop" when the stop never moved', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    const result = advancePosition(trade, c(1.099, 1.0995, 1.0975, 1.098), pm);
    expect(result.closed).toBe(true);
    expect(result.trade.status).toBe('LOSS');
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'CLOSE', reason: 'stop' }));
  });

  it('labels a stop-out as "trailing-stop" (not a loss-labelled "stop") when the stop had moved in the trader\'s favor', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    // Bar 1: price runs to 1R, breakeven kicks in (stop -> 1.1).
    const afterBreakeven = advancePosition(trade, c(1.1, 1.1025, 1.101, 1.102), pm, { initialStop: 1.098 });
    expect(afterBreakeven.closed).toBe(false);
    expect(afterBreakeven.trade.stop).toBe(1.1);

    // Bar 2: price pulls back and hits the now-moved stop at breakeven.
    const afterStopOut = advancePosition(afterBreakeven.trade, c(1.1015, 1.1015, 1.0995, 1.1), pm, {
      initialStop: 1.098, // the *original* stop at entry, not the moved one
    });
    expect(afterStopOut.closed).toBe(true);
    expect(afterStopOut.trade.exitPrice).toBe(1.1);
    expect(afterStopOut.actions).toContainEqual(
      expect.objectContaining({ type: 'CLOSE', reason: 'trailing-stop' })
    );
    // Breakeven exit should not itself register as a LOSS.
    expect(afterStopOut.trade.status).not.toBe('LOSS');
  });

  it('force-closes on timeout at the bar close price when neither stop nor target is hit', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    const result = advancePosition(trade, c(1.1005, 1.101, 1.1, 1.1008), pm, {
      entryIndex: 0,
      barIndex: 30,
      maxHoldBars: 30,
    });
    expect(result.closed).toBe(true);
    expect(result.trade.exitPrice).toBe(1.1008);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'CLOSE', reason: 'timeout' }));
  });

  it('does not time out before maxHoldBars is reached', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    const result = advancePosition(trade, c(1.1005, 1.101, 1.1, 1.1008), pm, {
      entryIndex: 0,
      barIndex: 5,
      maxHoldBars: 30,
    });
    expect(result.closed).toBe(false);
  });

  it('applies the same logic symmetrically for a SHORT trade', () => {
    const pm = new PositionManager();
    const trade = makeTrade({ side: 'SHORT', entry: 1.1, stop: 1.102, target: 1.094 });
    const result = advancePosition(trade, c(1.0945, 1.095, 1.0935, 1.0938), pm);
    expect(result.closed).toBe(true);
    expect(result.trade.status).toBe('WIN');
    expect(result.trade.exitPrice).toBe(1.094);
  });
});
