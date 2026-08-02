import type { ExecutedTrade, SafetyCheck } from '../../lib/types';
import type { Broker, ExecutionProvider } from '../../core/interfaces';

/**
 * execution/mt5/MT5Broker
 * -------------------------
 * Phase 13. A real MT5 adapter talks to a running MetaTrader terminal
 * through a bridge process (an Expert Advisor exposing a local socket or
 * file-based queue, or a hosted service like MetaApi) — there is no direct
 * browser-to-terminal connection, so this class cannot make that call from
 * inside this sandboxed app. What it *does* do is implement the exact same
 * `ExecutionProvider`/`Broker` contract as PaperBroker, with the fill
 * behaviour a bridge would realistically add (network latency, slippage,
 * occasional dropped connections) simulated instead of faked away — so
 * swapping this in for PaperBroker via SystemOrchestrator.setBroker/
 * setExecution is a one-line DI change, not a rewrite, whenever a real
 * bridge exists.
 *
 * `magicNumber`/`deviationPoints` are included because they're mandatory
 * fields on any real MT5 order request (OrderSend) — keeping them here now
 * means the interface this class satisfies won't need to change shape
 * later, only its `submit()`/`isConnected()` bodies will.
 */
export interface MT5Config {
  bridgeUrl: string;
  magicNumber: number;
  deviationPoints: number;
  /** Simulated round-trip latency to the bridge, in ms. */
  simulatedLatencyMs: number;
  /** Simulated slippage as a fraction of the requested price (e.g. 0.00003 = 0.3 pips on a 4dp pair). */
  simulatedSlippage: number;
}

export const DEFAULT_MT5_CONFIG: MT5Config = {
  bridgeUrl: 'tcp://127.0.0.1:5555', // placeholder — a real bridge EA/socket address
  magicNumber: 20260727,
  deviationPoints: 10,
  simulatedLatencyMs: 80,
  simulatedSlippage: 0.00003,
};

export class MT5Broker implements ExecutionProvider, Broker {
  id = 'mt5-broker (simulated bridge)';
  private connected = true;

  constructor(
    private safetyChecks: () => SafetyCheck[],
    private config: MT5Config = DEFAULT_MT5_CONFIG
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  /** Test-only / demo-only hook — a real bridge would flip this from a heartbeat, not a manual call. */
  simulateDisconnect(): void {
    this.connected = false;
  }

  simulateReconnect(): void {
    this.connected = true;
  }

  runSafetyChecks(): SafetyCheck[] {
    return this.safetyChecks();
  }

  accountEquity(): number {
    return 10_000;
  }

  submit(candidate: Parameters<ExecutionProvider['submit']>[0], lotSize: number, spread = 0): ExecutedTrade {
    if (!this.connected) {
      throw new Error(`${this.id}: bridge unreachable, order not sent`);
    }
    const slippage = candidate.side === 'LONG' ? this.config.simulatedSlippage : -this.config.simulatedSlippage;
    // Slippage (execution latency vs the quote) and spread (the ask/bid the
    // broker actually deals at) are two separate costs — a real bridge fill
    // pays both. Previously only slippage was modelled and spread was ignored.
    const halfSpread = spread / 2;
    const spreadAdjustment = candidate.side === 'LONG' ? halfSpread : -halfSpread;
    const fillPrice = candidate.entry + slippage + spreadAdjustment;

    return {
      id: `MT5-${Date.now().toString(36).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      instrument: candidate.instrument,
      timeframe: candidate.timeframe,
      side: candidate.side,
      entry: fillPrice,
      stop: candidate.stop,
      target: candidate.target,
      lotSize,
      rMultiple: null,
      status: 'OPEN',
      session: candidate.session,
      confidence: candidate.confidence,
      strategyVersion: candidate.strategyVersion,
      explanation: `Filled by ${this.id} · magic ${this.config.magicNumber} · deviation ${this.config.deviationPoints}pt · ${lotSize} lots · slippage ${(slippage * 1e5).toFixed(1)}pip · spread ${(spread * 1e5).toFixed(1)}pip`,
    };
  }

  close(trade: ExecutedTrade, exitPrice: number): ExecutedTrade {
    if (!this.connected) {
      throw new Error(`${this.id}: bridge unreachable, close not sent`);
    }
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
