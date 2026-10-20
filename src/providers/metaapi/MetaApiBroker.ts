// Import the explicit Node-targeted build. The bare 'metaapi.cloud-sdk'
// specifier has a conditional "exports" map where an ESM `import` site
// resolves to dists/esm-web (a BROWSER build that references `window`),
// while only a CJS `require()` site would get the safe dist/ Node build.
// Since this file is ESM (and is used both from tsx and from esbuild's
// Electron bundle), importing the unconditional "/node" subpath sidesteps
// that ambiguity entirely rather than depending on how each runtime happens
// to resolve conditional exports.
import MetaApiModule from 'metaapi.cloud-sdk/node';

// Second, separate interop issue: this package's compiled output sets
// `__esModule: true` and a real `.default` property internally, but under
// BOTH esbuild's --platform=node bundling AND native Node ESM (which is
// what `tsx` uses for npm run live / npm run backtest) a plain default
// import of a CJS module binds to the whole module object, not its nested
// `.default`. Confirmed by direct repro under both runtimes — without this,
// `new MetaApiModule(...)` throws "is not a constructor". The type
// declarations (which do describe a proper default export) don't reflect
// this runtime behavior, hence the cast.
const MetaApi = (MetaApiModule as unknown as { default: typeof MetaApiModule }).default;
import type { Candle, ExecutedTrade, SafetyCheck } from '../../lib/types';
import type { Broker, ExecutionProvider, MarketProvider, TradeCandidate } from '../../core/interfaces';
import { computeRiskBasedLotSize } from '../../core/risk/PositionSizer';

export interface MetaApiBrokerOptions {
  token: string;
  accountId: string;
  /** MT5 lot size to use for every fill. Ignored once `riskPercent` is set. */
  defaultVolume?: number;
  /**
   * When set (e.g. 0.01 for 1%), every trade is sized to risk this fraction
   * of current account equity given its own stop distance, instead of
   * always using `defaultVolume` — see core/risk/PositionSizer.ts.
   */
  riskPercent?: number;
}

/**
 * The MetaApi SDK ships two parallel type trees (dist/ for Node, dists/esm-web/
 * for browser bundlers) that TypeScript treats as structurally distinct
 * classes even though they're the same runtime object. Duck-typing the
 * handful of RPC methods this adapter actually calls sidesteps that clash
 * entirely instead of fighting the SDK's type resolution.
 */
interface MetaApiRpcConnection {
  connect(): Promise<void>;
  waitSynchronized(timeoutInSeconds?: number): Promise<unknown>;
  getAccountInformation(): Promise<{ equity: number; tradeAllowed: boolean; broker: string; currency?: string }>;
  /**
   * Tick size/value and volume constraints for a symbol — feeds risk-based
   * position sizing (core/risk/PositionSizer.ts), which needs to know what
   * one tick of movement is actually worth in account currency for THIS
   * symbol before it can turn "risk 1% of equity" into a lot size.
   */
  getSymbolSpecification(symbol: string): Promise<{
    tickSize: number;
    tickValue: number;
    volumeMin: number;
    volumeMax: number;
    volumeStep: number;
  }>;
  getSymbolPrice(symbol: string, keepSubscription: boolean): Promise<{ bid: number; ask: number }>;
  getPosition(positionId: string): Promise<{ currentPrice: number }>;
  createMarketBuyOrder(
    symbol: string,
    volume: number,
    stopLoss?: number,
    takeProfit?: number,
    options?: { trailingStopLoss?: TrailingStopLossConfig }
  ): Promise<{ orderId: string; positionId: string; stringCode: string }>;
  createMarketSellOrder(
    symbol: string,
    volume: number,
    stopLoss?: number,
    takeProfit?: number,
    options?: { trailingStopLoss?: TrailingStopLossConfig }
  ): Promise<{ orderId: string; positionId: string; stringCode: string }>;
  closePosition(positionId: string, options: Record<string, unknown>): Promise<{ stringCode: string }>;
  modifyPosition(
    positionId: string,
    stopLoss?: number,
    takeProfit?: number,
    trailingStopLoss?: TrailingStopLossConfig
  ): Promise<{ stringCode: string }>;
  /**
   * RPC history lookup — returns every deal MT5 has recorded against this
   * position ticket, synced from the broker's own server. Used to find the
   * real closing fill after a stop-loss/take-profit/trailing stop closes a
   * position without this app doing anything.
   */
  getDealsByPosition(positionId: string): Promise<{ deals: MetaApiDeal[] }>;
}

interface MetaApiDeal {
  price?: number;
  profit?: number;
  time?: string;
  /** 'DEAL_ENTRY_IN' for the opening fill, 'DEAL_ENTRY_OUT' / 'DEAL_ENTRY_OUT_BY' for the closing fill. */
  entryType?: string;
}

/**
 * MT5's own server manages this once set — not our Node process. If the
 * app crashes, loses power, or loses internet, the terminal MetaApi hosts
 * keeps trailing the stop on its own. `distance` is in the same units as
 * price by default (RELATIVE_PRICE); switch `units` to 'RELATIVE_POINTS' if
 * you'd rather think in points for a given symbol.
 */
export interface TrailingStopLossConfig {
  distance: { distance: number; units?: string };
}

/**
 * providers/metaapi/MetaApiBroker
 * -----------------------------------
 * Implements MarketProvider + Broker + ExecutionProvider against a live (or
 * demo) MT5 account through MetaApi.cloud. MetaApi hosts the actual MT5
 * terminal for you — this class only ever speaks REST/WebSocket, so the
 * platform runs anywhere Node runs. No Wine, no VM, no locally-installed
 * MT5 terminal.
 *
 * IMPORTANT: this must run server-side (see ../../server/liveRunner.ts).
 * The MetaApi token is a trading credential — it must never ship inside a
 * browser bundle. Vite env vars prefixed VITE_ are bundled into client JS
 * and are NOT a safe place for this token.
 *
 * Lifecycle: construct -> call connect() once -> then use as any other
 * MarketProvider/Broker/ExecutionProvider. connect() deploys the account if
 * needed and waits for the terminal to synchronize.
 */
export class MetaApiBroker implements MarketProvider, Broker, ExecutionProvider {
  id = 'metaapi-broker';

  private api: InstanceType<typeof MetaApiModule>;
  private connection: MetaApiRpcConnection | null = null;
  private synced = false;
  private lastAccountInfo: { equity: number; tradeAllowed: boolean; broker: string; currency?: string } | null = null;
  private readonly defaultVolume: number;
  private readonly riskPercent: number | null;

  constructor(private opts: MetaApiBrokerOptions) {
    this.api = new MetaApi(opts.token);
    this.defaultVolume = opts.defaultVolume ?? 0.01;
    this.riskPercent = opts.riskPercent && opts.riskPercent > 0 ? opts.riskPercent : null;
  }

  /** Must be called once before this adapter is handed to the SystemOrchestrator. */
  async connect(): Promise<void> {
    const account = await this.api.metatraderAccountApi.getAccount(this.opts.accountId);

    if (account.state !== 'DEPLOYED') {
      await account.deploy();
    }
    await account.waitConnected();

    const connection = account.getRPCConnection() as unknown as MetaApiRpcConnection;
    await connection.connect();
    await connection.waitSynchronized();

    this.connection = connection;
    this.synced = true;
    await this.refreshAccountInfo();
  }

  private requireConnection(): MetaApiRpcConnection {
    if (!this.connection) {
      throw new Error('MetaApiBroker.connect() must be awaited before use');
    }
    return this.connection;
  }

  private async refreshAccountInfo(): Promise<void> {
    const info = await this.requireConnection().getAccountInformation();
    this.lastAccountInfo = { equity: info.equity, tradeAllowed: info.tradeAllowed, broker: info.broker };
  }

  // ---- Broker -------------------------------------------------------------

  isConnected(): boolean {
    return this.synced;
  }

  runSafetyChecks(): SafetyCheck[] {
    const info = this.lastAccountInfo;
    return [
      {
        id: 'metaapi_connected',
        label: 'MetaApi Connected',
        description: 'Synchronized RPC connection to the MT5 terminal via MetaApi.cloud',
        passed: this.synced,
        detail: this.synced ? `Connected via ${this.id}` : 'Not connected — call connect() first',
        critical: true,
      },
      {
        id: 'trading_allowed',
        label: 'Trading Allowed',
        description: 'Broker account permits trading (not read-only / investor-mode)',
        passed: info?.tradeAllowed ?? false,
        detail: info ? `Broker: ${info.broker}` : 'Account information not yet loaded',
        critical: true,
      },
    ];
  }

  accountEquity(): number {
    return this.lastAccountInfo?.equity ?? 0;
  }

  // ---- MarketProvider -------------------------------------------------------

  getCandles(): Candle[] {
    throw new Error('MetaApiBroker.getCandles is async — use getCandlesAsync() instead');
  }

  async getCandlesAsync(instrument: string, timeframe: string, count: number): Promise<Candle[]> {
    const account = await this.api.metatraderAccountApi.getAccount(this.opts.accountId);
    const candles = await account.getHistoricalCandles(instrument, timeframe, undefined, count);
    return candles.map((c: { time: Date | string | number; open: number; high: number; low: number; close: number; volume?: number; tickVolume?: number }) => ({
      time: new Date(c.time).getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? c.tickVolume ?? 0,
    }));
  }

  getSpread(): number {
    throw new Error('MetaApiBroker.getSpread is async — use getSpreadAsync() instead');
  }

  async getSpreadAsync(instrument: string): Promise<number> {
    const price = await this.requireConnection().getSymbolPrice(instrument, false);
    return Number((price.ask - price.bid).toFixed(5));
  }

  /** MetaApi's RPC connection has no push stream — this polls on an interval instead. */
  subscribe(instrument: string, onCandle: (candle: Candle) => void): () => void {
    const interval = setInterval(() => {
      this.getCandlesAsync(instrument, '15m', 1)
        .then(([latest]) => latest && onCandle(latest))
        .catch(() => {
          /* transient network error — next poll will retry */
        });
    }, 60_000);
    return () => clearInterval(interval);
  }

  // ---- ExecutionProvider -----------------------------------------------------

  submit(): ExecutedTrade {
    throw new Error('MetaApiBroker.submit is async — always await it (SystemOrchestrator already does)');
  }

  async submitAsync(candidate: TradeCandidate): Promise<ExecutedTrade> {
    const connection = this.requireConnection();

    let volume = this.defaultVolume;
    let sizingNote = '';
    if (this.riskPercent) {
      try {
        const [account, symbolInfo] = await Promise.all([
          connection.getAccountInformation(),
          connection.getSymbolSpecification(candidate.instrument),
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
        sizingNote = ` · sized to risk ~${(this.riskPercent * 100).toFixed(2)}% equity (${sized.riskAmount}${account.currency ? ' ' + account.currency : ''})${sized.warning ? ` — ${sized.warning}` : ''}`;
      } catch (err) {
        // A sizing lookup hiccup shouldn't block a trade that already
        // cleared every other gate — fall back to the fixed default volume.
        sizingNote = ` · risk-based sizing failed (${err instanceof Error ? err.message : String(err)}), used default ${this.defaultVolume} lots instead`;
      }
    }

    // Distance is the original entry-to-stop risk — MT5's own server trails
    // the stop from there once price moves favorably. This is what survives
    // a power cut or a crashed Node process: the protective order lives on
    // the broker's terminal, not in this app's memory.
    const distance = Number(Math.abs(candidate.entry - candidate.stop).toFixed(5));
    const trailingStopLoss: TrailingStopLossConfig = { distance: { distance, units: 'RELATIVE_PRICE' } };

    const response =
      candidate.side === 'LONG'
        ? await connection.createMarketBuyOrder(candidate.instrument, volume, candidate.stop, candidate.target, {
            trailingStopLoss,
          })
        : await connection.createMarketSellOrder(candidate.instrument, volume, candidate.stop, candidate.target, {
            trailingStopLoss,
          });

    return {
      id: response.positionId ?? response.orderId ?? `MA-${Date.now()}`,
      timestamp: new Date().toISOString(),
      instrument: candidate.instrument,
      timeframe: candidate.timeframe,
      side: candidate.side,
      entry: candidate.entry,
      stop: candidate.stop,
      target: candidate.target,
      lotSize: volume,
      rMultiple: null,
      status: 'OPEN',
      session: candidate.session,
      confidence: candidate.confidence,
      strategyVersion: candidate.strategyVersion,
      explanation: `Filled live via MetaApi (${response.stringCode}) from candidate ${candidate.id} · broker-side SL/TP + trailing stop attached${sizingNote}`,
    };
  }

  /**
   * Closes part of a position's volume, leaving the rest open — used by the
   * partial-take-profit step (liveTradingManager's managePartialProfits()).
   * NOTE: assumes MetaApi's closePosition options accept a `volume` field to
   * request a partial close (same shape as MetatraderTradeOptions.volume in
   * the SDK) — confirm against your installed SDK version if this errors.
   */
  async partialCloseAsync(trade: ExecutedTrade, volume: number): Promise<{ price: number }> {
    const connection = this.requireConnection();
    const position = await connection.getPosition(trade.id).catch(() => null);
    const exitPrice = position?.currentPrice ?? trade.entry;
    await connection.closePosition(trade.id, { volume });
    return { price: exitPrice };
  }

  /**
   * Explicitly move a position's stop (e.g. a manual break-even jump the
   * Decision Engine's rules call for). Like the trailing stop above, this
   * order lives on the MT5 server the instant it's set — it does not
   * depend on this Node process staying alive afterward.
   */
  async modifyPositionAsync(trade: ExecutedTrade, newStop: number): Promise<void> {
    const connection = this.requireConnection();
    await connection.modifyPosition(trade.id, newStop, trade.target);
  }

  /**
   * Broker-side truth about what's actually still open. Used to reconcile
   * positions this app thinks are open against ones MT5 already closed via
   * the server-side SL/TP/trailing stop — which can happen at any time,
   * including while this process wasn't running.
   */
  async getOpenPositionsAsync(): Promise<string[]> {
    const connection = this.requireConnection() as unknown as { getPositions(): Promise<{ id: string | number }[]> };
    const positions = await connection.getPositions();
    return positions.map((p) => String(p.id));
  }

  /**
   * Called by reconcile() once a position has vanished from getOpenPositionsAsync() —
   * i.e. MT5 already closed it server-side via stop-loss, take-profit, or
   * MetaApi's own cloud-hosted trailing stop, without this app doing
   * anything. Reads the real closing deal from MetaApi's synced history so
   * the app records the actual fill instead of silently forgetting the
   * trade happened. Returns null (not a throw) if no closing deal is found
   * yet — the caller falls back to an estimate rather than losing the
   * trade record entirely.
   */
  async getClosedTradeAsync(trade: ExecutedTrade): Promise<ExecutedTrade | null> {
    const connection = this.requireConnection();
    let deals: MetaApiDeal[];
    try {
      const result = await connection.getDealsByPosition(trade.id);
      deals = result.deals ?? [];
    } catch {
      return null;
    }

    const exitDeal = [...deals]
      .reverse()
      .find((d) => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'DEAL_ENTRY_OUT_BY');
    if (!exitDeal || exitDeal.price === undefined) return null;

    const exitPrice = exitDeal.price;
    const risk = Math.abs(trade.entry - trade.stop);
    const raw = trade.side === 'LONG' ? exitPrice - trade.entry : trade.entry - exitPrice;
    const pnlR = risk > 0 ? Number((raw / risk).toFixed(2)) : 0;
    return {
      ...trade,
      status: pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN',
      exitPrice,
      exitTime: exitDeal.time ?? new Date().toISOString(),
      pnlR,
      rMultiple: pnlR,
      explanation: `${trade.explanation} · closed by your broker's stop-loss, take-profit, or trailing stop`,
    };
  }

  close(): ExecutedTrade {
    throw new Error('MetaApiBroker.close is async — use closeAsync() instead');
  }

  async closeAsync(trade: ExecutedTrade): Promise<ExecutedTrade> {
    const connection = this.requireConnection();
    // MetatraderTradeResponse doesn't carry a fill price, so read the
    // position's current price immediately before closing it — the actual
    // fill may differ by a tick or two of slippage from this estimate.
    const position = await connection.getPosition(trade.id).catch(() => null);
    const exitPrice = position?.currentPrice ?? trade.entry;
    await connection.closePosition(trade.id, {});

    const risk = Math.abs(trade.entry - trade.stop);
    const raw = trade.side === 'LONG' ? exitPrice - trade.entry : trade.entry - exitPrice;
    const pnlR = risk > 0 ? Number((raw / risk).toFixed(2)) : 0;
    return {
      ...trade,
      status: pnlR > 0.05 ? 'WIN' : pnlR < -0.05 ? 'LOSS' : 'BREAKEVEN',
      exitPrice,
      exitTime: new Date().toISOString(),
      pnlR,
      rMultiple: pnlR,
    };
  }
}
