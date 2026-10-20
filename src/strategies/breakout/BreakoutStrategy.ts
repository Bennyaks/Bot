import type { Candle } from '../../lib/types';
import { MarketPipeline, type StructureLevel } from '../../core/pipeline/MarketPipeline';
import { createTradeSignal } from '../../lib/engine';
import { getCurrentSession } from '../../lib/data';
import type { MultiTimeframeCandles, Strategy, TradeCandidate } from '../../core/interfaces';

/**
 * How close a 15M break-of-structure's broken level must sit to the 1H
 * level identified in Step 2 for the 15M event to count as "breaking THAT
 * level" rather than some unrelated, lower-significance level. ~15 pips on
 * a 4-decimal pair — wide enough for clustering/rounding noise between
 * timeframes, narrow enough that it isn't just any bullish/bearish 15M BOS.
 */
const LEVEL_ALIGNMENT_TOLERANCE = 0.0015;

/**
 * strategies/breakout/BreakoutStrategy
 * ---------------------------------------
 * Multi-timeframe alignment, top-down — see docs/multi-timeframe-analysis
 * (the reasoning this was rebuilt around): a higher timeframe is used to
 * understand the bigger picture, a lower timeframe is used to find the
 * precise entry. Every step below can independently say "no trade" and
 * the strategy is comfortable doing nothing — a candidate is only ever
 * produced when ALL FOUR agree:
 *
 *   1. 4H  — market bias (bullish / bearish / ranging). Ranging = no trade,
 *            full stop, regardless of what any lower timeframe shows.
 *   2. 1H  — market structure: the nearest untouched support/resistance
 *            level ahead of price, in the bias direction. No such level =
 *            no trade (nothing meaningful to break yet).
 *   3. 15M — setup: has price actually broken THAT 1H level (not just any
 *            level) with a confirmed candle close, in the bias direction?
 *   4. 5M  — entry confirmation: a retest-and-rejection or a momentum
 *            continuation candle, not just "the 15M breakout happened, so
 *            buy now." Falls back to the 15M series itself when no 5M feed
 *            is available (documented limitation of backtest.ts, which
 *            doesn't pull separate 5M history).
 *
 * This deliberately trades less often than a single-timeframe breakout
 * scan — that is the point. A 15M-only breakout has no way to tell a real
 * trend continuation from noise inside a larger range; requiring 4H/1H
 * agreement is what filters that out.
 */
export class BreakoutStrategy implements Strategy {
  id = 'breakout-strategy';
  version = 'v2.0-mtf';

  constructor(private pipeline: MarketPipeline = new MarketPipeline()) {}

  evaluate(instrument: string, candles: MultiTimeframeCandles): TradeCandidate | null {
    const { h4, h1, m15 } = candles;
    if (h4.length < 10 || h1.length < 10 || m15.length < 10) return null;

    // Step 1 — 4H: market bias. A ranging 4H is explicitly "no bias", never
    // resolved to a coin-flip direction by a lower timeframe.
    const bias = this.pipeline.analyze(h4);
    if (bias.trend === 'ranging') return null;
    const side: 'LONG' | 'SHORT' = bias.trend === 'bullish' ? 'LONG' : 'SHORT';

    // Step 2 — 1H: the nearest untouched structure level ahead of price, in
    // the bias direction — "where the important structure is."
    const h1Structure = this.pipeline.analyze(h1);
    const lastH1Close = h1[h1.length - 1].close;
    const keyLevel =
      side === 'LONG'
        ? nearestLevelAbove(h1Structure.levels, lastH1Close, 'resistance')
        : nearestLevelBelow(h1Structure.levels, lastH1Close, 'support');
    if (!keyLevel) return null;

    // Step 3 — 15M: has price actually broken THAT level, in the bias
    // direction, with a confirmed close? A 15M BOS that breaks some other,
    // unrelated level doesn't count — it isn't the setup the 1H structure
    // said to wait for.
    const m15Structure = this.pipeline.analyze(m15);
    if (!m15Structure.lastBOS) return null;
    const directionMatches =
      (side === 'LONG' && m15Structure.lastBOS.direction === 'bullish') ||
      (side === 'SHORT' && m15Structure.lastBOS.direction === 'bearish');
    if (!directionMatches) return null;
    const breaksKeyLevel = Math.abs(m15Structure.lastBOS.brokenLevel - keyLevel.price) <= LEVEL_ALIGNMENT_TOLERANCE;
    if (!breaksKeyLevel) return null;

    // Step 4 — 5M: confirm the entry itself rather than chasing the 15M
    // breakout candle directly. Uses the 15M series as a fallback when no
    // 5M feed is supplied (see class doc comment).
    const hasM5 = !!candles.m5 && candles.m5.length >= 10;
    const entryCandles = hasM5 ? candles.m5! : m15;
    const entryStructure = hasM5 ? this.pipeline.analyze(candles.m5!) : m15Structure;
    const confirmation = confirmEntry(entryCandles, side);
    if (!confirmation) return null;

    const last = entryCandles[entryCandles.length - 1];
    const entry = last.close;

    const referenceSwing =
      side === 'LONG'
        ? [...entryStructure.swings].reverse().find((s) => s.type === 'low')
        : [...entryStructure.swings].reverse().find((s) => s.type === 'high');
    const risk = referenceSwing ? Math.abs(entry - referenceSwing.price) : Math.abs(entry) * 0.002;
    const safeRisk = risk > 0 ? risk : Math.abs(entry) * 0.002;
    const stop = side === 'LONG' ? entry - safeRisk : entry + safeRisk;

    // Target the next 1H structure level beyond the one just broken, when
    // one exists — an actual liquidity target instead of an arbitrary
    // multiple. Falls back to a fixed 2R when there's no further level, or
    // when the next level is too close to be worth the trade (< 1.5R).
    const minAcceptableTarget = side === 'LONG' ? entry + safeRisk * 1.5 : entry - safeRisk * 1.5;
    const extendedTarget =
      side === 'LONG'
        ? nearestLevelAbove(h1Structure.levels, keyLevel.price, 'resistance')
        : nearestLevelBelow(h1Structure.levels, keyLevel.price, 'support');
    const target =
      extendedTarget && (side === 'LONG' ? extendedTarget.price > minAcceptableTarget : extendedTarget.price < minAcceptableTarget)
        ? extendedTarget.price
        : side === 'LONG'
          ? entry + safeRisk * 2
          : entry - safeRisk * 2;

    const avgVolume = entryCandles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, entryCandles.length);
    const volumeRatio = avgVolume > 0 ? last.volume / avgVolume : 1;
    const confidence = Math.min(
      0.95,
      0.4 +
        Math.min(keyLevel.touches, 4) * 0.07 +
        Math.min(Math.max(volumeRatio - 1, 0), 1) * 0.12 +
        (m15Structure.liquiditySweep ? 0.05 : 0) +
        (confirmation === 'retest' ? 0.06 : 0)
    );

    return createTradeSignal({
      instrument,
      timeframe: hasM5 ? '5m' : '15m',
      side,
      entry,
      stop,
      target,
      confidence,
      session: getCurrentSession(),
      marketRegime: bias.trend === 'bullish' ? 'TRENDING_BULL' : 'TRENDING_BEAR',
      strategyVersion: this.version,
      riskReward: Number((Math.abs(target - entry) / safeRisk).toFixed(2)),
      indicators: {
        volumeRatio: Number(volumeRatio.toFixed(2)),
        h1LevelTouches: keyLevel.touches,
        liquiditySweep: m15Structure.liquiditySweep ? 1 : 0,
      },
      structure:
        `4H ${bias.trend} → 1H ${keyLevel.type} ${keyLevel.price.toFixed(5)} (${keyLevel.touches}x tested) → ` +
        `15M breakout confirmed → ${hasM5 ? '5M' : '15M'} ${confirmation === 'retest' ? 'retest' : 'momentum'} entry`,
      setupStage: 'BOS_CONFIRMED',
    });
  }
}

function nearestLevelAbove(levels: StructureLevel[], price: number, type: 'resistance'): StructureLevel | null {
  const candidates = levels.filter((l) => l.type === type && l.price > price);
  return candidates.length ? candidates.reduce((closest, l) => (l.price < closest.price ? l : closest)) : null;
}

function nearestLevelBelow(levels: StructureLevel[], price: number, type: 'support'): StructureLevel | null {
  const candidates = levels.filter((l) => l.type === type && l.price < price);
  return candidates.length ? candidates.reduce((closest, l) => (l.price > closest.price ? l : closest)) : null;
}

/**
 * Entry-timeframe confirmation gate: either a retest-and-rejection of the
 * breakout (a wick back against the trend that still closes in its favor —
 * "pulled back to the level and held") or a plain momentum continuation
 * candle. Neither present means "the breakout happened on a higher
 * timeframe" is not, by itself, permission to enter right now.
 */
function confirmEntry(candles: Candle[], side: 'LONG' | 'SHORT'): 'retest' | 'momentum' | null {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || !prev) return null;
  const bullishCandle = last.close > last.open;
  const bearishCandle = last.close < last.open;

  if (side === 'LONG' && bullishCandle && last.close > prev.close) return 'momentum';
  if (side === 'SHORT' && bearishCandle && last.close < prev.close) return 'momentum';

  if (side === 'LONG' && last.low < prev.low && bullishCandle) return 'retest';
  if (side === 'SHORT' && last.high > prev.high && bearishCandle) return 'retest';

  return null;
}
