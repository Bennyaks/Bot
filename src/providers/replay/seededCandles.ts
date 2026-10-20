import type { Candle } from '../../lib/types';

/** mulberry32 — small, fast, deterministic PRNG. Same seed always produces the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Same shape as data.ts#generateCandles, but driven by a seeded PRNG instead
 * of Math.random(). Two calls with the same seed/count/base always produce
 * byte-identical candles — this is what makes replay tests (Phase 14)
 * meaningful: "every signal should be reproducible."
 */
export function generateSeededCandles(seed: number, count = 80, base = 1.084): Candle[] {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let price = base;
  const now = 1_700_000_000_000; // fixed epoch so timestamps are also deterministic
  for (let i = count; i >= 0; i--) {
    const drift = (Math.sin(i / 8) + Math.cos(i / 13)) * 0.00035;
    const noise = (rand() - 0.48) * 0.0008;
    const open = price;
    const close = price + drift + noise;
    const high = Math.max(open, close) + rand() * 0.0004;
    const low = Math.min(open, close) - rand() * 0.0004;
    const volume = 800 + rand() * 1400 + (i < 5 ? 900 : 0);
    candles.push({ time: now - i * 15 * 60 * 1000, open, high, low, close, volume });
    price = close;
  }
  return candles;
}
