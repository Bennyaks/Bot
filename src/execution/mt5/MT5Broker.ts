import type { Candle, ExecutedTrade, SafetyCheck } from '../../lib/types';
import type { Broker, ExecutionProvider, MarketProvider, TradeCandidate } from '../../core/interfaces';
import { computeRiskBasedLotSize, type SymbolRiskInfo } from '../../core/risk/PositionSizer';

export interface MT5BrokerOptions {
  /** Base URL of the local python-bridge/mt5_bridge.py process, e.g. http://localhost:8787 */
  bridgeUrl: string;
  /** MT5 lot size to use for every fill. Ignored once `riskPercent` is set. */
  defaultVolume?: number;
  /**
   * When set (e.g. 0.01 for 1%), every trade is sized to risk this fraction
   * of current account equity given its own stop distance, instead of
   * always using `defaultVolume` — see core/risk/PositionSizer.ts for why
   * a flat lot size across different stop distances breaks the R-multiple
   * math the rest of the platform relies on.
   */
  riskPercent?: number;
}

interface BridgeAccount {
  equity: number;
  balance: number;
  tradeAllowed: boolean;
  broker: string;
  server: string;
  currency: string;
}

interface BridgePosition {
  id: string;
  instrument: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  currentPrice: number;
  profit: number;
  openTime: string;
}

interface BridgeOrderResponse {
  id: string;
  instrument: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  stop: number;
  target: number;
  volume: number;
  stringCode: string;
}

type BridgeSymbolInfo = SymbolRiskInfo & { digits: number };

/**
 * execution/mt5/MT5Broker
 * -------------------------
 * See ./README.md. Talks to python-bridge/mt5_bridge.py, a local HTTP
 * wrapper around the OFFICIAL `MetaTrader5` Python package — no MetaApi
 * account, token, or fee, at the cost of needing the MT5 terminal (and this
 * bridge, and the Node app) running on the same Windows machine as the bot.
 *
 * Implements the exact same MarketProvider + Broker + ExecutionProvider
 * contracts as MetaApiBroker, so swapping between them in
 * SystemOrchestrator/LiveTradingManager is a constructor change, nothing
 * else in the platform needs to know which one is wired in.
 *
 * IMPORTANT ASYMMETRY vs MetaApiBroker: fixed SL/TP sent with an order are
 * broker-server-side here too (same protection). But there is no
 * cloud-hosted trailing-stop config in plain MT5 — modifyPositionAsync()
 * only moves a position's stop when it's actually called. A trailing stop
 * in this mode requires the Node app's PositionManager loop AND this
 * bridge AND the MT5 terminal to all keep running; it does not survive
 * your PC being off the way MetaApi's does. See ./README.md.
 */
export class MT5Broker implements MarketProvider, Broker, ExecutionProvider {
  id = 'mt5-broker';

  private lastAccountInfo: BridgeAccount | null = null;
  private connected = false;
  private readonly bridgeUrl: string;
  private readonly defaultVolume: number;
  private readonly riskPercent: number | null;

  constructor(opts: MT5BrokerOptions) {
    this.bridgeUrl = opts.bridgeUrl.replace(/\/$/, '');
    this.defaultVolume = opts.defaultVolume ?? 0.01;
    this.riskPercent = opts.riskPercent && opts.riskPercent > 0 ? opts.riskPercent : null;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    let res: Response;
    try {
      res = await fetch(`${this.bridgeUrl}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        ...init,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `MT5 bridge at ${this.bridgeUrl}${path} did not respond within 20s — it may be hung (check its terminal window) or MT5 may be showing a blocking dialog.`
        );
      }
      throw new Error(
        `Could not reach the MT5 bridge at ${this.bridgeUrl} — is mt5_bridge.py running, and is MT5 open and logged in? (${err instanceof Error ? err.message : String(err)})`
      );
    } finally {
      clearTimeout(timeout);
    }

    const rawText = await res.text();
    let body: unknown = null;
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        throw new Error(
          `MT5 bridge returned a non-JSON response (status ${res.status}) for ${path}: ${rawText.slice(0, 300)}`
        );
      }
    }

    if (!res.ok) {
      const message =
        body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
          ? String((body as Record<string, unknown>).error)
          : res.statusText;
      throw new Error(`MT5 bridge rejected the request: ${path} → ${message}`);
    }
    return body as T;
  }

  /** Pings the bridge and refreshes account info. Call before first use, and periodically (ConnectionManager does this). */
  async connect(): Promise<void> {
    const health = await this.request<{ connected: boolean; latencyMs: number }>('/health');
    this.connected = health.connected;
    if (this.connected) {
      this.lastAccountInfo = await this.request<BridgeAccount>('/account');
    }
  }

  // ---- Broker -------------------------------------------------------------

  isConnected(): boolean {
    return this.connected;
  }

  runSafetyChecks(): SafetyCheck[] {
    const info = this.lastAccountInfo;
    return [
      {
        id: 'mt5_bridge_connected',
        label: 'MT5 Bridge Connected',
        description: 'python-bridge/mt5_bridge.py is running and attached to the MT5 terminal',
        passed: this.connected,
        detail: this.connected ? `Connected via ${this.id}` : 'Not connected — is mt5_bridge.py running?',
        critical: true,
      },
      {
        id: 'trading_allowed',
        label: 'Trading Allowed',
        description: 'Broker account permits trading (not read-only / investor-mode)',
        passed: info?.tradeAllowed ?? false,
        detail: info ? `Broker: ${info.broker} (${info.server})` : 'Account information not yet loaded',
        critical: true,
      },
    ];
  }

  accountEquity(): number {
    return this.lastAccountInfo?.equity ?? 0;
  }

  // ---- MarketProvider -------------------------------------------------------

  getCandles(): Candle[] {
    throw new Error('MT5Broker.getCandles is async — use getCandlesAsync() instead');
  }

  async getCandlesAsync(instrument: string, timeframe: string, count: number): Promise<Candle[]> {
    const params = new URLSearchParams({ symbol: instrument, timeframe, count: String(count) });
    return this.request<Candle[]>(`/candles?${params}`);
  }

  getSpread(): number {
    throw new Error('MT5Broker.getSpread is async — use getSpreadAsync() instead');
  }

  async getSpreadAsync(instrument: string): Promise<number> {
    const params = new URLSearchParams({ symbol: instrument });
    const { spread } = await this.request<{ spread: number }>(`/spread?${params}`);
    return spread;
  }

  /** The bridge has no push stream — this polls on an interval instead, same shape as MetaApiBroker. */
  subscribe(instrument: string, onCandle: (candle: Candle) => void): () => void {
    const interval = setInterval(() => {
      this.getCandlesAsync(instrument, '15m', 1)
        .then(([latest]) => latest && onCandle(latest))
        .catch(() => {
          /* transient error — next poll retries */
        });
    }, 60_000);
    return () => clearInterval(interval);
  }

  // ---- ExecutionProvider -----------------------------------------------------

  submit(): ExecutedTrade {
    throw new Error('MT5Broker.submit is async — always await it (SystemOrchestrator already does)');
  }

  async submitAsync(candidate: TradeCandidate): Promise<ExecutedTrade> {
    let volume = this.defaultVolume;
    let sizingNote = '';
    if (this.riskPercent) {
      try {
        const [account, symbolInfo] = await Promise.all([
          this.request<BridgeAccount>('/account'),
          this.request<BridgeSymbolInfo>(`/symbol/${candidate.instrument}/info`),
        ]);
        this.lastAccountInfo = account;
        const sized = computeRiskBasedLotSize({
          equity: account.equity,
          riskPercent: this.riskPercent,
          entry: candidate.entry,
          stop: candidate.stop,
          symbolInfo,
        });
        volume = sized.lots;
        sizingNote = ` · sized to risk ~${(this.riskPercent * 100).toFixed(2)}% equity (${sized.riskAmount} ${account.currency})${sized.warning ? ` — ${sized.warning}` : ''}`;
      } catch (err) {
        // A sizing-endpoint hiccup shouldn't block a trade that already
        // cleared every other gate — fall back to the fixed default volume.
        sizingNote = ` · risk-based sizing failed (${err instanceof Error ? err.message : String(err)}), used default ${this.defaultVolume} lots instead`;
      }
    }

    const response = await this.request<BridgeOrderResponse>('/orders', {
      method: 'POST',
      body: JSON.stringify({
        instrument: candidate.instrument,
        side: candidate.side,
        stop: candidate.stop,
        target: candidate.target,
        volume,
      }),
    });

    return {
      id: response.id,
      timestamp: new Date().toISOString(),
      instrument: candidate.instrument,
      timeframe: candidate.timeframe,
      side: candidate.side,
      entry: response.entry,
      stop: response.stop,
      target: response.target,
      lotSize: response.volume,
      rMultiple: null,
      status: 'OPEN',
      session: candidate.session,
      confidence: candidate.confidence,
      strategyVersion: candidate.strategyVersion,
      explanation: `Filled live via MT5 bridge (${response.stringCode}) from candidate ${candidate.id} · fixed SL/TP is broker-side; trailing needs this app running${sizingNote}`,
    };
  }

  close(): ExecutedTrade {
    throw new Error('MT5Broker.close is async — use closeAsync() instead');
  }

  async closeAsync(trade: ExecutedTrade): Promise<ExecutedTrade> {
    const { price } = await this.request<{ price: number; stringCode: string }>(`/orders/${trade.id}/close`, {
      method: 'POST',
    });
    const risk = Math.abs(trade.entry - trade.stop);
    const raw = trade.side === 'LONG' ? price - trade.entry : trade.entry - price;
    const pnlR = risk > 0 ? Number((raw / risk).toFixed(2)) : 0;
    return {
      ...trade,
      status: pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN',
      exitPrice: price,
      exitTime: new Date().toISOString(),
      pnlR,
      rMultiple: pnlR,
    };
  }

  /**
   * Moves a position's broker-side stop — this is what PositionManager's
   * break-even/trailing decisions actually push to the broker in this mode.
   * Must be called on an interval by whatever's running the position-manage
   * loop; there's no persistent server-side trailing config here (see the
   * class doc comment and README.md).
   */
  async modifyPositionAsync(trade: ExecutedTrade, newStop: number): Promise<void> {
    await this.request(`/orders/${trade.id}/modify`, {
      method: 'POST',
      body: JSON.stringify({ stop: newStop, target: trade.target }),
    });
  }

  /** Broker-side truth about what's still open, for reconciling local tracking — same role as MetaApiBroker's. */
  async getOpenPositionsAsync(): Promise<string[]> {
    const positions = await this.request<BridgePosition[]>('/positions');
    return positions.map((p) => p.id);
  }

  /**
   * Closes part of a position (e.g. banking 50% at 1R) rather than all of
   * it. `volume` is snapped to the symbol's own volume step server-side —
   * pass whatever fraction you want, the bridge handles rounding.
   */
  async partialCloseAsync(trade: ExecutedTrade, volume: number): Promise<{ price: number; volume: number }> {
    const result = await this.request<{ price: number; stringCode: string; volume: number }>(`/orders/${trade.id}/close`, {
      method: 'POST',
      body: JSON.stringify({ volume }),
    });
    return { price: result.price, volume: result.volume };
  }

  /**
   * Called by reconcile() once a position has vanished from getOpenPositionsAsync() —
   * i.e. MT5 already closed it server-side via stop-loss, take-profit, or a
   * trailing stop, without this app doing anything. Reads the real closing
   * deal from MT5's own history so the app records the actual fill instead
   * of silently forgetting the trade ever happened. Returns null (not a
   * throw) if the bridge has no history for it yet — the caller falls back
   * to an estimate rather than losing the trade record entirely.
   */
  async getClosedTradeAsync(trade: ExecutedTrade): Promise<ExecutedTrade | null> {
    let result: { exitPrice: number; exitTime: string } | null;
    try {
      result = await this.request<{ exitPrice: number; exitTime: string } | null>(`/positions/${trade.id}/history`);
    } catch {
      return null;
    }
    if (!result) return null;

    const risk = Math.abs(trade.entry - trade.stop);
    const raw = trade.side === 'LONG' ? result.exitPrice - trade.entry : trade.entry - result.exitPrice;
    const pnlR = risk > 0 ? Number((raw / risk).toFixed(2)) : 0;
    return {
      ...trade,
      status: pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN',
      exitPrice: result.exitPrice,
      exitTime: result.exitTime,
      pnlR,
      rMultiple: pnlR,
      explanation: `${trade.explanation} · closed by your broker's stop-loss, take-profit, or trailing stop`,
    };
  }
}
