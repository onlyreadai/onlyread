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
    const d = e.data as { source?: unknown; theme?: unknown; cover?: unknown } | null;
    if (d?.source !== 'onlyread-page') return;
    if (d.theme !== undefined) applyTheme(normalizeTheme(d.theme));
    const c = coverFrom(d.cover);
    if (c !== undefined) showCover(c);
  });
}

/** The account page's cover message: where the section's spot is ({x, y, width}) and the window's size ({vw, vh}),
 *  in the page's pixels, while a dialog is open; null once the frame is back in its spot; undefined for anything else. */
export type Cover = { x: number; y: number; width: number; vw: number; vh: number };
export function coverFrom(v: unknown): Cover | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object' || v === undefined) return undefined;
  const { x, y, width, vw, vh } = v as Record<string, unknown>;
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const size = (n: unknown): n is number => num(n) && n > 0;
  return num(x) && num(y) && size(width) && size(vw) && size(vh) ? { x, y, width, vw, vh } : undefined;
}

/** The section drawn at its spot on the page, for as long as the frame is the window's size: a media query on that
 *  size, so the section moves in the same paint the frame grows or shrinks in (a message from the page would come a
 *  frame or more later, and the section would flash at the window's corner or out of its spot). */
export function coverRule(c: Cover): string {
  return `@media (width: ${Math.round(c.vw)}px) and (height: ${Math.round(c.vh)}px) { html.framed-cover .page { position: fixed; top: ${c.y}px; left: ${c.x}px; width: ${c.width}px; box-sizing: border-box; } }`;
}

/** Told where the spot is, the frame gets ready to cover the window and tells the page, which then grows it. An open
 *  dialog waits unseen (`framed-wait`) until the frame is the window's size, so it never pops in clipped. */
function showCover(c: Cover | null): void {
  const html = document.documentElement;
  html.classList.toggle('framed-cover', c !== null);
  coverQuery?.removeEventListener('change', covering);
  coverQuery = undefined;
  if (!c) {
    coverStyle?.remove();
    coverStyle = undefined;
    stopWaiting();
    return;
  }
  if (!coverStyle) coverStyle = document.head.appendChild(document.createElement('style'));
  coverStyle.textContent = coverRule(c);
  coverQuery = matchMedia(`(width: ${Math.round(c.vw)}px) and (height: ${Math.round(c.vh)}px)`);
  coverQuery.addEventListener('change', covering);
  covering();
  postToPage?.({ ready: true });
}
function covering(): void { if (coverQuery?.matches) stopWaiting(); }
function stopWaiting(): void {
  clearTimeout(waitTimer);
  document.documentElement.classList.remove('framed-wait');
}
let coverStyle: HTMLStyleElement | undefined;
let coverQuery: MediaQueryList | undefined;
let waitTimer: ReturnType<typeof setTimeout> | undefined;
/** Posts to the account page, once it is known to be the service's (allowFrame). */
let postToPage: ((msg: Record<string, unknown>) => void) | undefined;
/** How long an opened dialog waits for the frame to cover the window before it shows anyway, in the frame as it is. */
const COVER_WAIT_MS = 400;

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
  const report = () => post({ height: Math.ceil(page.getBoundingClientRect().height) });
  new ResizeObserver(report).observe(page);
  report();
  // A dialog opened in the frame: the page has the frame cover its window until no dialog is open.
  const dialogs = [...document.querySelectorAll('dialog')];
  let open = false;
  const watch = () => {
    const now = dialogs.some((d) => d.open);
    if (now === open) return;
    open = now;
    if (now && !coverQuery?.matches) {
      document.documentElement.classList.add('framed-wait');
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => document.documentElement.classList.remove('framed-wait'), COVER_WAIT_MS);
    }
    post({ dialog: now });
  };
  for (const d of dialogs) new MutationObserver(watch).observe(d, { attributes: true, attributeFilter: ['open'] });
  return true;
}
