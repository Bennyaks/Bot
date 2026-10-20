import { describe, it, expect } from 'vitest';
import { PositionManager } from './PositionManager';
import type { ExecutedTrade } from '../../lib/types';

function longTrade(): ExecutedTrade {
  return {
    id: 'T-LONG',
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
  };
}

describe('PositionManager', () => {
  it('moves stop to break-even once price reaches 1R in profit', () => {
    const pm = new PositionManager();
    const trade = longTrade();
    pm.open(trade);
    // risk = entry(1.26) - stop(1.258) = 0.002; 1R profit = 1.262 exactly
    const managed = pm.manage(trade, 1.262);
    expect(managed.stop).toBeCloseTo(trade.entry, 5);
  });

  it('does not move the stop before 1R profit', () => {
    const pm = new PositionManager();
    const trade = longTrade();
    pm.open(trade);
    const managed = pm.manage(trade, 1.2605);
    expect(managed.stop).toBeCloseTo(trade.stop, 5);
  });

  it('trails the stop upward as price advances beyond break-even', () => {
    const pm = new PositionManager();
    const trade = longTrade();
    pm.open(trade);
    let managed = pm.manage(trade, 1.2625); // triggers break-even
    managed = pm.manage(managed, 1.2645); // trail: 1.2645 - 0.002 = 1.2625
    expect(managed.stop).toBeGreaterThan(trade.entry);
  });

  it('computes a positive R-multiple when closed at target', () => {
    const pm = new PositionManager();
    const trade = longTrade();
    pm.open(trade);
    const closed = pm.close(trade, trade.target, 'target reached');
    expect(closed.status).toBe('WIN');
    expect(closed.pnlR).toBeCloseTo(2, 1); // (1.264-1.26)/(1.26-1.258) = 2R
  });

  it('computes a negative R-multiple when closed at stop', () => {
    const pm = new PositionManager();
    const trade = longTrade();
    pm.open(trade);
    const closed = pm.close(trade, trade.stop, 'stop hit');
    expect(closed.status).toBe('LOSS');
    expect(closed.pnlR).toBeCloseTo(-1, 1);
  });

  it('removes a position from openPositions() once closed', () => {
    const pm = new PositionManager();
    const trade = longTrade();
    pm.open(trade);
    expect(pm.openPositions()).toHaveLength(1);
    pm.close(trade, trade.target, 'target reached');
    expect(pm.openPositions()).toHaveLength(0);
  });
});
