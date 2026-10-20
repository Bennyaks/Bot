import { describe, it, expect } from 'vitest';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy';
import { generateCandles } from '../lib/data';
import { getInstrumentSpec } from '../lib/instruments';

describe('probe', () => {
  it('checks how often BreakoutStrategy finds a setup on synthetic data (fresh 300-candle series)', () => {
    const strategy = new BreakoutStrategy();
    let hits = 0;
    const trials = 300;
    for (let i = 0; i < trials; i++) {
      const spec = getInstrumentSpec('EURUSD');
      const candles = generateCandles(300, spec.basePrice, spec.volatilityFactor);
      const candidate = strategy.evaluate('EURUSD', candles);
      if (candidate) hits++;
    }
    console.log(`hits: ${hits} / ${trials} = ${((hits / trials) * 100).toFixed(1)}%`);
    expect(true).toBe(true);
  });

  it('checks a 6-instrument scan (like runMarketScan) — how often at least one instrument fires', () => {
    const strategy = new BreakoutStrategy();
    const instruments = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'NAS100', 'BTCUSD'];
    let scansWithAtLeastOneHit = 0;
    const scanTrials = 100;
    for (let s = 0; s < scanTrials; s++) {
      let anyHit = false;
      for (const inst of instruments) {
        const spec = getInstrumentSpec(inst);
        const candles = generateCandles(150, spec.basePrice, spec.volatilityFactor);
        if (strategy.evaluate(inst, candles)) anyHit = true;
      }
      if (anyHit) scansWithAtLeastOneHit++;
    }
    console.log(`scans with >=1 hit: ${scansWithAtLeastOneHit} / ${scanTrials}`);
    expect(true).toBe(true);
  });

  it('checks incremental replay-style growth (like replayTryOpenTrade)', () => {
    const strategy = new BreakoutStrategy();
    const spec = getInstrumentSpec('EURUSD');
    const full = generateCandles(300, spec.basePrice, spec.volatilityFactor);
    let hits = 0;
    for (let end = 10; end <= full.length; end++) {
      const window = full.slice(0, end).slice(-150);
      if (strategy.evaluate('EURUSD', window)) hits++;
    }
    console.log(`incremental hits: ${hits} / ${full.length - 10} bars had a fresh qualifying setup`);
    expect(true).toBe(true);
  });
});
