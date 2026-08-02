import type { Candle } from '../../lib/types';
import { createTradeSignal } from '../../lib/engine';
import { getCurrentSession } from '../../lib/data';
import { isNewsBlackout } from '../../lib/newsCalendar';
import { analyzeStructure } from '../../core/market/structure';
import type { Strategy, TradeCandidate } from '../../core/interfaces';

export interface BreakoutStrategyConfig {
  minVolumeRatio: number;
  minRiskReward: number;
  maxBarsSinceBreak: number;
  timeframe: string;
  strategyVersion: string;
}

export const DEFAULT_BREAKOUT_CONFIG: BreakoutStrategyConfig = {
  minVolumeRatio: 1.3,
  minRiskReward: 1.8,
  maxBarsSinceBreak: 3,
  timeframe: '15m',
  strategyVersion: 'breakout-v1',
};

/**
 * strategies/breakout/BreakoutStrategy
 * ---------------------------------------
 * Phase 3. Implements the Strategy contract for real: it only ever
 * produces a TradeCandidate (never places an order, never checks risk).
 * Everything from the candidate onward — Decision Engine gates, Risk
 * Manager veto, execution — is the same pipeline BreakoutStrategy shares
 * with the inline demo generator and the BacktestHarness (Phase 14).
 *
 * Entry logic, in order:
 *   1. Run core/market/structure's analyzeStructure over the window.
 *   2. Require a break within the last `maxBarsSinceBreak` candles — a
 *      stale break is not a live opportunity.
 *   3. Require the breakout candle's volume to expand vs. the trailing
 *      average (`minVolumeRatio`) — the classic "confirmed displacement"
 *      filter this platform's principles call for.
 *   4. Stop goes at the level that was broken (structure invalidation);
 *      target is placed at `minRiskReward` x the resulting risk.
 *
 * Deliberately loose here: BreakoutStrategy proposes optimistically and
 * lets the Decision Engine's independent gates (confidence, reward:risk,
 * session evidence, news) make the actual call — that separation of
 * concerns is the whole point of the architecture.
 */
export class BreakoutStrategy implements Strategy {
  id = 'breakout-strategy';
  version: string;

  constructor(private config: BreakoutStrategyConfig = DEFAULT_BREAKOUT_CONFIG) {
    this.version = config.strategyVersion;
  }

  evaluate(instrument: string, candles: Candle[]): TradeCandidate | null {
    if (candles.length < 10) return null;
    const snapshot = analyzeStructure(candles);
    const brk = snapshot.latestBreak;
    if (!brk) return null;

    const barsSinceBreak = candles.length - 1 - brk.index;
    if (barsSinceBreak > this.config.maxBarsSinceBreak) return null;

    const breakoutCandle = candles[brk.index];
    const volumeRatio = snapshot.averageVolume > 0 ? breakoutCandle.volume / snapshot.averageVolume : 0;
    if (volumeRatio < this.config.minVolumeRatio) return null;

    const side = brk.direction === 'bullish' ? 'LONG' : 'SHORT';
    const entry = candles[candles.length - 1].close;
    const stop = brk.brokenLevel;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    const target = side === 'LONG' ? entry + risk * this.config.minRiskReward : entry - risk * this.config.minRiskReward;

    // Confidence blends breakout freshness and volume expansion — both
    // capped at 1 so a single very-loud bar can't alone justify max
    // confidence; the Decision Engine's own threshold still has final say.
    const freshnessScore = 1 - barsSinceBreak / (this.config.maxBarsSinceBreak + 1);
    const volumeScore = Math.min(volumeRatio / (this.config.minVolumeRatio * 1.5), 1);
    const confidence = Number((0.5 + 0.25 * freshnessScore + 0.25 * volumeScore).toFixed(2));

    // The Decision Engine has a real no_news_event gate, but nothing ever
    // set MarketRegime.NEWS_EVENT for it to catch — every candidate arrived
    // with a trend regime regardless of an active news window. This is the
    // real check: is a medium/high-impact release for this instrument's
    // currencies imminent right now?
    const newsBlackout = isNewsBlackout(instrument);
    const marketRegime = newsBlackout.blocked ? 'NEWS_EVENT' : side === 'LONG' ? 'TRENDING_BULL' : 'TRENDING_BEAR';

    return createTradeSignal({
      instrument,
      timeframe: this.config.timeframe,
      side,
      entry,
      stop,
      target,
      confidence,
      session: getCurrentSession(),
      marketRegime,
      strategyVersion: this.version,
      riskReward: this.config.minRiskReward,
      indicators: {
        volumeRatio: Number(volumeRatio.toFixed(2)),
        averageVolume: Number(snapshot.averageVolume.toFixed(0)),
        barsSinceBreak,
      },
      structure: newsBlackout.blocked
        ? `${brk.kind} ${brk.direction} · broke ${brk.brokenLevel.toFixed(5)} at bar ${brk.index} · blocked by ${newsBlackout.event?.label ?? 'news event'}`
        : `${brk.kind} ${brk.direction} · broke ${brk.brokenLevel.toFixed(5)} at bar ${brk.index}`,
    });
  }
}
