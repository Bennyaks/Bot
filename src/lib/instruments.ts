/**
 * lib/instruments
 * ------------------
 * A pragmatic heuristic, not a broker-verified symbol list: recognizes
 * common crypto tickers by prefix so the Decision Engine can tell a 24/7
 * market (crypto) apart from a session-based one (FX). Broker symbol
 * naming varies (BTCUSD, BTCUSDT, XBTUSD, ...), so this matches on the
 * base ticker rather than the whole symbol string.
 */
const KNOWN_CRYPTO_TICKERS = [
  'BTC', 'XBT', 'ETH', 'XRP', 'LTC', 'SOL', 'ADA', 'DOGE', 'BNB', 'DOT',
  'MATIC', 'AVAX', 'LINK', 'TRX', 'SHIB', 'ATOM', 'XLM', 'UNI', 'ETC', 'BCH',
];

export function isCryptoInstrument(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  return KNOWN_CRYPTO_TICKERS.some((ticker) => upper.startsWith(ticker));
}

/**
 * Whether this instrument trades continuously with no session structure.
 * Crypto is the common case; a real system might extend this for certain
 * commodities, but FX sessions (Asian/London/NewYork) genuinely don't apply
 * to crypto, so gates that reason about "session evidence" should skip it
 * for these instruments rather than reject every crypto candidate outright.
 */
export function is24_7Market(symbol: string): boolean {
  return isCryptoInstrument(symbol);
}
