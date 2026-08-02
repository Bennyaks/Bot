import { getInstrumentSpec } from './instruments';

export type NewsImpact = 'low' | 'medium' | 'high';

export interface NewsEvent {
  id: string;
  currency: string;
  label: string;
  impact: NewsImpact;
  /** Epoch ms the event fires. */
  time: number;
}

/**
 * lib/newsCalendar
 * ------------------
 * There is no real economic-calendar integration in this app (that needs an
 * external data provider — ForexFactory/TradingEconomics/etc — which this
 * sandboxed app has no credentialed access to). What was actually missing,
 * though, wasn't the data provider so much as *any* code path that could
 * ever set MarketRegime.NEWS_EVENT — the gate in DecisionEngine existed but
 * nothing upstream ever produced that regime.
 *
 * This generates a small, deterministic-per-session set of high/medium
 * impact events on a realistic cadence (a few per currency per day) anchored
 * to the current time, so blackout windows are real and testable — swapping
 * `generateSessionEvents` for a live calendar fetch later is a one-function
 * change; `isNewsBlackout` and every caller of it stays identical.
 */
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'XAU', 'BTC', 'NAS100'];

const EVENT_LABELS: Record<string, string[]> = {
  USD: ['Non-Farm Payrolls', 'CPI y/y', 'FOMC Rate Decision', 'ISM Manufacturing PMI'],
  EUR: ['ECB Rate Decision', 'Flash CPI y/y', 'German ZEW Sentiment'],
  GBP: ['BOE Rate Decision', 'UK CPI y/y', 'UK GDP m/m'],
  JPY: ['BOJ Policy Rate', 'Tokyo CPI y/y'],
  XAU: ['US CPI y/y', 'FOMC Rate Decision'],
  BTC: ['US CPI y/y', 'SEC Policy Update'],
  NAS100: ['FOMC Rate Decision', 'US Nonfarm Payrolls', 'CPI y/y'],
};

/**
 * Deterministic seed so the same (dayIndex, currency, slot) always produces
 * the same pseudo-random draw — this is what makes the calendar a fixed set
 * of points in time rather than something that reshuffles depending on when
 * you ask about it.
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every event scheduled on UTC day `dayIndex` (days since epoch). This is a
 * pure function of dayIndex alone — critically, NOT of whatever instant the
 * caller happens to be querying from. A real calendar entry ("CPI at
 * 13:30 UTC Thursday") is a fixed point in time regardless of when you look
 * it up; an earlier version of this function computed event.time as
 * `queryTime + offset`, which meant the same "event" silently became a
 * different point in time depending on which instant you asked about —
 * an event that looked 20h out from one query would not be the event found
 * when querying again 5 minutes before it. Keying purely off the day fixes
 * that: querying at 09:00 and querying again at 16:55 on the same day sees
 * the exact same event list and the exact same event.time values.
 */
function eventsForDay(dayIndex: number): NewsEvent[] {
  const dayStart = dayIndex * MS_PER_DAY;
  const events: NewsEvent[] = [];

  CURRENCIES.forEach((currency, ci) => {
    const labels = EVENT_LABELS[currency] ?? [`${currency} Economic Release`];
    // 1-2 events per currency per day.
    const count = 1 + Math.floor(seededRandom(dayIndex * 131 + ci * 97) * 2);
    for (let i = 0; i < count; i++) {
      const seed = dayIndex * 131 + ci * 97 + i * 13;
      const offsetMs = seededRandom(seed) * MS_PER_DAY;
      const impactRoll = seededRandom(seed + 1);
      const impact: NewsImpact = impactRoll > 0.7 ? 'high' : impactRoll > 0.35 ? 'medium' : 'low';
      const label = labels[Math.floor(seededRandom(seed + 2) * labels.length)];
      events.push({
        id: `NEWS-${currency}-${dayIndex}-${i}`,
        currency,
        label,
        impact,
        time: dayStart + offsetMs,
      });
    }
  });

  return events;
}

/** Every event landing within the 24h window starting at `now`. */
export function generateUpcomingEvents(now = Date.now()): NewsEvent[] {
  const dayIndex = Math.floor(now / MS_PER_DAY);
  // Today's remaining events plus tomorrow's cover any 24h window regardless
  // of where in the day `now` falls.
  const events = [...eventsForDay(dayIndex), ...eventsForDay(dayIndex + 1)];
  return events
    .filter((e) => e.time >= now && e.time <= now + MS_PER_DAY)
    .sort((a, b) => a.time - b.time);
}

/**
 * Is `instrument` inside a news blackout window at `at`? Checks every
 * currency the instrument is exposed to (via lib/instruments' currency
 * legs) against medium/high-impact events within +/- windowMinutes.
 */
export function isNewsBlackout(
  instrument: string,
  at = new Date(),
  windowMinutesBefore = 15,
  windowMinutesAfter = 15
): { blocked: boolean; event?: NewsEvent } {
  const nowMs = at.getTime();
  const spec = getInstrumentSpec(instrument);
  const relevantCurrencies = new Set(spec.currencies);
  const beforeMs = windowMinutesBefore * 60 * 1000;
  const afterMs = windowMinutesAfter * 60 * 1000;
  // generateUpcomingEvents only looks forward from its anchor — an event
  // that fired a few minutes ago (still inside the "after" window) would
  // never be returned by generateUpcomingEvents(nowMs). Anchor the lookup
  // `afterMs` earlier so the whole [-afterMs, +beforeMs] range is covered.
  const events = generateUpcomingEvents(nowMs - afterMs).filter(
    (e) => relevantCurrencies.has(e.currency) && e.impact !== 'low'
  );

  for (const event of events) {
    const delta = event.time - nowMs;
    if (delta >= -afterMs && delta <= beforeMs) {
      return { blocked: true, event };
    }
  }
  return { blocked: false };
}
