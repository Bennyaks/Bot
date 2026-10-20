import { generateCandles } from '../../lib/data';
import type { Candle } from '../../lib/types';
import type { MarketProvider } from '../../core/interfaces';

/**
 * providers/replay/ReplayMarketProvider
 * ---------------------------------------
 * Simulated candle stream used for the dashboard demo and for replay
 * testing (Phase 14). A future providers/mt5/MT5MarketProvider or
 * providers/metaapi/MetaApiMarketProvider implements the same
 * MarketProvider contract — nothing downstream (Market Pipeline, Strategy,
 * Decision Engine) needs to know which one is wired in.
 */
export class ReplayMarketProvider implements MarketProvider {
  id = 'replay-provider';

  getCandles(instrument: string, timeframe: string, count: number): Candle[] {
    void instrument;
    void timeframe;
    return generateCandles(count);
  }

  getSpread(instrument: string): number {
    void instrument;
    return 0.00012;
  }

  subscribe(instrument: string, onCandle: (candle: Candle) => void): () => void {
    void instrument;
    const interval = setInterval(() => {
      const [latest] = generateCandles(1);
      onCandle(latest);
    }, 15_000);
    return () => clearInterval(interval);
  }
}
