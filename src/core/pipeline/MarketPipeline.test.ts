import { describe, it, expect } from 'vitest';
import { MarketPipeline } from './MarketPipeline';
import { generateSeededCandles } from '../../providers/replay/seededCandles';
import type { Candle } from '../../lib/types';

function candle(overrides: Partial<Candle>): Candle {
  return { time: 0, open: 1, high: 1, low: 1, close: 1, volume: 100, ...overrides };
}

describe('MarketPipeline', () => {
  it('detects an uptrend BOS when price closes above a prior swing high', () => {
    // A clean staircase up: swing high forms (needs 2 candles either side to
    // register with the default 2-bar fractal width), then a later candle
    // closes above it.
    const candles: Candle[] = [
      candle({ time: 0, open: 0.99, high: 0.995, low: 0.985, close: 0.99 }),
      candle({ time: 1, open: 0.99, high: 1.0, low: 0.985, close: 1.0 }),
      candle({ time: 2, open: 1.0, high: 1.02, low: 1.0, close: 1.01 }), // swing high @1.02
      candle({ time: 3, open: 1.01, high: 1.01, low: 0.995, close: 1.0 }),
      candle({ time: 4, open: 1.0, high: 1.005, low: 0.995, close: 1.0 }),
      candle({ time: 5, open: 1.0, high: 1.03, low: 1.0, close: 1.03 }), // closes above 1.02 swing high -> BOS
      candle({ time: 6, open: 1.03, high: 1.035, low: 1.02, close: 1.03 }),
      candle({ time: 7, open: 1.03, high: 1.033, low: 1.02, close: 1.025 }),
    ];
    const pipeline = new MarketPipeline();
    const structure = pipeline.analyze(candles);
    expect(structure.trend).toBe('bullish');
    expect(structure.lastBOS).not.toBeNull();
    expect(structure.lastBOS?.direction).toBe('bullish');
  });

  it('drops invalid candles during tick validation', () => {
    const candles: Candle[] = [
      candle({ time: 1, close: 1.0 }),
      candle({ time: 2, close: NaN }), // invalid — dropped
      candle({ time: 1, close: 1.01 }), // non-increasing time — dropped
      candle({ time: 3, close: 1.02 }),
    ];
    const pipeline = new MarketPipeline();
    const structure = pipeline.analyze(candles);
    expect(structure.validCandleCount).toBe(2);
  });

  it('produces byte-identical structure for the same seed (reproducibility)', () => {
    const a = generateSeededCandles(42, 100);
    const b = generateSeededCandles(42, 100);
    expect(a).toEqual(b);

    const pipeline1 = new MarketPipeline();
    const pipeline2 = new MarketPipeline();
    const structureA = pipeline1.analyze(a);
    const structureB = pipeline2.analyze(b);

    expect(structureA.trend).toBe(structureB.trend);
    expect(structureA.swings.length).toBe(structureB.swings.length);
    expect(structureA.lastBOS).toEqual(structureB.lastBOS);
  });

  it('produces different candles for different seeds', () => {
    const a = generateSeededCandles(1, 50);
    const b = generateSeededCandles(2, 50);
    expect(a).not.toEqual(b);
  });
});
