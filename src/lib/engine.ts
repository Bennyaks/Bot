import type {
  SafetyCheck,
  TradeSignal,
  RejectedTrade,
  SessionName,
  MarketRegime,
  SetupStage,
  HealthComponent,
  SystemMode,
} from './types';
import { getCurrentSession } from './data';

/** Broker Safety Engine — all checks must pass or trade is rejected */
export function runBrokerSafety(
  checks: SafetyCheck[],
  overrides?: Partial<Record<string, boolean>>
): { passed: boolean; results: SafetyCheck[]; failed: string[] } {
  const results = checks.map((c) => ({
    ...c,
    passed: overrides && c.id in overrides ? Boolean(overrides[c.id]) : c.passed,
  }));
  const failed = results.filter((r) => !r.passed).map((r) => r.label);
  return { passed: failed.length === 0, results, failed };
}

/** Session Intelligence — weight and gate by historical evidence */
export function sessionScore(
  session: SessionName,
  metrics: { winRate: number; profitFactor: number; averageR: number }
): { score: number; allow: boolean; reason: string } {
  const score =
    (metrics.winRate / 100) * 0.35 +
    Math.min(metrics.profitFactor / 2, 1) * 0.4 +
    Math.min(Math.max(metrics.averageR, 0) / 1, 1) * 0.25;

  if (metrics.profitFactor < 1.15 && metrics.winRate < 50) {
    return {
      score,
      allow: false,
      reason: `${session} session underperforms evidence thresholds (PF ${metrics.profitFactor}, WR ${metrics.winRate}%)`,
    };
  }
  return {
    score,
    allow: true,
    reason: `${session} session approved · evidence score ${(score * 100).toFixed(0)}%`,
  };
}

/** Diagnostics → SAFE MODE if any critical component fails */
export function evaluateSystemMode(components: HealthComponent[]): {
  mode: SystemMode;
  reason: string;
  criticalFailures: string[];
} {
  const criticalFailures = components
    .filter((c) => c.critical && (c.status === 'critical' || c.status === 'offline'))
    .map((c) => c.name);

  if (criticalFailures.length > 0) {
    return {
      mode: 'SAFE_MODE',
      reason: `Critical failure: ${criticalFailures.join(', ')}. No new trades.`,
      criticalFailures,
    };
  }

  const degraded = components.filter((c) => c.status === 'degraded');
  if (degraded.length >= 2) {
    return {
      mode: 'SAFE_MODE',
      reason: `Multiple degraded components (${degraded.map((d) => d.name).join(', ')}). Safe mode engaged.`,
      criticalFailures: [],
    };
  }

  return { mode: 'LIVE', reason: 'All critical systems healthy.', criticalFailures: [] };
}

/** Build a full rejection explanation — mandatory principle */
export function explainRejection(params: {
  instrument: string;
  timeframe: string;
  side: 'LONG' | 'SHORT';
  setupStage: SetupStage;
  failedRules: string[];
  marketRegime: MarketRegime;
  confidence: number;
  supportingData: Record<string, string | number | boolean>;
  session?: SessionName;
}): RejectedTrade {
  return {
    id: `RJ-${Date.now().toString(36).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    instrument: params.instrument,
    timeframe: params.timeframe,
    side: params.side,
    setupStage: params.setupStage,
    failedRules: params.failedRules,
    marketRegime: params.marketRegime,
    confidence: params.confidence,
    supportingData: params.supportingData,
    reasons: params.failedRules,
    session: params.session ?? getCurrentSession(),
  };
}

/** Strategy never places trades — only emits TradeSignal */
export function createTradeSignal(
  partial: Omit<TradeSignal, 'id' | 'timestamp' | 'status' | 'setupStage'> & {
    setupStage?: SetupStage;
  }
): TradeSignal {
  return {
    ...partial,
    id: `SIG-${Date.now().toString(36).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    setupStage: partial.setupStage ?? 'SIGNAL_READY',
    status: 'PENDING',
  };
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function pct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export function money(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });
}
