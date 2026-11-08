// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { findToast, holePath, watchAppearances } from './site-toast';

/** An element laid out at `r`, fixed or not, with `text` in it. */
function box(r: { left: number; top: number; width: number; height: number }, fixed: boolean, text = '', parent: Element = document.body): HTMLElement {
  const e = document.createElement('div');
  e.textContent = text;
  if (fixed) e.style.position = 'fixed';
  e.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r }) as DOMRect;
  parent.append(e);
  return e;
}
const zone = { left: 16, top: 660, width: 300, height: 110 };
// happy-dom does no hit testing: each test says what is under the notice.
let hits: Element[] = [];
(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => hits;
const notOurs = () => false;
const tick = () => new Promise((r) => setTimeout(r, 0)); // the observer's records arrive after the change

afterEach(() => { watchAppearances(false); document.body.replaceChildren(); hits = []; });

describe('finding a site toast under the notice', () => {
  it('finds a small fixed box with words in it that appeared around the refusal, the card rather than its region', async () => {
    const region = box({ left: 0, top: 700, width: 1500, height: 80 }, true); // the page's toast region, always there
    watchAppearances(true);
    const since = Date.now();
    const card = box({ left: 20, top: 725, width: 230, height: 40 }, false, 'Message send failed.', region);
    const label = box({ left: 40, top: 735, width: 120, height: 18 }, false, 'Message send failed.', card);
    await tick();
    hits = [label, card, region, document.body];
    expect(findToast(zone, notOurs, since)).toBe(card);
  });

  // A chat launcher or a cookie button in the corner is always there: framing it would say the page answered the refusal.
  it('leaves alone a box that was there before the refusal, and one shown again only later counts from then', async () => {
    const launcher = box({ left: 20, top: 725, width: 200, height: 40 }, true, 'Chat with us');
    watchAppearances(true);
    await tick();
    hits = [launcher];
    expect(findToast(zone, notOurs, Date.now() - 3000)).toBeNull();
    // A toast the page keeps in the page and shows by un-hiding it.
    launcher.hidden = true;
    launcher.hidden = false;
    await tick();
    expect(findToast(zone, notOurs, Date.now() - 3000)).toBe(launcher);
  });

  it('leaves alone the page itself, a big dialog, a bare icon, and OnlyRead\'s own elements', async () => {
    watchAppearances(true);
    const since = Date.now();
    const page = box({ left: 0, top: 0, width: 1500, height: 2000 }, false, 'Feed');
    const dialog = box({ left: 0, top: 0, width: 1500, height: 780 }, true, 'New message');
    const icon = box({ left: 20, top: 725, width: 90, height: 40 }, true);
    const ours = box({ left: 16, top: 660, width: 300, height: 110 }, true, 'OnlyRead kept LinkedIn read-only');
    await tick();
    for (const under of [[page], [dialog], [icon]]) {
      hits = under;
      expect(findToast(zone, notOurs, since)).toBeNull();
    }
    hits = [ours];
    expect(findToast(zone, (e) => e === ours, since)).toBeNull();
  });
});

describe('the window over the toast', () => {
  it('keeps the box and its shadow and cuts the toast out, rounded, even-odd', () => {
    const p = holePath(300, 160, { left: 10, top: 110, width: 230, height: 40 }, 8);
    expect(p.startsWith('path(evenodd, "M -48 -48 H 348 V 208 H -48 Z')).toBe(true);
    expect(p).toContain('M 18 110 H 232 A 8 8 0 0 1 240 118 V 142');
    expect(p.endsWith('Z")')).toBe(true);
  });

  it('never rounds a corner past half the toast', () => {
    expect(holePath(300, 160, { left: 0, top: 0, width: 20, height: 10 }, 99)).toContain('A 5 5');
  });
});
