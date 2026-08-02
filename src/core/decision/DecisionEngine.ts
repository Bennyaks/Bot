import type { RejectedTrade, SessionMetrics } from '../../lib/types';
import { explainRejection, sessionScore } from '../../lib/engine';
import type { TradeApproval, TradeCandidate } from '../interfaces';

export interface DecisionContext {
  sessionMetrics: SessionMetrics[];
  minConfidence?: number;
  minRiskReward?: number;
  /**
   * Spread in price units for the candidate's instrument, if known.
   * MarketProvider.getSpread() existed but nothing ever called it — this is
   * the field that makes the spread_cost gate below possible. Left
   * undefined, the gate can't check anything and passes through, so this is
   * additive and doesn't change behaviour for callers that don't supply it
   * (e.g. existing tests/backtest configs written before this).
   */
  spread?: number;
}

export type DecisionResult =
  | { approved: true; approval: TradeApproval }
  | { approved: false; rejection: RejectedTrade };

interface Gate {
  id: string;
  label: string;
  evaluate(candidate: TradeCandidate, ctx: DecisionContext): boolean;
}

/**
 * core/decision — Breakout -> TradeCandidate -> Decision Engine -> Approved | Rejected.
 *
 * A candidate must clear every mandatory gate to become a TradeApproval.
 * Each gate is independent and named, so a rejection is always explainable —
 * "Most Common Rejection" analytics (Phase 9) reads directly off gate ids.
 */
export class DecisionEngine {
  private gates: Gate[] = [
    {
      id: 'trend_alignment',
      label: 'Trend alignment',
      evaluate: (c) => c.marketRegime === 'TRENDING_BULL' || c.marketRegime === 'TRENDING_BEAR',
    },
    {
      id: 'session_evidence',
      label: 'Session evidence',
      evaluate: (c, ctx) => {
        const metrics = ctx.sessionMetrics.find((m) => m.session === c.session);
        if (!metrics) return false;
        return sessionScore(c.session, metrics).allow;
      },
    },
    {
      id: 'confidence_threshold',
      label: 'Confidence threshold',
      evaluate: (c, ctx) => c.confidence >= (ctx.minConfidence ?? 0.6),
    },
    {
      id: 'reward_risk',
      label: 'Reward:risk quality',
      evaluate: (c, ctx) => c.riskReward >= (ctx.minRiskReward ?? 1.5),
    },
    {
      id: 'structure_quality',
      label: 'Structure quality',
      evaluate: (c) => c.structure.length > 0 && c.setupStage !== 'SCANNING',
    },
    {
      id: 'no_news_event',
      label: 'No active news event',
      evaluate: (c) => c.marketRegime !== 'NEWS_EVENT',
    },
    {
      id: 'spread_cost',
      label: 'Reward:risk survives spread cost',
      evaluate: (c, ctx) => {
        // A spread has to be crossed on entry and would still have to be
        // crossed on an unfavourable exit, so it widens effective risk and
        // shrinks effective reward. Without ctx.spread this gate has
        // nothing to check against and passes — it never blocks a
        // candidate the caller didn't give spread data for.
        if (ctx.spread == null || ctx.spread <= 0) return true;
        const risk = Math.abs(c.entry - c.stop);
        const reward = Math.abs(c.target - c.entry);
        if (risk <= 0) return false;
        const netRisk = risk + ctx.spread;
        const netReward = Math.max(reward - ctx.spread, 0);
        const netRiskReward = netReward / netRisk;
        return netRiskReward >= (ctx.minRiskReward ?? 1.5);
      },
    },
  ];

  /** Allow the platform to register additional gates (e.g. spread, liquidity sweep) without editing this class. */
  registerGate(gate: Gate) {
    this.gates.push(gate);
  }

  evaluate(candidate: TradeCandidate, ctx: DecisionContext): DecisionResult {
    const passed: string[] = [];
    const failed: string[] = [];

    for (const gate of this.gates) {
      if (gate.evaluate(candidate, ctx)) {
        passed.push(gate.id);
      } else {
        failed.push(gate.label);
      }
    }

    if (failed.length > 0) {
      const rejection = explainRejection({
        instrument: candidate.instrument,
        timeframe: candidate.timeframe,
        side: candidate.side,
        setupStage: candidate.setupStage,
        failedRules: failed,
        marketRegime: candidate.marketRegime,
        confidence: candidate.confidence,
        supportingData: {
          riskReward: candidate.riskReward,
          gatesPassed: passed.length,
          gatesTotal: this.gates.length,
        },
        session: candidate.session,
      });
      return { approved: false, rejection };
    }

    return {
      approved: true,
      approval: {
        candidateId: candidate.id,
        approvedAt: new Date().toISOString(),
        score: passed.length / this.gates.length,
        passedGates: passed,
      },
    };
  }
}
