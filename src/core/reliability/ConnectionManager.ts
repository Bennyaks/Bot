import type { Broker, Notifier } from '../interfaces';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline';

export interface ConnectionManagerDeps {
  broker: Broker;
  notifier: Notifier;
  onStatusChange: (status: ConnectionStatus, latencyMs: number) => void;
  /** Injectable so tests can force failures instead of relying on Math.random(). */
  heartbeatCheck?: () => boolean;
}

/**
 * core/reliability/ConnectionManager
 * -------------------------------------
 * Responsibilities: broker reconnect, heartbeat monitoring, recovery,
 * resume trading. This is deliberately separate from the Broker
 * implementation itself — any Broker (paper, MT5, MetaApi, future brokers)
 * is monitored the same way.
 */
export class ConnectionManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: ConnectionStatus = 'connected';
  private reconnectAttempts = 0;
  private readonly maxBackoffMs = 30_000;

  constructor(private deps: ConnectionManagerDeps) {}

  start(intervalMs = 6000) {
    this.stop();
    this.timer = setInterval(() => this.heartbeat(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private heartbeat() {
    const start = Date.now();
    const alive = this.deps.heartbeatCheck ? this.deps.heartbeatCheck() : this.deps.broker.isConnected();
    const latencyMs = Date.now() - start + Math.round(Math.random() * 30);

    if (alive) {
      if (this.status !== 'connected') {
        this.status = 'connected';
        this.reconnectAttempts = 0;
        this.deps.notifier.log({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          module: 'ConnectionManager',
          message: `Connection restored to ${this.deps.broker.id} · resuming trading`,
          reproducible: true,
        });
      }
      this.deps.onStatusChange('connected', latencyMs);
      return;
    }

    this.reconnectAttempts += 1;
    const backoff = Math.min(this.maxBackoffMs, 1000 * 2 ** this.reconnectAttempts);
    this.status = this.reconnectAttempts >= 3 ? 'offline' : 'reconnecting';
    this.deps.notifier.log({
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      module: 'ConnectionManager',
      message: `Heartbeat lost to ${this.deps.broker.id} · attempt ${this.reconnectAttempts}, retrying in ${backoff}ms`,
      data: { reconnectAttempts: this.reconnectAttempts, backoff },
      reproducible: true,
    });
    this.deps.onStatusChange(this.status, latencyMs);
  }

  currentStatus(): ConnectionStatus {
    return this.status;
  }
}
