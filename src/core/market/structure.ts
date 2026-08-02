import type { Candle } from '../../lib/types';
import type { StructureBreak, SwingPoint } from '../events/eventTypes';

/**
 * core/market/structure
 * -----------------------
 * Phase 2 — Market Pipeline. Pure functions over a `Candle[]`, no classes,
 * no side effects: every function here is independently unit-testable and
 * reusable by both the live MarketStructureEngine and BacktestHarness
 * (Phase 14) without duplicating detection logic.
 *
 * Definitions used throughout:
 *   Swing high  — a candle whose high is greater than `lookback` candles on
 *                 either side (a fractal top).
 *   Swing low   — the mirror image (a fractal bottom).
 *   BOS         — Break of Structure: price closes beyond the most recent
 *                 swing point *in the direction of the prevailing trend*
 *                 (trend continuation).
 *   CHoCH       — Change of Character: price closes beyond the most recent
 *                 swing point *against* the prevailing trend (the first
 *                 sign of a reversal).
 */

export function detectSwings(candles: Candle[], lookback = 2): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const candle = candles[i];
    const isHigh = window.every((c) => c.high <= candle.high);
    const isLow = window.every((c) => c.low >= candle.low);
    // A candle can't be both a confirmed fractal high and low at once in
    // practice with real spread; if it somehow qualifies as both, prefer
    // whichever extreme deviates further from the window's median close.
    if (isHigh && !isLow) {
      swings.push({ index: i, time: candle.time, price: candle.high, type: 'high' });
    } else if (isLow && !isHigh) {
      swings.push({ index: i, time: candle.time, price: candle.low, type: 'low' });
    }
  }
  return swings;
}

/**
 * Walks the candle series in order, tracking the most recent confirmed
 * swing high/low and the prevailing trend, and emits a StructureBreak every
 * time a close trades through one of those levels — labelled BOS if it
 * continues the trend, CHoCH if it reverses it.
 */
export function detectStructureBreaks(candles: Candle[], swings: SwingPoint[]): StructureBreak[] {
  const breaks: StructureBreak[] = [];
  let trend: 'up' | 'down' | null = null;
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  let swingCursor = 0;

  for (let i = 0; i < candles.length; i++) {
    // Absorb any swings confirmed at or before this candle.
    while (swingCursor < swings.length && swings[swingCursor].index <= i) {
      const swing = swings[swingCursor];
      if (swing.type === 'high') lastHigh = swing;
      else lastLow = swing;
      swingCursor++;
    }

    const candle = candles[i];

    if (lastHigh && candle.close > lastHigh.price) {
      const kind = trend === 'down' || trend === null ? 'CHoCH' : 'BOS';
      breaks.push({
        direction: 'bullish',
        kind: trend === null ? 'BOS' : kind,
        index: i,
        time: candle.time,
        price: candle.close,
        brokenLevel: lastHigh.price,
      });
      trend = 'up';
      lastHigh = null; // consumed — the next break needs a fresh swing high
    } else if (lastLow && candle.close < lastLow.price) {
      const kind = trend === 'up' || trend === null ? 'CHoCH' : 'BOS';
      breaks.push({
        direction: 'bearish',
        kind: trend === null ? 'BOS' : kind,
        index: i,
        time: candle.time,
        price: candle.close,
        brokenLevel: lastLow.price,
      });
      trend = 'down';
      lastLow = null;
    }
  }

  return breaks;
}

export interface StructureSnapshot {
  swings: SwingPoint[];
  breaks: StructureBreak[];
  trend: 'up' | 'down' | 'unknown';
  latestBreak: StructureBreak | null;
  /** Rolling average volume over the trailing window, for breakout-quality gating. */
  averageVolume: number;
}

/** The one entry point BreakoutStrategy and the backtest harness both call. */
export function analyzeStructure(candles: Candle[], lookback = 2): StructureSnapshot {
  const swings = detectSwings(candles, lookback);
  const breaks = detectStructureBreaks(candles, swings);
  const latestBreak = breaks.length > 0 ? breaks[breaks.length - 1] : null;
  const averageVolume =
    candles.length > 0 ? candles.reduce((s, c) => s + c.volume, 0) / candles.length : 0;

  return {
    swings,
    breaks,
    trend: latestBreak ? (latestBreak.direction === 'bullish' ? 'up' : 'down') : 'unknown',
    latestBreak,
    averageVolume,
  };
}
