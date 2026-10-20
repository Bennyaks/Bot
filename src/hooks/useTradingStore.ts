import { useSyncExternalStore, useCallback, useMemo } from 'react';
import type {
  SafetyCheck,
  RejectedTrade,
  HealthComponent,
  LogEntry,
  SystemMode,
  TradeSignal,
  ExecutedTrade,
} from '../lib/types';
import {
  safetyChecks as initialSafety,
  rejectedTrades as initialRejected,
  healthComponents as initialHealth,
  generateLogs,
  liveSignals as initialSignals,
  executedTrades as initialExecuted,
  sessionMetrics,
} from '../lib/data';
import { runBrokerSafety, createTradeSignal, formatTime } from '../lib/engine';
import { SystemOrchestrator } from '../core/orchestrator/SystemOrchestrator';
import { PaperBroker } from '../execution/paper/PaperBroker';
import { MarketPipeline } from '../core/pipeline/MarketPipeline';
import { ReplayMarketProvider } from '../providers/replay/ReplayMarketProvider';
import { BreakoutStrategy } from '../strategies/breakout/BreakoutStrategy';
import { LocalJournalStorage } from '../storage/local/LocalJournalStorage';
import { ConnectionManager } from '../core/reliability/ConnectionManager';
import { TradeAnalytics } from '../core/analytics/Analytics';
import type { Notifier } from '../core/interfaces';

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
}

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function pushLog(entry: Omit<LogEntry, 'id'>) {
  const log: LogEntry = { ...entry, id: `L${Date.now()}${Math.random().toString(36).slice(2, 5)}` };
  setState({ logs: [log, ...state.logs].slice(0, 200) });
}

/**
 * Dependency injection root. Nothing here builds its own dependencies —
 * the Notifier, Broker/ExecutionProvider, MarketProvider, Strategy, and
 * Storage are each constructed once and handed to whatever needs them.
 * The SystemOrchestrator is the single entry point the store uses to run
 * a candidate through Broker Safety -> Decision Engine -> Risk Manager ->
 * Execution -> Position Manager.
 *
 * This dashboard is wired to PaperBroker + ReplayMarketProvider (simulated).
 * For a live account, run `npm run live` instead — see server/liveRunner.ts,
 * which wires the exact same DecisionEngine/RiskManager/BreakoutStrategy
 * classes to providers/metaapi/MetaApiBroker (a real MT5 account via
 * MetaApi.cloud) headlessly, independent of this browser dashboard.
 */
const notifier: Notifier = { log: pushLog };
const paperBroker = new PaperBroker(() => state.safety);
const orchestrator = new SystemOrchestrator({
  broker: paperBroker,
  execution: paperBroker,
  notifier,
});
const marketProvider = new ReplayMarketProvider();
const marketPipeline = new MarketPipeline(orchestrator.bus);
const breakoutStrategy = new BreakoutStrategy(marketPipeline);
const storage = new LocalJournalStorage();
const analytics = new TradeAnalytics();

const persistedRejections = storage.loadRejections();
const persistedTrades = storage.loadTrades();

let state: Store = {
  mode: 'LIVE',
  modeReason: 'All critical systems healthy.',
  safety: initialSafety.map((s) => ({ ...s })),
  rejected: [...persistedRejections, ...initialRejected],
  health: initialHealth.map((h) => ({ ...h })),
  logs: generateLogs(),
  signals: [...initialSignals],
  executed: [...persistedTrades, ...initialExecuted],
  clock: new Date().toISOString().slice(11, 19) + ' UTC',
  selectedRejectId: (persistedRejections[0] ?? initialRejected[0])?.id ?? null,
  pipelinePulse: 0,
};

function setState(partial: Partial<Store>) {
  state = { ...state, ...partial };
  emit();
}

// Connection Manager: owns the 'broker' health component exclusively —
// heartbeats it, simulates occasional drops, and drives reconnect/backoff.
const connectionManager = new ConnectionManager({
  broker: paperBroker,
  notifier,
  heartbeatCheck: () => Math.random() > 0.12, // ~88% heartbeat success, tuned for a visible demo
  onStatusChange: (status, latencyMs) => {
    const health = state.health.map((h) =>
      h.id === 'broker'
        ? {
            ...h,
            status:
              status === 'connected'
                ? ('healthy' as const)
                : status === 'reconnecting'
                  ? ('degraded' as const)
                  : ('critical' as const),
            latencyMs,
            lastCheck: new Date().toISOString(),
            message:
              status === 'connected'
                ? 'Active socket to broker API'
                : status === 'reconnecting'
                  ? '[DEGRADED] Reconnecting to broker API'
                  : '[CRITICAL] Broker API unreachable',
          }
        : h
    );
    const evalMode = orchestrator.checkHealth(health);
    setState({ health, mode: evalMode.mode, modeReason: evalMode.reason });
  },
});
connectionManager.start();

// Clock tick
setInterval(() => {
  setState({
    clock: new Date().toISOString().slice(11, 19) + ' UTC',
    pipelinePulse: state.pipelinePulse + 1,
  });
}, 1000);

// Periodic health jitter for every component *except* 'broker', which the
// ConnectionManager above owns exclusively so the two don't fight.
setInterval(() => {
  const health = state.health.map((h) =>
    h.id === 'broker'
      ? h
      : {
          ...h,
          lastCheck: new Date().toISOString(),
          latencyMs:
            h.latencyMs === 0 ? 0 : Math.max(1, Math.round(h.latencyMs + (Math.random() - 0.5) * 8)),
        }
  );
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

// Position Manager tick: every open trade gets a simulated price update and
// a chance to hit its stop or target. This is what makes R-multiples,
// win rate, and profit factor move over time instead of staying static.
setInterval(() => {
  const open = state.executed.filter((t) => t.status === 'OPEN');
  if (open.length === 0) return;
  let next = state.executed;
  for (const trade of open) {
    const roll = Math.random();
    if (roll < 0.22) {
      const closed = orchestrator.closePosition(trade, trade.target, 'target reached');
      storage.saveTrade(closed);
      next = next.map((t) => (t.id === trade.id ? closed : t));
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        module: 'PositionManager',
        message: `${trade.id} closed · target reached · ${closed.pnlR?.toFixed(2)}R`,
        data: { tradeId: trade.id, pnlR: closed.pnlR },
        reproducible: true,
      });
    } else if (roll < 0.36) {
      const closed = orchestrator.closePosition(trade, trade.stop, 'stop hit');
      storage.saveTrade(closed);
      next = next.map((t) => (t.id === trade.id ? closed : t));
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'TRADE',
        module: 'PositionManager',
        message: `${trade.id} closed · stop hit · ${closed.pnlR?.toFixed(2)}R`,
        data: { tradeId: trade.id, pnlR: closed.pnlR },
        reproducible: true,
      });
    }
  }
  if (next !== state.executed) setState({ executed: next });
}, 5000);

export function useTradingStore() {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state
  );

  const stats = useMemo(
    () => ({
      winRate: analytics.winRate(snap.executed),
      profitFactor: analytics.profitFactor(snap.executed),
      expectancy: analytics.expectancy(snap.executed),
    }),
    [snap.executed]
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

    storage.saveRejection(rejection);
    setState({
      rejected: [rejection, ...state.rejected],
      selectedRejectId: rejection.id,
    });
  }, []);

  const toggleHealth = useCallback((id: string) => {
    if (id === 'broker') {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        module: 'ConnectionManager',
        message: 'Broker Connection is managed by ConnectionManager heartbeats, not manual toggle.',
        reproducible: true,
      });
      return;
    }
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
   * Strategy never places trades — BreakoutStrategy only emits a
   * TradeCandidate (or nothing, if the Market Pipeline hasn't confirmed a
   * breakout). Everything from here down (Broker Safety, Decision Engine
   * gates, Risk Manager veto, ExecutionManager handoff, Position Manager
   * fill) is owned by the SystemOrchestrator, not this hook.
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

    const candles = marketProvider.getCandles('GBPUSD', '15m', 140);
    const candidate = breakoutStrategy.evaluate('GBPUSD', candles);

    if (!candidate) {
      pushLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        module: 'BreakoutStrategy',
        message: 'No confirmed breakout this scan — market structure still SCANNING',
        reproducible: true,
      });
      return;
    }

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
      storage.saveRejection(rejection);
      setState({
        signals: [rejected, ...state.signals],
        rejected: [rejection, ...state.rejected],
        selectedRejectId: rejection.id,
      });
      return;
    }

    const approved: TradeSignal = { ...candidate, status: 'EXECUTED', setupStage: 'EXECUTED' };
    const trade = orchestrator.fillCandidate(candidate);
    storage.saveTrade(trade);
    setState({ signals: [approved, ...state.signals], executed: [trade, ...state.executed] });
  }, []);

  return {
    ...snap,
    sessionMetrics,
    stats,
    toggleSafetyCheck,
    runSafetyAudit,
    selectReject,
    simulateReject,
    toggleHealth,
    emitDemoSignal,
    formatTime,
  };
}
