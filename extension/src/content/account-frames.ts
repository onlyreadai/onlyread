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
// The frame is told first, with the spot, and says when it is ready; only then does it grow.
// It draws the section at the spot by a media query that holds while it is not its in-page size, so the section
// usually moves in the very paint the frame grows or shrinks in (the frame paints in another process: a message would
// land a frame or more later, the section flashing at the window's corner). Usually: on closing, Chrome sometimes
// shows the frame's new size a frame before its new place, and the section sits at the window's corner for that frame.

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
  // The frame's height in the page: its content's, as it last told it; applied once it no longer covers the window.
  let inPageHeight = 240;
  // A dialog open in the frame (it asked to cover the window), and whether the frame does cover it yet: the spot's
  // height kept as it was (the frame out of the page's flow), and the spot's min-height before. Each dialog opened is
  // numbered (seq, counted as the frame counts them), and the frame's answers name the number, so an answer meant for
  // one closed since never grows the frame for the next.
  let wanted = false;
  let covered: { minHeight: string } | undefined;
  let seq = 0;
  // Where the spot is, as last sent; re-sent whenever it changes (a scroll, a resize, the page moving the spot) while a
  // dialog is open, and every second anyway. The frame answers each one. Asks left unanswered, COVER_STALL_ASKS of them
  // over COVER_STALL_MS at least, mean the frame is stuck (hung, crashed): it is shrunk back to its spot rather than
  // leave the whole page under it, and grown again if it answers after all. Counted in asks as well as time, so one long
  // task on the page (the answer waiting behind it) never counts as the frame stuck.
  let sent = '';
  let sentAt = 0;
  let asks = 0;
  let firstAsk = 0;
  // The next check: every animation frame, or once a second while the frame is taken for stuck (no use drawing frames
  // for a dead one until the page is left).
  let stalled = false;
  let stopTracking = () => {};
  // Where the frame sits inside its spot (the placeholder's padding and border, if the page ever gives it any): measured
  // from the frame itself while it is in the page, and kept for while it covers the window and only the spot is left.
  let inset = { x: 0, y: 0, width: 0 };
  const spot = () => {
    const s = el.getBoundingClientRect();
    if (!covered) {
      const f = iframe.getBoundingClientRect();
      inset = { x: f.left - s.left, y: f.top - s.top, width: s.width - f.width };
    }
    return { x: s.left + inset.x, y: s.top + inset.y, width: s.width - inset.width };
  };
  const sendCover = () => {
    const now = performance.now();
    if (covered && asks >= COVER_STALL_ASKS && now - firstAsk > COVER_STALL_MS) { shrink(); stalled = true; }
    const cover = spot();
    const key = JSON.stringify(cover);
    if (key === sent && now - sentAt < COVER_RESEND_MS) return;
    sent = key;
    sentAt = now;
    if (!asks++) firstAsk = now;
    iframe.contentWindow?.postMessage({ source: 'onlyread-page', cover, seq }, origin);
  };
  const track = () => {
    // The frame gone for good (the page dropped it past MAX_RESTORES): nothing is left to cover, so let go.
    if (!iframe.isConnected) { uncover(); return; }
    sendCover();
    if (!wanted) return;
    if (stalled) { const t = setTimeout(track, COVER_RESEND_MS); stopTracking = () => clearTimeout(t); }
    else { const t = requestAnimationFrame(track); stopTracking = () => cancelAnimationFrame(t); }
  };
  const want = () => {
    if (wanted) return;
    wanted = true;
    seq++;
    sent = '';
    asks = 0;
    stalled = false;
    track();
  };
  // The frame is ready for this dialog (it knows the spot): it grows to the window, and is checked every frame again
  // if it had been taken for stuck.
  const ready = (n: number) => {
    if (!wanted || n !== seq) return;
    asks = 0;
    if (stalled) { stalled = false; stopTracking(); track(); }
    if (covered) return;
    const s = el.getBoundingClientRect();
    covered = { minHeight: el.style.minHeight };
    // The spot keeps its height: its own, padding and all, where its min-height counts those (border-box), else the frame's.
    el.style.minHeight = `${getComputedStyle(el).boxSizing === 'border-box' ? s.height : iframe.getBoundingClientRect().height}px`;
    for (const [k, v] of COVER) iframe.style.setProperty(k, v);
  };
  // Back in its spot at its own height.
  const shrink = () => {
    if (!covered) return;
    for (const [k] of COVER) iframe.style.removeProperty(k);
    iframe.style.height = `${inPageHeight}px`;
    el.style.minHeight = covered.minHeight;
    covered = undefined;
  };
  const uncover = () => {
    if (!wanted) return;
    wanted = false;
    stopTracking();
    shrink();
    iframe.contentWindow?.postMessage({ source: 'onlyread-page', cover: null }, origin);
  };
  // The frame's content height, as it told it: its height in the page, applied now unless it covers the window.
  const setHeight = (h: number) => {
    if (!Number.isFinite(h) || h <= 0) return;
    inPageHeight = Math.min(Math.ceil(h), 20_000);
    if (!covered) iframe.style.height = `${inPageHeight}px`;
  };
  // A frame loaded afresh has no dialog open, and numbers its dialogs from the start again.
  iframe.addEventListener('load', () => { uncover(); seq = 0; });
  addEventListener('message', (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.origin !== origin) return;
    const d = e.data as { source?: unknown; height?: unknown; dialog?: unknown; ready?: unknown } | null;
    if (d?.source !== 'onlyread-frame') return;
    if (typeof d.height === 'number') setHeight(d.height);
    if (d.dialog === true) want();
    else if (d.dialog === false) uncover();
    if (typeof d.ready === 'number') ready(d.ready);
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

/** While a dialog is open: how often the frame is told again where its spot is, unchanged or not, and how many asks
 *  over how long may go unanswered before the frame is taken for stuck and shrunk back to its spot. */
const COVER_RESEND_MS = 1000;
const COVER_STALL_ASKS = 3;
const COVER_STALL_MS = 3000;

/** How many times a dropped frame is put back. */
const MAX_RESTORES = 5;
