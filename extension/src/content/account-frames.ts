// This browser's own pages framed on the OnlyRead Pro account page (PLAN-PRO-UI step 3, D6). Activity never leaves the
// browser: the account page shows it by framing the extension's settings page (options.html?framed=1#activity), which
// the page's scripts cannot read into (another origin). The page marks where with a placeholder naming the account it
// shows:
//   <div data-onlyread-frame="activity" data-account="person@example.com">…the page's own text…</div>
// The background checks that this page is the configured Pro service's, in its top frame, and that this browser is
// signed in to that same account (messages.ts frameCheck); only then is the frame put in. Otherwise the placeholder
// gets `data-onlyread-state` (signed-out, other-account, …) and keeps the page's own words, which the page picks by it.
// The frame reports its height (options/framed.ts), and asks to be scrolled into view when it opens a dialog.

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
  addEventListener('message', (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.origin !== origin) return;
    const d = e.data as { source?: unknown; height?: unknown; dialog?: unknown } | null;
    if (d?.source !== 'onlyread-frame') return;
    if (typeof d.height === 'number' && Number.isFinite(d.height) && d.height > 0) iframe.style.height = `${Math.min(Math.ceil(d.height), 20_000)}px`;
    if (d.dialog === true) iframe.scrollIntoView({ block: 'start', behavior: 'smooth' });
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

/** How many times a dropped frame is put back. */
const MAX_RESTORES = 5;
