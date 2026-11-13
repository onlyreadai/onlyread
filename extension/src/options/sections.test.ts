// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCount } from './sections';

// The settings count animation, driven directly: a fake clock and a queue of animation frames stand in for the
// browser, so no test sleeps. Each test gets a fresh element (the per-element state lives in a WeakMap) and the
// mocked globals are restored afterwards.
describe('setCount', () => {
  let now = 1000;
  let reduced = false;
  const frames: FrameRequestCallback[] = [];

  beforeEach(() => {
    now = 1000;
    reduced = false;
    frames.length = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('matchMedia', (_query: string): MediaQueryList => ({
      matches: reduced,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Run every frame queued so far with the given timestamp; frames a step re-queues wait for the next run. */
  const runFrames = (t: number): void => {
    for (const cb of frames.splice(0)) cb(t);
  };
  const el = (): HTMLElement => document.createElement('span');

  it('shows the final number at once when motion is reduced, without scheduling a frame', () => {
    reduced = true;
    const target = el();
    setCount(target, 1234);
    expect(target.textContent).toBe('1,234');
    expect(frames).toHaveLength(0);
  });

  it('shows zero at once, without animation', () => {
    const target = el();
    setCount(target, 0);
    expect(target.textContent).toBe('0');
    expect(frames).toHaveLength(0);
  });

  it('counts the first nonzero value up to its final formatted value over 900 ms', () => {
    const target = el();
    setCount(target, 1234);
    expect(target.textContent).toBe('');
    runFrames(1450); // halfway: eased to 1,080, still animating
    expect(target.textContent).toBe('1,080');
    expect(frames).toHaveLength(1);
    runFrames(1900); // 900 ms after the start: done, no frame left
    expect(target.textContent).toBe('1,234');
    expect(frames).toHaveLength(0);
  });

  it('setting the same value again does not restart the animation', () => {
    const target = el();
    setCount(target, 1234);
    runFrames(1450);
    expect(target.textContent).toBe('1,080');
    setCount(target, 1234);
    expect(frames).toHaveLength(1); // no fresh frame: the first animation just carries on
    runFrames(1900);
    expect(target.textContent).toBe('1,234');
    expect(frames).toHaveLength(0);
  });

  it('a newer value wins: the old queued frame cannot overwrite it', () => {
    const target = el();
    setCount(target, 100);
    runFrames(1450);
    expect(target.textContent).toBe('88');
    setCount(target, 200);
    expect(target.textContent).toBe('200');
    runFrames(1900); // the first animation's queued frame runs and bails out
    expect(target.textContent).toBe('200');
    expect(frames).toHaveLength(0);
  });

  it('updates after the first render appear at once', () => {
    const target = el();
    setCount(target, 100);
    runFrames(1900);
    expect(target.textContent).toBe('100');
    setCount(target, 250);
    expect(target.textContent).toBe('250');
    expect(frames).toHaveLength(0);
    setCount(target, 0);
    expect(target.textContent).toBe('0');
    expect(frames).toHaveLength(0);
  });
});
