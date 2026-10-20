import type { ExecutedTrade, RejectedTrade } from '../../lib/types';
import type { Storage } from '../../core/interfaces';

const TRADES_KEY = 'trading-platform:journal:trades:v1';
const REJECTIONS_KEY = 'trading-platform:journal:rejections:v1';
const MAX_ENTRIES = 500;

function hasLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/**
 * storage/local/LocalJournalStorage
 * ------------------------------------
 * Implements the Storage contract over the browser's localStorage so the
 * journal survives a page reload. Falls back to an in-memory array if
 * localStorage is unavailable (private browsing, SSR, etc.) — callers never
 * need to know which backend is active.
 */
export class LocalJournalStorage implements Storage {
  private memoryTrades: ExecutedTrade[] = [];
  private memoryRejections: RejectedTrade[] = [];
  private readonly persistent = hasLocalStorage();

  private read<T>(key: string): T[] {
    if (!this.persistent) return [];
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T[]) : [];
    } catch {
      return [];
    }
  }

  private write<T>(key: string, items: T[]): void {
    if (!this.persistent) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(items.slice(0, MAX_ENTRIES)));
    } catch {
      // Storage full or unavailable — the in-memory copy still has this run's data.
    }
  }

  saveTrade(trade: ExecutedTrade): void {
    this.memoryTrades = [trade, ...this.memoryTrades].slice(0, MAX_ENTRIES);
    if (this.persistent) {
      const existing = this.read<ExecutedTrade>(TRADES_KEY);
      this.write(TRADES_KEY, [trade, ...existing.filter((t) => t.id !== trade.id)]);
    }
  }

  saveRejection(rejection: RejectedTrade): void {
    this.memoryRejections = [rejection, ...this.memoryRejections].slice(0, MAX_ENTRIES);
    if (this.persistent) {
      const existing = this.read<RejectedTrade>(REJECTIONS_KEY);
      this.write(REJECTIONS_KEY, [rejection, ...existing.filter((r) => r.id !== rejection.id)]);
    }
  }

  loadTrades(): ExecutedTrade[] {
    return this.persistent ? this.read<ExecutedTrade>(TRADES_KEY) : this.memoryTrades;
  }

  loadRejections(): RejectedTrade[] {
    return this.persistent ? this.read<RejectedTrade>(REJECTIONS_KEY) : this.memoryRejections;
  }
}
