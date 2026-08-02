import type { EventBus } from '../events/EventBus';
import type { MarketProvider } from '../interfaces';
import { analyzeStructure, type StructureSnapshot } from './structure';

/**
 * core/market/MarketStructureEngine
 * ------------------------------------
 * Phase 2 — Market Pipeline. The stateful wrapper around the pure
 * `analyzeStructure` function: it owns pulling candles from a
 * MarketProvider, publishing SwingDetected/BreakoutDetected onto the
 * EventBus, and handing the latest StructureSnapshot to whatever strategy
 * asks for it (BreakoutStrategy, Phase 3).
 *
 * It depends only on the MarketProvider interface, so ReplayMarketProvider
 * today and a future MT5MarketProvider tomorrow both work unchanged.
 */
export class MarketStructureEngine {
  private lastEmittedBreakIndex = new Map<string, number>();

  constructor(
    private market: MarketProvider,
    private bus: EventBus
  ) {}

  /** Pull the latest candles for an instrument/timeframe and analyze structure over them. */
  scan(instrument: string, timeframe: string, count = 120): StructureSnapshot {
    const candles = this.market.getCandles(instrument, timeframe, count);
    const snapshot = analyzeStructure(candles);

    for (const swing of snapshot.swings.slice(-3)) {
      this.bus.emit('SwingDetected', { instrument, timeframe, swing });
    }

    const key = `${instrument}:${timeframe}`;
    const lastEmitted = this.lastEmittedBreakIndex.get(key) ?? -1;
    for (const structureBreak of snapshot.breaks) {
      if (structureBreak.index <= lastEmitted) continue;
      this.bus.emit('BreakoutDetected', { instrument, timeframe, structureBreak });
    }
    if (snapshot.latestBreak) {
      this.lastEmittedBreakIndex.set(key, snapshot.latestBreak.index);
    }

    return snapshot;
  }
}
