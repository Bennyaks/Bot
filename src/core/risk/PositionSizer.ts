import { getInstrumentSpec, type InstrumentSpec } from '../../lib/instruments';

export interface PositionSizingRules {
  /** % of account equity risked per trade, e.g. 1 = risk 1% of equity. */
  riskPercentPerTrade: number;
  /** Hard ceiling on lot size regardless of what the risk math produces. */
  maxLotSize: number;
}

export const DEFAULT_POSITION_SIZING_RULES: PositionSizingRules = {
  riskPercentPerTrade: 1,
  maxLotSize: 5,
};

export interface PositionSizeInput {
  equity: number;
  entry: number;
  stop: number;
  instrument: string;
  /** Spread in price units, if known — widens effective stop distance since a spread must be crossed to exit at a loss too. */
  spread?: number;
}

export interface PositionSizeResult {
  lotSize: number;
  /** Dollar amount actually at risk once the sizing is rounded/clamped to a tradable lot. */
  riskAmountUsd: number;
  /** riskAmountUsd expressed as a % of the input equity, for comparison against the target. */
  effectiveRiskPercent: number;
  stopDistance: number;
  clamped: boolean;
  warnings: string[];
}

/**
 * core/risk/PositionSizer
 * --------------------------
 * Previously `lotSize` was hardcoded to 0.1 in PaperBroker, MT5Broker, the
 * backtest harness, and the demo data — every trade risked the same amount
 * regardless of account size or stop width, which is the opposite of
 * "capital protection overrides profit". This computes lots from
 * (equity * risk%) / (stop distance in $ per lot), so a wide stop
 * automatically produces a smaller position and a tight stop a larger one,
 * always targeting the same dollar risk.
 */
export class PositionSizer {
  constructor(private rules: PositionSizingRules = DEFAULT_POSITION_SIZING_RULES) {}

  calculate(input: PositionSizeInput): PositionSizeResult {
    const spec: InstrumentSpec = getInstrumentSpec(input.instrument);
    const warnings: string[] = [];

    const rawStopDistance = Math.abs(input.entry - input.stop);
    // A spread has to be crossed on both entry and exit, so it effectively
    // widens the distance between where you get filled and where a loss is
    // realized — price it into the sizing, not just the decision gate.
    const stopDistance = rawStopDistance + (input.spread ?? 0);

    if (stopDistance <= 0 || input.equity <= 0) {
      warnings.push('Invalid stop distance or equity — sized to minimum lot as a fail-safe.');
      return {
        lotSize: spec.minLot,
        riskAmountUsd: 0,
        effectiveRiskPercent: 0,
        stopDistance,
        clamped: true,
        warnings,
      };
    }

    const riskAmountTarget = input.equity * (this.rules.riskPercentPerTrade / 100);
    const pipsAtRisk = stopDistance / spec.pipSize;
    const dollarRiskPerLot = pipsAtRisk * spec.pipValuePerStandardLot;

    let lots = dollarRiskPerLot > 0 ? riskAmountTarget / dollarRiskPerLot : spec.minLot;

    // Round to the instrument's lot step.
    lots = Math.round(lots / spec.lotStep) * spec.lotStep;

    let clamped = false;
    const rulesMax = Math.min(this.rules.maxLotSize, spec.maxLot);
    if (lots > rulesMax) {
      warnings.push(
        `Sizing capped at max lot ${rulesMax} (risk math wanted ${lots.toFixed(2)} — stop is unusually tight for this equity).`
      );
      lots = rulesMax;
      clamped = true;
    }
    if (lots < spec.minLot) {
      warnings.push(
        `Sizing floored at min lot ${spec.minLot} (risk math wanted ${lots.toFixed(4)} — actual risk will exceed the ${this.rules.riskPercentPerTrade}% target because the stop is wide relative to equity).`
      );
      lots = spec.minLot;
      clamped = true;
    }

    lots = Number(lots.toFixed(2));
    const riskAmountUsd = Number((lots * dollarRiskPerLot).toFixed(2));
    const effectiveRiskPercent = Number(((riskAmountUsd / input.equity) * 100).toFixed(3));

    return { lotSize: lots, riskAmountUsd, effectiveRiskPercent, stopDistance, clamped, warnings };
  }
}
