import { describe, it, expect } from 'vitest';
import { BreakoutStrategy } from './BreakoutStrategy';
import { generateSeededCandles } from '../../providers/replay/seededCandles';
import type { Candle } from '../../lib/types';
import type { MultiTimeframeCandles } from '../../core/interfaces';

/** Aggregates `factor` consecutive candles into one OHLCV bar — a real resample, not a random walk. */
function resample(candles: Candle[], factor: number): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

/**
 * Builds a self-consistent multi-timeframe candle set from one seeded 15M
 * series — h4/h1 are real aggregations of the same underlying price path
 * (not independent random walks), so cross-timeframe alignment is possible
 * to exercise meaningfully, the same as it would be against real market
 * data. No m5 feed — these tests exercise the 15M-fallback entry path.
 */
function toMultiTimeframe(seed: number, m15Count = 140): MultiTimeframeCandles {
  const base = generateSeededCandles(seed, 2000);
  return {
    h4: resample(base, 16),
    h1: resample(base, 4),
    m15: base.slice(-m15Count),
  };
}

describe('BreakoutStrategy (multi-timeframe alignment, replay reproducibility)', () => {
  it('produces the same candidate (or the same null) for the same seed', () => {
    const strategy1 = new BreakoutStrategy();
    const strategy2 = new BreakoutStrategy();
    const resultA = strategy1.evaluate('EURUSD', toMultiTimeframe(7));
    const resultB = strategy2.evaluate('EURUSD', toMultiTimeframe(7));

    if (resultA === null || resultB === null) {
      expect(resultA).toBe(resultB);
      return;
    }
    expect(resultA.side).toBe(resultB.side);
    expect(resultA.entry).toBeCloseTo(resultB.entry, 8);
    expect(resultA.stop).toBeCloseTo(resultB.stop, 8);
    expect(resultA.confidence).toBeCloseTo(resultB.confidence, 8);
  });

  it('produces a candidate with entry/stop/target on the correct side of each other, and 4H/1H/15M agreeing on direction', () => {
    let sawCandidate = false;
    for (let seed = 1; seed <= 40; seed++) {
      const result = new BreakoutStrategy().evaluate('EURUSD', toMultiTimeframe(seed));
      if (!result) continue;
      sawCandidate = true;
      if (result.side === 'LONG') {
        expect(result.stop).toBeLessThan(result.entry);
        expect(result.target).toBeGreaterThan(result.entry);
        expect(result.marketRegime).toBe('TRENDING_BULL');
      } else {
        expect(result.stop).toBeGreaterThan(result.entry);
        expect(result.target).toBeLessThan(result.entry);
        expect(result.marketRegime).toBe('TRENDING_BEAR');
      }
      expect(result.riskReward).toBeGreaterThan(0);
      expect(result.structure).toContain('4H');
      expect(result.structure).toContain('1H');
      expect(result.structure).toContain('15M');
    }
    // Alignment across three independent timeframes is a real gate, not a
    // formality — it's fine for most seeds to produce nothing. This just
    // confirms the gate is passable at all, not that it fires constantly.
    expect(sawCandidate).toBe(true);
  });

  it('returns null (SCANNING) rather than a fabricated candidate with too little data on any required timeframe', () => {
    const thin = generateSeededCandles(1, 5); // below the 10-candle minimum
    expect(new BreakoutStrategy().evaluate('EURUSD', { h4: thin, h1: thin, m15: thin })).toBeNull();

    const full = toMultiTimeframe(3);
    expect(new BreakoutStrategy().evaluate('EURUSD', { ...full, h4: thin })).toBeNull();
    expect(new BreakoutStrategy().evaluate('EURUSD', { ...full, h1: thin })).toBeNull();
    expect(new BreakoutStrategy().evaluate('EURUSD', { ...full, m15: thin })).toBeNull();
  });
});
