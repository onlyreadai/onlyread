// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The notice and the coach card live in closed shadow roots; the tests reach them by keeping roots open here, and
// press their buttons with real (isTrusted) clicks, which happy-dom never makes by itself.
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init: ShadowRootInit) { return attach.call(this, { ...init, mode: 'open' }); };
const trustedClick = (b: HTMLElement) => {
  const ev = new MouseEvent('click', { bubbles: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  b.dispatchEvent(ev);
};

// The coach card on the demo's site (demo-coach.ts), in a simulated page: what to try while it waits, the refused write
// once the background says so, Skip asking the background (never changing anything itself), and the card going.
const sent: { type: string }[] = [];
const listeners: ((msg: unknown) => void)[] = [];
const state: unknown = { active: true, name: 'LinkedIn', action: 'React to any post', hint: 'Click Like under a post in your feed.', change: 'your reaction' };
const push = (msg: unknown) => { for (const l of listeners) l(msg); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const card = () => {
  const root = document.querySelector('[data-onlyread="demo"]')?.shadowRoot;
  return {
    shown: Boolean(root?.querySelector('.card')),
    title: root?.querySelector('.title')?.textContent ?? '',
    text: root?.querySelector('.card')?.textContent ?? '',
    click: (label: string) => trustedClick([...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === label)!),
  };
};

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true })); // reduced motion: no confetti canvas in the simulated page
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: async (msg: { type: string }) => {
      if (msg.type === 'demo:state') return state;
      if (msg.type === 'demo:font') return { ok: false }; // no font in the simulated page: the system one
      sent.push(msg);
      return { ok: true };
    },
    onMessage: { addListener: (l: (msg: unknown) => void) => { listeners.push(l); } },
  } });
  const { installDemoCoach } = await import('./demo-coach');
  installDemoCoach();
  await tick(); await tick();
});

describe('the demo coach card', () => {
  it('says what to try on the demo\'s site, under the wordmark and "Demo"', () => {
    expect(card().shown).toBe(true);
    expect(card().title).toBe('Try it: react to any post');
    expect(card().text).toContain('Demo');
    expect(card().text).toContain('Waiting for your click');
  });
  it('a page script clicking Skip does nothing: only real input counts', () => {
    const root = document.querySelector('[data-onlyread="demo"]')?.shadowRoot;
    [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === 'Skip demo')!.click();
    expect(sent).toEqual([]);
    expect(card().shown).toBe(true);
  });
  it('Skip only asks the background to end the demo, and the card goes', async () => {
    card().click('Skip demo');
    expect(sent).toEqual([{ type: 'demo:skip' }]);
    await new Promise((r) => setTimeout(r, 10));
    expect(card().shown).toBe(false);
  });
  it('moves to step 2 when the background says the write was stopped: the page behind blurred', () => {
    push({ type: 'demo:stopped', site: 'linkedin', name: 'Create' });
    const root = document.querySelector('[data-onlyread="demo"]')?.shadowRoot;
    expect(root?.querySelector('.backdrop')).not.toBeNull();
    expect(root?.querySelectorAll('.steps i.on')).toHaveLength(2);
  });
  it('once the demo ends, shows the summary over the page: what was stopped, what still worked, what happens now', async () => {
    push({ type: 'demo:ended', site: 'linkedin', stopped: 'Create', restored: true, skipped: false });
    const root = document.querySelector('[data-onlyread="demo-summary"]')?.shadowRoot;
    expect(root?.querySelector('h2')?.textContent).toBe('Stopped: your reaction on LinkedIn');
    expect([...(root?.querySelectorAll('.fact') ?? [])].map((f) => f.textContent)).toEqual(['✓LinkedIn never received it', '✓Browsing kept working', '→From now on, it steps in only for AI agents']);
    // Guard more sites is the main action; Try another site and Done the plain ones.
    expect(root?.querySelector('button.primary')?.textContent).toBe('Guard more sites');
    expect([...(root?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toEqual(['Guard more sites', 'Try another site', 'Done']);
    await new Promise((r) => setTimeout(r, 10));
    expect(card().shown).toBe(false); // the corner card made way
    // Guard more sites only asks the background to open the settings at Sites; Done closes it.
    trustedClick([...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === 'Guard more sites')!);
    expect(sent).toContainEqual({ type: 'settings:open', section: 'guarded-sites' });
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('[data-onlyread="demo-summary"]')).toBeNull();
  });
  it('Try another asks the background for the demo\'s choice of site, and the summary goes', async () => {
    push({ type: 'demo:stopped', site: 'linkedin', name: 'Create' }); // the demo again
    push({ type: 'demo:ended', site: 'linkedin', stopped: 'Create', restored: true, skipped: false });
    const root = document.querySelector('[data-onlyread="demo-summary"]')?.shadowRoot;
    sent.length = 0;
    trustedClick([...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === 'Try another site')!);
    expect(sent).toEqual([{ type: 'settings:open', section: 'demo' }]);
    await new Promise((r) => setTimeout(r, 400));
    expect(document.querySelector('[data-onlyread="demo-summary"]')).toBeNull();
  });
  it('a demo ended by a skip after its write was refused takes the card away and still sums up', async () => {
    push({ type: 'demo:stopped', site: 'x', name: 'Favorite tweet' }); // a card again
    push({ type: 'demo:ended', site: 'x', restored: true, skipped: true });
    expect(document.querySelector('[data-onlyread="demo-summary"]')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(card().shown).toBe(false);
  });
  // On Like, LinkedIn shows its own "Something went wrong" toast in the corner; the notice frames it with a window over it
  // (actions.ts). The card and the blurred backdrop lie between the notice and the page: without the same window they
  // showed through it, an empty blurred box, instead of the toast.
  it('cuts the window the notice keeps over the page\'s toast through the card and the backdrop too', async () => {
    const notice = await import('./notice-root');
    const shadow = document.createElement('div').attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.className = 'box';
    box.getBoundingClientRect = () => ({ left: 16, top: 600, width: 300, height: 160, right: 316, bottom: 760, x: 16, y: 600, toJSON: () => ({}) }) as DOMRect;
    shadow.append(box);
    notice.setNoticeRoot(shadow, () => {});
    push({ type: 'demo:stopped', site: 'linkedin', name: 'Create' });
    await new Promise((r) => setTimeout(r, 50)); // the card finds the notice on the next frames
    const root = document.querySelector('[data-onlyread="demo"]')?.shadowRoot;
    const layers = () => [root?.querySelector<HTMLElement>('.card'), root?.querySelector<HTMLElement>('.backdrop')].map((e) => e?.style.clipPath ?? '');
    expect(layers()).toEqual(['', '']);
    const rect = { left: 20, top: 712, width: 230, height: 40, right: 250, bottom: 752, x: 20, y: 712, toJSON: () => ({}) } as DOMRect;
    notice.toastFramed({ rect, radius: 8 });
    expect(layers().every((c) => c.startsWith('path(evenodd'))).toBe(true);
    expect(layers()[1]).toContain('M 28 712 H 242'); // the backdrop's window, where the toast is on the page
    notice.toastFramed(null);
    expect(layers()).toEqual(['', '']);
    push({ type: 'demo:ended', site: 'linkedin', restored: true });
    await new Promise((r) => setTimeout(r, 10));
  });
  it('ends step 2 at the end of its timer, closing OnlyRead\'s notice even while it is held open', async () => {
    const { NOTICE_MS } = await import('../shared/refusals');
    const notice = await import('./notice-root');
    let closed = 0;
    notice.setNoticeRoot(document.createElement('div').attachShadow({ mode: 'open' }), () => { closed++; });
    vi.useFakeTimers();
    try {
      sent.length = 0;
      push({ type: 'demo:stopped', site: 'linkedin', name: 'Create' });
      vi.advanceTimersByTime(NOTICE_MS - 100);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(closed).toBe(1);
      expect(sent).toEqual([{ type: 'demo:done' }]);
    } finally { vi.useRealTimers(); }
  });
});
