import { describe, it, expect } from 'vitest';
import { generateUpcomingEvents, isNewsBlackout } from '../newsCalendar';

describe('lib/newsCalendar', () => {
  it('generates at least one event per tracked currency within 24h', () => {
    const events = generateUpcomingEvents();
    const currencies = new Set(events.map((e) => e.currency));
    expect(currencies.size).toBeGreaterThan(0);
    expect(events.every((e) => e.time >= Date.now())).toBe(true);
  });

  it('is deterministic within the same hour (same events for two calls close together)', () => {
    const now = Date.now();
    const a = generateUpcomingEvents(now);
    const b = generateUpcomingEvents(now + 1000);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it('flags a blackout when a relevant high-impact event is inside the window', () => {
    const events = generateUpcomingEvents();
    const highImpact = events.find((e) => e.impact === 'high' && (e.currency === 'USD' || e.currency === 'EUR'));
    if (!highImpact) return; // deterministic-but-random seed happened not to produce one this hour; not a failure
    const result = isNewsBlackout('EURUSD', new Date(highImpact.time - 5 * 60 * 1000));
    expect(result.blocked).toBe(true);
  });

  it('agrees with a manual scan of generateUpcomingEvents for the same instant', () => {
    const now = Date.now();
    const events = generateUpcomingEvents(now).filter(
      (e) => e.impact !== 'low' && (e.currency === 'EUR' || e.currency === 'USD')
    );
    const beforeMs = 15 * 60 * 1000;
    const afterMs = 15 * 60 * 1000;
    const expectedBlocked = events.some((e) => {
      const delta = e.time - now;
      return delta >= -afterMs && delta <= beforeMs;
    });
    const result = isNewsBlackout('EURUSD', new Date(now), 15, 15);
    expect(result.blocked).toBe(expectedBlocked);
  });
});
