// This browser's own pages framed on the OnlyRead Pro account page (PLAN-PRO-UI step 3, D6). Activity never leaves the
// browser: the account page shows it by framing the extension's settings page (options.html?framed=1#activity), which
// the page's scripts cannot read into (another origin). The page marks where with a placeholder naming the account it
// shows:
//   <div data-onlyread-frame="activity" data-account="person@example.com">…the page's own text…</div>
// The background checks that this page is the configured Pro service's, in its top frame, and that this browser is
// signed in to that same account (messages.ts frameCheck); only then is the frame put in. Otherwise the placeholder
// gets `data-onlyread-state` (signed-out, other-account, …) and keeps the page's own words, which the page picks by it.
// The frame reports its height (options/framed.ts). While it has a dialog open (a report, the PIN) it covers the whole
// window, so the dialog and its dimmed backdrop are the page's whole width and height, however short the section is:
// its spot on the page keeps its height, and the frame is told where that spot is to draw the section there still.

/** The sections the account page may frame. */
const SECTIONS = new Set(['activity', 'security']);
const DONE = 'data-onlyread-state';

export function installAccountFrames(): void {
  if (window !== window.top) return;
  const scan = () => {
    for (const el of document.querySelectorAll<HTMLElement>(`[data-onlyread-frame]:not([${DONE}])`)) void frame(el);
  };
  // The account page draws itself after load (a client-rendered app), so placeholders may come later.
  const start = () => {
    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

async function frame(el: HTMLElement): Promise<void> {
  const section = el.dataset.onlyreadFrame ?? '';
  el.setAttribute(DONE, 'checking');
  if (!SECTIONS.has(section)) { el.setAttribute(DONE, 'unknown-section'); return; }
  let answer: { ok?: boolean; reason?: string } | undefined;
  try {
    answer = await chrome.runtime.sendMessage({ type: 'page:frame-check', account: el.dataset.account ?? '' });
  } catch { answer = undefined; } // the extension reloaded meanwhile
  if (!answer?.ok) { el.setAttribute(DONE, answer?.reason ?? 'unavailable'); return; }
  const iframe = document.createElement('iframe');
  const theme = pageTheme();
  iframe.src = chrome.runtime.getURL(`options.html?framed=1&theme=${theme}#${section}`);
  iframe.title = section === 'activity' ? 'OnlyRead activity in this browser' : 'OnlyRead protection in this browser';
  iframe.style.cssText = `display:block;width:100%;height:240px;border:0;background:transparent;color-scheme:${FRAME_SCHEME[theme]}`;
  const origin = new URL(iframe.src).origin;
  // The page's light or dark, as it is: sent on every load of the frame (a frame put back after the page dropped it
  // loads afresh) and every time the page switches.
  const sendTheme = () => {
    const t = pageTheme();
    iframe.style.colorScheme = FRAME_SCHEME[t];
    iframe.contentWindow?.postMessage({ source: 'onlyread-page', theme: t }, origin);
  };
  iframe.addEventListener('load', sendTheme);
  new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // The content's height, as the frame last told it; applied once the frame no longer covers the window.
  let height = '240px';
  // Covering the window: the spot's height kept as it was (the frame out of the page's flow), and its min-height before.
  let covered: { minHeight: string } | undefined;
  const sendCover = () => {
    const r = el.getBoundingClientRect();
    iframe.contentWindow?.postMessage({ source: 'onlyread-page', cover: { x: r.left, y: r.top, width: r.width } }, origin);
  };
  const cover = () => {
    if (!covered) {
      covered = { minHeight: el.style.minHeight };
      el.style.minHeight = `${iframe.getBoundingClientRect().height}px`;
      for (const [k, v] of COVER) iframe.style.setProperty(k, v);
      addEventListener('resize', sendCover);
    }
    sendCover();
  };
  const uncover = () => {
    if (!covered) return;
    for (const [k] of COVER) iframe.style.removeProperty(k);
    iframe.style.height = height;
    el.style.minHeight = covered.minHeight;
    covered = undefined;
    removeEventListener('resize', sendCover);
    iframe.contentWindow?.postMessage({ source: 'onlyread-page', cover: null }, origin);
  };
  // A frame loaded afresh has no dialog open.
  iframe.addEventListener('load', uncover);
  addEventListener('message', (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.origin !== origin) return;
    const d = e.data as { source?: unknown; height?: unknown; dialog?: unknown } | null;
    if (d?.source !== 'onlyread-frame') return;
    if (typeof d.height === 'number' && Number.isFinite(d.height) && d.height > 0) {
      height = `${Math.min(Math.ceil(d.height), 20_000)}px`;
      if (!covered) iframe.style.height = height;
    }
    if (d.dialog === true) cover();
    else if (d.dialog === false) uncover();
  });
  el.replaceChildren(iframe);
  el.setAttribute(DONE, 'framed');
  // The page's own code may re-render the placeholder's contents and drop the frame (seen once on pro.onlyread.ai
  // right after loading): put it back, a few times at most, so two scripts can never fight over it for good.
  let restores = 0;
  new MutationObserver((_m, watch) => {
    if (el.contains(iframe)) return;
    if (++restores > MAX_RESTORES || !el.isConnected) { watch.disconnect(); return; }
    el.replaceChildren(iframe);
  }).observe(el, { childList: true });
}

/** The account page's light or dark choice (`data-theme` on its <html>; none: the system's). */
type PageTheme = 'light' | 'dark' | 'system';
function pageTheme(): PageTheme {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

/** The frame's colour scheme for a theme. Chrome paints a framed page's whole backdrop, square, when the frame's scheme
 *  and the framed page's differ: as the page's, they never do, and the section's round cards show no corners or gap. */
const FRAME_SCHEME: Record<PageTheme, string> = { light: 'light', dark: 'dark', system: 'light dark' };

/** The frame's style while it covers the window for a dialog. Its corners square (the account page rounds the frame's,
 *  as its card's), above everything on the page. */
const COVER: ReadonlyArray<readonly [string, string]> = [
  ['position', 'fixed'], ['inset', '0'], ['height', '100%'], ['z-index', '2147483647'], ['border-radius', '0'],
];

/** How many times a dropped frame is put back. */
const MAX_RESTORES = 5;
