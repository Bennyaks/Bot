import { describe, it, expect } from 'vitest';
import { PositionSizer } from '../PositionSizer';

describe('PositionSizer', () => {
  it('sizes a wider stop smaller than a tighter stop for the same equity/risk%', () => {
    const sizer = new PositionSizer({ riskPercentPerTrade: 1, maxLotSize: 50 });
    const tightStop = sizer.calculate({ equity: 10_000, entry: 1.085, stop: 1.083, instrument: 'EURUSD' });
    const wideStop = sizer.calculate({ equity: 10_000, entry: 1.085, stop: 1.075, instrument: 'EURUSD' });
    expect(wideStop.lotSize).toBeLessThan(tightStop.lotSize);
  });

  it('risks approximately the target % of equity, not a fixed lot size', () => {
    const sizer = new PositionSizer({ riskPercentPerTrade: 1, maxLotSize: 50 });
    const result = sizer.calculate({ equity: 10_000, entry: 1.085, stop: 1.083, instrument: 'EURUSD' });
    // Target risk is $100 (1% of 10,000) — actual risk should land close to
    // that once rounded to the nearest lot step, not be some unrelated fixed amount.
    expect(result.riskAmountUsd).toBeGreaterThan(50);
    expect(result.riskAmountUsd).toBeLessThan(150);
    expect(result.clamped).toBe(false);
  });

  it('scales position size up as equity grows, for the same stop distance', () => {
    const sizer = new PositionSizer({ riskPercentPerTrade: 1, maxLotSize: 50 });
    const small = sizer.calculate({ equity: 5_000, entry: 1.085, stop: 1.083, instrument: 'EURUSD' });
    const large = sizer.calculate({ equity: 50_000, entry: 1.085, stop: 1.083, instrument: 'EURUSD' });
    expect(large.lotSize).toBeGreaterThan(small.lotSize);
  });

  it('floors at the instrument minimum lot and flags the result as clamped when equity is too small for the stop', () => {
    const sizer = new PositionSizer({ riskPercentPerTrade: 1, maxLotSize: 50 });
    const result = sizer.calculate({ equity: 50, entry: 1.085, stop: 1.083, instrument: 'EURUSD' });
    expect(result.lotSize).toBe(0.01);
    expect(result.clamped).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('caps at maxLotSize even when the risk math would size larger', () => {
    const sizer = new PositionSizer({ riskPercentPerTrade: 50, maxLotSize: 2 });
    const result = sizer.calculate({ equity: 1_000_000, entry: 1.085, stop: 1.084, instrument: 'EURUSD' });
    expect(result.lotSize).toBe(2);
    expect(result.clamped).toBe(true);
  });

  it('widens effective stop distance (and therefore reduces size) when a spread is supplied', () => {
    const sizer = new PositionSizer({ riskPercentPerTrade: 1, maxLotSize: 50 });
    const noSpread = sizer.calculate({ equity: 10_000, entry: 1.085, stop: 1.083, instrument: 'EURUSD' });
    const withSpread = sizer.calculate({
      equity: 10_000,
      entry: 1.085,
      stop: 1.083,
      instrument: 'EURUSD',
      spread: 0.0005,
    });
    expect(withSpread.stopDistance).toBeGreaterThan(noSpread.stopDistance);
    expect(withSpread.lotSize).toBeLessThanOrEqual(noSpread.lotSize);
  });

  it('fails safe to the instrument minimum lot on a zero-distance stop instead of dividing by zero', () => {
    const sizer = new PositionSizer();
    const result = sizer.calculate({ equity: 10_000, entry: 1.085, stop: 1.085, instrument: 'EURUSD' });
    expect(result.lotSize).toBe(0.01);
    expect(result.clamped).toBe(true);
    expect(Number.isFinite(result.lotSize)).toBe(true);
  });

  it('sizes very differently across instruments with different pip values (XAUUSD vs EURUSD)', () => {
    const sizer = new PositionSizer({ riskPercentPerTrade: 1, maxLotSize: 50 });
    const eurusd = sizer.calculate({ equity: 10_000, entry: 1.085, stop: 1.083, instrument: 'EURUSD' });
    const xauusd = sizer.calculate({ equity: 10_000, entry: 2385, stop: 2375, instrument: 'XAUUSD' });
    expect(eurusd.lotSize).not.toBe(xauusd.lotSize);
    expect(eurusd.riskAmountUsd).toBeGreaterThan(0);
    expect(xauusd.riskAmountUsd).toBeGreaterThan(0);
  });
});
