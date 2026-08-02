import { describe, it, expect } from 'vitest';
import { PositionManager } from '../PositionManager';
import type { ExecutedTrade } from '../../../lib/types';

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
    confidence: 0.8,
    strategyVersion: 'breakout-v1',
    explanation: 'test trade',
    ...overrides,
  };
}

describe('PositionManager', () => {
  it('opens and tracks a position', () => {
    const pm = new PositionManager();
    pm.open(makeTrade());
    expect(pm.openPositions().map((p) => p.id)).toEqual(['T1']);
  });

  it('moves the stop to break-even (not all the way to current price) once price reaches +1R', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    pm.open(trade);
    // (1.102-1.1)/(1.1-1.098) = 1R exactly -> break-even sets stop=entry(1.1).
    // Trailing then runs using the *original* 0.002 risk distance (not
    // re-derived from the just-moved stop), so trail = 1.102-0.002 = 1.1,
    // which isn't > the just-set 1.1 stop — it stays at breakeven exactly.
    // (Previously trailing re-derived risk from the post-breakeven stop,
    // which is momentarily 0, collapsing the trail to "stop = current
    // price" — a zero-buffer trail that would stop the trade out on the
    // very next tick of noise.)
    const managed = pm.manage(trade, 1.102);
    expect(managed.stop).toBe(1.1);
  });

  it('does not move the stop while price is still below entry', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    pm.open(trade);
    // Below entry, trailing's trail (price - risk) stays below the original stop, so nothing moves.
    const managed = pm.manage(trade, 1.099);
    expect(managed.stop).toBe(1.098);
  });

  it('trails gradually once price crosses entry but before break-even fires', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    pm.open(trade);
    // Between entry (1.10) and +1R (1.102), break-even hasn't fired yet, so
    // the trailing controller alone moves the stop using the original risk:
    // trail = 1.101 - 0.002 = 1.099, which is above the original 1.098.
    const managed = pm.manage(trade, 1.101);
    expect(managed.stop).toBeCloseTo(1.099, 5);
  });

  it('trails at a constant distance behind price once comfortably past +1R for a LONG', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    pm.open(trade);
    // Break-even sets stop=1.1, then trailing holds the original 0.002 risk
    // distance behind price: trail = 1.104 - 0.002 = 1.102. A real trailing
    // stop keeps a buffer — it should not lock exactly onto the current
    // price, which would stop the trade out on the next tick of noise.
    const managed = pm.manage(trade, 1.104);
    expect(managed.stop).toBeCloseTo(1.102, 5);
  });

  it('mirrors the same constant-distance trailing behavior for a SHORT', () => {
    const pm = new PositionManager();
    const trade = makeTrade({ side: 'SHORT', entry: 1.1, stop: 1.102, target: 1.094 });
    pm.open(trade);
    // (1.1-1.096)/(1.102-1.1) = 2R -> break-even sets stop=1.1, then trailing
    // holds the original 0.002 risk distance: trail = 1.096 + 0.002 = 1.098.
    const managed = pm.manage(trade, 1.096);
    expect(managed.stop).toBeCloseTo(1.098, 5);
  });

  it('closes a position as a WIN and removes it from open positions', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    pm.open(trade);
    const closed = pm.close(trade, 1.106, 'target-hit');
    expect(closed.status).toBe('WIN');
    expect(closed.pnlR).toBe(3); // (1.106-1.1)/(1.1-1.098) = 3R
    expect(pm.openPositions()).toHaveLength(0);
  });

  it('closes a position as a LOSS when the exit is below entry for a LONG', () => {
    const pm = new PositionManager();
    const trade = makeTrade();
    pm.open(trade);
    const closed = pm.close(trade, 1.098, 'stop-hit');
    expect(closed.status).toBe('LOSS');
    expect(closed.pnlR).toBe(-1);
  });
});
