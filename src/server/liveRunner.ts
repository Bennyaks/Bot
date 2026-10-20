/**
 * server/liveRunner
 * --------------------
 * Runs the platform standalone (Node, no browser) against a real broker via
 * MetaApiBroker. This is what "independent on its own, relying on data from
 * an integrated broker" means concretely: the Decision Engine, Risk Manager,
 * Position Manager, and BreakoutStrategy are the exact same classes used by
 * the dashboard — this file just wires them to a live data/execution source
 * instead of ReplayMarketProvider + PaperBroker, and drops the UI entirely.
 *
 * Run with:  npm run live
 * Required env vars: METAAPI_TOKEN, METAAPI_ACCOUNT_ID
 * Optional:
 *   METAAPI_WATCHLIST     comma-separated instruments to scan each cycle
 *                         (default EURUSD,GBPUSD,USDJPY) — "finds a
 *                         favorable market" means: scans all of these every
 *                         cycle, only surfaces the ones that actually clear
 *                         every gate.
 *   METAAPI_POLL_SECONDS  how often to scan (default 60)
 *   METAAPI_RISK_PERCENT  risk this % of equity per trade (e.g. "1" for 1%),
 *                         sized off each trade's own stop distance instead
 *                         of a flat lot size — see core/risk/PositionSizer.ts.
 *                         When unset, falls back to METAAPI_LOT_SIZE (default 0.01).
 *   METAAPI_LOT_SIZE      flat lot size per trade — ignored if METAAPI_RISK_PERCENT is set.
 *   AUTO_CONFIRM          "true" to fire approved trades immediately with no
 *                         prompt. Default is "false" — every approved trade
 *                         waits for you to type y/n in this terminal before
 *                         it's actually sent to the broker.
 *
 * PROTECTION: every fill sent by MetaApiBroker.submitAsync() already carries
 * a broker-side stop-loss, take-profit, AND a native MT5 trailing stop (see
 * providers/metaapi/MetaApiBroker.ts). Those live on MetaApi's hosted MT5
 * terminal, not in this process — if your power or internet drops, the
 * position is still protected and will still close itself at target or
 * trail in your favor. This script only needs to be running to find NEW
 * trades, not to protect ones already open.
 *
 * SECURITY: this file reads credentials from plain process.env, not Vite's
 * import.meta.env — it must never be imported by browser code. Vite only
 * bundles files actually imported by the app; this one is invoked directly
 * by Node (via tsx) and is never pulled into the client build.
 */
import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { MetaApiBroker } from '../providers/metaapi/MetaApiBroker';
import { MarketPipeline } from '../core/pipeline/MarketPipeline';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy';
import { SystemOrchestrator } from '../core/orchestrator/SystemOrchestrator';
import { ConnectionManager } from '../core/reliability/ConnectionManager';
import { computeSessionMetrics } from '../core/analytics/sessionPerformance';
import type { ExecutedTrade } from '../lib/types';
import type { Notifier } from '../core/interfaces';

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const watchlist = (process.env.METAAPI_WATCHLIST ?? 'EURUSD,GBPUSD,USDJPY').split(',').map((s) => s.trim());
const pollSeconds = Number(process.env.METAAPI_POLL_SECONDS ?? 60);
const riskPercentEnv = process.env.METAAPI_RISK_PERCENT ? Number(process.env.METAAPI_RISK_PERCENT) / 100 : undefined;
const lotSizeEnv = process.env.METAAPI_LOT_SIZE ? Number(process.env.METAAPI_LOT_SIZE) : undefined;
/** Same rule liveTradingManager.ts uses: a trade's own risk distance is the fairest yardstick for "spread too wide right now" — a fixed pip number means nothing across instruments with very different typical stop sizes. */
const MAX_SPREAD_FRACTION_OF_RISK = 0.15;
const autoConfirm = (process.env.AUTO_CONFIRM ?? 'false').toLowerCase() === 'true';

if (!token || !accountId) {
  console.error('Missing METAAPI_TOKEN or METAAPI_ACCOUNT_ID. Copy .env.example to .env and fill both in.');
  process.exit(1);
}

const notifier: Notifier = {
  log: (entry) => {
    const stamp = new Date(entry.timestamp).toISOString().slice(11, 19);
    console.log(`[${stamp}] ${entry.level.padEnd(6)} ${entry.module.padEnd(16)} ${entry.message}`);
  },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  const broker = new MetaApiBroker({ token: token!, accountId: accountId!, defaultVolume: lotSizeEnv, riskPercent: riskPercentEnv });
  console.log(`Connecting to MetaApi account ${accountId}...`);
  await broker.connect();
  console.log(`Connected. Equity: ${broker.accountEquity()}`);
  console.log(`Watching: ${watchlist.join(', ')} · scanning every ${pollSeconds}s`);
  console.log(
    riskPercentEnv
      ? `Position sizing: risking ~${(riskPercentEnv * 100).toFixed(2)}% of equity per trade (stop-distance dependent).`
      : `Position sizing: flat ${lotSizeEnv ?? 0.01} lots per trade.`
  );
  console.log(autoConfirm ? 'AUTO_CONFIRM=true — approved trades fire immediately.' : 'Every approved trade will ask for your go-ahead below.\n');

  const orchestrator = new SystemOrchestrator({ broker, execution: broker, notifier });
  const pipeline = new MarketPipeline(orchestrator.bus);
  const strategy = new BreakoutStrategy(pipeline);

  const connectionManager = new ConnectionManager({
    broker,
    notifier,
    onStatusChange: (status) => {
      if (status !== 'connected') console.warn(`Connection status: ${status}`);
    },
  });
  connectionManager.start();

  // Tracked locally just so RiskManager has portfolio context (max open
  // positions, exposure per symbol, etc). The actual protection on each
  // position (SL/TP/trailing) lives on MT5's server regardless of this list.
  let openPositions: ExecutedTrade[] = [];
  const closedToday: ExecutedTrade[] = [];

  /**
   * A locally-tracked position that has vanished from the broker's own open
   * list was closed server-side (SL/TP/trailing stop, or manually). This
   * used to just drop it from `openPositions` and log a line — closedToday
   * was declared but never actually appended to, so session metrics
   * (computeSessionMetrics feeding the Decision Engine's gates) always saw
   * zero closed trades no matter how many the broker had actually closed.
   * Now the real exit is fetched and the trade is recorded properly.
   */
  async function reconcileOpenPositions() {
    if (openPositions.length === 0) return;
    const brokerOpenIds = new Set(await broker.getOpenPositionsAsync());
    const stillOpen = openPositions.filter((t) => brokerOpenIds.has(t.id));
    const justClosed = openPositions.filter((t) => !brokerOpenIds.has(t.id));
    if (justClosed.length === 0) return;

    openPositions = stillOpen;

    for (const trade of justClosed) {
      let fetched: ExecutedTrade | null = null;
      try {
        fetched = await broker.getClosedTradeAsync(trade);
      } catch (err) {
        console.error(`Could not fetch closing details for ${trade.id}:`, err);
      }

      const exitPrice = fetched?.exitPrice ?? trade.entry;
      const risk = Math.abs(trade.entry - trade.stop);
      const raw = trade.side === 'LONG' ? exitPrice - trade.entry : trade.entry - exitPrice;
      const pnlR = risk > 0 ? Number((raw / risk).toFixed(2)) : 0;
      const closed: ExecutedTrade = {
        ...trade,
        status: pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN',
        exitPrice,
        exitTime: fetched?.exitTime ?? new Date().toISOString(),
        pnlR,
        rMultiple: pnlR,
      };
      closedToday.push(closed);

      notifier.log({
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        module: 'PositionManager',
        message: `${trade.instrument} closed by broker's stop-loss/take-profit/trailing stop · ${pnlR.toFixed(2)}R (${closed.status})${
          fetched ? '' : ' — exact fill unavailable, estimate used'
        }`,
        reproducible: false,
      });
    }
  }

  async function evaluateInstrument(instrument: string): Promise<{ candidate: Awaited<ReturnType<typeof strategy.evaluate>>; opportunityScore: number } | null> {
    // Multi-timeframe fetch — see BreakoutStrategy's class doc comment:
    // 4H sets the bias, 1H the structure, 15M the setup, 5M the entry.
    const [h4, h1, m15, m5] = await Promise.all([
      broker.getCandlesAsync(instrument, '4h', 120),
      broker.getCandlesAsync(instrument, '1h', 150),
      broker.getCandlesAsync(instrument, '15m', 140),
      broker.getCandlesAsync(instrument, '5m', 120),
    ]);
    const candidate = strategy.evaluate(instrument, { h4, h1, m15, m5 });
    if (!candidate) return null;

    const result = orchestrator.submitCandidate(candidate, {
      safety: broker.runSafetyChecks(),
      sessionMetrics: computeSessionMetrics(closedToday),
      openPositions,
      closedToday,
    });
    if (result.outcome !== 'approved') return null;

    // Spread filter, scaled to this trade's own risk distance (see the
    // MAX_SPREAD_FRACTION_OF_RISK doc comment at the top of this file).
    try {
      const spread = await broker.getSpreadAsync(instrument);
      const risk = Math.abs(candidate.entry - candidate.stop);
      if (risk > 0 && spread / risk > MAX_SPREAD_FRACTION_OF_RISK) {
        console.log(`    ${instrument} setup skipped — spread too wide relative to this trade's stop distance.`);
        return null;
      }
    } catch {
      // If the spread check itself fails, don't block a trade that already cleared every other gate.
    }

    return { candidate, opportunityScore: candidate.confidence * candidate.riskReward };
  }

  async function confirmAndFill(candidate: NonNullable<Awaited<ReturnType<typeof strategy.evaluate>>>, rank: number, total: number) {
    console.log(
      `\n>>> [${rank}/${total}] ${candidate.instrument} ${candidate.side} @ ${candidate.entry.toFixed(5)} ` +
        `stop ${candidate.stop.toFixed(5)} target ${candidate.target.toFixed(5)} ` +
        `(confidence ${(candidate.confidence * 100).toFixed(0)}%, R:R ${candidate.riskReward.toFixed(2)})` +
        (rank === 1 && total > 1 ? '  [BEST OPPORTUNITY THIS SCAN]' : '')
    );

    let go = autoConfirm;
    if (!autoConfirm) {
      const answer = await rl.question('    Enter this trade? [y/N] ');
      go = answer.trim().toLowerCase() === 'y';
    }
    if (!go) {
      console.log('    Skipped.\n');
      return;
    }

    const trade = await broker.submitAsync(candidate);
    openPositions = [...openPositions, trade];
    notifier.log({
      timestamp: new Date().toISOString(),
      level: 'TRADE',
      module: 'ExecutionManager',
      message: `${candidate.instrument} ${candidate.side} filled live · position ${trade.id} · SL/TP + trailing stop attached at the broker`,
      reproducible: true,
    });
  }

  let scanning = false;

  /**
   * Every instrument in the watchlist is scanned every cycle — there is no
   * pre-filtering of "which pairs to check." Evaluation across instruments
   * runs concurrently (each is an independent 4-timeframe fetch), so total
   * scan time is close to the slowest single instrument rather than the sum
   * of all of them. What ranking happens here is across THIS cycle's
   * results: every candidate that cleared Safety -> Decision Engine -> Risk
   * Manager is scored by confidence*riskReward and offered strongest-first.
   *
   * Guarded against overlap: confirmAndFill() blocks on your y/N answer in
   * the terminal, so if you take longer to answer than one poll interval,
   * the next scan() firing on top of it would interleave console output and
   * could double-submit. Skips the cycle instead — the following one fires
   * on schedule regardless.
   */
  async function scan() {
    if (scanning) {
      console.log('(skipping this scan cycle — still waiting on a previous one, likely your y/N answer above)');
      return;
    }
    scanning = true;
    try {
      await reconcileOpenPositions();

      const results = await Promise.allSettled(watchlist.map((instrument) => evaluateInstrument(instrument)));
      const approved: { candidate: NonNullable<Awaited<ReturnType<typeof strategy.evaluate>>>; opportunityScore: number }[] = [];
      results.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value?.candidate) {
          approved.push({ candidate: result.value.candidate, opportunityScore: result.value.opportunityScore });
        } else if (result.status === 'rejected') {
          console.error(`Scan failed for ${watchlist[i]}:`, result.reason);
        }
      });

      approved.sort((a, b) => b.opportunityScore - a.opportunityScore);
      for (let i = 0; i < approved.length; i++) {
        await confirmAndFill(approved[i].candidate, i + 1, approved.length);
      }
    } finally {
      scanning = false;
    }
  }

  await scan();
  setInterval(() => {
    scan().catch((err) => console.error('Scan cycle failed:', err));
  }, pollSeconds * 1000);
}

main().catch((err) => {
  console.error('liveRunner failed to start:', err);
  process.exit(1);
});
