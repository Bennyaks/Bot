import type { ExecutedTrade, LogEntry, RejectedTrade } from '../../lib/types';
import type { Storage } from '../interfaces';

const TRADES_KEY = 'trading-platform:trades';
const REJECTIONS_KEY = 'trading-platform:rejections';
const LOGS_KEY = 'trading-platform:logs';
const MAX_RECORDS = 500;
/**
 * The in-app Decision Log Stream only ever kept the most recent 200 lines
 * in memory (useTradingStore's pushLog does `.slice(0, 200)`) — anything
 * older was gone permanently, so there was no audit trail beyond whatever
 * happened to still be on screen. This keeps a much longer-lived record in
 * Storage independently of that in-memory cap.
 */
const MAX_LOG_RECORDS = 5000;

/**
 * core/storage/LocalStorageAdapter
 * ----------------------------------
 * Phase 8. Implements the Storage contract over window.localStorage so the
 * Trade Journal survives a refresh instead of resetting to demo data every
 * load. Nothing upstream (Orchestrator, Journal page) knows or cares that
 * this is localStorage — swapping in an IndexedDB- or server-backed Storage
 * later means writing one more class against the same interface.
 *
 * Every read/write is wrapped defensively: a full or disabled localStorage
 * (private browsing, quota exceeded) degrades to "nothing persists" rather
 * than crashing the platform.
 */
export class LocalStorageAdapter implements Storage {
  private available: boolean;

  constructor(private namespace = '') {
    this.available = LocalStorageAdapter.probe();
  }

  private static probe(): boolean {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      const testKey = '__storage_probe__';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  private key(base: string): string {
    return this.namespace ? `${base}:${this.namespace}` : base;
  }

  private read<T>(base: string): T[] {
    if (!this.available) return [];
    try {
      const raw = window.localStorage.getItem(this.key(base));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      // Corrupt payload — treat as empty rather than throwing during render.
      return [];
    }
  }

  private write<T>(base: string, records: T[]): void {
    if (!this.available) return;
    try {
      window.localStorage.setItem(this.key(base), JSON.stringify(records.slice(0, MAX_RECORDS)));
    } catch {
      // Quota exceeded or storage revoked mid-session — fail silently,
      // the in-memory state (useTradingStore) is still the source of truth
      // for the current session even if persistence stops working.
    }
  }

  saveTrade(trade: ExecutedTrade): void {
    const trades = this.read<ExecutedTrade>(TRADES_KEY).filter((t) => t.id !== trade.id);
    this.write(TRADES_KEY, [trade, ...trades]);
  }

  saveRejection(rejection: RejectedTrade): void {
    const rejections = this.read<RejectedTrade>(REJECTIONS_KEY).filter((r) => r.id !== rejection.id);
    this.write(REJECTIONS_KEY, [rejection, ...rejections]);
  }

  loadTrades(): ExecutedTrade[] {
    return this.read<ExecutedTrade>(TRADES_KEY);
  }

  loadRejections(): RejectedTrade[] {
    return this.read<RejectedTrade>(REJECTIONS_KEY);
  }

  saveLog(entry: LogEntry): void {
    if (!this.available) return;
    try {
      const raw = window.localStorage.getItem(this.key(LOGS_KEY));
      const existing: LogEntry[] = raw ? JSON.parse(raw) : [];
      const next = [entry, ...(Array.isArray(existing) ? existing : [])].slice(0, MAX_LOG_RECORDS);
      window.localStorage.setItem(this.key(LOGS_KEY), JSON.stringify(next));
    } catch {
      // Quota exceeded or corrupt payload — the audit trail degrading is
      // acceptable; the trading pipeline itself must not fail because of it.
    }
  }

  loadLogs(): LogEntry[] {
    return this.read<LogEntry>(LOGS_KEY);
  }

  clear(): void {
    if (!this.available) return;
    try {
      window.localStorage.removeItem(this.key(TRADES_KEY));
      window.localStorage.removeItem(this.key(REJECTIONS_KEY));
      window.localStorage.removeItem(this.key(LOGS_KEY));
    } catch {
      // best-effort
    }
  }
}

/**
 * In-memory fallback — same contract, no persistence. Useful for tests,
 * SSR, or a future replay/backtest harness (Phase 14) that shouldn't
 * pollute a real browser's localStorage.
 */
export class InMemoryStorage implements Storage {
  private trades: ExecutedTrade[] = [];
  private rejections: RejectedTrade[] = [];
  private logs: LogEntry[] = [];

  saveTrade(trade: ExecutedTrade): void {
    this.trades = [trade, ...this.trades.filter((t) => t.id !== trade.id)].slice(0, MAX_RECORDS);
  }

  saveRejection(rejection: RejectedTrade): void {
    this.rejections = [rejection, ...this.rejections.filter((r) => r.id !== rejection.id)].slice(0, MAX_RECORDS);
  }

  saveLog(entry: LogEntry): void {
    this.logs = [entry, ...this.logs].slice(0, MAX_LOG_RECORDS);
  }

  loadTrades(): ExecutedTrade[] {
    return [...this.trades];
  }

  loadRejections(): RejectedTrade[] {
    return [...this.rejections];
  }

  loadLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.trades = [];
    this.rejections = [];
    this.logs = [];
  }
}
