import { describe, it, expect } from 'vitest';
import { translateBrokerError, friendlyReason } from './friendlyError';

describe('translateBrokerError', () => {
  it('translates a known retcode into plain language', () => {
    const result = translateBrokerError(
      'MT5 bridge rejected the request: /orders → order_send failed (retcode=10018, last_error=1: Success)'
    );
    expect(result.title).toBe('Market is closed');
    expect(result.retryable).toBe(true);
    expect(result.raw).toContain('retcode=10018');
  });

  it('translates the AutoTrading-disabled retcode with an actionable instruction', () => {
    const result = translateBrokerError('order_send failed (retcode=10027, last_error=1: Success)');
    expect(result.title).toMatch(/AutoTrading/i);
    expect(result.message).toMatch(/toolbar|Options/i);
  });

  it('translates an unreachable bridge error', () => {
    const result = translateBrokerError(
      'Could not reach the MT5 bridge at http://localhost:8787 — is mt5_bridge.py running?'
    );
    expect(result.title).toMatch(/reach/i);
    expect(result.retryable).toBe(true);
  });

  it('translates a timeout error', () => {
    const result = translateBrokerError('MT5 bridge at http://localhost:8787/orders did not respond within 20s');
    expect(result.title).toMatch(/too long/i);
  });

  it('translates a stop-distance validation error', () => {
    const result = translateBrokerError('Stop is 0.00040 from price; EURUSD requires at least 0.00050 (5 points)');
    expect(result.title).toMatch(/close/i);
    expect(result.retryable).toBe(false);
  });

  it('translates a symbol-selection error', () => {
    const result = translateBrokerError("Could not select symbol 'EURUSD' — check it's visible in Market Watch.");
    expect(result.title).toMatch(/available/i);
  });

  it('falls back to a generic message for an unrecognized retcode', () => {
    const result = translateBrokerError('order_send failed (retcode=99999, last_error=1: Success)');
    expect(result.title).toBe('Trade was not placed');
    expect(result.message).toContain('99999');
  });

  it('falls back to a fully generic message when nothing matches', () => {
    const result = translateBrokerError('some totally unexpected internal error');
    expect(result.title).toMatch(/went wrong/i);
    expect(result.raw).toBe('some totally unexpected internal error');
  });

  it('never discards the original raw text', () => {
    const raw = 'order_send failed (retcode=10019, last_error=1: Success)';
    expect(translateBrokerError(raw).raw).toBe(raw);
  });
});

describe('friendlyReason', () => {
  it('translates a known Decision Engine gate label', () => {
    expect(friendlyReason('Confidence threshold')).toMatch(/confident enough/);
    expect(friendlyReason('Reward:risk quality')).toMatch(/reward/);
    expect(friendlyReason('Session evidence')).toMatch(/track record/);
  });

  it('strips a DecisionEngine:/RiskManager: prefix before translating', () => {
    expect(friendlyReason('DecisionEngine: Confidence threshold')).toMatch(/confident enough/);
  });

  it('passes through an unrecognized reason unchanged', () => {
    expect(friendlyReason('Some brand new rule')).toBe('Some brand new rule');
  });
});
