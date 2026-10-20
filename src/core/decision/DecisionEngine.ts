import type { RejectedTrade, SessionMetrics } from '../../lib/types';
import { explainRejection, sessionScore } from '../../lib/engine';
import { is24_7Market } from '../../lib/instruments';
import type { TradeApproval, TradeCandidate } from '../interfaces';

export interface DecisionContext {
  sessionMetrics: SessionMetrics[];
  minConfidence?: number;
  minRiskReward?: number;
  /** Minimum closed trades in a session before its stats are trusted enough to reject on. Default 10. */
  minSessionSample?: number;
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
        // Crypto and other 24/7 markets have no "session" to have evidence
        // for — the Asian/London/NewYork model this gate checks is an FX
        // concept. Skip rather than reject: an empty/missing sessionMetrics
        // entry for a 24/7 instrument isn't evidence of underperformance.
        if (is24_7Market(c.instrument)) return true;
        const metrics = ctx.sessionMetrics.find((m) => m.session === c.session);
        const minSample = ctx.minSessionSample ?? 10;
        // No matching entry, or too few REAL closed trades in this session
        // to draw a conclusion from, is an absence of evidence — not
        // evidence of underperformance. A fresh live account starts with
        // zero trades in every session; that must not read as "every
        // session has failed" the way it would if this returned false.
        if (!metrics || metrics.totalTrades < minSample) return true;
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
