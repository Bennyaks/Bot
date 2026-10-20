import { describe, it, expect } from 'vitest';
import { isCryptoInstrument, is24_7Market } from './instruments';

describe('isCryptoInstrument', () => {
  it('recognizes common crypto tickers regardless of quote currency suffix', () => {
    expect(isCryptoInstrument('BTCUSD')).toBe(true);
    expect(isCryptoInstrument('BTCUSDT')).toBe(true);
    expect(isCryptoInstrument('ETHUSD')).toBe(true);
    expect(isCryptoInstrument('XRPUSD')).toBe(true);
    expect(isCryptoInstrument('SOLUSDT')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCryptoInstrument('btcusd')).toBe(true);
  });

  it('does not flag standard FX pairs', () => {
    expect(isCryptoInstrument('EURUSD')).toBe(false);
    expect(isCryptoInstrument('GBPUSD')).toBe(false);
    expect(isCryptoInstrument('USDJPY')).toBe(false);
  });
});

describe('is24_7Market', () => {
  it('matches crypto detection (currently the only 24/7 case handled)', () => {
    expect(is24_7Market('BTCUSD')).toBe(true);
    expect(is24_7Market('EURUSD')).toBe(false);
  });
});
