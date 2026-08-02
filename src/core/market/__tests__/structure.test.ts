import { describe, it, expect } from 'vitest';
import { detectSwings, detectStructureBreaks, analyzeStructure } from '../structure';
import type { Candle } from '../../../lib/types';

/** Build a simple candle from OHLC with a synthetic time and flat volume. */
function c(open: number, high: number, low: number, close: number, i: number, volume = 1000): Candle {
  return { time: i * 60_000, open, high, low, close, volume };
}

describe('detectSwings', () => {
  it('finds a fractal swing high in the middle of a peak', () => {
    // Prices rise to a peak at index 4 then fall — index 4 should be a swing high.
    const candles = [1, 2, 3, 4, 5, 4, 3, 2, 1].map((p, i) => c(p, p + 0.1, p - 0.1, p, i));
    const swings = detectSwings(candles, 2);
    const highs = swings.filter((s) => s.type === 'high');
    expect(highs.some((s) => s.index === 4)).toBe(true);
  });

  it('finds a fractal swing low in the middle of a trough', () => {
    const candles = [5, 4, 3, 2, 1, 2, 3, 4, 5].map((p, i) => c(p, p + 0.1, p - 0.1, p, i));
    const swings = detectSwings(candles, 2);
    const lows = swings.filter((s) => s.type === 'low');
    expect(lows.some((s) => s.index === 4)).toBe(true);
  });

  it('finds nothing on a monotonic series (no fractal turning points)', () => {
    const candles = [1, 2, 3, 4, 5, 6, 7].map((p, i) => c(p, p + 0.1, p - 0.1, p, i));
    expect(detectSwings(candles, 2)).toHaveLength(0);
  });
});

describe('detectStructureBreaks', () => {
  it('labels the first break off a fresh swing as BOS, not CHoCH', () => {
    // Rise to a peak (swing high at 4), pull back, then break above it.
    const prices = [1, 2, 3, 4, 5, 4, 3, 4, 5, 6];
    const candles = prices.map((p, i) => c(p, p + 0.1, p - 0.1, p, i));
    const swings = detectSwings(candles, 2);
    const breaks = detectStructureBreaks(candles, swings);
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[0].kind).toBe('BOS');
    expect(breaks[0].direction).toBe('bullish');
  });

  it('labels a reversal against the prevailing trend as CHoCH', () => {
    // Rise, pull back, break out bullish (BOS, trend -> up), rise to a new
    // peak, pull back again, then break back down through that pullback's
    // low — that second break reverses the established uptrend, so it must
    // read as CHoCH, not BOS.
    const prices = [1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 3, 4, 3, 2, 1, 0];
    const candles = prices.map((p, i) => c(p, p + 0.1, p - 0.1, p, i));
    const swings = detectSwings(candles, 2);
    const breaks = detectStructureBreaks(candles, swings);

    expect(breaks[0].kind).toBe('BOS');
    expect(breaks[0].direction).toBe('bullish');

    const bearishBreaks = breaks.filter((b) => b.direction === 'bearish');
    expect(bearishBreaks.length).toBeGreaterThan(0);
    expect(bearishBreaks[0].kind).toBe('CHoCH');
  });
});

describe('analyzeStructure', () => {
  it('reports the trend as the direction of the most recent break', () => {
    const prices = [1, 2, 3, 4, 5, 4, 3, 4, 5, 6];
    const candles = prices.map((p, i) => c(p, p + 0.1, p - 0.1, p, i));
    const snapshot = analyzeStructure(candles);
    expect(snapshot.trend).toBe('up');
    expect(snapshot.latestBreak?.direction).toBe('bullish');
  });

  it('reports unknown trend and no break when the series is flat', () => {
    const candles = Array.from({ length: 10 }, (_, i) => c(1, 1.01, 0.99, 1, i));
    const snapshot = analyzeStructure(candles);
    expect(snapshot.trend).toBe('unknown');
    expect(snapshot.latestBreak).toBeNull();
  });

  it('computes average volume across the window', () => {
    const candles = [c(1, 1.1, 0.9, 1, 0, 1000), c(1, 1.1, 0.9, 1, 1, 2000)];
    const snapshot = analyzeStructure(candles);
    expect(snapshot.averageVolume).toBe(1500);
  });
});
