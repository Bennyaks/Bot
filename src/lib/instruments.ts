import { INSTRUMENTS } from './data';

export type InstrumentSymbol = (typeof INSTRUMENTS)[number];

/**
 * lib/instruments
 * -----------------
 * The platform previously had no per-instrument model at all: lot size was
 * hardcoded to 0.1 everywhere, spread was a single flat number regardless of
 * symbol, and nothing knew which currencies a symbol actually exposes an
 * account to. This file is the single source of truth those subsystems read
 * from — PositionSizer (risk-based sizing), the Decision Engine's spread
 * gate, RiskManager's correlation check, and the Replay/MT5 fill paths.
 *
 * Values are realistic industry-typical approximations for a standard
 * (100,000 unit) lot, not live broker feed data — there is no live feed in
 * this app (see MarketProvider). A real MT5MarketProvider would replace
 * `typicalSpreadPips` with the broker's live quoted spread and
 * `pipValuePerStandardLot` would be computed from the live cross rate
 * instead of hardcoded, but the *shape* of every downstream calculation
 * (risk % -> lots, spread -> net R:R, exposure -> correlation) does not
 * change when that swap happens.
 */
export interface InstrumentSpec {
  symbol: InstrumentSymbol;
  /** Price movement that counts as "1 pip" for this instrument. */
  pipSize: number;
  /** Decimal places typically quoted — used for display only. */
  digits: number;
  /** USD value of a 1-pip move on one standard (1.0) lot. */
  pipValuePerStandardLot: number;
  /** Typical dealing spread in pips, used where no live feed exists. */
  typicalSpreadPips: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  /** Reasonable current-ish price level, used only to seed replay candle generation. */
  basePrice: number;
  /** Relative volatility multiplier applied to replay candle generation (1 = EURUSD-like). */
  volatilityFactor: number;
  /** [base, quote] "currencies" this instrument exposes an account to — used for correlation exposure. */
  currencies: [string, string];
}

export const INSTRUMENT_SPECS: Record<InstrumentSymbol, InstrumentSpec> = {
  EURUSD: {
    symbol: 'EURUSD',
    pipSize: 0.0001,
    digits: 5,
    pipValuePerStandardLot: 10,
    typicalSpreadPips: 1.2,
    minLot: 0.01,
    maxLot: 50,
    lotStep: 0.01,
    basePrice: 1.084,
    volatilityFactor: 1,
    currencies: ['EUR', 'USD'],
  },
  GBPUSD: {
    symbol: 'GBPUSD',
    pipSize: 0.0001,
    digits: 5,
    pipValuePerStandardLot: 10,
    typicalSpreadPips: 1.6,
    minLot: 0.01,
    maxLot: 50,
    lotStep: 0.01,
    basePrice: 1.264,
    volatilityFactor: 1.15,
    currencies: ['GBP', 'USD'],
  },
  USDJPY: {
    symbol: 'USDJPY',
    pipSize: 0.01,
    digits: 3,
    pipValuePerStandardLot: 6.7, // approx at ~150 USDJPY; a live feed would derive this from the current rate
    typicalSpreadPips: 1.4,
    minLot: 0.01,
    maxLot: 50,
    lotStep: 0.01,
    basePrice: 154.8,
    volatilityFactor: 1.05,
    currencies: ['USD', 'JPY'],
  },
  XAUUSD: {
    symbol: 'XAUUSD',
    pipSize: 0.1, // gold is typically quoted to 2dp with the "pip" treated as $0.10
    digits: 2,
    pipValuePerStandardLot: 10, // 100oz contract: a $0.10 move is worth $10 per 1.0 lot
    typicalSpreadPips: 3.5,
    minLot: 0.01,
    maxLot: 20,
    lotStep: 0.01,
    basePrice: 2385,
    volatilityFactor: 3.5,
    currencies: ['XAU', 'USD'],
  },
  NAS100: {
    symbol: 'NAS100',
    pipSize: 1, // 1 index point
    digits: 1,
    pipValuePerStandardLot: 1, // $1 per index point per 1.0 lot (typical CFD sizing)
    typicalSpreadPips: 2.5,
    minLot: 0.1,
    maxLot: 20,
    lotStep: 0.1,
    basePrice: 19200,
    volatilityFactor: 12,
    currencies: ['NAS100', 'USD'],
  },
  BTCUSD: {
    symbol: 'BTCUSD',
    pipSize: 1, // $1 move
    digits: 1,
    pipValuePerStandardLot: 1, // $1 per $1 move per 1.0 lot (i.e. 1 lot = 1 BTC notional)
    typicalSpreadPips: 25,
    minLot: 0.01,
    maxLot: 10,
    lotStep: 0.01,
    basePrice: 64500,
    volatilityFactor: 45,
    currencies: ['BTC', 'USD'],
  },
};

export function getInstrumentSpec(instrument: string): InstrumentSpec {
  const spec = INSTRUMENT_SPECS[instrument as InstrumentSymbol];
  if (spec) return spec;
  // Unknown symbol (e.g. a future addition to INSTRUMENTS without a spec yet) —
  // degrade to conservative EURUSD-like defaults rather than throwing, since a
  // thrown error here would take down the whole candidate pipeline.
  return {
    symbol: instrument as InstrumentSymbol,
    pipSize: 0.0001,
    digits: 5,
    pipValuePerStandardLot: 10,
    typicalSpreadPips: 2,
    minLot: 0.01,
    maxLot: 10,
    lotStep: 0.01,
    basePrice: 1,
    volatilityFactor: 1,
    currencies: [instrument, 'USD'],
  };
}

/** The spread for this instrument expressed in price units (not pips) — what getSpread() should return. */
export function spreadInPrice(instrument: string): number {
  const spec = getInstrumentSpec(instrument);
  return spec.typicalSpreadPips * spec.pipSize;
}

/**
 * Signed currency exposure a single position contributes, for the
 * portfolio-correlation check in RiskManager. LONG a pair = buy the base,
 * sell the quote (+1 base / -1 quote); SHORT is the mirror. This is what
 * lets "Long EURUSD + Long GBPUSD + Short USDJPY" be recognised as one
 * concentrated -3 USD bet instead of three independent 1R risks.
 */
export function currencyExposureLegs(
  instrument: string,
  side: 'LONG' | 'SHORT'
): { currency: string; sign: 1 | -1 }[] {
  const [base, quote] = getInstrumentSpec(instrument).currencies;
  const baseSign: 1 | -1 = side === 'LONG' ? 1 : -1;
  const quoteSign: 1 | -1 = side === 'LONG' ? -1 : 1;
  return [
    { currency: base, sign: baseSign },
    { currency: quote, sign: quoteSign },
  ];
}
