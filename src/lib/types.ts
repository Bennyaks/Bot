export type SessionName = 'Asian' | 'London' | 'NewYork';
export type TradeSide = 'LONG' | 'SHORT';
export type SetupStage =
  | 'SCANNING'
  | 'STRUCTURE_DETECTED'
  | 'BOS_CONFIRMED'
  | 'VOLUME_CHECK'
  | 'RISK_EVAL'
  | 'SIGNAL_READY'
  | 'RISK_APPROVED'
  | 'EXECUTED'
  | 'REJECTED'
  | 'CLOSED';

export type MarketRegime =
  | 'TRENDING_BULL'
  | 'TRENDING_BEAR'
  | 'RANGING'
  | 'HIGH_VOLATILITY'
  | 'LOW_LIQUIDITY'
  | 'NEWS_EVENT';

export type HealthStatus = 'healthy' | 'degraded' | 'critical' | 'offline';
export type SystemMode = 'LIVE' | 'PAPER' | 'SAFE_MODE' | 'BACKTEST';

export interface SessionMetrics {
  session: SessionName;
  winRate: number;
  profitFactor: number;
  averageR: number;
  tradeFrequency: number;
  totalTrades: number;
  netR: number;
  bestHour: string;
  worstHour: string;
  active: boolean;
}

export interface SafetyCheck {
  id: string;
  label: string;
  description: string;
  passed: boolean;
  detail: string;
  critical: boolean;
}

export interface RejectedTrade {
  id: string;
  timestamp: string;
  instrument: string;
  timeframe: string;
  side: TradeSide;
  setupStage: SetupStage;
  failedRules: string[];
  marketRegime: MarketRegime;
  confidence: number;
  supportingData: Record<string, string | number | boolean>;
  reasons: string[];
  session: SessionName;
}

export interface ExecutedTrade {
  id: string;
  timestamp: string;
  instrument: string;
  timeframe: string;
  side: TradeSide;
  entry: number;
  stop: number;
  target: number;
  lotSize: number;
  rMultiple: number | null;
  status: 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN';
  session: SessionName;
  confidence: number;
  strategyVersion: string;
  exitPrice?: number;
  exitTime?: string;
  pnlR?: number;
  explanation: string;
}

export interface TradeSignal {
  id: string;
  timestamp: string;
  instrument: string;
  timeframe: string;
  side: TradeSide;
  entry: number;
  stop: number;
  target: number;
  confidence: number;
  session: SessionName;
  marketRegime: MarketRegime;
  strategyVersion: string;
  setupStage: SetupStage;
  riskReward: number;
  indicators: Record<string, number>;
  structure: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'EXPIRED';
}

export interface HealthComponent {
  id: string;
  name: string;
  status: HealthStatus;
  latencyMs: number;
  lastCheck: string;
  message: string;
  critical: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'REJECT' | 'SAFETY';
  module: string;
  message: string;
  data?: Record<string, unknown>;
  reproducible: boolean;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
