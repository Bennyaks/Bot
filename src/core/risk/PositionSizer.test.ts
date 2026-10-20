import { describe, it, expect } from 'vitest';
import { computeRiskBasedLotSize } from './PositionSizer';

describe('computeRiskBasedLotSize', () => {
  it('sizes a wider stop smaller and a tighter stop bigger for the same risk %', () => {
    const symbolInfo = { tickSize: 0.00001, tickValue: 1, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };
    const tight = computeRiskBasedLotSize({ equity: 10_000, riskPercent: 0.01, entry: 1.1, stop: 1.099, symbolInfo }); // 10 pip stop
    const wide = computeRiskBasedLotSize({ equity: 10_000, riskPercent: 0.01, entry: 1.1, stop: 1.096, symbolInfo }); // 40 pip stop

    expect(tight.lots).toBeGreaterThan(wide.lots);
    // Both should risk roughly the same dollar amount despite the different lot sizes.
    expect(tight.riskAmount).toBeCloseTo(100, 0);
    expect(wide.riskAmount).toBeCloseTo(100, 0);
  });

  it('snaps to the broker volume step/min/max rather than returning an unsnapped float', () => {
    const symbolInfo = { tickSize: 0.00001, tickValue: 1, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };
    const result = computeRiskBasedLotSize({ equity: 10_000, riskPercent: 0.01, entry: 1.1, stop: 1.099, symbolInfo });
    const steps = (result.lots - symbolInfo.volumeMin) / symbolInfo.volumeStep;
    expect(Number.isInteger(Number(steps.toFixed(6)))).toBe(true);
  });

  it('falls back to the symbol minimum lot with a warning when inputs are unusable', () => {
    const symbolInfo = { tickSize: 0, tickValue: 0, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };
    const result = computeRiskBasedLotSize({ equity: 10_000, riskPercent: 0.01, entry: 1.1, stop: 1.1, symbolInfo });
    expect(result.lots).toBe(0.01);
    expect(result.warning).toBeDefined();
  });

  it('flags and caps when the requested risk would exceed the symbol max lot', () => {
    const symbolInfo = { tickSize: 0.00001, tickValue: 1, volumeMin: 0.01, volumeMax: 1, volumeStep: 0.01 };
    // Huge equity + tight stop -> the math wants far more than 1.0 lots.
    const result = computeRiskBasedLotSize({ equity: 10_000_000, riskPercent: 0.01, entry: 1.1, stop: 1.0999, symbolInfo });
    expect(result.lots).toBe(1);
    expect(result.warning).toContain('maximum lot');
  });
});
