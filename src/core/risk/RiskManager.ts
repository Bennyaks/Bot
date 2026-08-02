import { explainRejection } from '../../lib/engine';
import { currencyExposureLegs } from '../../lib/instruments';
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
   * Max net directional exposure to a single underlying currency, in "R
   * units" (one open position each on the base or quote side = 1 unit).
   * Long EURUSD + Long GBPUSD + Short USDJPY is -3 net USD exposure even
   * though each looks like an independent 1R risk on its own symbol — this
   * is the check that catches that.
   */
  maxCurrencyExposure: number;
}

export const DEFAULT_RISK_RULES: RiskRules = {
  maxOpenPositions: 3,
  maxDailyLossR: -4,
  maxConsecutiveLosses: 3,
  maxExposurePerSymbol: 1,
  minRiskReward: 1.5,
  maxCurrencyExposure: 2,
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

  /**
   * Net signed exposure per currency across every open position plus the
   * candidate itself. A currency that only the candidate touches but no
   * open position does still returns a defined (non-zero) entry so the
   * caller doesn't need a separate existence check.
   */
  private currencyExposure(
    portfolio: PortfolioState,
    candidate: TradeCandidate
  ): Map<string, number> {
    const totals = new Map<string, number>();
    const add = (instrument: string, side: TradeCandidate['side']) => {
      for (const leg of currencyExposureLegs(instrument, side)) {
        totals.set(leg.currency, (totals.get(leg.currency) ?? 0) + leg.sign);
      }
    };
    for (const position of portfolio.openPositions) {
      add(position.instrument, position.side);
    }
    add(candidate.instrument, candidate.side);
    return totals;
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

    const exposureAfterCandidate = this.currencyExposure(portfolio, candidate);
    const candidateCurrencies = currencyExposureLegs(candidate.instrument, candidate.side).map(
      (leg) => leg.currency
    );
    for (const currency of candidateCurrencies) {
      const net = exposureAfterCandidate.get(currency) ?? 0;
      if (Math.abs(net) > this.rules.maxCurrencyExposure) {
        const contributors = portfolio.openPositions
          .filter((p) => currencyExposureLegs(p.instrument, p.side).some((leg) => leg.currency === currency))
          .map((p) => `${p.side} ${p.instrument}`);
        return {
          approved: false,
          ruleId: 'correlation_exposure',
          reason: `Adding ${candidate.side} ${candidate.instrument} would push net ${currency} exposure to ${net} (limit ${this.rules.maxCurrencyExposure}) — correlated with ${contributors.join(', ') || 'no other open positions'}`,
        };
      }
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
