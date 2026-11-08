// A site's own toast under OnlyRead's notice ("Message send failed." in LinkedIn's corner): the notice frames it rather
// than covering it, the way the demo's card frames the notice (demo-coach.ts), so the page's words and OnlyRead's
// reason for them show together. Any site: a toast is a small fixed box with words in it, found where the notice is.

export interface Rect { left: number; top: number; width: number; height: number }

/** The largest a toast can be; anything bigger (a dialog, a sidebar, a banner across the page) is left alone. */
const MAX_W = 520;
const MAX_H = 160;

const toastSized = (e: Element) => {
  const r = e.getBoundingClientRect();
  return r.width >= 80 && r.height >= 20 && r.width <= MAX_W && r.height <= MAX_H;
};

/** The toast a hit at one point belongs to: the largest toast-sized box on the way up to the fixed one it floats in
 *  (a toast region across the page holds a smaller card), when it has words in it. Null for the page itself. */
function toastAt(x: number, y: number, ours: (el: Element) => boolean): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (let e = document.elementsFromPoint(x, y).find((h) => !ours(h)) ?? null; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    if (e instanceof HTMLElement && toastSized(e)) best = e;
    if (getComputedStyle(e).position === 'fixed') return best?.textContent?.trim() ? best : null; // a bare icon is no message
  }
  return null;
}

/** The page's toast showing inside `zone` (the notice's own box), or null. `ours` says which elements are OnlyRead's. */
export function findToast(zone: Rect, ours: (el: Element) => boolean): HTMLElement | null {
  for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.15, 0.5, 0.85]) {
    const toast = toastAt(zone.left + zone.width * fx, zone.top + zone.height * fy, ours);
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
