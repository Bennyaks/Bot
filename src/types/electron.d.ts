import type { ExecutedTrade, LogEntry } from '../lib/types';

export type MT5ConnectArgs = (
  | { mode: 'metaapi'; token: string; accountId: string }
  | { mode: 'mt5-local'; bridgeUrl: string }
) & {
  watchlist?: string[];
  pollSeconds?: number;
  lotSize?: number;
  /** When set (e.g. 0.01 for 1%), overrides lotSize — every trade is sized to risk this fraction of equity. See core/risk/PositionSizer.ts. */
  riskPercent?: number;
};

export type MT5ConnectionStatus = 'idle' | 'connected' | 'reconnecting' | 'offline';

export interface MT5Status {
  connected: boolean;
  connectionStatus: MT5ConnectionStatus;
  equity: number;
  broker: string | null;
  lotSize: number;
  riskPercent: number | null;
}

export interface MT5PendingCandidate {
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

/** An open position enriched with display-friendly derived fields. */
export interface MT5LivePosition extends ExecutedTrade {
  currentPrice: number | null;
  floatingR: number | null;
  elapsedMinutes: number;
}

/**
 * Bridge exposed by electron/preload.ts via contextBridge. Only present
 * when running inside the Electron shell — always check
 * `typeof window.mt5 !== 'undefined'` before using it, since the same
 * built dashboard also runs in a plain browser (npm run dev) where this
 * is undefined by design (MetaApi's SDK is Node-only and must never run
 * in a browser context).
 */
export interface MT5Bridge {
  connect(args: MT5ConnectArgs): Promise<MT5Status>;
  disconnect(): Promise<{ ok: boolean }>;
  approve(candidateId: string, overrides?: { stop?: number; target?: number }): Promise<{ ok: boolean }>;
  skip(candidateId: string): Promise<{ ok: boolean }>;
  closePosition(tradeId: string): Promise<{ ok: boolean }>;
  status(): Promise<MT5Status>;
  positions(): Promise<MT5LivePosition[]>;
  history(): Promise<ExecutedTrade[]>;
  onLog(cb: (entry: LogEntry) => void): void;
  onStatus(cb: (status: MT5Status) => void): void;
  onCandidate(cb: (candidate: MT5PendingCandidate) => void): void;
  onCandidateExpired(cb: (candidateId: string) => void): void;
  onPositions(cb: (positions: MT5LivePosition[]) => void): void;
  removeAllListeners(): void;
}

declare global {
  interface Window {
    mt5?: MT5Bridge;
  }
}

export {};
