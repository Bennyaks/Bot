/**
 * electron/main/tradeHistoryStore
 * ----------------------------------
 * The main process has no `window`/`localStorage` — this persists real
 * closed trades to a JSON file instead, so trade history survives an app
 * restart. Only trades with a known, real outcome (closed through this
 * app's own closePosition() call, which reads the actual fill price) are
 * ever written here — never a fabricated or estimated P&L.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutedTrade } from '../../src/lib/types';

const MAX_ENTRIES = 500;

export class TradeHistoryStore {
  private filePath: string;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'trade-history.json');
  }

  load(): ExecutedTrade[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  append(trade: ExecutedTrade): ExecutedTrade[] {
    const existing = this.load().filter((t) => t.id !== trade.id);
    const next = [trade, ...existing].slice(0, MAX_ENTRIES);
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), 'utf-8');
    } catch {
      // Best-effort — the in-memory copy in LiveTradingManager still has this run's data.
    }
    return next;
  }
}
