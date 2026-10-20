import type { ExecutedTrade, SafetyCheck } from '../../lib/types';
import type { Broker, ExecutionProvider } from '../../core/interfaces';

/**
 * execution/paper/PaperBroker
 * ----------------------------
 * Implements both ExecutionProvider (order fills) and Broker (connectivity /
 * safety) so the rest of the platform is agnostic to which is wired in.
 * A future execution/mt5/MT5Broker would implement the exact same two
 * interfaces — nothing upstream of ExecutionProvider needs to change.
 */
export class PaperBroker implements ExecutionProvider, Broker {
  id = 'paper-broker';

  constructor(private safetyChecks: () => SafetyCheck[]) {}

  isConnected(): boolean {
    return true;
  }

  runSafetyChecks(): SafetyCheck[] {
    return this.safetyChecks();
  }

  accountEquity(): number {
    return 10_000;
  }

  submit(candidate: Parameters<ExecutionProvider['submit']>[0]): ExecutedTrade {
    return {
      id: `PB-${Date.now().toString(36).toUpperCase()}`,
      timestamp: new Date().toISOString(),
      instrument: candidate.instrument,
      timeframe: candidate.timeframe,
      side: candidate.side,
      entry: candidate.entry,
      stop: candidate.stop,
      target: candidate.target,
      lotSize: 0.1,
      rMultiple: null,
      status: 'OPEN',
      session: candidate.session,
      confidence: candidate.confidence,
      strategyVersion: candidate.strategyVersion,
      explanation: `Filled by PaperBroker from candidate ${candidate.id}`,
    };
  }

  close(trade: ExecutedTrade, exitPrice: number): ExecutedTrade {
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
