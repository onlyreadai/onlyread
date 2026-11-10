// The settings page framed on the OnlyRead Pro account page (content/account-frames.ts): options.html?framed=1#<section>
// shows that one section, with no header, sidebar or footer, at the frame's width. It shows anything only when the page
// framing it is the configured Pro service (`location.ancestorOrigins`, which a page cannot set); anywhere else, or
// opened on its own, it stays blank. It tells that page its height, and when a dialog opens and closes (a report, the
// PIN): while one is open the page has the frame cover its whole window, and tells it where the section's spot is, so
// the section is drawn there still and the dialog is the window's, centred, the whole page dimmed behind it.

import { applyTheme, normalizeTheme, type Theme } from '../shared/theme';

const FRAMEABLE = new Set(['activity', 'security']);

/** The account page's light or dark choice, as the frame was opened with it (content/account-frames.ts `theme`):
 *  framed, the section looks like the page around it, whatever this extension's own setting is. */
export function framedTheme(): Theme {
  return normalizeTheme(new URLSearchParams(location.search).get('theme'));
}

/** The section asked for when the page is opened framed (options.html?framed=1#activity), or undefined. */
export function framedSection(): string | undefined {
  if (new URLSearchParams(location.search).get('framed') !== '1') return undefined;
  const s = location.hash.slice(1);
  return FRAMEABLE.has(s) ? s : 'activity';
}

/** Hidden until the framing page is known (framed.css rules in options.html: `html.framed body` stays invisible). */
export function enterFramed(section: string): void {
  document.documentElement.classList.add('framed');
  document.getElementById(section)?.classList.add('framed-target');
  // The page's light or dark, now and as it switches (content/account-frames.ts sends it on every load of the frame
  // and on every switch). Listened for from the start, before the framing page is known: the look alone, and the page
  // stays blank anyway unless the framing page is the service's (allowFrame).
  addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const d = e.data as { source?: unknown; theme?: unknown; cover?: unknown; seq?: unknown } | null;
    if (d?.source !== 'onlyread-page') return;
    if (d.theme !== undefined) applyTheme(normalizeTheme(d.theme));
    const c = coverFrom(d.cover);
    if (c !== undefined) onCover(c, typeof d.seq === 'number' ? d.seq : undefined);
  });
}

/** The account page's cover message, while a dialog is open: where the section's spot is ({x, y, width}), in the
 *  page's pixels; null once the frame is back in its spot; undefined for anything else. The spot's width is the frame's
 *  own in the page. */
export type Cover = { x: number; y: number; width: number };
export function coverFrom(v: unknown): Cover | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object' || v === undefined) return undefined;
  const { x, y, width } = v as Record<string, unknown>;
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return num(x) && num(y) && num(width) && width > 0 ? { x, y, width } : undefined;
}

/** How far the frame's size may be from its size in the page and still count as it: a screen pixel and a half, a CSS
 *  pixel at least, as the frame's size is rounded to the screen's (zoomed out, a screen pixel is more than a CSS one). */
export function coverSlack(dpr: number): number {
  return Math.max(1, 1.5 / dpr);
}

/** Whether the frame is anything but its size in the page (the spot's width, and `height`, the height it last told the
 *  page), give or take `slack`: covering the window, whatever the window's size, display scaling or zoom (an exact
 *  size would never match where a CSS pixel is a fraction of the screen's, and would lag a window being resized). */
export function coverQueryFor(c: Cover, height: number, slack: number): string {
  const near = (feature: string, n: number) => `(${n - slack}px < ${feature} < ${n + slack}px)`;
  return `not all and ${near('width', c.width)} and ${near('height', height)}`;
}

/** The section drawn at its spot on the page while the frame covers the window: a media query, so the section usually
 *  moves in the same paint the frame grows or shrinks in, where a message from the page would come a frame or more
 *  later and the section would flash at the window's corner. Usually: on closing, Chrome sometimes shows the frame's
 *  new size a frame before its new place, and the section sits at the window's corner for that frame. */
export function coverRule(c: Cover, height: number, slack: number): string {
  return `@media ${coverQueryFor(c, height, slack)} { html.framed-cover .page { position: fixed; top: ${c.y}px; left: ${c.x}px; width: ${c.width}px; box-sizing: border-box; } }`;
}

/** Told where the spot is, the frame gets ready to cover the window and tells the page (naming the dialog's number,
 *  `seq`), which then grows it. Told null, the frame is back in its spot. */
function onCover(c: Cover | null, seq: number | undefined): void {
  // The page numbers the dialogs as the frame opens them (one each, in order): a spot sent for one closed since is
  // not this one's.
  if (c && seq !== opens) return;
  cover = c ?? undefined;
  document.documentElement.classList.toggle('framed-cover', c !== null);
  applyCover();
  if (!c) {
    coverStyle?.remove();
    coverStyle = undefined;
    // A dialog opened since keeps waiting, for its own cover.
    if (!dialogOpen) stopWaiting();
    return;
  }
  if (seq !== undefined) postToPage?.({ ready: seq });
}

/** The rule and the query for the spot as last told and the frame's height as it last told the page; again whenever
 *  either changes. Built from the frame's own height, not the page's copy of it, so the rule knows a new height before
 *  the page shrinks the frame to it. */
function applyCover(): void {
  coverQuery?.removeEventListener('change', covering);
  coverQuery = undefined;
  if (!cover) return;
  const slack = coverSlack(devicePixelRatio);
  // Kept up to date after a close too, until the page says the frame is back in its spot: closing can change the
  // section's height (a report sent), and the rule must know it before the page shrinks the frame to it.
  if (!dialogOpen) { if (coverStyle) coverStyle.textContent = coverRule(cover, inPageHeight, slack); return; }
  if (!coverStyle) coverStyle = document.head.appendChild(document.createElement('style'));
  coverStyle.textContent = coverRule(cover, inPageHeight, slack);
  coverQuery = matchMedia(coverQueryFor(cover, inPageHeight, slack));
  coverQuery.addEventListener('change', covering);
  covering();
}
/** An open dialog waits unseen (`framed-wait`) until the frame covers the window, so it never pops in clipped. */
function covering(): void { if (coverQuery?.matches) stopWaiting(); }
function stopWaiting(): void {
  clearTimeout(waitTimer);
  document.documentElement.classList.remove('framed-wait');
}
let cover: Cover | undefined;
let coverStyle: HTMLStyleElement | undefined;
let coverQuery: MediaQueryList | undefined;
let waitTimer: ReturnType<typeof setTimeout> | undefined;
let dialogOpen = false;
/** The dialogs opened in this frame so far: the page's number for the open one. */
let opens = 0;
/** The frame's height in the page, as last told it (the page sets the frame to it, capped as here). */
let inPageHeight = 0;
/** Posts to the account page, once it is known to be the service's (allowFrame). */
let postToPage: ((msg: Record<string, unknown>) => void) | undefined;
/** How long an opened dialog waits for the frame to cover the window before it shows anyway, in the frame as it is. */
const COVER_WAIT_MS = 400;
/** The tallest the page lets the frame be (content/account-frames.ts). */
const MAX_FRAME_HEIGHT = 20_000;

/** Whether `ancestors` is exactly the Pro service's page: one ancestor, the service's origin. */
export function framedByService(ancestors: ArrayLike<string>, serviceUrl: string): boolean {
  let origin: string;
  try { origin = new URL(serviceUrl).origin; } catch { return false; }
  return ancestors.length === 1 && ancestors[0] === origin;
}

/** Shown once the framing page is the service's; else the page is emptied and stays blank. */
export function allowFrame(serviceUrl: string): boolean {
  if (!framedByService(location.ancestorOrigins, serviceUrl)) {
    document.body.replaceChildren();
    return false;
  }
  const origin = new URL(serviceUrl).origin;
  document.documentElement.classList.add('framed-ok');
  const post = (msg: Record<string, unknown>) => window.parent.postMessage({ source: 'onlyread-frame', ...msg }, origin);
  postToPage = post;
  // The content's own height: the document's is never less than the frame's, so it could only grow.
  const page = document.querySelector<HTMLElement>('.page') ?? document.body;
  const report = () => {
    const height = Math.ceil(page.getBoundingClientRect().height);
    inPageHeight = Math.min(height, MAX_FRAME_HEIGHT);
    applyCover();
    post({ height });
  };
  new ResizeObserver(report).observe(page);
  report();
  // A dialog opened in the frame: the page has the frame cover its window until no dialog is open.
  const dialogs = [...document.querySelectorAll('dialog')];
  const watch = () => {
    const now = dialogs.some((d) => d.open);
    if (now === dialogOpen) return;
    dialogOpen = now;
    // Closed, the frame stops watching whether it covers the window, and opened again it forgets the last dialog's
    // spot: the next dialog waits for its own cover, even one opened before the page has shrunk the frame back. The
    // rule itself stays until the page says the frame is back in its spot (cover null), the section held there.
    if (now) { opens++; cover = undefined; }
    applyCover();
    if (now) {
      document.documentElement.classList.add('framed-wait');
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => document.documentElement.classList.remove('framed-wait'), COVER_WAIT_MS);
    }
    post({ dialog: now });
  };
  for (const d of dialogs) new MutationObserver(watch).observe(d, { attributes: true, attributeFilter: ['open'] });
  return true;
}
