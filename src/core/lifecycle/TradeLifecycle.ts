export type TradeLifecycleState =
  | 'CANDIDATE'
  | 'DECISION_APPROVED'
  | 'DECISION_REJECTED'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'SUBMITTED'
  | 'ORDER_REJECTED'
  | 'FILLED'
  | 'MANAGING'
  | 'BREAKEVEN'
  | 'TRAILING'
  | 'CLOSING'
  | 'CLOSED'
  | 'ARCHIVED';

export interface LifecycleTransition {
  id: string;
  from: TradeLifecycleState | null;
  to: TradeLifecycleState;
  at: string;
  reason?: string;
}

/**
 * Valid next states from each state. A candidate that's been rejected
 * (DECISION_REJECTED/RISK_REJECTED) or an order the broker refused
 * (ORDER_REJECTED) is terminal — those ids never transition again, which is
 * itself meaningful: it means "this specific attempt is over," not "this
 * trade can be retried in place." A fresh attempt gets a fresh id.
 *
 * MANAGING/BREAKEVEN/TRAILING can all go directly to CLOSED — a stop or
 * target hit doesn't only happen from a specific management sub-state, and
 * CLOSING (an order-to-close submitted but not yet broker-confirmed) is
 * defined for completeness but isn't required in this app's fully
 * synchronous close path; a future MT5 close with real settlement latency
 * would route through it. TRAILING self-loops (TRAILING -> TRAILING) since
 * a trailing stop legitimately re-trails on every bar that moves it.
 */
const TRANSITIONS: Record<TradeLifecycleState, readonly TradeLifecycleState[]> = {
  CANDIDATE: ['DECISION_APPROVED', 'DECISION_REJECTED'],
  DECISION_APPROVED: ['RISK_APPROVED', 'RISK_REJECTED'],
  DECISION_REJECTED: [],
  RISK_APPROVED: ['SUBMITTED'],
  RISK_REJECTED: [],
  SUBMITTED: ['FILLED', 'ORDER_REJECTED'],
  ORDER_REJECTED: [],
  FILLED: ['MANAGING'],
  MANAGING: ['BREAKEVEN', 'TRAILING', 'CLOSING', 'CLOSED'],
  BREAKEVEN: ['TRAILING', 'CLOSING', 'CLOSED'],
  TRAILING: ['TRAILING', 'CLOSING', 'CLOSED'],
  CLOSING: ['CLOSED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransition(from: TradeLifecycleState | null, to: TradeLifecycleState): boolean {
  if (from == null) return to === 'CANDIDATE';
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly id: string,
    public readonly from: TradeLifecycleState | null,
    public readonly to: TradeLifecycleState
  ) {
    super(`Invalid trade lifecycle transition for ${id}: ${from ?? '(none)'} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * core/lifecycle/TradeLifecycle
 * --------------------------------
 * Previously a trade's "state" was just whatever ExecutedTrade.status and
 * TradeSignal.status happened to hold at a given moment — true, but not a
 * record of *how it got there*, and nothing stopped an impossible jump
 * (a candidate going straight from CANDIDATE to CLOSED, say) since there
 * was no transition table to check against. This tracker sits alongside
 * those existing status fields (it doesn't replace them — WIN/LOSS/
 * BREAKEVEN on a closed ExecutedTrade is a real outcome classification,
 * not a lifecycle stage) and answers a different question: every state
 * *this specific id* has passed through, in order, with a timestamp and
 * an optional reason for each hop — which is what "every transition is
 * observable, replayable, and testable" actually requires.
 *
 * transition() throws InvalidTransitionError on an illegal hop rather than
 * silently accepting it — a state machine that accepts anything isn't
 * providing the guarantee it exists for.
 */
export class TradeLifecycleTracker {
  private current = new Map<string, TradeLifecycleState>();
  private history = new Map<string, LifecycleTransition[]>();

  /** Current state, or null if this id has never been tracked. */
  stateOf(id: string): TradeLifecycleState | null {
    return this.current.get(id) ?? null;
  }

  historyOf(id: string): LifecycleTransition[] {
    return this.history.get(id) ?? [];
  }

  /** Every id currently tracked, most-recently-touched first. */
  trackedIds(): string[] {
    return [...this.history.entries()]
      .sort((a, b) => {
        const aLast = a[1][a[1].length - 1]?.at ?? '';
        const bLast = b[1][b[1].length - 1]?.at ?? '';
        return bLast.localeCompare(aLast);
      })
      .map(([id]) => id);
  }

  /**
   * Move `id` to `to`. Throws InvalidTransitionError if that hop isn't
   * legal from its current state (or, for a brand-new id, if `to` isn't
   * CANDIDATE — every trade's history has to start at the same place).
   */
  transition(id: string, to: TradeLifecycleState, reason?: string): LifecycleTransition {
    const from = this.stateOf(id);
    if (!canTransition(from, to)) {
      throw new InvalidTransitionError(id, from, to);
    }
    this.current.set(id, to);
    const record: LifecycleTransition = { id, from, to, at: new Date().toISOString(), reason };
    const list = this.history.get(id) ?? [];
    list.push(record);
    this.history.set(id, list);
    return record;
  }

  /**
   * Move all tracked state from `oldId` to `newId`, preserving history —
   * for the one identity change this app has: a TradeCandidate's id and
   * the ExecutedTrade it fills into have different ids (a fresh id is
   * minted at fill time), but it's the same trade's lifecycle continuing,
   * not a new one starting. Throws if `newId` is already tracked, since
   * that would silently discard whichever history was there first.
   */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) return;
    if (this.history.has(newId)) {
      throw new Error(`Cannot rekey ${oldId} -> ${newId}: ${newId} is already tracked.`);
    }
    const state = this.current.get(oldId);
    const hist = this.history.get(oldId);
    if (state == null || hist == null) {
      throw new Error(`Cannot rekey ${oldId}: it isn't tracked.`);
    }
    this.current.set(newId, state);
    this.history.set(newId, hist);
    this.current.delete(oldId);
    this.history.delete(oldId);
  }
}
