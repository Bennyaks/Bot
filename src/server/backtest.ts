/**
 * server/backtest
 * ------------------
 * Walk-forward backtest of the exact same pipeline (MarketPipeline ->
 * BreakoutStrategy -> DecisionEngine -> RiskManager -> PositionManager)
 * against REAL historical candles pulled from your MT5 account via
 * MetaApi — no live orders are ever placed. This answers "can I backtest
 * against my MT5 broker's data": yes, this is how.
 *
 * Run with:  npm run backtest
 * Required env vars: METAAPI_TOKEN, METAAPI_ACCOUNT_ID (same .env as liveRunner)
 * Optional:  BACKTEST_INSTRUMENT (default EURUSD)
 *            BACKTEST_TIMEFRAME  (default 15m)
 *            BACKTEST_BARS       (default 1500 — how many historical candles to pull)
 *
 * Methodology, so the results are honest:
 * - A candidate is only evaluated using candles STRICTLY BEFORE the bar
 *   being decided on (no lookahead).
 * - A fill happens at the OPEN of the NEXT bar after a candidate is
 *   approved — not at the signal bar's own close — to avoid the classic
 *   backtest bug of filling at a price you couldn't actually have traded at.
 * - An open position is checked against each subsequent bar's high/low for
 *   a stop or target touch, stop checked first (worst-case assumption when
 *   a single bar's range could have hit either).
 * - Spread is modeled as a real cost (BACKTEST_SPREAD_PIPS, default 1.5) —
 *   half the spread against you on entry, half against you on exit, same
 *   as it would be live. Without this, a strategy whose edge is thin
 *   relative to typical spread can look profitable in a backtest and lose
 *   money for real once spread and commission are actually paid.
 */
import 'dotenv/config';
import { MetaApiBroker } from '../providers/metaapi/MetaApiBroker';
import { MarketPipeline } from '../core/pipeline/MarketPipeline';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy';
import { DecisionEngine } from '../core/decision/DecisionEngine';
import { RiskManager } from '../core/risk/RiskManager';
import { PositionManager } from '../core/position/PositionManager';
import { TradeAnalytics, equityCurve, maxDrawdown } from '../core/analytics/Analytics';
import { computeSessionMetrics } from '../core/analytics/sessionPerformance';
import type { ExecutedTrade } from '../lib/types';

const token = process.env.METAAPI_TOKEN;
const accountId = process.env.METAAPI_ACCOUNT_ID;
const instrument = process.env.BACKTEST_INSTRUMENT ?? 'EURUSD';
const timeframe = process.env.BACKTEST_TIMEFRAME ?? '15m';
const totalBars = Number(process.env.BACKTEST_BARS ?? 1500);
const windowSize = 140; // matches the live strategy's scan window
const spreadPips = Number(process.env.BACKTEST_SPREAD_PIPS ?? 1.5);
const pipSize = instrument.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
/** Full round-trip cost in price units — half paid on entry, half on exit, see the class doc comment. */
const spreadCost = spreadPips * pipSize;

if (!token || !accountId) {
  console.error('Missing METAAPI_TOKEN or METAAPI_ACCOUNT_ID. Copy .env.example to .env and fill both in.');
  process.exit(1);
}

function isSameUtcDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth() && da.getUTCDate() === db.getUTCDate();
}

async function main() {
  const broker = new MetaApiBroker({ token: token!, accountId: accountId! });
  console.log(`Connecting to MetaApi account ${accountId} (read-only — fetching history, no orders will be placed)...`);
  await broker.connect();

  console.log(`Pulling ${totalBars} ${timeframe} candles for ${instrument}...`);
  const candles = await broker.getCandlesAsync(instrument, timeframe, totalBars);
  if (candles.length < windowSize + 10) {
    console.error(`Only got ${candles.length} candles back — need at least ${windowSize + 10}. Try a smaller BACKTEST_BARS or a different instrument/timeframe.`);
    process.exit(1);
  }
  console.log(`Got ${candles.length} candles, spanning ${new Date(candles[0].time).toISOString()} to ${new Date(candles[candles.length - 1].time).toISOString()}`);

  // BreakoutStrategy is now multi-timeframe (4H bias -> 1H structure -> 15M
  // setup -> 5M entry) — pull matching 4H/1H history so the same alignment
  // gate applies here, not just live. KNOWN LIMITATION: this does not pull
  // separate 5M history, so the "5M entry confirmation" step falls back to
  // confirming on the 15M series itself (BreakoutStrategy's documented
  // fallback for when no m5 feed is supplied) — a true bar-aligned 5M
  // replay would need its own lookahead-safe alignment and is future work.
  console.log('Pulling matching 4H and 1H history for the multi-timeframe alignment gate...');
  const h4Full = await broker.getCandlesAsync(instrument, '4h', Math.ceil(totalBars / 16) + 50);
  const h1Full = await broker.getCandlesAsync(instrument, '1h', Math.ceil(totalBars / 4) + 50);
  let h4Pointer = 0;
  let h1Pointer = 0;

  const pipeline = new MarketPipeline(); // no bus in a backtest — thousands of bars would spam it
  const strategy = new BreakoutStrategy(pipeline);
  const decisionEngine = new DecisionEngine();
  const riskManager = new RiskManager();
  const positionManager = new PositionManager();

  let openTrades: ExecutedTrade[] = [];
  const closedTrades: ExecutedTrade[] = [];
  let candidatesSeen = 0;
  let decisionRejected = 0;
  let riskRejected = 0;

  for (let i = windowSize; i < candles.length - 1; i++) {
    const bar = candles[i];

    // 1) Manage open trades against this bar's range (stop checked first — worst case).
    for (const trade of [...openTrades]) {
      let rawExitPrice: number | null = null;
      let reason = '';
      if (trade.side === 'LONG') {
        if (bar.low <= trade.stop) { rawExitPrice = trade.stop; reason = 'stop hit'; }
        else if (bar.high >= trade.target) { rawExitPrice = trade.target; reason = 'target reached'; }
      } else {
        if (bar.high >= trade.stop) { rawExitPrice = trade.stop; reason = 'stop hit'; }
        else if (bar.low <= trade.target) { rawExitPrice = trade.target; reason = 'target reached'; }
      }
      if (rawExitPrice !== null) {
        // Closing a LONG sells at the bid (below mid); closing a SHORT buys back at the ask (above mid) — half the spread against you either way.
        const exitPrice = trade.side === 'LONG' ? rawExitPrice - spreadCost / 2 : rawExitPrice + spreadCost / 2;
        const closed = positionManager.close(trade, exitPrice, reason);
        openTrades = openTrades.filter((t) => t.id !== trade.id);
        closedTrades.push(closed);
      }
    }

    // 2) Scan using only candles strictly before this bar's close (no lookahead).
    // Advance the 4H/1H pointers to the last candle at or before this bar's
    // time — same no-lookahead rule as the 15M window below.
    while (h4Pointer + 1 < h4Full.length && h4Full[h4Pointer + 1].time <= bar.time) h4Pointer++;
    while (h1Pointer + 1 < h1Full.length && h1Full[h1Pointer + 1].time <= bar.time) h1Pointer++;
    const h4Window = h4Full.slice(0, h4Pointer + 1);
    const h1Window = h1Full.slice(0, h1Pointer + 1);
    const window = candles.slice(i - windowSize, i + 1);
    const candidate = strategy.evaluate(instrument, { h4: h4Window, h1: h1Window, m15: window });
    if (!candidate) continue;
    candidatesSeen++;

    const decision = decisionEngine.evaluate(candidate, { sessionMetrics: computeSessionMetrics(closedTrades) });
    if (!decision.approved) {
      decisionRejected++;
      continue;
    }

    const closedToday = closedTrades.filter((t) => isSameUtcDay(new Date(t.exitTime ?? t.timestamp).getTime(), bar.time));
    const riskVerdict = riskManager.evaluate(candidate, { openPositions: openTrades, closedToday, session: candidate.session });
    if (!riskVerdict.approved) {
      riskRejected++;
      continue;
    }

    // 3) Fill at the NEXT bar's open — the earliest price you could actually have traded at.
    // Buying pays the ask (above mid), selling pays the bid (below mid) — half the spread against you on entry too.
    const fillBar = candles[i + 1];
    const entryPrice = candidate.side === 'LONG' ? fillBar.open + spreadCost / 2 : fillBar.open - spreadCost / 2;
    const trade: ExecutedTrade = {
      id: `BT-${i}`,
      timestamp: new Date(fillBar.time).toISOString(),
      instrument,
      timeframe,
      side: candidate.side,
      entry: entryPrice,
      stop: candidate.stop,
      target: candidate.target,
      lotSize: 0.01,
      rMultiple: null,
      status: 'OPEN',
      session: candidate.session,
      confidence: candidate.confidence,
      strategyVersion: candidate.strategyVersion,
      explanation: `Backtest fill from candidate ${candidate.id}`,
    };
    positionManager.open(trade);
    openTrades.push(trade);
  }

  // Mark-to-close anything still open at the end of the data window.
  const lastClose = candles[candles.length - 1].close;
  for (const trade of openTrades) {
    const exitPrice = trade.side === 'LONG' ? lastClose - spreadCost / 2 : lastClose + spreadCost / 2;
    closedTrades.push(positionManager.close(trade, exitPrice, 'backtest window ended'));
  }

  const analytics = new TradeAnalytics();
  const curve = equityCurve(closedTrades);
  console.log('\n=== Backtest results ===');
  console.log(`Instrument/timeframe: ${instrument} ${timeframe}`);
  console.log(`Spread modeled: ${spreadPips} pips round-trip (set BACKTEST_SPREAD_PIPS to change)`);
  console.log(`Candles scanned: ${candles.length}`);
  console.log(`Candidates produced by BreakoutStrategy: ${candidatesSeen}`);
  console.log(`Rejected by DecisionEngine: ${decisionRejected}`);
  console.log(`Rejected by RiskManager: ${riskRejected}`);
  console.log(`Trades taken: ${closedTrades.length}`);
  console.log(`Win rate: ${analytics.winRate(closedTrades)}%`);
  console.log(`Profit factor: ${analytics.profitFactor(closedTrades)}`);
  console.log(`Expectancy: ${analytics.expectancy(closedTrades)}R per trade`);
  console.log(`Net R: ${curve.length ? curve[curve.length - 1].toFixed(2) : 0}R`);
  console.log(`Max drawdown: ${maxDrawdown(curve)}R`);
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
