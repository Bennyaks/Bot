import { useSyncExternalStore, useCallback } from 'react';
import type {
  SafetyCheck,
  RejectedTrade,
  HealthComponent,
  LogEntry,
  SystemMode,
  TradeSignal,
  ExecutedTrade,
  Candle,
} from '../lib/types';
import {
  safetyChecks as initialSafety,
  rejectedTrades as initialRejected,
  healthComponents as initialHealth,
  generateLogs,
  liveSignals as initialSignals,
  executedTrades as initialExecuted,
  sessionMetrics,
  INSTRUMENTS,
} from '../lib/data';
import { getInstrumentSpec } from '../lib/instruments';
import { runBrokerSafety, createTradeSignal, formatTime } from '../lib/engine';
import { generateCandles } from '../lib/data';
import { SystemOrchestrator } from '../core/orchestrator/SystemOrchestrator';
import { PaperBroker } from '../execution/paper/PaperBroker';
import { MT5Broker } from '../execution/mt5/MT5Broker';
import { LocalStorageAdapter } from '../core/storage/LocalStorage';
import { TradeAnalytics, type AnalyticsSummary } from '../core/analytics/TradeAnalytics';
import { ConnectionManager } from '../core/connection/ConnectionManager';
import { ReplayMarketProvider } from '../providers/replay/ReplayMarketProvider';
import { CsvMarketProvider } from '../providers/csv/CsvMarketProvider';
import { ReplayController, type ReplaySpeed } from '../core/replay/ReplayController';
import type { TradeLifecycleState } from '../core/lifecycle/TradeLifecycle';
import { MarketStructureEngine } from '../core/market/MarketStructureEngine';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy';
import { BacktestHarness } from '../core/backtest/BacktestHarness';
import { CompositeNotifier } from '../core/notify/CompositeNotifier';
import type { Notifier, TradeCandidate } from '../core/interfaces';

const WEBHOOK_URL_KEY = 'trading-platform:webhook-url';
const DESKTOP_ALERTS_KEY = 'trading-platform:desktop-alerts';

function readLocalSetting(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalSetting(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // best-effort — settings are a convenience, not load-bearing
  }
}

interface Store {
  mode: SystemMode;
  modeReason: string;
  safety: SafetyCheck[];
  rejected: RejectedTrade[];
  health: HealthComponent[];
  logs: LogEntry[];
  signals: TradeSignal[];
  executed: ExecutedTrade[];
  clock: string;
  selectedRejectId: string | null;
  pipelinePulse: number;
  analytics: AnalyticsSummary;
  brokerConnected: boolean;
  brokerId: string;
  lastBacktest: BacktestSummary | null;
  desktopAlertsEnabled: boolean;
  webhookUrl: string | null;
  /** Instruments with a real historical CSV series loaded — runBacktest uses one of these automatically instead of synthetic candles when available. */
  csvInstruments: string[];
  replay: ReplayLabState;
}

export interface ReplayLabState {
  instrument: string;
  index: number;
  total: number;
  playing: boolean;
  speed: ReplaySpeed;
  complete: boolean;
  dataSource: 'csv' | 'synthetic';
  /** Rolling window of the most recently emitted candles, capped for chart rendering — index/total above track the FULL series position, this is just what's currently drawn. */
  windowCandles: Candle[];
  /** A trade opened mid-replay via replayTryOpenTrade, managed bar-by-bar through the exact same orchestrator.manageOpenPosition every other trade in this app goes through. */
  openTrade: ExecutedTrade | null;
  /** The open trade's current lifecycle state (see core/lifecycle/TradeLifecycle) — CANDIDATE through ARCHIVED, kept in sync as manageOpenPosition runs. */
  lifecycleState: TradeLifecycleState | null;
}

export interface BacktestSummary {
  ranAt: string;
  instrument: string;
  candles: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  rejectionsByModule: Record<string, number>;
  startingEquity: number;
  finalEquity: number;
  netProfitUsd: number;
  /** Whether this run used real uploaded CSV history or the synthetic generator. */
  dataSource: 'csv' | 'synthetic';
}

/**
 * Dependency injection root. Nothing here builds its own dependencies —
 * Storage, Analytics, the Notifier, and Broker/ExecutionProvider are
 * constructed once and handed to the SystemOrchestrator, which is the
 * single entry point the store uses to run a candidate through
 * Broker Safety -> Decision Engine -> Risk Manager -> Execution, and the
 * single place Storage/Analytics subscribe to what happens next.
 */
const storage = new LocalStorageAdapter();
const analytics = new TradeAnalytics();
// CompositeNotifier wraps the in-app log stream with real out-of-band
// alerts (desktop Notification + webhook POST) for ERROR/SAFETY entries —
// previously "alert user" meant nothing beyond a log line nobody might see.
const baseNotifier: Notifier = { log: pushLog };
const notifier: Notifier = new CompositeNotifier(baseNotifier, {
  desktopEnabled: () => state.desktopAlertsEnabled,
  webhookUrl: () => state.webhookUrl,
});
const paperBroker = new PaperBroker(() => state.safety);
const mt5Broker = new MT5Broker(() => state.safety);

// Phase 2/3 — real market structure detection and a Strategy implementation
// that reads off it, instead of the hand-authored demo candidate below.
// Constructed before the orchestrator so it can be injected as
// OrchestratorDeps.marketProvider (needed for the spread_cost gate + real
// fill pricing) instead of the orchestrator running with no spread data.
const replayMarket = new ReplayMarketProvider();
// Real historical OHLC data, when the user loads it — same MarketProvider
// interface as replayMarket, so BacktestHarness doesn't care which candles
// it was handed. Nothing is loaded by default; runBacktest falls back to
// the synthetic generator for any instrument with no CSV loaded.
const csvMarketProvider = new CsvMarketProvider();

/**
 * Replay Lab (Phase 15) singleton state. Not part of `Store` — a
 * ReplayController owns real timers and must not be reconstructed on every
 * render, so it lives here the same way orchestrator/replayMarket do.
 * replayOpenTradeContext tracks the bar index and initial stop of whatever
 * trade is currently open in the lab, since advancePosition needs both for
 * its timeout/trailing-stop-vs-stop labelling and neither belongs on the
 * ExecutedTrade object itself.
 */
let replayController: ReplayController | null = null;
let replayOpenTradeContext: { entryIndex: number; initialStop: number } | null = null;

const orchestrator = new SystemOrchestrator({
  broker: paperBroker,
  execution: paperBroker,
  notifier,
  storage,
  analytics,
  marketProvider: replayMarket,
});
const marketStructureEngine = new MarketStructureEngine(replayMarket, orchestrator.bus);
const breakoutStrategy = new BreakoutStrategy();
const connectionManager = new ConnectionManager(paperBroker, orchestrator.bus);

// Phase 14 — runs the exact same DecisionEngine/RiskManager instances the
// live pipeline uses, just synchronously over historical candles.
const backtestHarness = new BacktestHarness(breakoutStrategy);

// Merge whatever the Trade Journal already persisted (Phase 8) with the
// bundled demo data, so a refresh shows real history instead of resetting.
const persistedTrades = orchestrator.loadPersistedTrades();
const persistedRejections = orchestrator.loadPersistedRejections();
// Audit trail beyond the in-memory rolling 200-line buffer (see
// LocalStorageAdapter.saveLog/loadLogs) — merged with the demo log lines so
// a refresh shows real history instead of only ever showing canned data.
const persistedLogs = storage.loadLogs?.() ?? [];

let state: Store = {
  mode: 'LIVE',
  modeReason: 'All critical systems healthy.',
  safety: initialSafety.map((s) => ({ ...s })),
  rejected: [...persistedRejections, ...initialRejected],
  health: initialHealth.map((h) => ({ ...h })),
  logs: [...persistedLogs, ...generateLogs()].slice(0, 200),
  signals: [...initialSignals],
  executed: [...persistedTrades, ...initialExecuted.filter((t) => !persistedTrades.some((p) => p.id === t.id))],
  clock: new Date().toISOString().slice(11, 19) + ' UTC',
  selectedRejectId: (persistedRejections[0] ?? initialRejected[0])?.id ?? null,
  pipelinePulse: 0,
  analytics: orchestrator.getAnalyticsSummary(),
  brokerConnected: paperBroker.isConnected(),
  brokerId: orchestrator.currentBrokerId(),
  lastBacktest: null,
  desktopAlertsEnabled: readLocalSetting(DESKTOP_ALERTS_KEY) === '1',
  webhookUrl: readLocalSetting(WEBHOOK_URL_KEY),
  csvInstruments: [],
  replay: {
    instrument: 'EURUSD',
    index: 0,
    total: 0,
    playing: false,
    speed: 1,
    complete: false,
    dataSource: 'synthetic',
    windowCandles: [],
    openTrade: null,
    lifecycleState: null,
  },
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function setState(partial: Partial<Store>) {
  state = { ...state, ...partial };
  emit();
}

function pushLog(entry: Omit<LogEntry, 'id'>) {
  const log: LogEntry = { ...entry, id: `L${Date.now()}${Math.random().toString(36).slice(2, 5)}` };
  // Full history goes to Storage (the audit trail); only the most recent
  // 200 lines stay in the in-memory Decision Log Stream the UI renders.
  storage.saveLog?.(log);
  setState({ logs: [log, ...state.logs].slice(0, 200) });
}

/**
 * Shared by emitDemoSignal and runMarketScan: an approved candidate gets
 * filled, then managed bar-by-bar against a real (if synthetic) forward
 * price path through the exact same advancePosition() logic
 * BacktestHarness uses — not a random timer. Breakeven, trailing, stop,
 * target, and timeout are all decided by real price movement against the
 * trade's levels, exactly like a backtest, so "replay" and "live" no
 * longer disagree about what management even means.
 */
async function fillAndSimulateClose(candidate: TradeCandidate, source: string) {
  let trade: ExecutedTrade;
  try {
    trade = await orchestrator.fillCandidate(candidate);
  } catch (err) {
    // A real ExecutionProvider can genuinely reject a submit (margin,
    // liquidity, a requote) — PaperBroker's rejectionProbability makes that
    // real instead of theoretical. There is no position to track here; log
    // it and stop, rather than pushing a half-formed trade into state.
    const message = err instanceof Error ? err.message : String(err);
    pushLog({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      module: 'ExecutionManager',
      message: `${candidate.id} not filled · ${message}`,
      reproducible: true,
    });
    return;
  }

  setState({ executed: [trade, ...state.executed] });
  pushLog({
    timestamp: new Date().toISOString(),
    level: 'TRADE',
    module: 'ExecutionManager',
    message: `${trade.id} filled · ${trade.instrument} ${trade.side} @ ${trade.entry.toFixed(5)} (${source})`,
    reproducible: true,
  });

  // A forward-looking price path anchored at the real entry price — the
  // same generator BacktestHarness runs candidates over, just seeded to
  // start where this specific trade opened instead of at a fixed base.
  const spec = getInstrumentSpec(trade.instrument);
  const path = generateCandles(60, trade.entry, spec.volatilityFactor);
  const maxHoldBars = 30;
  const tickIntervalMs = 350;
  let barIndex = 0;
  const initialStop = trade.stop;

  const tick = () => {
    const live = state.executed.find((t) => t.id === trade.id);
    if (!live || live.status !== 'OPEN') return; // closed elsewhere / superseded

    barIndex += 1;
    const candle = path[Math.min(barIndex - 1, path.length - 1)];
    const result = orchestrator.manageOpenPosition(live, candle, {
      entryIndex: 0,
      barIndex,
      maxHoldBars,
      initialStop,
    });

    setState({ executed: state.executed.map((t) => (t.id === result.trade.id ? result.trade : t)) });

    const moveAction = result.actions.find((a) => a.type === 'MOVE_STOP');
    if (moveAction && moveAction.type === 'MOVE_STOP') {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'PositionManager',
        message: `${result.trade.id} stop moved to ${moveAction.to.toFixed(5)} (${moveAction.reason})`,
        reproducible: true,
      });
    }

    if (result.closed) {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        module: 'PositionManager',
        message: `${result.trade.id} closed · ${result.trade.status} (${result.trade.pnlR}R) · ${result.actions.find((a) => a.type === 'CLOSE')?.reason ?? 'closed'}`,
        reproducible: true,
      });
      return;
    }

    setTimeout(tick, tickIntervalMs);
  };

  setTimeout(tick, tickIntervalMs);
}

// Bus subscriptions the store cares about directly (everything else — Storage,
// Analytics — subscribes for itself inside the Orchestrator's constructor).
// AnalyticsUpdated keeps the Journal/Dashboard's headline stats live without
// the store recomputing them; BrokerConnectionChanged reflects the Connection
// Manager's reconnect state so the UI never has to poll it.
orchestrator.bus.on('AnalyticsUpdated', (summary) => setState({ analytics: summary }));
orchestrator.bus.on('BrokerConnectionChanged', ({ connected, reason }) => {
  pushLog({
    timestamp: new Date().toISOString(),
    level: connected ? 'INFO' : 'ERROR',
    module: 'ConnectionManager',
    message: reason,
    reproducible: true,
  });
  setState({ brokerConnected: connected });
});
connectionManager.start(5000);

// Clock tick
setInterval(() => {
  setState({
    clock: new Date().toISOString().slice(11, 19) + ' UTC',
    pipelinePulse: state.pipelinePulse + 1,
  });
}, 1000);

// Periodic health / market simulation — routed through the orchestrator so
// SAFE_MODE transitions are published on the EventBus (SystemModeChanged)
// for any future subscriber (Analytics, Notifier) in addition to the log line.
setInterval(() => {
  const health = state.health.map((h) => ({
    ...h,
    lastCheck: new Date().toISOString(),
    latencyMs:
      h.latencyMs === 0
        ? 0
        : Math.max(1, Math.round(h.latencyMs + (Math.random() - 0.5) * 8)),
  }));
  const evalMode = orchestrator.checkHealth(health);
  if (evalMode.mode !== state.mode) {
    pushLog({
      timestamp: new Date().toISOString(),
      level: evalMode.mode === 'SAFE_MODE' ? 'ERROR' : 'INFO',
      module: 'Diagnostics',
      message: `System mode → ${evalMode.mode}: ${evalMode.reason}`,
      reproducible: true,
    });
  }
  setState({ health, mode: evalMode.mode, modeReason: evalMode.reason });
}, 4000);

export function useTradingStore() {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state
  );

  const toggleSafetyCheck = useCallback((id: string) => {
    const safety = state.safety.map((c) =>
      c.id === id
        ? {
            ...c,
            passed: !c.passed,
            detail: !c.passed ? c.detail.replace('FAIL · ', '') : `FAIL · ${c.detail}`,
          }
        : c
    );
    const result = runBrokerSafety(safety);
    pushLog({
      timestamp: new Date().toISOString(),
      level: 'SAFETY',
      module: 'BrokerSafety',
      message: result.passed
        ? 'All pre-trade checks passed'
        : `Safety failure: ${result.failed.join(', ')} — trade rejected`,
      data: { failed: result.failed },
      reproducible: true,
    });
    setState({ safety: result.results });
  }, []);

  const runSafetyAudit = useCallback(() => {
    const result = runBrokerSafety(state.safety);
    pushLog({
      timestamp: new Date().toISOString(),
      level: result.passed ? 'SAFETY' : 'ERROR',
      module: 'BrokerSafety',
      message: result.passed
        ? `Safety audit complete · ${result.results.length}/8 checks passed`
        : `Audit REJECT · ${result.failed.join(', ')}`,
      data: { passed: result.passed, failed: result.failed },
      reproducible: true,
    });
    return result;
  }, []);

  const selectReject = useCallback((id: string) => {
    setState({ selectedRejectId: id });
  }, []);

  const simulateReject = useCallback(() => {
    const candidate = createTradeSignal({
      instrument: 'EURUSD',
      timeframe: '15m',
      side: 'LONG',
      entry: 1.084,
      stop: 1.0815,
      target: 1.086,
      confidence: 0.29 + Math.random() * 0.2,
      session: 'Asian',
      marketRegime: 'RANGING',
      strategyVersion: 'v1.4',
      riskReward: 1.0 + Math.random() * 0.4,
      indicators: {
        atr: 0.0011,
        volumeRatio: Number((0.5 + Math.random() * 0.4).toFixed(2)),
      },
      structure: 'Weak displacement, unconfirmed BOS',
    });

    // Force through the Decision Engine so the rejection is real, explainable
    // gate output rather than a hand-authored RejectedTrade object.
    const result = orchestrator.submitCandidate(candidate, {
      safety: state.safety,
      sessionMetrics,
      openPositions: state.executed.filter((t) => t.status === 'OPEN'),
      closedToday: state.executed.filter((t) => t.status !== 'OPEN'),
    });

    const reasons = result.rejectionReasons ?? ['Weak Volume', 'Low Confidence', 'No Displacement'];
    const rejection: RejectedTrade = {
      id: `RJ-${Date.now().toString(36).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      instrument: candidate.instrument,
      timeframe: candidate.timeframe,
      side: candidate.side,
      setupStage: 'VOLUME_CHECK',
      failedRules: reasons,
      marketRegime: candidate.marketRegime,
      confidence: candidate.confidence,
      supportingData: {
        volumeRatio: candidate.indicators.volumeRatio ?? 0,
        riskReward: candidate.riskReward,
        bosConfirmed: false,
        atr: candidate.indicators.atr ?? 0,
        rejectedBy: result.rejectionModule ?? 'DecisionEngine',
      },
      reasons,
      session: candidate.session,
    };

    setState({
      rejected: [rejection, ...state.rejected],
      selectedRejectId: rejection.id,
    });
  }, []);

  const toggleHealth = useCallback((id: string) => {
    const health = state.health.map((h) => {
      if (h.id !== id) return h;
      const next =
        h.status === 'healthy' ? 'critical' : h.status === 'critical' ? 'degraded' : 'healthy';
      return {
        ...h,
        status: next as HealthComponent['status'],
        message:
          next === 'healthy'
            ? h.message.replace(/\[.*\]\s*/, '')
            : `[${next.toUpperCase()}] ${h.message}`,
        lastCheck: new Date().toISOString(),
      };
    });
    const evalMode = orchestrator.checkHealth(health);
    pushLog({
      timestamp: new Date().toISOString(),
      level: evalMode.mode === 'SAFE_MODE' ? 'ERROR' : 'WARN',
      module: 'Diagnostics',
      message: `Component ${id} toggled · mode ${evalMode.mode}`,
      data: { mode: evalMode.mode, reason: evalMode.reason },
      reproducible: true,
    });
    setState({ health, mode: evalMode.mode, modeReason: evalMode.reason });
  }, []);

  /**
   * Strategy never places trades — it only emits a TradeCandidate. Everything
   * from here down (Broker Safety, Decision Engine gates, Risk Manager veto,
   * ExecutionManager handoff) is owned by the SystemOrchestrator, not this hook.
   */
  const emitDemoSignal = useCallback(() => {
    if (state.mode === 'SAFE_MODE') {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ExecutionEngine',
        message: 'SAFE MODE active — signal discarded, no new trades',
        reproducible: true,
      });
      return;
    }

    const candidate = createTradeSignal({
      instrument: 'GBPUSD',
      timeframe: '15m',
      side: Math.random() > 0.5 ? 'LONG' : 'SHORT',
      entry: 1.2645 + Math.random() * 0.002,
      stop: 1.262,
      target: 1.2695,
      confidence: 0.7 + Math.random() * 0.2,
      session: 'London',
      marketRegime: 'TRENDING_BULL',
      strategyVersion: 'v1.4',
      riskReward: 2.0,
      indicators: {
        atr: 0.0014,
        rsi: 55,
        volumeRatio: 1.6,
        adx: 26,
      },
      structure: 'Confirmed BOS with volume expansion',
    });

    const result = orchestrator.submitCandidate(candidate, {
      safety: state.safety,
      sessionMetrics,
      openPositions: state.executed.filter((t) => t.status === 'OPEN'),
      closedToday: state.executed.filter((t) => t.status !== 'OPEN'),
    });

    if (result.outcome !== 'approved') {
      const reasons = result.rejectionReasons ?? ['Unknown'];
      const rejection: RejectedTrade = {
        id: `RJ-${Date.now().toString(36).toUpperCase()}`,
        timestamp: new Date().toISOString(),
        instrument: candidate.instrument,
        timeframe: candidate.timeframe,
        side: candidate.side,
        setupStage: 'RISK_EVAL',
        failedRules: reasons.map((r) => `${result.rejectionModule ?? 'Engine'}: ${r}`),
        marketRegime: candidate.marketRegime,
        confidence: candidate.confidence,
        supportingData: { rejectedBy: result.rejectionModule ?? 'unknown' },
        reasons,
        session: candidate.session,
      };
      const rejected: TradeSignal = { ...candidate, status: 'REJECTED', setupStage: 'REJECTED' };
      setState({
        signals: [rejected, ...state.signals],
        rejected: [rejection, ...state.rejected],
        selectedRejectId: rejection.id,
      });
      return;
    }

    const approved: TradeSignal = { ...candidate, status: 'APPROVED', setupStage: 'RISK_APPROVED' };
    setState({ signals: [approved, ...state.signals] });

    // Approval alone isn't a position — hand it to the shared fill/hold/close
    // helper so it actually opens through the ExecutionProvider, gets
    // managed, and closes through PositionManager -> Storage -> Analytics.
    void fillAndSimulateClose(candidate, 'demo signal');
  }, []);

  /**
   * Phase 2/3 — pulls real candles, runs the Market Structure Engine over
   * them (publishing SwingDetected/BreakoutDetected on the bus), and asks
   * BreakoutStrategy for a candidate off that structure. Unlike
   * emitDemoSignal this candidate isn't hand-authored — it only exists if
   * the strategy actually found a fresh, volume-confirmed break.
   *
   * Previously this only ever scanned 'EURUSD' — INSTRUMENTS listed six
   * symbols but nothing looped over them, so five of the six never ran.
   * This scans every instrument in turn and submits a candidate for each
   * one that produces a qualifying setup, instead of just the first.
   */
  const runMarketScan = useCallback(() => {
    if (state.mode === 'SAFE_MODE') {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ExecutionEngine',
        message: 'SAFE MODE active — market scan skipped, no new trades',
        reproducible: true,
      });
      return;
    }

    let qualifyingSetups = 0;

    for (const instrument of INSTRUMENTS) {
      const snapshot = marketStructureEngine.scan(instrument, '15m', 150);
      const candidate = breakoutStrategy.evaluate(instrument, replayMarket.getCandles(instrument, '15m', 150));

      if (!candidate) {
        pushLog({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          module: 'BreakoutStrategy',
          message: `No qualifying setup on ${instrument} · trend ${snapshot.trend}, ${snapshot.breaks.length} break(s) in window`,
          reproducible: true,
        });
        continue;
      }
      qualifyingSetups += 1;

      const result = orchestrator.submitCandidate(candidate, {
        safety: state.safety,
        sessionMetrics,
        openPositions: state.executed.filter((t) => t.status === 'OPEN'),
        closedToday: state.executed.filter((t) => t.status !== 'OPEN'),
      });

      if (result.outcome !== 'approved') {
        const reasons = result.rejectionReasons ?? ['Unknown'];
        const rejection: RejectedTrade = {
          id: `RJ-${Date.now().toString(36).toUpperCase()}`,
          timestamp: new Date().toISOString(),
          instrument: candidate.instrument,
          timeframe: candidate.timeframe,
          side: candidate.side,
          setupStage: 'RISK_EVAL',
          failedRules: reasons.map((r) => `${result.rejectionModule ?? 'Engine'}: ${r}`),
          marketRegime: candidate.marketRegime,
          confidence: candidate.confidence,
          supportingData: { rejectedBy: result.rejectionModule ?? 'unknown' },
          reasons,
          session: candidate.session,
        };
        const rejected: TradeSignal = { ...candidate, status: 'REJECTED', setupStage: 'REJECTED' };
        setState({
          signals: [rejected, ...state.signals],
          rejected: [rejection, ...state.rejected],
          selectedRejectId: rejection.id,
        });
        continue;
      }

      const approved: TradeSignal = { ...candidate, status: 'APPROVED', setupStage: 'RISK_APPROVED' };
      setState({ signals: [approved, ...state.signals] });
      void fillAndSimulateClose(candidate, `market scan · ${candidate.structure}`);
    }

    pushLog({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      module: 'MarketStructureEngine',
      message: `Multi-symbol scan complete · ${INSTRUMENTS.length} instruments · ${qualifyingSetups} qualifying setup(s)`,
      reproducible: true,
    });
  }, []);

  /** Phase 13 — swap the live Broker/ExecutionProvider between PaperBroker and the simulated MT5 adapter. */
  const toggleBroker = useCallback(() => {
    const usingPaper = state.brokerId === paperBroker.id;
    const next = usingPaper ? mt5Broker : paperBroker;
    orchestrator.setBroker(next);
    orchestrator.setExecution(next);
    connectionManager.setBroker(next);
    pushLog({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      module: 'SystemOrchestrator',
      message: `Broker switched to ${next.id}`,
      reproducible: true,
    });
    setState({ brokerId: next.id, brokerConnected: next.isConnected() });
  }, []);

  /** Diagnostics -> "Force Reconnect" — manually retriggers the backoff cycle on the current broker. */
  const forceReconnect = useCallback(() => {
    connectionManager.forceReconnect();
  }, []);

  /**
   * Phase 14 — runs BreakoutStrategy through the exact same DecisionEngine
   * and RiskManager instances used live, over either real uploaded CSV
   * history (if loaded for this instrument — see loadCsvHistory) or a
   * fresh batch of generated candles otherwise, entirely synchronously (no
   * timers, no UI trade objects). Sizes every simulated fill against a
   * real running equity curve via PositionSizer instead of a hardcoded
   * lot, and prices the instrument's typical spread into both the
   * Decision Engine gate and the fills.
   */
  const runBacktest = useCallback((instrument: string = 'EURUSD') => {
    const useCsv = csvMarketProvider.hasData(instrument);
    const candles = useCsv
      ? csvMarketProvider.getFullSeries(instrument)
      : generateCandles(400, getInstrumentSpec(instrument).basePrice, getInstrumentSpec(instrument).volatilityFactor);
    const startingEquity = 10_000;
    // A short CSV upload (a few hundred candles, say) shouldn't lose its
    // entire usable range to a windowSize built for the 400-candle
    // synthetic default — clamp it down for small real datasets.
    const windowSize = Math.min(60, Math.max(15, Math.floor(candles.length / 4)));
    const result = backtestHarness.run(candles, {
      instrument,
      sessionMetrics,
      windowSize,
      maxHoldBars: 30,
      startingEquity,
    });
    const summary: BacktestSummary = {
      ranAt: new Date().toISOString(),
      instrument,
      candles: candles.length,
      trades: result.trades.length,
      winRate: result.summary.winRate,
      profitFactor: result.summary.profitFactor,
      expectancy: result.summary.expectancy,
      rejectionsByModule: result.rejectionsByModule,
      startingEquity: result.startingEquity,
      finalEquity: result.finalEquity,
      netProfitUsd: result.netProfitUsd,
      dataSource: useCsv ? 'csv' : 'synthetic',
    };
    pushLog({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      module: 'BacktestHarness',
      message: `Backtest complete · ${instrument} (${summary.dataSource}) · ${summary.trades} trades · ${summary.winRate}% WR · PF ${summary.profitFactor} · net ${summary.netProfitUsd >= 0 ? '+' : ''}$${summary.netProfitUsd} (equity $${startingEquity} → $${summary.finalEquity})`,
      data: { rejectionsByModule: summary.rejectionsByModule },
      reproducible: true,
    });
    setState({ lastBacktest: summary });
  }, []);

  /**
   * Diagnostics -> "Load Historical Data". Parses and stores a real OHLC
   * CSV for one instrument so the next runBacktest() call for that
   * instrument uses it automatically instead of synthetic candles — a
   * strategy that only ever sees a random walk never gets exercised
   * against real ranging periods, spikes, or liquidity sweeps.
   */
  const loadCsvHistory = useCallback((instrument: string, csvText: string) => {
    const result = csvMarketProvider.loadCsv(instrument, csvText);
    pushLog({
      timestamp: new Date().toISOString(),
      level: result.candles.length > 0 ? 'INFO' : 'ERROR',
      module: 'CsvMarketProvider',
      message:
        result.candles.length > 0
          ? `Loaded ${result.candles.length} candles of real history for ${instrument}${result.skippedRows > 0 ? ` (${result.skippedRows} row(s) skipped)` : ''} — next backtest on ${instrument} will use it.`
          : `Could not parse any candles from the uploaded file for ${instrument}.`,
      data: { notes: result.notes },
      reproducible: true,
    });
    setState({ csvInstruments: csvMarketProvider.loadedInstruments() });
    return result;
  }, []);

  const clearCsvHistory = useCallback((instrument: string) => {
    csvMarketProvider.clear(instrument);
    setState({ csvInstruments: csvMarketProvider.loadedInstruments() });
  }, []);

  /**
   * Replay Lab (Phase 15) — turns a fixed candle series into a controllable
   * playback: play/pause/step/speed/seek, instead of a series that only
   * ever ran forward once at a fixed cadence with no way to inspect a
   * specific bar. Loads real CSV history for `instrument` if one is loaded
   * (see loadCsvHistory), otherwise a fresh synthetic series — same
   * data-source rule runBacktest uses.
   */
  const startReplay = useCallback((instrument: string) => {
    replayController?.dispose();
    replayOpenTradeContext = null;

    const useCsv = csvMarketProvider.hasData(instrument);
    const spec = getInstrumentSpec(instrument);
    const candles = useCsv
      ? csvMarketProvider.getFullSeries(instrument)
      : generateCandles(300, spec.basePrice, spec.volatilityFactor);

    setState({
      replay: {
        instrument,
        index: 0,
        total: candles.length,
        playing: false,
        speed: 1,
        complete: false,
        dataSource: useCsv ? 'csv' : 'synthetic',
        windowCandles: [],
        openTrade: null,
        lifecycleState: null,
      },
    });

    replayController = new ReplayController(candles, {
      baseIntervalMs: 700,
      onCandle: (candle, index) => {
        const windowCandles = [...state.replay.windowCandles, candle].slice(-150);
        setState({ replay: { ...state.replay, windowCandles } });

        // Whatever's open gets managed against every real bar the replay
        // plays — the same advancePosition() call BacktestHarness and the
        // live pipeline use, so what you watch here is exactly what would
        // have happened either of those other two ways.
        const openTrade = state.replay.openTrade;
        if (openTrade && openTrade.status === 'OPEN' && replayOpenTradeContext) {
          const result = orchestrator.manageOpenPosition(openTrade, candle, {
            entryIndex: replayOpenTradeContext.entryIndex,
            barIndex: index,
            maxHoldBars: 200,
            initialStop: replayOpenTradeContext.initialStop,
          });
          setState({
            replay: {
              ...state.replay,
              openTrade: result.trade,
              lifecycleState: orchestrator.lifecycleStateOf(result.trade.id),
            },
          });

          const moveAction = result.actions.find((a) => a.type === 'MOVE_STOP');
          if (moveAction && moveAction.type === 'MOVE_STOP') {
            pushLog({
              timestamp: new Date().toISOString(),
              level: 'INFO',
              module: 'ReplayLab',
              message: `${result.trade.id} stop moved to ${moveAction.to.toFixed(5)} (${moveAction.reason}) at bar ${index}`,
              reproducible: true,
            });
          }
          if (result.closed) {
            replayOpenTradeContext = null;
            pushLog({
              timestamp: new Date().toISOString(),
              level: 'TRADE',
              module: 'ReplayLab',
              message: `${result.trade.id} closed · ${result.trade.status} (${result.trade.pnlR}R) at bar ${index}`,
              reproducible: true,
            });
          }
        }
      },
      onStateChange: (controllerState) => {
        setState({
          replay: {
            ...state.replay,
            index: controllerState.index,
            total: controllerState.total,
            playing: controllerState.playing,
            speed: controllerState.speed,
            complete: controllerState.complete,
          },
        });
      },
      onComplete: () => {
        pushLog({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          module: 'ReplayLab',
          message: `Replay of ${instrument} complete (${candles.length} candles, ${useCsv ? 'real history' : 'synthetic'}).`,
          reproducible: true,
        });
      },
    });
  }, []);

  const replayPlay = useCallback(() => {
    replayController?.play();
  }, []);

  const replayPause = useCallback(() => {
    replayController?.pause();
  }, []);

  const replayStep = useCallback(() => {
    replayController?.step();
  }, []);

  const replaySetSpeed = useCallback((speed: ReplaySpeed) => {
    replayController?.setSpeed(speed);
  }, []);

  const replaySeek = useCallback((index: number) => {
    replayController?.seek(index);
    // Jumping to a different point invalidates the chart window and any
    // open trade's tracked context — a trade opened at bar 40 doesn't mean
    // anything once the user has scrubbed back to bar 10.
    replayOpenTradeContext = null;
    setState({ replay: { ...state.replay, windowCandles: [], openTrade: null, lifecycleState: null } });
  }, []);

  const replayReset = useCallback(() => {
    replayController?.reset();
    replayOpenTradeContext = null;
    setState({ replay: { ...state.replay, windowCandles: [], openTrade: null, lifecycleState: null } });
  }, []);

  /**
   * Try to open a trade at the current replay position — runs
   * BreakoutStrategy over the candles played so far (the exact same
   * strategy, DecisionEngine, and RiskManager the live pipeline uses) and,
   * if it produces an approved candidate, fills it and starts managing it
   * bar-by-bar as replay continues. This is the actual point of a replay
   * controller: pause exactly where a setup formed, open it, then step
   * forward one bar at a time and watch PositionManager's real decisions
   * instead of only ever seeing an aggregate backtest result.
   */
  const replayTryOpenTrade = useCallback(async () => {
    if (state.replay.openTrade && state.replay.openTrade.status === 'OPEN') {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'ReplayLab',
        message: 'A trade is already open in the replay — close it or let it finish first.',
        reproducible: true,
      });
      return;
    }
    if (state.replay.windowCandles.length < 10) {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'ReplayLab',
        message: 'Not enough candles played yet to evaluate a setup — step or play forward first.',
        reproducible: true,
      });
      return;
    }

    const candidate = breakoutStrategy.evaluate(state.replay.instrument, state.replay.windowCandles);
    if (!candidate) {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'ReplayLab',
        message: `No qualifying setup on ${state.replay.instrument} at this point in the replay.`,
        reproducible: true,
      });
      return;
    }

    const result = orchestrator.submitCandidate(candidate, {
      safety: state.safety,
      sessionMetrics,
      openPositions: [],
      closedToday: [],
    });
    if (result.outcome !== 'approved') {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'REJECT',
        module: 'ReplayLab',
        message: `Setup found but rejected by ${result.rejectionModule} · ${(result.rejectionReasons ?? []).join(', ')}`,
        reproducible: true,
      });
      return;
    }

    try {
      const trade = await orchestrator.fillCandidate(candidate);
      replayOpenTradeContext = { entryIndex: state.replay.index, initialStop: trade.stop };
      setState({ replay: { ...state.replay, openTrade: trade, lifecycleState: orchestrator.lifecycleStateOf(trade.id) } });
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        module: 'ReplayLab',
        message: `${trade.id} opened in replay · ${trade.instrument} ${trade.side} @ ${trade.entry.toFixed(5)} — play or step forward to watch it managed.`,
        reproducible: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        module: 'ReplayLab',
        message: `Replay fill rejected · ${message}`,
        reproducible: true,
      });
    }
  }, []);

  /** Flatten whatever's open in the replay at the current bar's close, without waiting for a stop/target/timeout. */
  const replayCloseTrade = useCallback(() => {
    const openTrade = state.replay.openTrade;
    if (!openTrade || openTrade.status !== 'OPEN') return;
    const lastCandle = state.replay.windowCandles[state.replay.windowCandles.length - 1];
    const exitPrice = lastCandle ? lastCandle.close : openTrade.entry;
    const closed = orchestrator.closePosition(openTrade, exitPrice, 'manual close (replay)');
    replayOpenTradeContext = null;
    setState({ replay: { ...state.replay, openTrade: closed, lifecycleState: orchestrator.lifecycleStateOf(closed.id) } });
    pushLog({
      timestamp: new Date().toISOString(),
      level: 'TRADE',
      module: 'ReplayLab',
      message: `${closed.id} manually closed in replay · ${closed.status} (${closed.pnlR}R)`,
      reproducible: true,
    });
  }, []);

  /** Diagnostics -> notification settings. Desktop alerts need a user-gesture permission request; the webhook is just a URL saved locally. */
  const requestDesktopAlerts = useCallback(async () => {
    const permission = await CompositeNotifier.requestPermission();
    const granted = permission === 'granted';
    writeLocalSetting(DESKTOP_ALERTS_KEY, granted ? '1' : null);
    pushLog({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      module: 'CompositeNotifier',
      message: granted
        ? 'Desktop alerts enabled for ERROR/SAFETY events'
        : `Desktop alert permission ${permission} — alerts stay in-app only`,
      reproducible: true,
    });
    setState({ desktopAlertsEnabled: granted });
  }, []);

  const disableDesktopAlerts = useCallback(() => {
    writeLocalSetting(DESKTOP_ALERTS_KEY, null);
    setState({ desktopAlertsEnabled: false });
  }, []);

  const setWebhookUrl = useCallback((url: string) => {
    const trimmed = url.trim();
    writeLocalSetting(WEBHOOK_URL_KEY, trimmed || null);
    pushLog({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      module: 'CompositeNotifier',
      message: trimmed ? 'Webhook configured for ERROR/SAFETY events' : 'Webhook cleared',
      reproducible: true,
    });
    setState({ webhookUrl: trimmed || null });
  }, []);

  return {
    ...snap,
    sessionMetrics,
    toggleSafetyCheck,
    runSafetyAudit,
    selectReject,
    simulateReject,
    toggleHealth,
    emitDemoSignal,
    runMarketScan,
    toggleBroker,
    forceReconnect,
    runBacktest,
    loadCsvHistory,
    clearCsvHistory,
    startReplay,
    replayPlay,
    replayPause,
    replayStep,
    replaySetSpeed,
    replaySeek,
    replayReset,
    replayTryOpenTrade,
    replayCloseTrade,
    requestDesktopAlerts,
    disableDesktopAlerts,
    setWebhookUrl,
    formatTime,
  };
}
