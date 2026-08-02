import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '../ConnectionManager';
import { EventBus } from '../../events/EventBus';
import type { Broker } from '../../interfaces';

function makeBroker(initiallyConnected = true): Broker & { setConnected: (v: boolean) => void } {
  let connected = initiallyConnected;
  return {
    id: 'test-broker',
    isConnected: () => connected,
    runSafetyChecks: () => [],
    accountEquity: () => 10_000,
    setConnected: (v: boolean) => {
      connected = v;
    },
  };
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits BrokerConnectionChanged(false) as soon as a poll detects a drop', () => {
    const broker = makeBroker(true);
    const bus = new EventBus();
    const events: boolean[] = [];
    bus.on('BrokerConnectionChanged', (e) => events.push(e.connected));

    const cm = new ConnectionManager(broker, bus, { baseDelayMs: 1000, maxDelayMs: 4000 });
    cm.start(1000);

    broker.setConnected(false);
    vi.advanceTimersByTime(1000); // first poll tick

    expect(events).toContain(false);
    cm.stop();
  });

  it('reconnects and emits BrokerConnectionChanged(true) once the broker recovers', () => {
    const broker = makeBroker(true);
    const bus = new EventBus();
    const events: { connected: boolean; attempt: number }[] = [];
    bus.on('BrokerConnectionChanged', (e) => events.push({ connected: e.connected, attempt: e.attempt }));

    const cm = new ConnectionManager(broker, bus, { baseDelayMs: 500, maxDelayMs: 2000 });
    cm.start(500);

    broker.setConnected(false);
    vi.advanceTimersByTime(500); // detect the drop

    broker.setConnected(true);
    vi.advanceTimersByTime(500); // first backoff attempt fires and succeeds

    const recovered = events.some((e) => e.connected === true);
    expect(recovered).toBe(true);
    cm.stop();
  });

  it('backs off exponentially while the broker stays down', () => {
    const broker = makeBroker(false);
    const bus = new EventBus();
    const attempts: number[] = [];
    bus.on('BrokerConnectionChanged', (e) => {
      if (!e.connected) attempts.push(e.attempt);
    });

    const cm = new ConnectionManager(broker, bus, { baseDelayMs: 100, maxDelayMs: 10_000 });
    cm.start(100);
    vi.advanceTimersByTime(100); // detect drop (attempt 0)
    vi.advanceTimersByTime(100); // attempt 1 fails (delay was 100ms)
    vi.advanceTimersByTime(200); // attempt 2 fails (delay was 200ms)

    expect(attempts).toContain(1);
    expect(attempts).toContain(2);
    cm.stop();
  });

  it('check() reports critical once past the criticalAfterAttempts threshold', () => {
    const broker = makeBroker(false);
    const bus = new EventBus();
    const cm = new ConnectionManager(broker, bus, { baseDelayMs: 10, maxDelayMs: 100, criticalAfterAttempts: 2 });
    cm.start(10);
    vi.advanceTimersByTime(10); // detect drop
    vi.advanceTimersByTime(10); // attempt 1
    vi.advanceTimersByTime(20); // attempt 2

    const health = cm.check();
    expect(health.status).toBe('critical');
    cm.stop();
  });

  it('forceReconnect() immediately kicks off a new backoff cycle', () => {
    const broker = makeBroker(true);
    const bus = new EventBus();
    const events: boolean[] = [];
    bus.on('BrokerConnectionChanged', (e) => events.push(e.connected));

    const cm = new ConnectionManager(broker, bus, { baseDelayMs: 100, maxDelayMs: 1000 });
    cm.forceReconnect();

    expect(events).toContain(false);
    cm.stop();
  });
});
