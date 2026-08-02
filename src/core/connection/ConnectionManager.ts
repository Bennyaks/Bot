import type { HealthComponent } from '../../lib/types';
import type { Broker, HealthSource } from '../interfaces';
import type { EventBus } from '../events/EventBus';

export interface ConnectionManagerOptions {
  /** Base delay before the first reconnect attempt. */
  baseDelayMs?: number;
  /** Ceiling for the exponential backoff. */
  maxDelayMs?: number;
  /** How many consecutive failures before this is treated as a critical health component. */
  criticalAfterAttempts?: number;
}

const DEFAULTS: Required<ConnectionManagerOptions> = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  criticalAfterAttempts: 3,
};

/**
 * core/connection/ConnectionManager
 * ------------------------------------
 * Phase 10. Owns broker connectivity independently of trading logic: polls
 * `Broker.isConnected()`, and on a drop runs exponential backoff reconnect
 * attempts rather than either hammering the broker or silently giving up.
 *
 * It only depends on the Broker interface, so it works unchanged against
 * PaperBroker today and a future MT5Broker (Phase 13) tomorrow. It publishes
 * BrokerConnectionChanged on the EventBus rather than calling back into the
 * orchestrator directly — anything that cares (Notifier, Diagnostics,
 * SystemOrchestrator.checkHealth) subscribes.
 *
 * It also implements HealthSource so it can be dropped straight into the
 * Diagnostics health list alongside the other components.
 */
export class ConnectionManager implements HealthSource {
  readonly id = 'connection-manager';
  private opts: Required<ConnectionManagerOptions>;
  private attempt = 0;
  private connected = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private broker: Broker,
    private bus: EventBus,
    options: ConnectionManagerOptions = {}
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Start polling the broker's connectivity on an interval. Returns a stop function. */
  start(pollIntervalMs = 5000): () => void {
    this.pollTimer = setInterval(() => this.poll(), pollIntervalMs);
    return () => this.stop();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  private poll(): void {
    const nowConnected = this.broker.isConnected();

    if (nowConnected && !this.connected) {
      // Recovered — reset backoff state.
      this.connected = true;
      this.attempt = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.bus.emit('BrokerConnectionChanged', {
        connected: true,
        attempt: 0,
        reason: `${this.broker.id} connection restored`,
      });
      return;
    }

    if (!nowConnected && this.connected) {
      // Just dropped — start the backoff sequence.
      this.connected = false;
      this.attempt = 0;
      this.bus.emit('BrokerConnectionChanged', {
        connected: false,
        attempt: 0,
        reason: `${this.broker.id} connection lost`,
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.opts.baseDelayMs * 2 ** this.attempt, this.opts.maxDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.attempt += 1;
      const nowConnected = this.broker.isConnected();
      this.bus.emit('BrokerConnectionChanged', {
        connected: nowConnected,
        attempt: this.attempt,
        reason: nowConnected
          ? `${this.broker.id} reconnected on attempt ${this.attempt}`
          : `${this.broker.id} reconnect attempt ${this.attempt} failed, retrying in ${Math.min(
              this.opts.baseDelayMs * 2 ** this.attempt,
              this.opts.maxDelayMs
            )}ms`,
      });
      if (nowConnected) {
        this.connected = true;
        this.attempt = 0;
      } else {
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Manually force a reconnect cycle — wired to a "Force Reconnect" diagnostics action. */
  forceReconnect(): void {
    this.connected = false;
    this.attempt = 0;
    this.bus.emit('BrokerConnectionChanged', {
      connected: false,
      attempt: 0,
      reason: `${this.broker.id} reconnect manually triggered`,
    });
    this.scheduleReconnect();
  }

  /** Retarget onto a new Broker after a hot-swap (see SystemOrchestrator.setBroker) — resets backoff state. */
  setBroker(broker: Broker): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.broker = broker;
    this.connected = broker.isConnected();
    this.attempt = 0;
  }

  check(): HealthComponent {
    const failing = !this.connected && this.attempt >= this.opts.criticalAfterAttempts;
    return {
      id: this.id,
      name: 'Connection Manager',
      status: this.connected ? 'healthy' : failing ? 'critical' : 'degraded',
      latencyMs: this.connected ? 12 : 0,
      lastCheck: new Date().toISOString(),
      message: this.connected
        ? `${this.broker.id} connected`
        : `${this.broker.id} disconnected · reconnect attempt ${this.attempt}`,
      critical: true,
    };
  }
}
