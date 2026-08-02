import type { Candle } from '../../lib/types';

export type ReplaySpeed = 0.5 | 1 | 2 | 4 | 8;

export interface ReplayState {
  /** Number of candles emitted so far — also the index of the next candle to emit. */
  index: number;
  total: number;
  playing: boolean;
  speed: ReplaySpeed;
  currentCandle: Candle | null;
  complete: boolean;
}

export interface ReplayControllerOptions {
  /** ms between candles at 1x speed. Default 1000. */
  baseIntervalMs?: number;
  onCandle?: (candle: Candle, index: number) => void;
  onStateChange?: (state: ReplayState) => void;
  onComplete?: () => void;
}

/**
 * core/replay/ReplayController
 * -------------------------------
 * Turns a fixed candle series into a controllable playback: play, pause,
 * step exactly one candle, change speed, or jump to a position — instead
 * of a series only ever running forward at one fixed cadence with no way
 * to inspect what happened at a specific bar. This is what the live/demo
 * pipeline's own tick loop (useTradingStore's fillAndSimulateClose) is
 * conceptually doing already, generalized into a reusable, inspectable
 * engine — the same one can drive replaying a CSV history, the synthetic
 * generator, or (once one exists) a live feed's buffered candles, with a
 * human able to pause and step through exactly the bar a strategy behaved
 * oddly on instead of only ever watching it run at full speed.
 *
 * Doesn't know anything about trading — onCandle is just told which candle
 * came in; wiring it to SystemOrchestrator.manageOpenPosition (or a chart,
 * or both) is the caller's job. That keeps this reusable for anything that
 * consumes a Candle[] one bar at a time.
 */
export class ReplayController {
  private index = 0;
  private playing = false;
  private speed: ReplaySpeed = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly baseIntervalMs: number;

  constructor(
    private candles: Candle[],
    private options: ReplayControllerOptions = {}
  ) {
    this.baseIntervalMs = options.baseIntervalMs ?? 1000;
  }

  getState(): ReplayState {
    return {
      index: this.index,
      total: this.candles.length,
      playing: this.playing,
      speed: this.speed,
      currentCandle: this.index > 0 ? this.candles[this.index - 1] : null,
      complete: this.index >= this.candles.length,
    };
  }

  /** Replace the series and start over from the beginning, paused. Useful for loading a different instrument/upload into the same controller instance instead of constructing a new one. */
  loadCandles(candles: Candle[]): void {
    this.pause();
    this.candles = candles;
    this.index = 0;
    this.emitState();
  }

  play(): void {
    if (this.playing || this.index >= this.candles.length) return;
    this.playing = true;
    this.scheduleNext();
    this.emitState();
  }

  pause(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.playing) return;
    this.playing = false;
    this.emitState();
  }

  /** Advance exactly one candle, regardless of play state — pauses if playback was running, since a manual step mid-playback is a debugging action, not a speed change. */
  step(): Candle | null {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.playing = false;
    const candle = this.advanceOne();
    this.emitState();
    return candle;
  }

  setSpeed(speed: ReplaySpeed): void {
    if (this.speed === speed) return;
    this.speed = speed;
    if (this.playing) {
      // Reschedule immediately so a speed change takes effect on the very
      // next tick instead of waiting out whatever interval was already
      // in flight at the old speed.
      if (this.timer != null) clearTimeout(this.timer);
      this.scheduleNext();
    }
    this.emitState();
  }

  /** Jump directly to a position without emitting the candles in between — a scrub, not a fast-forward. Always pauses first. */
  seek(index: number): void {
    this.pause();
    this.index = Math.max(0, Math.min(index, this.candles.length));
    this.emitState();
  }

  reset(): void {
    this.pause();
    this.index = 0;
    this.emitState();
  }

  dispose(): void {
    this.pause();
  }

  private advanceOne(): Candle | null {
    if (this.index >= this.candles.length) return null;
    const candle = this.candles[this.index];
    const emittedIndex = this.index;
    this.index += 1;
    this.options.onCandle?.(candle, emittedIndex);
    if (this.index >= this.candles.length) {
      this.playing = false;
      this.options.onComplete?.();
    }
    return candle;
  }

  private scheduleNext(): void {
    const interval = this.baseIntervalMs / this.speed;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.advanceOne();
      this.emitState();
      if (this.playing && this.index < this.candles.length) {
        this.scheduleNext();
      } else {
        this.playing = false;
      }
    }, interval);
  }

  private emitState(): void {
    this.options.onStateChange?.(this.getState());
  }
}
