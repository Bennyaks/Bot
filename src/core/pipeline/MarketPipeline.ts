import type { Candle } from '../../lib/types';
import type { EventBus } from '../events/EventBus';

export interface Swing {
  index: number;
  time: number;
  price: number;
  type: 'high' | 'low';
}

export interface StructureLevel {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
}

export interface StructureBreak {
  direction: 'bullish' | 'bearish';
  index: number;
  price: number;
  brokenLevel: number;
}

export type Trend = 'bullish' | 'bearish' | 'ranging';

export interface MarketStructure {
  swings: Swing[];
  levels: StructureLevel[];
  trend: Trend;
  lastBOS: StructureBreak | null;
  lastCHoCH: StructureBreak | null;
  liquiditySweep: boolean;
  validCandleCount: number;
}

/**
 * core/pipeline/MarketPipeline
 * ------------------------------
 * Market Provider -> Tick Validation -> Candle Builder -> Market Structure ->
 * Swing Detection -> Support/Resistance -> Liquidity -> BOS -> CHoCH.
 *
 * Pure analysis over whatever candles a MarketProvider hands it — reusable
 * by every future strategy, not just the breakout engine. Optionally
 * publishes each stage onto the shared EventBus.
 */
export class MarketPipeline {
  constructor(private bus?: EventBus, private fractalWidth = 2) {}

  /** Tick/candle validation: drop anything with non-finite OHLC or non-increasing time. */
  private validate(candles: Candle[]): Candle[] {
    const clean: Candle[] = [];
    let lastTime = -Infinity;
    for (const c of candles) {
      const finite = [c.open, c.high, c.low, c.close, c.volume].every((v) => Number.isFinite(v));
      const ordered = c.high >= c.low && c.time > lastTime;
      if (finite && ordered) {
        clean.push(c);
        lastTime = c.time;
      }
    }
    return clean;
  }

  private detectSwings(candles: Candle[]): Swing[] {
    const w = this.fractalWidth;
    const swings: Swing[] = [];
    for (let i = w; i < candles.length - w; i++) {
      const window = candles.slice(i - w, i + w + 1);
      const c = candles[i];
      if (window.every((k) => k.high <= c.high)) {
        swings.push({ index: i, time: c.time, price: c.high, type: 'high' });
      } else if (window.every((k) => k.low >= c.low)) {
        swings.push({ index: i, time: c.time, price: c.low, type: 'low' });
      }
    }
    return swings;
  }

  /** Cluster nearby swings into support/resistance levels within a small tolerance band. */
  private buildLevels(swings: Swing[], tolerance = 0.0006): StructureLevel[] {
    const levels: StructureLevel[] = [];
    for (const swing of swings) {
      const type = swing.type === 'high' ? 'resistance' : 'support';
      const existing = levels.find((l) => l.type === type && Math.abs(l.price - swing.price) <= tolerance);
      if (existing) {
        existing.touches += 1;
        existing.price = (existing.price + swing.price) / 2;
      } else {
        levels.push({ price: swing.price, type, touches: 1 });
      }
    }
    return levels;
  }

  /** Walk swings in order; a close beyond the last opposite swing is a break of structure. */
  private detectBreaks(
    candles: Candle[],
    swings: Swing[]
  ): { trend: Trend; lastBOS: StructureBreak | null; lastCHoCH: StructureBreak | null } {
    let trend: Trend = 'ranging';
    let lastBOS: StructureBreak | null = null;
    let lastCHoCH: StructureBreak | null = null;

    const highs = swings.filter((s) => s.type === 'high');
    const lows = swings.filter((s) => s.type === 'low');

    for (let i = 0; i < candles.length; i++) {
      const close = candles[i].close;
      const priorHigh = [...highs].reverse().find((s) => s.index < i);
      const priorLow = [...lows].reverse().find((s) => s.index < i);

      if (priorHigh && close > priorHigh.price) {
        const brk: StructureBreak = { direction: 'bullish', index: i, price: close, brokenLevel: priorHigh.price };
        if (trend === 'bearish') {
          lastCHoCH = brk;
        } else {
          lastBOS = brk;
        }
        trend = 'bullish';
      } else if (priorLow && close < priorLow.price) {
        const brk: StructureBreak = { direction: 'bearish', index: i, price: close, brokenLevel: priorLow.price };
        if (trend === 'bullish') {
          lastCHoCH = brk;
        } else {
          lastBOS = brk;
        }
        trend = 'bearish';
      }
    }

    return { trend, lastBOS, lastCHoCH };
  }

  /** A wick pierces a known level and closes back inside it — a liquidity sweep / stop hunt. */
  private detectLiquiditySweep(candles: Candle[], levels: StructureLevel[]): boolean {
    const recent = candles.slice(-10);
    return recent.some((c) =>
      levels.some((l) => {
        if (l.type === 'resistance') return c.high > l.price && c.close < l.price;
        return c.low < l.price && c.close > l.price;
      })
    );
  }

  analyze(candles: Candle[]): MarketStructure {
    const clean = this.validate(candles);
    const swings = this.detectSwings(clean);
    const levels = this.buildLevels(swings);
    const { trend, lastBOS, lastCHoCH } = this.detectBreaks(clean, swings);
    const liquiditySweep = this.detectLiquiditySweep(clean, levels);

    const structure: MarketStructure = {
      swings,
      levels,
      trend,
      lastBOS,
      lastCHoCH,
      liquiditySweep,
      validCandleCount: clean.length,
    };

    if (this.bus) {
      for (const swing of swings) this.bus.emit('SwingDetected', { swing });
      for (const level of levels) this.bus.emit('LevelDetected', { level });
      if (lastBOS) this.bus.emit('BOSDetected', { brk: lastBOS });
      if (lastCHoCH) this.bus.emit('CHoCHDetected', { brk: lastCHoCH });
      if (liquiditySweep) this.bus.emit('LiquiditySweepDetected', { levels });
    }

    return structure;
  }
}
