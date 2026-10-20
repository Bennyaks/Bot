import { explainRejection } from '../../lib/engine';
import type { RejectedTrade } from '../../lib/types';
import type {
  PortfolioState,
  RiskManagerContract,
  RiskVerdict,
  TradeCandidate,
} from '../interfaces';

export interface RiskRules {
  maxOpenPositions: number;
  maxDailyLossR: number;
  maxConsecutiveLosses: number;
  maxExposurePerSymbol: number;
  minRiskReward: number;
  /**
   * Two different instruments sharing a currency (EURUSD + GBPUSD both
   * touch USD; EURUSD + EURGBP both touch EUR) are correlated bets, not
   * independent ones — a single currency move can hit both at once. This
   * caps how many open positions may touch any one currency, including
   * the candidate about to open.
   */
  maxPositionsPerCurrency: number;
}

export const DEFAULT_RISK_RULES: RiskRules = {
  maxOpenPositions: 3,
  maxDailyLossR: -4,
  maxConsecutiveLosses: 3,
  maxExposurePerSymbol: 1,
  minRiskReward: 1.5,
  maxPositionsPerCurrency: 2,
};

/**
 * core/risk — the Risk Manager can reject a trade regardless of how
 * confident the strategy or Decision Engine were. It is the last gate
 * before a candidate is allowed to reach the Execution Layer.
 */
export class RiskManager implements RiskManagerContract {
  constructor(private rules: RiskRules = DEFAULT_RISK_RULES) {}

  private consecutiveLosses(portfolio: PortfolioState): number {
    let streak = 0;
    for (const trade of portfolio.closedToday) {
      if (trade.status === 'LOSS') streak += 1;
      else if (trade.status === 'WIN') break;
    }
    return streak;
  }

  private dailyR(portfolio: PortfolioState): number {
    return portfolio.closedToday.reduce((sum, t) => sum + (t.pnlR ?? 0), 0);
  }

  private exposure(portfolio: PortfolioState, instrument: string): number {
    return portfolio.openPositions.filter((p) => p.instrument === instrument).length;
  }

  /** e.g. 'EURUSD' -> ['EUR', 'USD']. Falls back to the whole symbol for anything non-standard (crypto/CFD tickers etc.) rather than throwing. */
  private currenciesOf(instrument: string): string[] {
    const symbol = instrument.toUpperCase();
    return symbol.length >= 6 ? [symbol.slice(0, 3), symbol.slice(3, 6)] : [symbol];
  }

  /** The first currency already at or over the limit once this candidate is included, or null if none. */
  private correlatedCurrencyLimit(portfolio: PortfolioState, instrument: string): { currency: string; count: number } | null {
    for (const currency of this.currenciesOf(instrument)) {
      const count = portfolio.openPositions.filter((p) => this.currenciesOf(p.instrument).includes(currency)).length;
      if (count + 1 > this.rules.maxPositionsPerCurrency) return { currency, count };
    }
    return null;
  }

  evaluate(candidate: TradeCandidate, portfolio: PortfolioState): RiskVerdict {
    if (portfolio.openPositions.length >= this.rules.maxOpenPositions) {
      return {
        approved: false,
        ruleId: 'max_open_positions',
        reason: `Max open positions reached (${this.rules.maxOpenPositions})`,
      };
    }

    const consecutiveLosses = this.consecutiveLosses(portfolio);
    if (consecutiveLosses >= this.rules.maxConsecutiveLosses) {
      return {
        approved: false,
        ruleId: 'max_consecutive_losses',
        reason: `${consecutiveLosses} consecutive losses — cooling off`,
      };
    }

    const dailyR = this.dailyR(portfolio);
    if (dailyR <= this.rules.maxDailyLossR) {
      return {
        approved: false,
        ruleId: 'max_daily_loss',
        reason: `Daily loss limit hit (${dailyR.toFixed(2)}R ≤ ${this.rules.maxDailyLossR}R)`,
      };
    }

    if (this.exposure(portfolio, candidate.instrument) >= this.rules.maxExposurePerSymbol) {
      return {
        approved: false,
        ruleId: 'max_symbol_exposure',
        reason: `Max exposure to ${candidate.instrument} already open`,
      };
    }

    const correlated = this.correlatedCurrencyLimit(portfolio, candidate.instrument);
    if (correlated) {
      return {
        approved: false,
        ruleId: 'max_currency_correlation',
        reason: `${correlated.count} open position(s) already exposed to ${correlated.currency} — opening ${candidate.instrument} would be a correlated bet, not an independent one`,
      };
    }

    if (candidate.riskReward < this.rules.minRiskReward) {
      return {
        approved: false,
        ruleId: 'min_risk_reward',
        reason: `Reward:risk ${candidate.riskReward.toFixed(2)} below minimum ${this.rules.minRiskReward}`,
      };
    }

    return { approved: true, reason: 'Within all risk limits' };
  }

  /** Build a full RejectedTrade explanation from a risk verdict, for the journal/UI. */
  explain(candidate: TradeCandidate, verdict: RiskVerdict): RejectedTrade {
    return explainRejection({
      instrument: candidate.instrument,
      timeframe: candidate.timeframe,
      side: candidate.side,
      setupStage: 'RISK_EVAL',
      failedRules: [`Risk Manager: ${verdict.reason}`],
      marketRegime: candidate.marketRegime,
      confidence: candidate.confidence,
      supportingData: { ruleId: verdict.ruleId ?? 'unknown' },
      session: candidate.session,
    });
  }
}
