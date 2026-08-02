import { describe, it, expect } from 'vitest';
import { TradeLifecycleTracker, canTransition, InvalidTransitionError } from '../TradeLifecycle';

describe('canTransition', () => {
  it('only allows CANDIDATE as the first state', () => {
    expect(canTransition(null, 'CANDIDATE')).toBe(true);
    expect(canTransition(null, 'FILLED')).toBe(false);
  });

  it('allows the documented happy path end to end', () => {
    const path: Parameters<typeof canTransition>[1][] = [
      'CANDIDATE',
      'DECISION_APPROVED',
      'RISK_APPROVED',
      'SUBMITTED',
      'FILLED',
      'MANAGING',
      'BREAKEVEN',
      'TRAILING',
      'CLOSED',
      'ARCHIVED',
    ];
    let from: Parameters<typeof canTransition>[0] = null;
    for (const to of path) {
      expect(canTransition(from, to)).toBe(true);
      from = to;
    }
  });

  it('rejects an impossible jump straight from CANDIDATE to CLOSED', () => {
    expect(canTransition('CANDIDATE', 'CLOSED')).toBe(false);
  });

  it('rejects transitioning out of a terminal rejection state', () => {
    expect(canTransition('DECISION_REJECTED', 'RISK_APPROVED')).toBe(false);
    expect(canTransition('RISK_REJECTED', 'SUBMITTED')).toBe(false);
    expect(canTransition('ORDER_REJECTED', 'FILLED')).toBe(false);
    expect(canTransition('ARCHIVED', 'MANAGING')).toBe(false);
  });

  it('allows TRAILING to self-loop (repeated trailing-stop updates)', () => {
    expect(canTransition('TRAILING', 'TRAILING')).toBe(true);
  });

  it('allows MANAGING/BREAKEVEN/TRAILING to close directly without visiting CLOSING', () => {
    expect(canTransition('MANAGING', 'CLOSED')).toBe(true);
    expect(canTransition('BREAKEVEN', 'CLOSED')).toBe(true);
    expect(canTransition('TRAILING', 'CLOSED')).toBe(true);
  });
});

describe('TradeLifecycleTracker', () => {
  it('starts an id at CANDIDATE and records the transition', () => {
    const tracker = new TradeLifecycleTracker();
    tracker.transition('T1', 'CANDIDATE');
    expect(tracker.stateOf('T1')).toBe('CANDIDATE');
    expect(tracker.historyOf('T1')).toEqual([
      expect.objectContaining({ id: 'T1', from: null, to: 'CANDIDATE' }),
    ]);
  });

  it('throws InvalidTransitionError on an illegal hop and does not mutate state', () => {
    const tracker = new TradeLifecycleTracker();
    tracker.transition('T1', 'CANDIDATE');
    expect(() => tracker.transition('T1', 'CLOSED')).toThrow(InvalidTransitionError);
    expect(tracker.stateOf('T1')).toBe('CANDIDATE'); // unchanged after the failed attempt
    expect(tracker.historyOf('T1')).toHaveLength(1); // no bad record appended
  });

  it('records a reason with each transition when supplied', () => {
    const tracker = new TradeLifecycleTracker();
    tracker.transition('T1', 'CANDIDATE');
    tracker.transition('T1', 'DECISION_REJECTED', 'confidence below threshold');
    expect(tracker.historyOf('T1')[1].reason).toBe('confidence below threshold');
  });

  it('builds a full ordered history across many transitions', () => {
    const tracker = new TradeLifecycleTracker();
    tracker.transition('T1', 'CANDIDATE');
    tracker.transition('T1', 'DECISION_APPROVED');
    tracker.transition('T1', 'RISK_APPROVED');
    tracker.transition('T1', 'SUBMITTED');
    tracker.transition('T1', 'FILLED');
    tracker.transition('T1', 'MANAGING');
    tracker.transition('T1', 'BREAKEVEN', 'price reached +1R');
    tracker.transition('T1', 'CLOSED', 'target hit');
    const history = tracker.historyOf('T1');
    expect(history.map((h) => h.to)).toEqual([
      'CANDIDATE',
      'DECISION_APPROVED',
      'RISK_APPROVED',
      'SUBMITTED',
      'FILLED',
      'MANAGING',
      'BREAKEVEN',
      'CLOSED',
    ]);
    expect(history.every((h, i) => (i === 0 ? h.from === null : h.from === history[i - 1].to))).toBe(true);
  });

  it('rekey moves current state and full history to a new id', () => {
    const tracker = new TradeLifecycleTracker();
    tracker.transition('C1', 'CANDIDATE');
    tracker.transition('C1', 'DECISION_APPROVED');
    tracker.transition('C1', 'RISK_APPROVED');
    tracker.transition('C1', 'SUBMITTED');
    tracker.rekey('C1', 'PB-XYZ');

    expect(tracker.stateOf('C1')).toBeNull();
    expect(tracker.historyOf('C1')).toEqual([]);
    expect(tracker.stateOf('PB-XYZ')).toBe('SUBMITTED');
    expect(tracker.historyOf('PB-XYZ')).toHaveLength(4);

    // The rekeyed id continues seamlessly — FILLED is a legal next state from SUBMITTED.
    tracker.transition('PB-XYZ', 'FILLED');
    expect(tracker.stateOf('PB-XYZ')).toBe('FILLED');
  });

  it('rekey throws if the new id is already tracked, rather than silently discarding history', () => {
    const tracker = new TradeLifecycleTracker();
    tracker.transition('C1', 'CANDIDATE');
    tracker.transition('C2', 'CANDIDATE');
    expect(() => tracker.rekey('C1', 'C2')).toThrow();
  });

  it('rekey throws for an untracked source id', () => {
    const tracker = new TradeLifecycleTracker();
    expect(() => tracker.rekey('ghost', 'C1')).toThrow();
  });

  it('trackedIds returns most-recently-touched first', () => {
    const tracker = new TradeLifecycleTracker();
    tracker.transition('OLD', 'CANDIDATE');
    tracker.transition('NEW', 'CANDIDATE');
    tracker.transition('OLD', 'DECISION_REJECTED');
    // OLD was touched again after NEW, so it should now lead.
    expect(tracker.trackedIds()[0]).toBe('OLD');
  });

  it('an id with no tracked history reports null state and empty history', () => {
    const tracker = new TradeLifecycleTracker();
    expect(tracker.stateOf('nope')).toBeNull();
    expect(tracker.historyOf('nope')).toEqual([]);
  });
});
