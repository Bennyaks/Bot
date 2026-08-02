import type { LogEntry } from '../../lib/types';
import type { Notifier } from '../interfaces';

const ALERT_LEVELS: LogEntry['level'][] = ['ERROR', 'SAFETY'];

export interface CompositeNotifierOptions {
  /** Returns whether desktop notifications are currently enabled (user opt-in + permission granted). */
  desktopEnabled?: () => boolean;
  /** Returns a webhook URL to POST alert-level entries to, or null/empty if none is configured. */
  webhookUrl?: () => string | null;
  /** Injectable for tests — defaults to the real fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * core/notify/CompositeNotifier
 * --------------------------------
 * The previous Notifier only ever did one thing: append a line to the
 * in-app log stream. If SAFE_MODE tripped while nobody had the browser tab
 * open, nothing told anyone — the SAFE MODE protocol's "alert user" step
 * meant "write a log line" and nothing more.
 *
 * This wraps any base Notifier (the existing pushLog-backed one) and adds
 * two real out-of-band channels for ERROR/SAFETY-level entries: a browser
 * desktop Notification (works even if the tab is backgrounded, as long as
 * the browser process is running) and a webhook POST (works even if the
 * browser isn't running at all, as long as the user configured one — e.g.
 * a Slack incoming webhook or a phone-push bridge like ntfy.sh).
 *
 * Both are strictly best-effort and never throw back into the caller —
 * a failed webhook or a denied notification permission should never break
 * the trading pipeline that's trying to alert about a real problem.
 */
export class CompositeNotifier implements Notifier {
  constructor(
    private base: Notifier,
    private options: CompositeNotifierOptions = {}
  ) {}

  log(entry: Omit<LogEntry, 'id'>): void {
    this.base.log(entry);

    if (!ALERT_LEVELS.includes(entry.level)) return;

    this.tryDesktopNotification(entry);
    this.tryWebhook(entry);
  }

  private tryDesktopNotification(entry: Omit<LogEntry, 'id'>): void {
    try {
      if (!this.options.desktopEnabled?.()) return;
      if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return;
      new Notification(`[${entry.level}] ${entry.module}`, { body: entry.message });
    } catch {
      // Best-effort — a notification failure must never break the pipeline
      // that's trying to report a real (possibly critical) event.
    }
  }

  private tryWebhook(entry: Omit<LogEntry, 'id'>): void {
    try {
      const url = this.options.webhookUrl?.();
      if (!url) return;
      const doFetch = this.options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
      if (!doFetch) return;
      void doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level: entry.level,
          module: entry.module,
          message: entry.message,
          timestamp: entry.timestamp,
          data: entry.data,
        }),
      }).catch(() => {
        // Network unreachable / CORS / bad URL — swallow. The in-app log
        // (this.base.log, already called above) is still the record of
        // truth even if the out-of-band alert didn't make it out.
      });
    } catch {
      // Synchronous failures (e.g. malformed URL) — same best-effort policy.
    }
  }

  /** Ask the browser for desktop notification permission. Call from a user gesture (button click). */
  static async requestPermission(): Promise<NotificationPermission | 'unsupported' | 'insecure'> {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
    // Browsers only permit notification prompts from secure contexts (HTTPS,
    // with localhost treated as secure). Without this check Chromium often
    // simply returns "denied" without showing a prompt, which looks like a
    // broken button to the user.
    if (!window.isSecureContext) return 'insecure';
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }
    return Notification.requestPermission();
  }
}
