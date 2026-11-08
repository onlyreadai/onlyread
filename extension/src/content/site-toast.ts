// A site's own toast under OnlyRead's notice ("Message send failed." in LinkedIn's corner): the notice frames it rather
// than covering it, the way the demo's card frames the notice (demo-coach.ts), so the page's words and OnlyRead's
// reason for them show together. Any site: a toast is a small fixed box with words in it, found where the notice is,
// that appeared around the refusal: a chat launcher or a cookie button that is always there is never one.

export interface Rect { left: number; top: number; width: number; height: number }

/** The largest a toast can be; anything bigger (a dialog, a sidebar, a banner across the page) is left alone. */
const MAX_W = 520;
const MAX_H = 160;

// ---- When elements appeared: added to the page, or shown (a class, style or `hidden` change), on a guarded site only.
// The observer only notes the time; nothing is measured or styled until a refusal asks.
const appeared = new WeakMap<Element, number>();
let watcher: MutationObserver | null = null;

export function watchAppearances(on: boolean): void {
  if (on === Boolean(watcher)) return;
  if (!on) { watcher?.disconnect(); watcher = null; return; }
  watcher = new MutationObserver((records) => {
    const now = Date.now();
    for (const r of records) {
      if (r.type === 'attributes') appeared.set(r.target as Element, now);
      else for (const n of r.addedNodes) if (n instanceof Element) appeared.set(n, now);
    }
  });
  watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
}

/** Whether `el` or anything around it, up to `top`, appeared at or after `since`. */
function appearedSince(el: Element, top: Element, since: number): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if ((appeared.get(e) ?? 0) >= since) return true;
    if (e === top) return false;
  }
  return false;
}

const toastSized = (e: Element) => {
  const r = e.getBoundingClientRect();
  return r.width >= 80 && r.height >= 20 && r.width <= MAX_W && r.height <= MAX_H;
};

/** The toast a hit at one point belongs to: the largest toast-sized box on the way up to the fixed one it floats in
 *  (a toast region across the page holds a smaller card), when it has words in it and appeared at or after `since`.
 *  Null for the page itself. */
function toastAt(x: number, y: number, ours: (el: Element) => boolean, since: number): HTMLElement | null {
  const hit = document.elementsFromPoint(x, y).find((h) => !ours(h));
  let best: HTMLElement | null = null;
  for (let e = hit ?? null; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    if (e instanceof HTMLElement && toastSized(e)) best = e;
    if (getComputedStyle(e).position !== 'fixed') continue;
    if (!best?.textContent?.trim()) return null; // a bare icon is no message
    return hit && appearedSince(hit, e, since) ? best : null; // always there: a launcher, not the page's answer
  }
  return null;
}

/** The page's toast showing inside `zone` (the notice's own box) that appeared at or after `since`, or null. `ours`
 *  says which elements are OnlyRead's. */
export function findToast(zone: Rect, ours: (el: Element) => boolean, since: number): HTMLElement | null {
  for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.15, 0.5, 0.85]) {
    const toast = toastAt(zone.left + zone.width * fx, zone.top + zone.height * fy, ours, since);
    if (toast) return toast;
  }
  return null;
}

const n = (v: number) => Math.round(v * 10) / 10;

/** A clip path for a `w`×`h` box that keeps everything around it (its shadow, `spread` past each edge) and cuts out
 *  `hole` (in the box's own coordinates) with rounded corners, so what is under the hole shows through. */
export function holePath(w: number, h: number, hole: Rect, radius: number, spread = 48): string {
  const { left: x, top: y, width: hw, height: hh } = hole;
  const r = Math.max(0, Math.min(radius, hw / 2, hh / 2));
  const outer = `M ${-spread} ${-spread} H ${n(w + spread)} V ${n(h + spread)} H ${-spread} Z`;
  const inner = `M ${n(x + r)} ${n(y)} H ${n(x + hw - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + hw)} ${n(y + r)} V ${n(y + hh - r)}`
    + ` A ${n(r)} ${n(r)} 0 0 1 ${n(x + hw - r)} ${n(y + hh)} H ${n(x + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + hh - r)}`
    + ` V ${n(y + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)} Z`;
  return `path(evenodd, "${outer} ${inner}")`;
}
