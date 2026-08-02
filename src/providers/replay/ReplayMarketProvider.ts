import { generateCandles } from '../../lib/data';
import { getInstrumentSpec, spreadInPrice } from '../../lib/instruments';
import type { Candle } from '../../lib/types';
import type { MarketProvider } from '../../core/interfaces';

/**
 * providers/replay/ReplayMarketProvider
 * ---------------------------------------
 * Simulated candle stream used for the dashboard demo and for replay
 * testing (Phase 14). A future providers/mt5/MT5MarketProvider implements
 * the same MarketProvider contract — nothing downstream (Market Pipeline,
 * Strategy, Decision Engine) needs to know which one is wired in.
 *
 * Previously both getCandles() and getSpread() ignored the `instrument`
 * argument entirely — every symbol produced the same EURUSD-shaped series
 * and the same flat spread, so scanning USDJPY or XAUUSD showed data that
 * had nothing to do with that instrument. Both now read from
 * lib/instruments' per-symbol spec (base price, volatility, typical
 * spread), so different instruments actually look and cost differently.
 */
export class ReplayMarketProvider implements MarketProvider {
  id = 'replay-provider';

  getCandles(instrument: string, timeframe: string, count: number): Candle[] {
    void timeframe;
    const spec = getInstrumentSpec(instrument);
    return generateCandles(count, spec.basePrice, spec.volatilityFactor);
  }

  getSpread(instrument: string): number {
    return spreadInPrice(instrument);
  }

  subscribe(instrument: string, onCandle: (candle: Candle) => void): () => void {
    const spec = getInstrumentSpec(instrument);
    const interval = setInterval(() => {
      const [latest] = generateCandles(1, spec.basePrice, spec.volatilityFactor);
      onCandle(latest);
    }, 15_000);
    return () => clearInterval(interval);
  }
}
