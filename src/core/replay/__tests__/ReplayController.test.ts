import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReplayController } from '../ReplayController';
import type { Candle } from '../../../lib/types';

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 60_000,
    open: 1.1 + i * 0.0001,
    high: 1.1005 + i * 0.0001,
    low: 1.0995 + i * 0.0001,
    close: 1.1002 + i * 0.0001,
    volume: 1000 + i,
  }));
}

describe('ReplayController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts paused at index 0 with nothing emitted', () => {
    const controller = new ReplayController(makeCandles(5));
    const state = controller.getState();
    expect(state.index).toBe(0);
    expect(state.playing).toBe(false);
    expect(state.currentCandle).toBeNull();
    expect(state.complete).toBe(false);
  });

  it('step() advances exactly one candle and calls onCandle', () => {
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(5), { onCandle });
    const candle = controller.step();
    expect(candle).not.toBeNull();
    expect(onCandle).toHaveBeenCalledTimes(1);
    expect(onCandle).toHaveBeenCalledWith(candle, 0);
    expect(controller.getState().index).toBe(1);
  });

  it('step() does not advance playback timing state and leaves the controller paused', () => {
    const controller = new ReplayController(makeCandles(5));
    controller.step();
    expect(controller.getState().playing).toBe(false);
  });

  it('play() emits candles automatically at the configured interval', () => {
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(5), { baseIntervalMs: 1000, onCandle });
    controller.play();
    expect(controller.getState().playing).toBe(true);
    expect(onCandle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onCandle).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(onCandle).toHaveBeenCalledTimes(2);
  });

  it('pause() stops emitting further candles', () => {
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(5), { baseIntervalMs: 1000, onCandle });
    controller.play();
    vi.advanceTimersByTime(1000);
    expect(onCandle).toHaveBeenCalledTimes(1);

    controller.pause();
    vi.advanceTimersByTime(5000);
    expect(onCandle).toHaveBeenCalledTimes(1);
    expect(controller.getState().playing).toBe(false);
  });

  it('setSpeed(2) halves the interval between emitted candles', () => {
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(10), { baseIntervalMs: 1000, onCandle });
    controller.play();
    controller.setSpeed(2);

    vi.advanceTimersByTime(500);
    expect(onCandle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(onCandle).toHaveBeenCalledTimes(2);
  });

  it('reaching the end of the series stops playback and calls onComplete', () => {
    const onComplete = vi.fn();
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(2), { baseIntervalMs: 1000, onCandle, onComplete });
    controller.play();
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(onCandle).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(controller.getState().complete).toBe(true);
    expect(controller.getState().playing).toBe(false);

    // No further ticks should fire once complete.
    vi.advanceTimersByTime(5000);
    expect(onCandle).toHaveBeenCalledTimes(2);
  });

  it('play() is a no-op once the series is exhausted', () => {
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(1), { baseIntervalMs: 1000, onCandle });
    controller.step();
    expect(controller.getState().complete).toBe(true);
    controller.play();
    expect(controller.getState().playing).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(onCandle).toHaveBeenCalledTimes(1);
  });

  it('seek() jumps directly to a position without emitting the skipped candles', () => {
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(10), { onCandle });
    controller.seek(5);
    expect(controller.getState().index).toBe(5);
    expect(onCandle).not.toHaveBeenCalled();
    expect(controller.getState().playing).toBe(false);
  });

  it('seek() clamps to the valid range', () => {
    const controller = new ReplayController(makeCandles(5));
    controller.seek(-3);
    expect(controller.getState().index).toBe(0);
    controller.seek(999);
    expect(controller.getState().index).toBe(5);
  });

  it('reset() returns to index 0 and pauses', () => {
    const controller = new ReplayController(makeCandles(5));
    controller.play();
    vi.advanceTimersByTime(1000);
    controller.reset();
    expect(controller.getState().index).toBe(0);
    expect(controller.getState().playing).toBe(false);
  });

  it('loadCandles() replaces the series and restarts at index 0', () => {
    const controller = new ReplayController(makeCandles(3));
    controller.step();
    controller.step();
    expect(controller.getState().index).toBe(2);

    controller.loadCandles(makeCandles(10));
    expect(controller.getState().index).toBe(0);
    expect(controller.getState().total).toBe(10);
    expect(controller.getState().complete).toBe(false);
  });

  it('onStateChange fires on every state-affecting action', () => {
    const onStateChange = vi.fn();
    const controller = new ReplayController(makeCandles(5), { onStateChange });
    controller.play();
    controller.pause();
    controller.step();
    controller.seek(2);
    controller.reset();
    expect(onStateChange.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('dispose() stops any pending timer', () => {
    const onCandle = vi.fn();
    const controller = new ReplayController(makeCandles(5), { baseIntervalMs: 1000, onCandle });
    controller.play();
    controller.dispose();
    vi.advanceTimersByTime(5000);
    expect(onCandle).not.toHaveBeenCalled();
  });
});
