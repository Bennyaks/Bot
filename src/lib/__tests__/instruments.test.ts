import { describe, it, expect } from 'vitest';
import { getInstrumentSpec, spreadInPrice, currencyExposureLegs, INSTRUMENT_SPECS } from '../instruments';
import { INSTRUMENTS } from '../data';

describe('lib/instruments', () => {
  it('has a spec for every instrument in the INSTRUMENTS list', () => {
    for (const symbol of INSTRUMENTS) {
      expect(INSTRUMENT_SPECS[symbol]).toBeDefined();
      expect(INSTRUMENT_SPECS[symbol].symbol).toBe(symbol);
    }
  });

  it('falls back to conservative defaults for an unknown symbol instead of throwing', () => {
    const spec = getInstrumentSpec('NOTREAL');
    expect(spec.minLot).toBeGreaterThan(0);
    expect(spec.pipSize).toBeGreaterThan(0);
  });

  it('returns spread in price units proportional to the instrument pip size', () => {
    const eurusdSpread = spreadInPrice('EURUSD');
    const usdjpySpread = spreadInPrice('USDJPY');
    expect(eurusdSpread).toBeGreaterThan(0);
    expect(usdjpySpread).toBeGreaterThan(0);
    // USDJPY pips are 100x the size of EURUSD pips, so even a similar pip
    // spread count should not collapse to the same price-unit magnitude.
    expect(eurusdSpread).not.toBeCloseTo(usdjpySpread, 5);
  });

  it('gives LONG a pair +base/-quote exposure and SHORT the mirror', () => {
    const long = currencyExposureLegs('EURUSD', 'LONG');
    const short = currencyExposureLegs('EURUSD', 'SHORT');
    expect(long).toEqual([
      { currency: 'EUR', sign: 1 },
      { currency: 'USD', sign: -1 },
    ]);
    expect(short).toEqual([
      { currency: 'EUR', sign: -1 },
      { currency: 'USD', sign: 1 },
    ]);
  });

  it('models the classic hidden-correlation case: Long EURUSD + Long GBPUSD + Short USDJPY all lean short USD', () => {
    const legs = [
      ...currencyExposureLegs('EURUSD', 'LONG'),
      ...currencyExposureLegs('GBPUSD', 'LONG'),
      ...currencyExposureLegs('USDJPY', 'SHORT'),
    ];
    const usdNet = legs.filter((l) => l.currency === 'USD').reduce((sum, l) => sum + l.sign, 0);
    expect(usdNet).toBe(-3);
  });
});
