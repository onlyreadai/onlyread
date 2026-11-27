// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCount, setActivityCount, scrollToSection, setCount } from './sections';
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
    expect(target.textContent).toBe((1234).toLocaleString());
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
    expect(target.textContent).toBe((1080).toLocaleString());
    expect(frames).toHaveLength(1);
    runFrames(1900); // 900 ms after the start: done, no frame left
    expect(target.textContent).toBe((1234).toLocaleString());
    expect(frames).toHaveLength(0);
  });

  it('setting the same value again does not restart the animation', () => {
    const target = el();
    setCount(target, 1234);
    runFrames(1450);
    expect(target.textContent).toBe((1080).toLocaleString());
    setCount(target, 1234);
    expect(frames).toHaveLength(1); // no fresh frame: the first animation just carries on
    runFrames(1900);
    expect(target.textContent).toBe((1234).toLocaleString());
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

describe('clearCount', () => {
  it('clears the displayed count and resets its cached value', () => {
    const target = document.createElement('span');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));

    setCount(target, 5);
    expect(target.textContent).toBe('5');

    clearCount(target);
    expect(target.textContent).toBe('');

    setCount(target, 5);
    expect(target.textContent).toBe('5');
  });
});

describe('setActivityCount', () => {
  const el = (): HTMLElement => document.createElement('span');

  it('hides the badge when the count is zero', () => {
    const target = el();
    setActivityCount(target, 0);
    expect(target.textContent).toBe('');
  });

  it('shows a positive refused-write count', () => {
    const target = el();
    setActivityCount(target, 5);
    expect(target.textContent).toBe('5');
  });

  it('clears the badge when the count changes from positive to zero', () => {
    const target = el();
    setActivityCount(target, 5);
    expect(target.textContent).toBe('5');
    setActivityCount(target, 0);
    expect(target.textContent).toBe('');
  });
});
// Section scrolling, driven directly: a real element in the document stands in for the settings section, and its
// scrollIntoView is a mock, so no scrolling actually happens. Each test gets a clean DOM and the mocked globals
// are restored afterwards.
describe('scrollToSection', () => {
  let reduced = false;

  beforeEach(() => {
    reduced = false;
    document.body.innerHTML = '';
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
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /** A section in the document whose scrollIntoView is a mock; returns the element and the mock. */
  const section = (id: string): { el: HTMLElement; scroll: ReturnType<typeof vi.fn> } => {
    const el = document.createElement('section');
    el.id = id;
    document.body.append(el);
    const scroll = vi.fn();
    el.scrollIntoView = scroll;
    return { el, scroll };
  };

  it('scrolls an existing target smoothly when motion is not reduced', () => {
    const { scroll } = section('general');
    scrollToSection('general');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('scrolls an existing target at once when motion is reduced', () => {
    reduced = true;
    const { scroll } = section('general');
    scrollToSection('general');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('scrolls only the requested section', () => {
    const { scroll } = section('general');
    const other = section('privacy');
    scrollToSection('privacy');
    expect(scroll).not.toHaveBeenCalled();
    expect(other.scroll).toHaveBeenCalledTimes(1);
    expect(other.scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('a missing target is a safe no-op: no exception and no scroll call', () => {
    const { scroll } = section('general');
    expect(() => scrollToSection('missing')).not.toThrow();
    expect(scroll).not.toHaveBeenCalled();
  });
});
