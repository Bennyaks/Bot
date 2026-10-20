/**
 * core/risk/PositionSizer
 * --------------------------
 * A flat lot size risks a wildly different dollar amount depending on how
 * wide a given trade's stop is — a 10-pip stop and a 40-pip stop at the
 * same 0.01 lots are not "the same risk," which quietly breaks the
 * R-multiple math the rest of the platform (RiskManager's maxDailyLossR,
 * expectancy, win-rate) is built on. This computes the lot size that risks
 * a fixed PERCENTAGE of account equity on every trade instead, so 1R
 * always means the same thing regardless of that trade's stop distance.
 *
 * Pure function, no broker/network dependency — both MT5Broker and
 * MetaApiBroker call this with whatever symbol specification their own API
 * gives them.
 */

export interface SymbolRiskInfo {
  /** Smallest price increment the broker quotes, e.g. 0.00001 for a 5-digit EURUSD. */
  tickSize: number;
  /** Account-currency value of one tick move, for 1.00 lot. */
  tickValue: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
}

export interface RiskSizingParams {
  equity: number;
  /** Fraction of equity to risk on this trade, e.g. 0.01 for 1%. */
  riskPercent: number;
  entry: number;
  stop: number;
  symbolInfo: SymbolRiskInfo;
}

export interface RiskSizingResult {
  lots: number;
  /** Account-currency amount this position actually risks at the computed, broker-step-snapped lot size (not the requested riskPercent exactly — rounding to the broker's volume step moves it slightly). */
  riskAmount: number;
  warning?: string;
}

export function computeRiskBasedLotSize(params: RiskSizingParams): RiskSizingResult {
  const { equity, riskPercent, entry, stop, symbolInfo } = params;
  const { tickSize, tickValue, volumeMin, volumeMax, volumeStep } = symbolInfo;

  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0 || tickSize <= 0 || tickValue <= 0 || equity <= 0 || riskPercent <= 0) {
    return {
      lots: volumeMin,
      riskAmount: 0,
      warning: 'Could not compute risk-based lot size (missing price/symbol data) — using the symbol minimum lot instead.',
    };
  }

  const riskAmountTarget = equity * riskPercent;
  const ticksAtRisk = stopDistance / tickSize;
  const valuePerLotAtRisk = ticksAtRisk * tickValue;
  let lots = valuePerLotAtRisk > 0 ? riskAmountTarget / valuePerLotAtRisk : volumeMin;

  // Snap to what the broker will actually accept — same rule submit_order's
  // resolve_volume() applies server-side, done here too so the UI/log can
  // show the real size before the order is even sent.
  lots = Math.max(volumeMin, Math.min(volumeMax, lots));
  if (volumeStep > 0) {
    const steps = Math.round((lots - volumeMin) / volumeStep);
    lots = Number((volumeMin + steps * volumeStep).toFixed(8));
  }

  const actualRiskAmount = Number((valuePerLotAtRisk * lots).toFixed(2));
  const requestedLotsBeforeSnap = riskAmountTarget / valuePerLotAtRisk;
  const warning =
    requestedLotsBeforeSnap < volumeMin
      ? `Requested risk (${(riskPercent * 100).toFixed(2)}% = ${riskAmountTarget.toFixed(2)}) would need less than the symbol's minimum lot (${volumeMin}) — using the minimum instead, which risks more than requested (${actualRiskAmount.toFixed(2)}).`
      : requestedLotsBeforeSnap > volumeMax
        ? `Requested risk would need more than the symbol's maximum lot (${volumeMax}) — capping there, which risks less than requested.`
        : undefined;

  return { lots, riskAmount: actualRiskAmount, warning };
}
