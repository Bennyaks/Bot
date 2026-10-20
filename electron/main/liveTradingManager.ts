/**
 * electron/main/liveTradingManager
 * -----------------------------------
 * Runs inside Electron's main process (plain Node, not the renderer), so it
 * can import MetaApiBroker/MT5Broker directly — same rule as
 * server/liveRunner.ts: this must never be imported by renderer/browser code.
 *
 * Supports two interchangeable broker modes — 'metaapi' (MetaApiBroker) and
 * 'mt5-local' (MT5Broker, talking to python-bridge/mt5_bridge.py) — because
 * both implement the exact same MarketProvider + Broker + ExecutionProvider
 * contracts. Same SystemOrchestrator, same BreakoutStrategy, same
 * DecisionEngine/RiskManager underneath either way; only which broker is
 * constructed changes.
 *
 * One real behavioral difference between the modes: MetaApi's cloud-hosted
 * terminal manages a trailing stop on its own even if this app isn't
 * running. Plain MT5 has no equivalent — a trailing stop here only moves
 * when modifyPositionAsync() is actually called, so this class runs its own
 * PositionManager loop for 'mt5-local' sessions (see manageOpenPositions()).
 * See src/execution/mt5/README.md for the full trade-off.
 */
import { MetaApiBroker } from '../../src/providers/metaapi/MetaApiBroker';
import { MT5Broker } from '../../src/execution/mt5/MT5Broker';
import { MarketPipeline } from '../../src/core/pipeline/MarketPipeline';
import { BreakoutStrategy } from '../../src/strategies/breakout/BreakoutStrategy';
import { SystemOrchestrator } from '../../src/core/orchestrator/SystemOrchestrator';
import { PositionManager } from '../../src/core/position/PositionManager';
import { ConnectionManager, type ConnectionStatus } from '../../src/core/reliability/ConnectionManager';
import { computeSessionMetrics } from '../../src/core/analytics/sessionPerformance';
import { TradeHistoryStore } from './tradeHistoryStore';
import type { ExecutedTrade, LogEntry, Candle } from '../../src/lib/types';
import type { Notifier, TradeCandidate } from '../../src/core/interfaces';

export type LiveConnectOptions =
  | { mode: 'metaapi'; token: string; accountId: string; lotSize?: number; riskPercent?: number }
  | { mode: 'mt5-local'; bridgeUrl: string; lotSize?: number; riskPercent?: number };

type LiveBroker = MetaApiBroker | MT5Broker;

/**
 * 4H and 1H candles barely change within a single poll cycle — a 4H bar is
 * only new every 4 hours — so refetching both on every scan was 2 of the 4
 * candle requests per instrument buying nothing. Cached per instrument with
 * its own refresh cooldown; only 15M/5M (the setup/entry timeframes, which
 * DO need to be fresh every scan) are fetched unconditionally.
 */
interface CachedCandles {
  candles: Candle[];
  fetchedAt: number;
}

export interface PendingCandidate {
  id: string;
  instrument: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  lotSize: number;
  timeframe: string;
  confidence: number;
  riskReward: number;
  structure: string;
  /** confidence * riskReward for this scan cycle — higher is a stronger setup. */
  opportunityScore: number;
  /** 1 = best opportunity found across the whole watchlist this cycle. */
  rank: number;
}

/** An open position enriched with live-ish display data — everything an ExecutedTrade has, plus what the UI needs to show it meaningfully. */
export interface LivePosition extends ExecutedTrade {
  /** Most recent close price seen for this instrument (from the last scan cycle) — not a real-time tick, but refreshed every scan. */
  currentPrice: number | null;
  /** Unrealized R-multiple estimated from currentPrice, using the same risk basis as the real close calculation. */
  floatingR: number | null;
  /** Minutes since the position was opened. */
  elapsedMinutes: number;
}

export interface LiveStatus {
  connected: boolean;
  connectionStatus: ConnectionStatus | 'idle';
  equity: number;
  broker: string | null;
  lotSize: number;
  riskPercent: number | null;
}

export interface LiveTradingEvents {
  onLog: (entry: LogEntry) => void;
  onStatus: (status: LiveStatus) => void;
  onCandidate: (candidate: PendingCandidate) => void;
  onCandidateExpired: (candidateId: string) => void;
  onPositions: (positions: LivePosition[]) => void;
}

export class LiveTradingManager {
  private broker: LiveBroker | null = null;
  private orchestrator: SystemOrchestrator | null = null;
  private strategy: BreakoutStrategy | null = null;
  private connectionManager: ConnectionManager | null = null;
  private positionManager = new PositionManager();
  private historyStore: TradeHistoryStore;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private connectionStatus: ConnectionStatus | 'idle' = 'idle';

  private openPositions: ExecutedTrade[] = [];
  private closedToday: ExecutedTrade[] = [];
  private history: ExecutedTrade[] = [];
  private pending = new Map<string, TradeCandidate>();
  private candidateCreatedAt = new Map<string, number>();
  private lastPriceByInstrument = new Map<string, number>();
  /** Per-instrument cache for the slow-moving higher timeframes — see CachedCandles doc comment below. */
  private htfCache = new Map<string, { h4: CachedCandles; h1: CachedCandles }>();
  /** True while a scan() is in flight — see scan()'s overlap guard. */
  private scanning = false;

  private watchlist: string[] = ['EURUSD', 'GBPUSD', 'USDJPY'];
  private pollMs = 60_000;
  private lotSize = 0.01;
  private riskPercent: number | null = null;
  /** Trades already given their partial-take-profit close — never twice for the same trade id. */
  private partialTaken = new Set<string>();
  /** How much of the position to bank at partialTakeAtR, and at what R that triggers. See managePartialProfits(). */
  private readonly partialTakeAtR = 1;
  private readonly partialTakeFraction = 0.5;
  /**
   * A trade's own risk distance (entry-to-stop) is the fairest yardstick
   * for "is the spread too wide right now" — a fixed pip number would be
   * meaningless across instruments with very different typical stop sizes.
   * Reject entries where the spread eats more than this fraction of the
   * planned risk.
   */
  private readonly maxSpreadFractionOfRisk = 0.15;
  /** Approve-in-flight guard — stops a rapid double-click/double-IPC-call from submitting the same candidate twice. */
  private readonly approving = new Set<string>();
  /**
   * A recommendation nobody acted on for this long is worth clearing out
   * rather than leaving it sitting in the UI looking actionable — the
   * price it was computed against has likely moved on by then. Pruned at
   * the top of every scan(); see pruneExpiredCandidates().
   */
  private readonly candidateTtlMs = 10 * 60 * 1000;

  constructor(private events: LiveTradingEvents, userDataDir: string) {
    this.historyStore = new TradeHistoryStore(userDataDir);
    this.history = this.historyStore.load();
  }

  private emitLog(entry: Omit<LogEntry, 'id'>) {
    this.events.onLog({ ...entry, id: `L${Date.now()}${Math.random().toString(36).slice(2, 6)}` });
  }

  private emitStatus() {
    this.events.onStatus({
      connected: this.broker?.isConnected() ?? false,
      connectionStatus: this.connectionStatus,
      equity: this.broker?.accountEquity() ?? 0,
      broker: this.broker?.id ?? null,
      lotSize: this.lotSize,
      riskPercent: this.riskPercent,
    });
  }

  private emitPositions() {
    const now = Date.now();
    const enriched: LivePosition[] = this.openPositions.map((trade) => {
      const currentPrice = this.lastPriceByInstrument.get(trade.instrument) ?? null;
      const risk = Math.abs(trade.entry - trade.stop);
      const floatingR =
        currentPrice !== null && risk > 0
          ? Number(
              (((trade.side === 'LONG' ? currentPrice - trade.entry : trade.entry - currentPrice) / risk)).toFixed(2)
            )
          : null;
      return {
        ...trade,
        currentPrice,
        floatingR,
        elapsedMinutes: Math.max(0, Math.round((now - new Date(trade.timestamp).getTime()) / 60_000)),
      };
    });
    this.events.onPositions(enriched);
  }

  async connect(options: LiveConnectOptions): Promise<LiveStatus> {
    if (this.broker) this.disconnect();

    this.lotSize = options.lotSize && options.lotSize > 0 ? options.lotSize : 0.01;
    this.riskPercent = options.riskPercent && options.riskPercent > 0 ? options.riskPercent : null;

    const notifier: Notifier = { log: (e) => this.emitLog(e) };
    const broker: LiveBroker =
      options.mode === 'metaapi'
        ? new MetaApiBroker({ token: options.token, accountId: options.accountId, defaultVolume: this.lotSize, riskPercent: this.riskPercent ?? undefined })
        : new MT5Broker({ bridgeUrl: options.bridgeUrl, defaultVolume: this.lotSize, riskPercent: this.riskPercent ?? undefined });
    await broker.connect();
    this.broker = broker;

    this.orchestrator = new SystemOrchestrator({ broker, execution: broker, notifier });
    this.strategy = new BreakoutStrategy(new MarketPipeline(this.orchestrator.bus));

    this.connectionManager = new ConnectionManager({
      broker,
      notifier,
      onStatusChange: (status) => {
        this.connectionStatus = status;
        this.emitStatus();
      },
    });
    this.connectionManager.start();
    this.connectionStatus = 'connected';
    this.emitStatus();

    if (options.mode === 'mt5-local') {
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'LiveTradingManager',
        message:
          'Connected via native MT5 bridge. Fixed stop-loss/take-profit is protected by your broker even if this app closes, but trailing-stop moves need this app to stay running.',
        reproducible: false,
      });
    }
    if (this.riskPercent) {
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'LiveTradingManager',
        message: `Position sizing: risking ~${(this.riskPercent * 100).toFixed(2)}% of equity per trade (stop-distance dependent), not a fixed ${this.lotSize} lots.`,
        reproducible: false,
      });
    }

    this.startScanning();
    return {
      connected: true,
      connectionStatus: 'connected',
      equity: broker.accountEquity(),
      broker: broker.id,
      lotSize: this.lotSize,
      riskPercent: this.riskPercent,
    };
  }

  disconnect(): void {
    this.connectionManager?.stop();
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    this.connectionManager = null;
    this.broker = null;
    this.orchestrator = null;
    this.strategy = null;
    this.pending.clear();
    this.candidateCreatedAt.clear();
    this.htfCache.clear();
    this.lastPriceByInstrument.clear();
    this.partialTaken.clear();
    this.approving.clear();
    this.connectionStatus = 'idle';
    this.emitStatus();
  }

  setWatchlist(list: string[]): void {
    this.watchlist = list.map((s) => s.trim()).filter(Boolean);
  }

  setPollSeconds(seconds: number): void {
    this.pollMs = Math.max(5, seconds) * 1000;
    if (this.scanTimer) this.startScanning();
  }

  private startScanning(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scan().catch((err) => this.emitLog(this.errorLog('LiveTradingManager', err)));
    this.scanTimer = setInterval(() => {
      this.scan().catch((err) => this.emitLog(this.errorLog('LiveTradingManager', err)));
    }, this.pollMs);
  }

  private errorLog(module: string, err: unknown): Omit<LogEntry, 'id'> {
    return {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      module,
      message: err instanceof Error ? err.message : String(err),
      reproducible: false,
    };
  }

  /**
   * A locally-tracked position that has vanished from the broker's own open
   * list was closed server-side — stop-loss, take-profit, or a trailing
   * stop firing while nobody was watching. This used to just drop the
   * position from `openPositions` and say nothing further: the trade would
   * disappear from the UI with no record in History/Sessions, no P&L, and
   * no feedback into session analytics — which looked indistinguishable
   * from "the bot never closes trades." Now every broker-side close is
   * fetched, recorded into closedToday/history exactly like a manual
   * close, and logged with its real result.
   */
  private async reconcile(): Promise<void> {
    if (!this.broker || this.openPositions.length === 0) return;
    const brokerOpenIds = new Set(await this.broker.getOpenPositionsAsync());
    const stillOpen = this.openPositions.filter((t) => brokerOpenIds.has(t.id));
    const justClosed = this.openPositions.filter((t) => !brokerOpenIds.has(t.id));
    if (justClosed.length === 0) return;

    this.openPositions = stillOpen;

    for (const trade of justClosed) {
      let fetched: ExecutedTrade | null = null;
      try {
        fetched = await this.broker.getClosedTradeAsync(trade);
      } catch (err) {
        this.emitLog(this.errorLog('PositionManager', err));
      }

      // positionManager.close() is the single source of truth for turning an
      // exit price into pnlR/rMultiple/status, and it also clears this
      // trade's entry in PositionManager's own internal bookkeeping (the
      // initialRisk map) — run it either way, using the broker's real exit
      // price when we have one and the last known market price as a
      // clearly-labelled fallback when we don't.
      const fallbackPrice = this.lastPriceByInstrument.get(trade.instrument) ?? trade.entry;
      const computed = this.positionManager.close(
        trade,
        fetched?.exitPrice ?? fallbackPrice,
        fetched
          ? "closed by your broker's stop-loss, take-profit, or trailing stop"
          : 'closed by your broker — exact fill unavailable, last known price used as an estimate'
      );
      const closed: ExecutedTrade = fetched ? { ...computed, exitTime: fetched.exitTime ?? computed.exitTime } : computed;

      this.closedToday = [closed, ...this.closedToday];
      this.history = this.historyStore.append(closed);

      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        module: 'PositionManager',
        message: `${trade.instrument} closed by your broker's stop-loss/take-profit/trailing stop · ${
          closed.pnlR !== undefined ? `${closed.pnlR.toFixed(2)}R` : 'unknown P&L'
        } (${closed.status})${fetched ? '' : ' — exact fill price unavailable, this is an estimate'}`,
        reproducible: false,
      });
    }

    this.emitPositions();
  }

  /**
   * Runs every scan cycle for whichever position-management steps apply.
   * managePartialProfits() runs for both broker modes; manageTrailingStops()
   * only for 'mt5-local' (see manageTrailingStops()'s own doc comment for why
   * MetaApi sessions don't need it run locally).
   */
  private async manageOpenPositions(): Promise<void> {
    if (!this.broker || this.openPositions.length === 0) return;
    await this.managePartialProfits();
    await this.manageTrailingStops();
  }

  /**
   * For 'mt5-local' sessions only: run PositionManager's break-even/trailing
   * logic against the latest price for each open position's instrument, and
   * push any resulting stop change to the broker. MetaApi sessions skip this
   * — its cloud-hosted trailing config (set at submit time) already handles
   * it without our involvement.
   */
  private async manageTrailingStops(): Promise<void> {
    if (!this.broker || this.broker.id !== 'mt5-broker' || this.openPositions.length === 0) return;
    const mt5 = this.broker as MT5Broker;

    for (const trade of this.openPositions) {
      const currentPrice = this.lastPriceByInstrument.get(trade.instrument);
      if (currentPrice === undefined) continue;

      const managed = this.positionManager.manage(trade, currentPrice);
      if (managed.stop === trade.stop) continue;

      try {
        await mt5.modifyPositionAsync(trade, managed.stop);
        this.openPositions = this.openPositions.map((t) => (t.id === trade.id ? managed : t));
        this.emitPositions();
        this.emitLog({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          module: 'PositionManager',
          message: `${trade.instrument} stop moved to protect more profit (now at ${managed.stop.toFixed(5)}).`,
          reproducible: false,
        });
      } catch (err) {
        this.emitLog(this.errorLog('PositionManager', err));
      }
    }
  }

  /**
   * Runs for BOTH broker modes (unlike trailing above) — banking part of a
   * winner at a fixed R and moving the remainder's stop to breakeven isn't
   * something either broker does on its own; it's this app's own decision,
   * same as the strategy/risk logic. Reduces variance on the frequent
   * "ran to 1R then reversed" trades without abandoning the bigger win the
   * full position is still positioned for.
   */
  private async managePartialProfits(): Promise<void> {
    if (!this.broker || this.openPositions.length === 0) return;

    for (const trade of [...this.openPositions]) {
      if (this.partialTaken.has(trade.id)) continue;
      const currentPrice = this.lastPriceByInstrument.get(trade.instrument);
      if (currentPrice === undefined) continue;

      const risk = this.positionManager.initialRiskFor(trade.id) ?? Math.abs(trade.entry - trade.stop);
      if (risk <= 0) continue;
      const inProfitR = trade.side === 'LONG' ? (currentPrice - trade.entry) / risk : (trade.entry - currentPrice) / risk;
      if (inProfitR < this.partialTakeAtR) continue;

      const closeVolume = Number((trade.lotSize * this.partialTakeFraction).toFixed(8));
      if (closeVolume <= 0) continue;

      try {
        const result = await this.broker.partialCloseAsync(trade, closeVolume);
        this.partialTaken.add(trade.id);
        const remainingLots = Number((trade.lotSize - closeVolume).toFixed(8));
        const realizedR = Number(
          ((trade.side === 'LONG' ? result.price - trade.entry : trade.entry - result.price) / risk).toFixed(2)
        );

        // Record the realized partial as its own history entry — it's a
        // real, booked P&L event even though the position itself is still
        // open. Its rMultiple/pnlR is against the ORIGINAL risk basis, same
        // convention as the final close, so summing this with the eventual
        // close of the remainder gives the true blended R for the trade.
        const partialRecord: ExecutedTrade = {
          ...trade,
          id: `${trade.id}-partial1`,
          lotSize: closeVolume,
          status: realizedR > 0.05 ? 'WIN' : realizedR < -0.05 ? 'LOSS' : 'BREAKEVEN',
          exitPrice: result.price,
          exitTime: new Date().toISOString(),
          pnlR: realizedR,
          rMultiple: realizedR,
          explanation: `${trade.explanation} · partial close (${Math.round(this.partialTakeFraction * 100)}% of position) at ${this.partialTakeAtR}R — remainder moved to breakeven`,
        };
        this.closedToday = [partialRecord, ...this.closedToday];
        this.history = this.historyStore.append(partialRecord);

        let updatedTrade: ExecutedTrade = { ...trade, lotSize: remainingLots };
        this.openPositions = this.openPositions.map((t) => (t.id === trade.id ? updatedTrade : t));

        // Move the remainder's stop to breakeven — standard practice at the
        // same trigger point a partial is normally taken. mt5-local needs an
        // explicit push; MetaApi's own trailing config already has the
        // remainder covered once price is favorable, so it's left alone.
        if (this.broker.id === 'mt5-broker' && updatedTrade.stop !== updatedTrade.entry) {
          try {
            await (this.broker as MT5Broker).modifyPositionAsync(updatedTrade, updatedTrade.entry);
            updatedTrade = { ...updatedTrade, stop: updatedTrade.entry };
            this.openPositions = this.openPositions.map((t) => (t.id === trade.id ? updatedTrade : t));
          } catch (err) {
            this.emitLog(this.errorLog('PositionManager', err));
          }
        }

        this.emitPositions();
        this.emitLog({
          timestamp: new Date().toISOString(),
          level: 'TRADE',
          module: 'PositionManager',
          message: `${trade.instrument}: banked ${Math.round(this.partialTakeFraction * 100)}% at ${realizedR.toFixed(2)}R, ${remainingLots} lots remain${this.broker.id === 'mt5-broker' ? ', stop moved to breakeven' : ''}.`,
          reproducible: true,
        });
      } catch (err) {
        this.emitLog(this.errorLog('PositionManager', err));
      }
    }
  }

  /**
   * Runs every watchlist instrument through the pipeline and collects every
   * candidate that clears Safety -> Decision Engine -> Risk Manager. There
   * is no cross-instrument filtering before this point — every instrument
   * in the watchlist is scanned every cycle. What happens here is ranking
   * *within* this cycle's results: candidates are scored and the best one
   * is marked, but every approved candidate is still surfaced — approval
   * already means "this cleared every mandatory gate," which none of the
   * other candidates that got rejected did.
   */
  /** 4H is only worth refetching every ~20 minutes; 1H every ~5 — both change far slower than a typical poll interval. */
  private static readonly H4_REFRESH_MS = 20 * 60 * 1000;
  private static readonly H1_REFRESH_MS = 5 * 60 * 1000;

  private async getCandlesCached(
    instrument: string,
    timeframe: '4h' | '1h',
    count: number,
    refreshMs: number
  ): Promise<Candle[]> {
    if (!this.broker) return [];
    const cacheKey = timeframe === '4h' ? 'h4' : 'h1';
    const entry = this.htfCache.get(instrument)?.[cacheKey];
    if (entry && Date.now() - entry.fetchedAt < refreshMs) return entry.candles;

    const candles = await this.broker.getCandlesAsync(instrument, timeframe, count);
    const existing = this.htfCache.get(instrument) ?? { h4: { candles: [], fetchedAt: 0 }, h1: { candles: [], fetchedAt: 0 } };
    existing[cacheKey] = { candles, fetchedAt: Date.now() };
    this.htfCache.set(instrument, existing);
    return candles;
  }

  /**
   * A recommendation nobody acted on within candidateTtlMs is removed and
   * the UI is told to drop its card — see candidateTtlMs's doc comment.
   */
  private pruneExpiredCandidates(): void {
    const now = Date.now();
    for (const [id, createdAt] of [...this.candidateCreatedAt.entries()]) {
      if (now - createdAt < this.candidateTtlMs) continue;
      const candidate = this.pending.get(id);
      this.pending.delete(id);
      this.candidateCreatedAt.delete(id);
      this.events.onCandidateExpired(id);
      if (candidate) {
        this.emitLog({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          module: 'LiveTradingManager',
          message: `${candidate.instrument} ${candidate.side} setup expired after ${Math.round(this.candidateTtlMs / 60_000)} minutes unanswered — price has likely moved past this entry, waiting for a fresh setup instead.`,
          reproducible: false,
        });
      }
    }
  }

  private async scan(): Promise<void> {
    if (!this.broker || !this.orchestrator || !this.strategy) return;
    if (this.scanning) {
      // The previous scan is still running (a slow bridge/API response, a
      // large watchlist, or a poll interval set shorter than a full scan
      // takes) — starting another on top of it would only compound the
      // slowness and risk two scans racing on the same shared state.
      // Skipping this tick is safe: the next one fires on schedule regardless.
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'LiveTradingManager',
        message: 'Previous scan is still in progress — skipping this cycle rather than overlapping it. If this keeps happening, your poll interval is shorter than a full scan takes; consider raising it.',
        reproducible: false,
      });
      return;
    }
    this.scanning = true;
    try {
      await this.reconcile();
      this.pruneExpiredCandidates();

      const approved: { candidate: TradeCandidate; opportunityScore: number }[] = [];

      // Every instrument's 4-timeframe fetch is independent of every other
      // instrument's — run them concurrently instead of one after another,
      // so total scan time is roughly the slowest single instrument rather
      // than the sum of all of them.
      await Promise.all(
        this.watchlist.map(async (instrument) => {
          try {
            // Multi-timeframe fetch: 4H sets the bias, 1H the structure, 15M
            // the setup, 5M the entry confirmation — see BreakoutStrategy's
            // class doc comment. 4H/1H are cached (see getCandlesCached) since
            // they barely change between scans; 15M/5M are always fresh.
            const [h4, h1, m15, m5] = await Promise.all([
              this.getCandlesCached(instrument, '4h', 120, LiveTradingManager.H4_REFRESH_MS),
              this.getCandlesCached(instrument, '1h', 150, LiveTradingManager.H1_REFRESH_MS),
              this.broker!.getCandlesAsync(instrument, '15m', 140),
              this.broker!.getCandlesAsync(instrument, '5m', 120),
            ]);
            const last = m5.at(-1) ?? m15.at(-1);
            if (last) this.lastPriceByInstrument.set(instrument, last.close);

            const candidate = this.strategy!.evaluate(instrument, { h4, h1, m15, m5 });
            if (!candidate) return;

            const result = this.orchestrator!.submitCandidate(candidate, {
              safety: this.broker!.runSafetyChecks(),
              sessionMetrics: computeSessionMetrics(this.closedToday),
              openPositions: this.openPositions,
              closedToday: this.closedToday,
            });
            if (result.outcome !== 'approved') return;

            // Spread filter: scaled to THIS trade's own risk distance rather
            // than a fixed pip number, since "3 pips of spread" is negligible
            // on a 40-pip stop and enormous on a 6-pip stop.
            try {
              const spread = await this.broker!.getSpreadAsync(instrument);
              const risk = Math.abs(candidate.entry - candidate.stop);
              if (risk > 0 && spread / risk > this.maxSpreadFractionOfRisk) {
                this.emitLog({
                  timestamp: new Date().toISOString(),
                  level: 'INFO',
                  module: 'LiveTradingManager',
                  message: `${instrument} setup skipped — spread (${spread.toFixed(5)}) is ${((spread / risk) * 100).toFixed(0)}% of this trade's planned risk, above the ${(this.maxSpreadFractionOfRisk * 100).toFixed(0)}% limit.`,
                  reproducible: false,
                });
                return;
              }
            } catch {
              // If the spread check itself fails, don't block a trade that already cleared every other gate.
            }

            // Simple, explainable opportunity score — confidence and reward:risk
            // both matter and neither alone is enough (a low-confidence 5R
            // setup and a 95%-confidence 0.5R setup are both weak candidates).
            approved.push({ candidate, opportunityScore: candidate.confidence * candidate.riskReward });
          } catch (err) {
            this.emitLog(this.errorLog('LiveTradingManager', err));
          }
        })
      );

      approved.sort((a, b) => b.opportunityScore - a.opportunityScore);
      approved.forEach(({ candidate, opportunityScore }, index) => {
        this.pending.set(candidate.id, candidate);
        this.candidateCreatedAt.set(candidate.id, Date.now());
        this.events.onCandidate({
          id: candidate.id,
          instrument: candidate.instrument,
          side: candidate.side,
          entry: candidate.entry,
          stop: candidate.stop,
          target: candidate.target,
          lotSize: this.lotSize,
          timeframe: candidate.timeframe,
          confidence: candidate.confidence,
          riskReward: candidate.riskReward,
          structure: candidate.structure,
          opportunityScore: Number(opportunityScore.toFixed(2)),
          rank: index + 1,
        });
      });

      this.emitPositions();
      await this.manageOpenPositions();
    } finally {
      this.scanning = false;
    }
  }

  /**
   * The "go" directive — nothing is sent to the broker until this is called.
   * `overrides` lets the user widen/tighten the strategy's own stop-loss or
   * take-profit before the order is placed; anything not overridden keeps
   * the strategy's computed value. Both are validated to still sit on the
   * correct side of entry for the trade direction before anything is sent.
   */
  async approve(candidateId: string, overrides?: { stop?: number; target?: number }): Promise<void> {
    const candidate = this.pending.get(candidateId);
    if (!candidate || !this.broker) {
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ExecutionManager',
        message: `Could not approve candidate ${candidateId} — ${
          !this.broker ? 'not connected to a broker' : 'candidate expired or already handled (try scanning again)'
        }`,
        reproducible: false,
      });
      return;
    }
    if (this.approving.has(candidateId)) {
      // A rapid double-click or a duplicate IPC call arrived while the first
      // approve() was still in flight — the candidate is already deleted
      // from `pending` below, so a second concurrent call would otherwise
      // hit the "expired" branch anyway, but this catches it before it can
      // race submitAsync() and place the same order twice.
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'ExecutionManager',
        message: `${candidate.instrument} ${candidate.side} — ignored a duplicate approve() while the first one was still submitting.`,
        reproducible: false,
      });
      return;
    }
    this.approving.add(candidateId);

    try {
      let finalCandidate: TradeCandidate = candidate;
      if (overrides && (overrides.stop !== undefined || overrides.target !== undefined)) {
        const stop = overrides.stop ?? candidate.stop;
        const target = overrides.target ?? candidate.target;
        const isLong = candidate.side === 'LONG';
        const stopValid = isLong ? stop < candidate.entry : stop > candidate.entry;
        const targetValid = isLong ? target > candidate.entry : target < candidate.entry;
        if (!stopValid || !targetValid) {
          this.emitLog({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            module: 'ExecutionManager',
            message: `${candidate.instrument} ${candidate.side} — adjusted stop/target must stay on the correct side of entry (${candidate.entry}); stop ${stop}, target ${target} rejected.`,
            reproducible: false,
          });
          throw new Error('Adjusted stop-loss/take-profit is on the wrong side of entry for this trade direction.');
        }
        const risk = Math.abs(candidate.entry - stop);
        const reward = Math.abs(target - candidate.entry);
        finalCandidate = { ...candidate, stop, target, riskReward: risk > 0 ? Number((reward / risk).toFixed(2)) : 0 };
      }

      this.pending.delete(candidateId);
      this.candidateCreatedAt.delete(candidateId);

      try {
        const trade = await this.broker.submitAsync(finalCandidate);
        this.positionManager.open(trade);
        this.openPositions = [...this.openPositions, trade];
        this.emitPositions();
        this.emitLog({
          timestamp: new Date().toISOString(),
          level: 'TRADE',
          module: 'ExecutionManager',
          message: `${finalCandidate.instrument} ${finalCandidate.side} filled live · position ${trade.id}${
            finalCandidate !== candidate ? ' (stop/take-profit adjusted by you before entry)' : ''
          }`,
          reproducible: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ExecutionManager',
        message: `${finalCandidate.instrument} ${finalCandidate.side} FAILED to fill · ${message}`,
        reproducible: false,
      });
      // Re-throw so the IPC caller's promise rejects and the UI can show it,
      // not just log it — a failed order is exactly the kind of thing that
      // must not be silently swallowed.
      throw err;
      }
    } finally {
      this.approving.delete(candidateId);
    }
  }

  skip(candidateId: string): void {
    this.pending.delete(candidateId);
    this.candidateCreatedAt.delete(candidateId);
  }

  async closePosition(tradeId: string): Promise<void> {
    if (!this.broker) return;
    const trade = this.openPositions.find((t) => t.id === tradeId);
    if (!trade) {
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ExecutionManager',
        message: `Could not close ${tradeId} — not found in local open-positions tracking (already closed?)`,
        reproducible: false,
      });
      return;
    }
    try {
      const closed = await this.broker.closeAsync(trade);
      this.openPositions = this.openPositions.filter((t) => t.id !== tradeId);
      this.closedToday = [closed, ...this.closedToday];
      this.history = this.historyStore.append(closed);
      this.emitPositions();
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        module: 'ExecutionManager',
        message: `${trade.instrument} closed manually · ${closed.pnlR?.toFixed(2)}R`,
        reproducible: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ExecutionManager',
        message: `${tradeId} FAILED to close · ${message}`,
        reproducible: false,
      });
      throw err;
    }
  }

  status(): LiveStatus {
    return {
      connected: this.broker?.isConnected() ?? false,
      connectionStatus: this.connectionStatus,
      equity: this.broker?.accountEquity() ?? 0,
      broker: this.broker?.id ?? null,
      lotSize: this.lotSize,
      riskPercent: this.riskPercent,
    };
  }

  positions(): LivePosition[] {
    const now = Date.now();
    return this.openPositions.map((trade) => {
      const currentPrice = this.lastPriceByInstrument.get(trade.instrument) ?? null;
      const risk = Math.abs(trade.entry - trade.stop);
      const floatingR =
        currentPrice !== null && risk > 0
          ? Number(
              (((trade.side === 'LONG' ? currentPrice - trade.entry : trade.entry - currentPrice) / risk)).toFixed(2)
            )
          : null;
      return {
        ...trade,
        currentPrice,
        floatingR,
        elapsedMinutes: Math.max(0, Math.round((now - new Date(trade.timestamp).getTime()) / 60_000)),
      };
    });
  }

  getHistory(): ExecutedTrade[] {
    return this.history;
  }
}
