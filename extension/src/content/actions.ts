// Layer 2 (context): records what the agent did in the page right before a
// request, so the judge and the audit log can see "click on 'Save'" next to the
// POST it produced. Also disables file inputs when uploads are off. Everything
// here follows the background's per-host answer (`guard:config`, background/guard.ts):
// on a site that is not guarded, or while protection is off, nothing is sent and
// nothing is changed in the page.
import type { UiAction } from '../shared/types';
import { TYPED_SECRET_TTL_MS, fieldName, isSensitiveField } from '../shared/ui-names';
import { type CheckFailure, NOTICE_MS, checkFailure, checkFailureAction, checkFailureLine, noticeTitle, stoppedLine } from '../shared/refusals';
import iconUrl from '../../assets/icon-48.png';
import { installAccountNudge } from './account-nudge';
import { installAgentSetup } from './agent-setup';
import { installAccountFrames } from './account-frames';
import { installDemoCoach } from './demo-coach';
import { setNoticeRoot, toastFramed } from './notice-root';
import { findToast, holePath, watchAppearances } from './site-toast';

const NAME_MAX = 80;

function text(s: string | null | undefined): string | undefined {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, NAME_MAX) : undefined;
}

function accessibleName(el: Element): string | undefined {
  const aria = el.getAttribute('aria-label');
  if (aria) return text(aria);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '');
    const t = text(parts.join(' '));
    if (t) return t;
  }
  // Form fields and editable areas: named by their label, never by what was typed into them (R5).
  const label = (el as HTMLInputElement).labels?.[0]?.textContent ?? undefined;
  if (el instanceof HTMLInputElement) return fieldName({ kind: 'input', type: el.type, autocomplete: el.autocomplete, value: el.value, placeholder: el.placeholder, name: el.name, label });
  if (el instanceof HTMLTextAreaElement) return fieldName({ kind: 'textarea', placeholder: el.placeholder, name: el.name, label });
  if (el instanceof HTMLSelectElement) return fieldName({ kind: 'select', name: el.name, label });
  if (el instanceof HTMLElement && el.isContentEditable) return fieldName({ kind: 'editable', placeholder: el.getAttribute('placeholder') ?? el.dataset.placeholder });
  if (el instanceof HTMLImageElement) return text(el.alt);
  // innerText, not textContent: the name a person sees, without the text of hidden children.
  return text((el as HTMLElement).innerText ?? el.textContent) ?? text(el.getAttribute('title'));
}

function describeTarget(el: Element | null): Partial<UiAction> {
  if (!el) return { tag: 'unknown' };
  const tag = el.tagName.toLowerCase();
  const out: Partial<UiAction> = { tag, role: el.getAttribute('role') ?? undefined, name: accessibleName(el) };
  if (el instanceof HTMLInputElement && isSensitiveField(el.type, el.autocomplete)) out.sensitive = true;
  if (el instanceof HTMLAnchorElement && el.href) out.href = el.href;
  const form = (el as HTMLElement).closest('form');
  if (form) { out.formAction = form.action; out.formMethod = form.method; }
  return out;
}

function fieldNames(form: HTMLFormElement): string[] {
  return [...new Set([...form.elements].map((e) => (e as HTMLInputElement).name).filter(Boolean))];
}

// A guarded site while protection is attached (the background's answer): only then are actions and typed secrets
// reported. The listeners are registered at document_start all the same, so they run before any page script.
let reporting = false;

function send(action: Omit<UiAction, 'ts' | 'url'>): void {
  if (!reporting) return;
  const full: UiAction = { ...action, ts: Date.now(), url: location.href } as UiAction;
  try { void chrome.runtime.sendMessage({ type: 'ui:action', action: full }).catch(() => {}); } catch { /* extension reloaded */ }
}

const INTERACTIVE = 'button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[onclick]';

// Only real input (isTrusted): a page script clicking a harmless-looking button just before a write must not
// give the judge a false reason for it.
document.addEventListener('click', (e) => {
  if (!e.isTrusted) return;
  const t = e.target as Element | null;
  const el = t?.closest?.(INTERACTIVE) ?? t;
  send({ type: 'click', ...describeTarget(el), tag: el?.tagName.toLowerCase() ?? 'unknown' });
}, true);

document.addEventListener('submit', (e) => {
  if (!e.isTrusted) return;
  const f = e.target as HTMLFormElement;
  send({ type: 'submit', tag: 'form', formAction: f.action, formMethod: f.method, fields: fieldNames(f) });
}, true);

document.addEventListener('keydown', (e) => {
  if (!e.isTrusted || e.key !== 'Enter') return;
  const el = document.activeElement;
  send({ type: 'enter', ...describeTarget(el), tag: el?.tagName.toLowerCase() ?? 'unknown' });
}, true);

document.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | null;
  if (t?.type !== 'file') return;
  send({ type: 'file', tag: 'input', name: t.name, fields: [...(t.files ?? [])].map((f) => f.name) });
}, true);

// Password, one-time-code and card fields: their current value goes to the background, which holds it in memory
// only to remove it from request bodies before a judge sees them (background/typed-secrets.ts). Only real input
// (isTrusted), so a page script can't plant words to hide them from the judge. Each field is sent under a
// number of its own, never its name.
const fieldIds = new WeakMap<HTMLInputElement, number>();
let nextFieldId = 0;
/** Values typed (or autofilled) while nothing is reported: before an agent session starts, or before the background's
 *  first answer. Kept here, in the page, and sent once reporting starts, so a password typed first and submitted later
 *  by the agent is still removed from what the judge and the log see. The last real input's value, never one a page
 *  script set since. Each value is forgotten ten minutes after its last input, as the background does
 *  (TYPED_SECRET_TTL_MS), so a value typed on a page that never becomes guarded is not held for the page's life. */
const typedBeforeReporting = new Map<HTMLInputElement, { value: string; at: number }>();
let forgetTimer: ReturnType<typeof setTimeout> | undefined;
/** Drops held values older than the limit, and wakes again for the next one to expire. */
function forgetStaleTyped(): void {
  forgetTimer = undefined;
  const now = Date.now();
  let next = Number.POSITIVE_INFINITY;
  for (const [el, t] of typedBeforeReporting) {
    if (now - t.at >= TYPED_SECRET_TTL_MS) typedBeforeReporting.delete(el);
    else next = Math.min(next, t.at + TYPED_SECRET_TTL_MS);
  }
  if (next !== Number.POSITIVE_INFINITY) forgetTimer = setTimeout(forgetStaleTyped, next - now);
}
function sendSecret(el: HTMLInputElement, value: string): void {
  let id = fieldIds.get(el);
  if (id === undefined) { id = nextFieldId++; fieldIds.set(el, id); }
  try { void chrome.runtime.sendMessage({ type: 'secret:typed', field: `${location.origin}#${id}`, value }).catch(() => {}); } catch { /* extension reloaded */ }
}
function reportSensitive(e: Event): void {
  const el = e.composedPath()[0];
  if (!e.isTrusted || !(el instanceof HTMLInputElement) || !isSensitiveField(el.type, el.autocomplete)) return;
  if (!reporting) {
    typedBeforeReporting.set(el, { value: el.value, at: Date.now() });
    if (forgetTimer === undefined) forgetTimer = setTimeout(forgetStaleTyped, TYPED_SECRET_TTL_MS);
    return;
  }
  sendSecret(el, el.value);
}
function sendTypedBeforeReporting(): void {
  const now = Date.now();
  for (const [el, t] of typedBeforeReporting) if (t.value && now - t.at < TYPED_SECRET_TTL_MS) sendSecret(el, t.value);
  typedBeforeReporting.clear();
  if (forgetTimer !== undefined) { clearTimeout(forgetTimer); forgetTimer = undefined; }
}
// On window, registered before any page script: a page's own listener cannot change the value before this reads it.
addEventListener('input', reportSensitive, true);
addEventListener('change', reportSensitive, true);

// The Pro account page, just after it saved its guarded-site list (its "Saved" redirect, `?sites=saved`): the
// background fetches the list at once, so a change made there reaches this browser without Sync now.
// The background takes the ping only from the page of the service this browser is signed in to (messages.ts
// accountPageSaved); from any other page it is nothing.
if (window === window.top && /\/account\/?$/.test(location.pathname) && new URLSearchParams(location.search).get('sites') === 'saved') {
  try { void chrome.runtime.sendMessage({ type: 'page:account-saved' }).catch(() => {}); } catch { /* extension reloaded */ }
}

// The Pro service's sign-in done page (`/signin/done#code=…&state=…`): the code goes to the background,
// which takes it only from that page of the service this browser uses, in the tab the sign-in started in, with its
// state (messages.ts proSignInCode). The fragment is dropped from the address at once, so the code isn't left in it.
if (window === window.top && /\/signin\/done\/?$/.test(location.pathname) && location.hash.includes('code=')) {
  const p = new URLSearchParams(location.hash.slice(1));
  const code = p.get('code'), state = p.get('state');
  history.replaceState(null, '', location.pathname + location.search);
  if (code && state) {
    try { void chrome.runtime.sendMessage({ type: 'page:signin-code', code, state }).catch(() => {}); } catch { /* extension reloaded */ }
  }
}

// The tab an email sign-in link opened (`/sign-in/verify?__clerk_status=verified`): the sign-in goes on in the tab it
// started in (the setup window or the settings tab), which the background brings forward (messages.ts proSignInLink).
if (window === window.top && /\/sign-in\/verify\/?$/.test(location.pathname) && /[?&]__clerk_status=(verified|client_mismatch)\b/.test(location.search)) {
  try { void chrome.runtime.sendMessage({ type: 'page:signin-link' }).catch(() => {}); } catch { /* extension reloaded */ }
}

// OnlyRead Pro's agent-setup page: the agent's setup, passed on from a real click only (agent-setup.ts).
installAgentSetup();
installAccountNudge(); // the Pro account page's "the account changed" (account-nudge.ts)
installAccountFrames(); // this browser's Activity and Security framed on the Pro account page (account-frames.ts)
installDemoCoach(); // the first-run demo's guide, on the site it runs on (demo-coach.ts)

// A closing page: what it sends from now on (keepalive fetches, beacons) leaves after the debugger session ends,
// unjudged. On a guarded site while writes are refused, the page's own close handlers (pagehide, then
// visibilitychange and unload) do not run at all: the pagehide and visibilitychange listeners are registered at
// document_start, before any page script, and stop the event. The unload one is there only while the close is held
// (setHoldClose): an unload listener makes a page ineligible for the back/forward cache, so an unguarded page, or one
// whose writes pass, never carries one of OnlyRead's. It is a capture listener on the
// window, so it runs before the page's own unless the page registered a capture unload listener itself before the
// guard answer came. Added only from pagehide it would come too late: an unload keepalive would get through (e2e
// phase1). The background also refuses the tab's writes by rule from here on (background/closing-tabs.ts), for
// anything else. Top frame only: an iframe going away is not the page closing.
let holdClose = false;
let closingNow = false;
const stopIfClosing = (e: Event) => { if (closingNow) e.stopImmediatePropagation(); };
const topFrame = window === window.top;
// Where unload is not allowed (Chrome's default now, unless the site's Permissions-Policy allows it), the page's own
// unload handlers never run, so there is nothing to stop, and adding a listener only logs a policy violation.
const unloadAllowed = () => (document as Document & { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy?.allowsFeature('unload') ?? true;
function setHoldClose(on: boolean): void {
  holdClose = on;
  if (!topFrame || !unloadAllowed()) return;
  if (on) addEventListener('unload', stopIfClosing, true);
  else removeEventListener('unload', stopIfClosing, true);
}
if (topFrame) {
  addEventListener('pagehide', (e) => {
    if (!holdClose) return;
    closingNow = true;
    e.stopImmediatePropagation();
    try { void chrome.runtime.sendMessage({ type: 'page:closing' }).catch(() => {}); } catch { /* extension reloaded */ }
  }, true);
  addEventListener('visibilitychange', stopIfClosing, true);
  // Restored from the back/forward cache: the page lives on.
  addEventListener('pageshow', (e) => { if (e.persisted) closingNow = false; }, true);
}

// ---- One small fixed notice (top frame only), shared by refused writes and blocked edits. It lives in its own
// shadow root so the page's CSS can't restyle it and it can't touch the page; role="status" keeps it readable to
// screen readers and to an agent reading the page (a policy refusal must not look like a network error).
// It says what was protected on which site in plain words, keeps a request stopped only
// because a check could not run (the judge, or Pro signed out) apart from a stopped change, offers the one fix there
// is ("Sign in to Pro"), and keeps the internal codes behind "Details".
type NoticeLine = { text: string; count: number };
interface NoticeContent {
  title: string;
  lines: NoticeLine[];
  /** Requests stopped only because a check could not run, in words. */
  checks?: string[];
  /** The internal codes, shown under Details. */
  codes?: string[];
  fix?: 'signin';
}
let noticeHost: HTMLElement | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let noticeHover = false;
/** Details is open: the notice stays until dismissed. */
let noticePinned = false;

const NOTICE_CSS = `
:host { all: initial; direction: ltr; } /* all: initial leaves direction alone, and an RTL page would flip the notice */
/* Liquid glass: a tinted, blurred, saturated pane over the page, a bright hairline edge, a soft top highlight.
   The tint keeps the text readable over any page. Dark glass in the system's dark mode; otherwise light or dark
   follows the page behind the notice (pageIsDark). */
.box { --glass: rgba(255,255,255,.74); --edge: rgba(255,255,255,.75); --shine: rgba(255,255,255,.65); --ink: #1d1320;
  --muted: rgba(29,19,32,.66); --faint: rgba(29,19,32,.5); --chip: rgba(255,255,255,.55); --line: rgba(29,19,32,.14);
  --warn: #c2410c; --accent: #db2777; --shadow: 0 10px 40px rgba(15,23,42,.18), 0 2px 8px rgba(15,23,42,.10);
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483647; width: max-content; min-width: min(300px, calc(100vw - 32px));
  max-width: min(400px, calc(100vw - 32px)); box-sizing: border-box; display: grid; grid-template-columns: auto 1fr;
  gap: 12px; align-items: start; padding: 14px 16px; border-radius: 18px; isolation: isolate;
  background: var(--glass); color: var(--ink); border: 1px solid var(--edge);
  backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow: var(--shadow), inset 0 1px 0 var(--shine), inset 0 -1px 0 rgba(255,255,255,.12);
  font: 13px/1.45 system-ui, -apple-system, "SF Pro Text", "Segoe UI", Roboto, sans-serif; pointer-events: none;
  animation: in .6s cubic-bezier(.3,.7,.4,1.4) both; }
.box::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: -1;
  background: linear-gradient(180deg, rgba(255,255,255,.38) 0%, rgba(255,255,255,0) 42%),
              radial-gradient(120% 60% at 0% 0%, rgba(255,255,255,.28), transparent 60%); }
.box.dark { --glass: rgba(31,26,34,.82); --edge: rgba(255,255,255,.14); --shine: rgba(255,255,255,.18); --ink: #f5eef3;
    --muted: rgba(245,238,243,.74); --faint: rgba(245,238,243,.52); --chip: rgba(255,255,255,.1); --line: rgba(255,255,255,.18);
    --warn: #fbbf87; --accent: #ec4899; --shadow: 0 18px 40px -16px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.3); }
.box.dark::before { background: linear-gradient(180deg, rgba(255,255,255,.08) 0%, rgba(255,255,255,0) 40%); }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .box { --glass: rgba(250,250,252,.97); } .box.dark { --glass: rgba(31,26,34,.97); }
}
@keyframes in { 0% { opacity: 0; transform: translateY(24px) scale(.98); } 60% { opacity: 1; } 100% { transform: none; } }
.icon { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; overflow: hidden;
  background: linear-gradient(135deg, #f472b6, #db2777 55%, #be185d); color: #fff; }
.icon img { width: 28px; height: 28px; display: block; }
.icon.img { background: none; }
.title { font-weight: 700; font-size: 13.5px; letter-spacing: -.005em; margin: 4px 0 6px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
li { color: var(--ink); }
.check { margin: 8px 0 0; color: var(--warn); }
.count { margin-left: 6px; padding: 1px 7px; border-radius: 999px; background: var(--chip); color: var(--ink);
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.codes { margin: 8px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--chip); color: var(--muted); pointer-events: auto;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; user-select: text; }
.codes[hidden] { display: none; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.acts button { pointer-events: auto; cursor: pointer; font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 7px 11px; border-radius: 9px; border: 1px solid var(--line); background: transparent; color: var(--ink);
  transition: transform .12s, filter .15s, background .15s; }
.acts button:hover { background: var(--chip); transform: translateY(-1px); }
.acts button:active { transform: scale(.98); }
.acts button.icon-btn { padding: 0; width: 27px; height: 27px; margin-left: auto; display: inline-grid; place-items: center;
  border-color: transparent; color: var(--faint); }
.acts button.icon-btn:hover { color: var(--ink); }
.acts button.icon-btn + button.icon-btn { margin-left: 0; }
.acts button[hidden] { display: none; }
.acts button.primary { background: var(--accent); border-color: transparent; color: #fff; }
.acts button.primary:hover { filter: brightness(1.07); }
.acts button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* Framing a site's toast (site-toast.ts): the notice grows around it, smoothly. */
.box { transition: left .45s cubic-bezier(.2,.9,.25,1.1), bottom .45s cubic-bezier(.2,.9,.25,1.1),
  min-width .45s cubic-bezier(.2,.9,.25,1.1), padding-bottom .45s cubic-bezier(.2,.9,.25,1.1); }
@media (prefers-reduced-motion: reduce) { .box { animation: none; transition: none; } .acts button { transition: none; } }
`;
const LOCK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/** Dark glass when the system is in dark mode, whatever the page; otherwise when the page right behind the notice is
 *  dark: the first solid background colour under its corner. */
function pageIsDark(): boolean {
  if (matchMedia('(prefers-color-scheme: dark)').matches) return true;
  const parse = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
  const els = document.elementsFromPoint(40, Math.max(0, window.innerHeight - 40)).filter((e) => e !== noticeHost);
  for (const start of [...els, document.body, document.documentElement]) {
    for (let e: Element | null = start; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return matchMedia('(prefers-color-scheme: dark)').matches;
      const [r = 0, g = 0, b = 0, a = 1] = parse(cs.backgroundColor);
      if (a > 0.5) return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    }
  }
  return false; // no background anywhere: the canvas is white
}
function hideNotice(): void {
  unframeToast();
  if (noticeHost) {
    noticeHost.style.display = 'none';
    try { if (noticeHost.matches(':popover-open')) noticeHost.hidePopover(); } catch { /* no Popover API */ }
  }
  noticePinned = false;
  blocked.clear();
  checks.clear();
  explains.clear();
  counted.clear();
}
function scheduleHide(ms: number): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { if (noticeHover || noticePinned) scheduleHide(1500); else hideNotice(); }, ms);
}

interface NoticeParts { box: HTMLDivElement; title: HTMLDivElement; list: HTMLUListElement; checks: HTMLDivElement; codes: HTMLDivElement; acts: HTMLDivElement }
let parts: NoticeParts | null = null;

/** OnlyRead's own icon, inline; a page whose policy refuses data images gets the lock mark instead. */
function noticeIcon(): HTMLDivElement {
  const icon = document.createElement('div');
  icon.className = 'icon img';
  const img = document.createElement('img');
  img.alt = '';
  img.src = iconUrl;
  img.addEventListener('error', () => { icon.className = 'icon'; icon.innerHTML = LOCK_SVG; }, { once: true });
  icon.append(img);
  return icon;
}

/** Builds the notice once; later notices update its text in place, so it doesn't flash or slide in again. */
function noticeParts(): NoticeParts {
  if (parts) return parts;
  noticeHost = document.createElement('div');
  noticeHost.setAttribute('data-onlyread', 'notice');
  const root = noticeHost.attachShadow({ mode: 'open' }); // open: an agent reading the page must see the refusal
  setNoticeRoot(root, hideNotice);
  const style = document.createElement('style');
  style.textContent = NOTICE_CSS;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '') => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const box = el('div', 'box');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.addEventListener('mouseenter', () => { noticeHover = true; });
  box.addEventListener('mouseleave', () => { noticeHover = false; });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideNotice(); });
  const body = el('div');
  const p: NoticeParts = { box, title: el('div', 'title'), list: el('ul'), checks: el('div'), codes: el('div', 'codes'), acts: el('div', 'acts') };
  body.append(p.title, p.list, p.checks, p.codes, p.acts);
  box.append(noticeIcon(), body);
  root.append(style, box);
  noticeHost.style.display = 'none';
  noticeHost.setAttribute('popover', 'manual');
  document.documentElement.appendChild(noticeHost);
  // The page opening a dialog or popover after the notice: the notice goes back on top of it. Closing the modal the
  // notice sits in: the notice moves back out to the page, or it would close with it.
  const restack = (e: Event) => {
    if (e.target === noticeHost || noticeHost?.style.display !== 'block') return;
    const closing = e.type === 'close' || (e as ToggleEvent).newState === 'closed';
    if (!closing || (e.target instanceof Node && e.target.contains(noticeHost))) raiseNotice();
  };
  document.addEventListener('toggle', restack, true);
  document.addEventListener('close', restack, true);
  parts = p;
  return p;
}

// ---- A site's own toast where the notice shows (LinkedIn's "Message send failed."): the notice grows around it and
// leaves a window over it, so the page's words show inside OnlyRead's frame instead of under it (site-toast.ts).
/** Room around the toast inside the frame. */
const TOAST_PAD = 10;
/** A toast that appeared this long before a refusal can still be the page's answer to it (the page may show its error a
 *  moment before OnlyRead's notice arrives); one that was there earlier was there anyway. */
const TOAST_BEFORE_MS = 3000;
/** How long after a refusal the notice looks for the page's toast. */
const TOAST_LOOK_MS = 3000;
/** How long the frame follows the toast every frame once found: its slide-in and the notice growing around it. */
const TOAST_FOLLOW_MS = 1000;
let toastSearch: ReturnType<typeof setInterval> | undefined;
let toastFrame = 0;
let framedToast: HTMLElement | null = null;
/** The newest refusal's time: the search window runs from it. */
let refusedAt = 0;
const isOurs = (el: Element) => Boolean(el.closest('[data-onlyread]'));

/** A refusal: look for the page's toast for a few seconds; while one is framed, check now and then that it is still
 *  there (the notice shrinks back when it goes), until the notice closes. */
function followToast(): void {
  refusedAt = Date.now();
  if (toastSearch) return;
  const look = () => {
    const box = parts?.box;
    if (!box || noticeHost?.style.display !== 'block') return;
    if (framedToast) { placeFrame(); return; }
    if (Date.now() - refusedAt > TOAST_LOOK_MS) return;
    const toast = findToast(box.getBoundingClientRect(), isOurs, refusedAt - TOAST_BEFORE_MS);
    if (toast) { framedToast = toast; frameToast(); }
  };
  look();
  toastSearch = setInterval(look, 250);
}

/** Sizes the notice around the framed toast and cuts its window. False once the toast is gone (the frame is undone). */
function placeFrame(): boolean {
  const box = parts?.box;
  const toast = framedToast;
  const t = toast?.isConnected ? toast.getBoundingClientRect() : undefined;
  if (!box || !toast || !t?.width) { framedToast = null; unframeBox(); return false; }
  box.style.left = `${Math.max(4, t.left - TOAST_PAD)}px`;
  box.style.bottom = `${Math.max(4, window.innerHeight - t.bottom - TOAST_PAD)}px`;
  box.style.minWidth = `${t.width + 2 * TOAST_PAD}px`;
  box.style.paddingBottom = `${t.height + 2 * TOAST_PAD}px`;
  const b = box.getBoundingClientRect();
  const radius = Number.parseFloat(getComputedStyle(toast).borderTopLeftRadius) || 8;
  box.style.clipPath = holePath(b.width, b.height, { left: t.left - b.left, top: t.top - b.top, width: t.width, height: t.height }, radius);
  toastFramed({ rect: t, radius });
  return true;
}

/** Frames the toast every frame while things move (its slide-in, the notice growing); the search's ticks keep it
 *  placed after that. */
function frameToast(): void {
  cancelAnimationFrame(toastFrame);
  const until = Date.now() + TOAST_FOLLOW_MS;
  const step = () => { if (placeFrame() && Date.now() < until) toastFrame = requestAnimationFrame(step); };
  step();
}

function unframeBox(): void {
  cancelAnimationFrame(toastFrame);
  toastFramed(null);
  const box = parts?.box;
  if (!box) return;
  for (const k of ['left', 'bottom', 'minWidth', 'paddingBottom', 'clipPath'] as const) box.style[k] = '';
}

function unframeToast(): void {
  if (toastSearch) clearInterval(toastSearch);
  toastSearch = undefined;
  framedToast = null;
  unframeBox();
}

/** Puts the notice above everything the page shows: in the browser's top layer, newest there, as no z-index is above
 *  a modal dialog and its backdrop (LinkedIn's message box dimmed the notice under it). While a modal dialog is open
 *  everything outside it is inert, so the notice goes inside it there, or Details and Dismiss could not be pressed. */
function raiseNotice(): void {
  const host = noticeHost!;
  const modal = [...document.querySelectorAll('dialog')].filter((d) => { try { return d.matches(':modal'); } catch { return false; } }).pop();
  const parent = modal ?? document.documentElement;
  if (host.parentNode !== parent) parent.appendChild(host);
  try {
    if (host.matches(':popover-open')) host.hidePopover();
    host.showPopover();
  } catch { /* no Popover API: the z-index still puts it over the page */ }
}

/** `realOnly`: the click must be real input, so a page script cannot press it (Sign in to Pro opens OnlyRead's settings). */
function button(label: string, onClick: () => void, cls = '', realOnly = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', (e) => { e.stopPropagation(); if (e.isTrusted || !realOnly) onClick(); });
  return b;
}

const COPY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const MEGAPHONE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** The copy icon (development builds): copies the refused requests, one per line; where the page refuses the
 *  clipboard, shows them under Details, selected, to copy by hand. */
function copyButton(p: NoticeParts): HTMLButtonElement {
  const b = button('', () => {
    const text = requests.join('\n');
    const show = (svg: string, label: string) => {
      b.innerHTML = svg;
      b.setAttribute('aria-label', label);
      b.title = label;
    };
    const done = (label: string) => { show(CHECK_SVG, label); setTimeout(() => show(COPY_SVG, idle), 1500); };
    const byHand = () => {
      p.codes.textContent = text;
      p.codes.hidden = false;
      noticePinned = true;
      getSelection()?.selectAllChildren(p.codes);
      show(COPY_SVG, 'Select and copy');
    };
    try { navigator.clipboard.writeText(text).then(() => done('Copied'), byHand); } catch { byHand(); }
  }, 'icon-btn');
  const idle = `Copy requests (${requests.length})`;
  b.innerHTML = COPY_SVG;
  b.setAttribute('aria-label', idle);
  b.title = idle;
  return b;
}

/** The report icon (a megaphone), shown with the details: a refusal that was a mistake, sent to OnlyRead support from
 *  the settings page's report dialog, opened on the newest refusal. */
function reportButton(): HTMLButtonElement {
  const b = button('', () => { void chrome.runtime.sendMessage({ type: 'settings:open', section: 'support' }).catch(() => {}); hideNotice(); }, 'icon-btn', true);
  const label = 'Report a mistake';
  b.innerHTML = MEGAPHONE_SVG;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

/** The buttons: the one fix when there is one, Details when there are codes, Dismiss, and on the right, while the
 *  details show, the report icon, and in development builds the copy icon. */
function renderActs(p: NoticeParts, c: NoticeContent): void {
  const acts: HTMLButtonElement[] = [];
  if (c.fix === 'signin') acts.push(button('Sign in to Pro', () => { void chrome.runtime.sendMessage({ type: 'settings:open', section: 'ai-judge' }).catch(() => {}); hideNotice(); }, 'primary', true));
  const report = reportButton();
  report.hidden = p.codes.hidden;
  if (c.codes?.length) {
    const details = button(p.codes.hidden ? 'Details' : 'Hide details', () => {
      p.codes.hidden = !p.codes.hidden;
      report.hidden = p.codes.hidden;
      noticePinned = !p.codes.hidden;
      details.textContent = p.codes.hidden ? 'Details' : 'Hide details';
      details.setAttribute('aria-expanded', String(!p.codes.hidden));
    }, 'details');
    details.setAttribute('aria-expanded', String(!p.codes.hidden));
    acts.push(details);
  }
  acts.push(button('Dismiss', hideNotice, 'dismiss'));
  acts.push(report);
  if (requests.length) acts.push(copyButton(p));
  p.acts.replaceChildren(...acts);
}

function showNotice(c: NoticeContent, ms = NOTICE_MS): void {
  if (window.top !== window) return;
  const p = noticeParts();
  const appearing = noticeHost!.style.display === 'none';
  if (appearing) { p.box.classList.toggle('dark', pageIsDark()); p.codes.hidden = true; } // the glass for the page underneath
  p.title.textContent = c.title;
  p.list.replaceChildren(...c.lines.map((l) => {
    const li = document.createElement('li');
    li.append(l.text);
    if (l.count > 1) { const n = document.createElement('span'); n.className = 'count'; n.textContent = `×${l.count}`; li.append(n); }
    return li;
  }));
  p.checks.replaceChildren(...(c.checks ?? []).map((t) => { const e = document.createElement('p'); e.className = 'check'; e.textContent = t; return e; }));
  p.codes.textContent = (c.codes ?? []).join('\n');
  p.codes.style.whiteSpace = 'pre-wrap';
  renderActs(p, c);
  raiseNotice();
  if (appearing) {
    noticeHost!.style.display = 'block';
    p.box.style.animation = 'none'; void p.box.offsetWidth; p.box.style.animation = ''; // replay the entrance only on appearing
  }
  followToast();
  scheduleHide(ms);
}

// Refused writes, grouped: one plain line per kind of change, with a count for repeats (the newest three kinds), and
// apart from them, requests stopped only because a check could not run, counted per cause.
const blocked = new Map<string, NoticeLine>();
const checks = new Map<CheckFailure, number>();
/** OnlyRead Pro's own words for a check it refused, per cause (background/interception.ts `explain`). */
const explains = new Map<CheckFailure, string>();
const codes: string[] = [];
let siteName = '';
/** The requests the notice counted (background/interception.ts `sig`), so one sent again is not counted twice. */
const counted = new Set<string>();
/** The refused requests of this page, newest last (development builds send them: background/interception.ts), kept
 *  past a dismissed notice so the ones from a page's first moments can still be copied. */
const requests: string[] = [];
const MAX_REQUESTS = 50;

function noteRequest(line: string): void {
  requests.push(line);
  while (requests.length > MAX_REQUESTS) requests.shift();
}

/** Whether the notice already counted this request: the page sending a refused request again as it was (LinkedIn
 *  resends a message twice) is the same change. */
function countedBefore(sig: string | undefined): boolean {
  if (!sig) return false;
  if (counted.has(sig)) return true;
  counted.add(sig);
  return false;
}

function noteBlocked(msg: { shape?: string; reason?: string; site?: string; request?: string; explain?: string; sig?: string }): void {
  siteName = msg.site || location.hostname.replace(/^www\./, '');
  if (countedBefore(msg.sig)) return;
  if (msg.request) noteRequest(`${msg.request} · ${msg.shape ?? ''} · ${msg.reason ?? ''}`);
  if (blocked.size === 0 && checks.size === 0) codes.length = 0;
  codes.push(`${msg.shape ?? ''} · ${msg.reason ?? ''}`);
  while (codes.length > 6) codes.shift();
  const failure = checkFailure(msg.reason);
  if (failure) {
    checks.set(failure, (checks.get(failure) ?? 0) + 1);
    if (msg.explain) explains.set(failure, msg.explain);
    return;
  }
  countLine(stoppedLine(msg.shape, siteName));
}

/** One more of a kind of change: the newest kind last, the newest three kinds kept. */
function countLine(text: string): void {
  const prev = blocked.get(text);
  blocked.delete(text); // re-insert so the newest kind is last
  blocked.set(text, { text, count: (prev?.count ?? 0) + 1 });
  while (blocked.size > 3) blocked.delete(blocked.keys().next().value!);
}

if (window.top === window) {
  chrome.runtime.onMessage.addListener((msg: { type?: string; shape?: string; reason?: string; path?: string; site?: string; request?: string; explain?: string; sig?: string }) => {
    if (msg?.type !== 'onlyread:blocked') return;
    noteBlocked(msg);
    const fix = [...checks.keys()].map(checkFailureAction).find(Boolean);
    showNotice({
      title: noticeTitle(siteName), lines: [...blocked.values()],
      checks: [...checks].map(([kind, n]) => checkFailureLine(kind, n, explains.get(kind))), codes: [...codes], fix,
    });
  });
}

// ---- Uploads off (a guarded site, enforcing, `uploads: false`): file inputs are disabled, ones added later too, and
// a click on one is swallowed with a notice saying why. Switched by the background's answer (applyGuardConfig);
// switching off gives back the inputs this script disabled, never one the page had disabled itself.
let uploadsOff = false;
let uploadObserver: MutationObserver | null = null;
const disabledInputs = new Set<HTMLInputElement>();
let lastUploadNotice = 0;

function disableInput(i: HTMLInputElement): void {
  if (i.disabled || disabledInputs.has(i)) return;
  i.disabled = true; i.dataset.onlyread = 'uploads-disabled'; disabledInputs.add(i);
}
function disableFileInputs(root: ParentNode): void {
  // The added node itself can be the file input (querySelectorAll only searches inside it).
  if (root instanceof HTMLInputElement && root.type === 'file') disableInput(root);
  root.querySelectorAll<HTMLInputElement>('input[type=file]').forEach(disableInput);
}
function setUploadGuard(on: boolean): void {
  if (on === uploadsOff) return;
  uploadsOff = on;
  if (on) {
    disableFileInputs(document);
    uploadObserver = new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n instanceof Element) disableFileInputs(n); });
    uploadObserver.observe(document.documentElement, { childList: true, subtree: true });
  } else {
    uploadObserver?.disconnect(); uploadObserver = null;
    for (const i of disabledInputs) { i.disabled = false; delete i.dataset.onlyread; }
    disabledInputs.clear();
  }
}
function noteUploadBlocked(): void {
  const now = Date.now();
  if (now - lastUploadNotice < 3000) return;
  lastUploadNotice = now;
  showNotice({ title: 'Uploads are turned off here', lines: [{ text: 'This site is read-only, so file uploads are disabled.', count: 1 }] }, 4000);
}
document.addEventListener('click', (e) => {
  if (!uploadsOff) return;
  const t = e.target as HTMLInputElement | null;
  if (t?.tagName === 'INPUT' && t.type === 'file') { e.preventDefault(); e.stopImmediatePropagation(); noteUploadBlocked(); }
}, true);

// ---- Editor guard (per-site `editorGuard`). Makes rich-text editors non-editable so a content edit
// is never authored. For apps whose content writes ride a channel the extension cannot inspect
// (Linear's sync WebSocket carries collaborative edits as well as updates). Two layers: force
// contenteditable=false (and re-force it when the editor re-asserts true), and swallow editing input
// at the capture phase so the editor's own key handlers never run. Defense-in-depth for the UI path,
// not a network guarantee: code-driven writes can still bypass it.
const EDITOR_SEL = '[contenteditable="true"], [contenteditable=""], .ProseMirror';
let editorGuardOn = false;
let editorObserver: MutationObserver | null = null;
/** Each guarded element with its `contenteditable` as it was, to give back when the guard stops: `.ProseMirror`
 *  matches read-only views too, which must not come out editable. */
const guardedEditors = new Map<HTMLElement, string | null>();
let lastEditNotice = 0;

function guardOne(el: HTMLElement): void {
  if (el.dataset.onlyreadEditor === '1' && el.getAttribute('contenteditable') === 'false') return;
  if (!guardedEditors.has(el)) guardedEditors.set(el, el.getAttribute('contenteditable'));
  el.setAttribute('contenteditable', 'false');
  el.dataset.onlyreadEditor = '1';
}
function guardEditors(root: ParentNode): void {
  if (root instanceof HTMLElement && root.matches(EDITOR_SEL)) guardOne(root);
  root.querySelectorAll<HTMLElement>(EDITOR_SEL).forEach(guardOne);
}
/** One change while the guard is on: an editor the app unlocked again is re-locked, an element that became
 *  editable is locked, and editors inside added nodes are locked. */
function onEditorMutation(m: MutationRecord): void {
  if (m.type === 'attributes' && m.target instanceof HTMLElement) {
    const el = m.target;
    // The editor re-asserted contenteditable=true on its own update; force it back.
    if (el.dataset.onlyreadEditor === '1') {
      if (el.getAttribute('contenteditable') !== 'false') el.setAttribute('contenteditable', 'false');
    } else if (el.matches(EDITOR_SEL)) {
      guardOne(el);
    }
  }
  for (const n of m.addedNodes) if (n instanceof Element) guardEditors(n);
}
function startEditorGuard(): void {
  if (editorGuardOn) return;
  editorGuardOn = true;
  guardEditors(document);
  editorObserver = new MutationObserver((muts) => { for (const m of muts) onEditorMutation(m); });
  editorObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable'] });
}
function stopEditorGuard(): void {
  if (!editorGuardOn) return;
  editorGuardOn = false;
  editorObserver?.disconnect();
  editorObserver = null;
  for (const [el, was] of guardedEditors) {
    if (was === null) el.removeAttribute('contenteditable'); else el.setAttribute('contenteditable', was);
    delete el.dataset.onlyreadEditor;
  }
  guardedEditors.clear();
}
function inGuardedEditor(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('[data-onlyread-editor="1"]') !== null;
}
function noteEditBlocked(): void {
  const now = Date.now();
  if (now - lastEditNotice < 3000) return;
  lastEditNotice = now;
  showNotice({ title: 'Editing is turned off here', lines: [{ text: 'This site is read-only, so typing in editors is disabled.', count: 1 }] }, 4000);
}
/** Keys that would change content. Navigation, selection and copy (arrows, Tab, Escape, Cmd+A/C) pass. */
function isEditingKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey) return /^[vxVX]$/.test(e.key) || e.key === 'Backspace' || e.key === 'Delete';
  if (e.altKey) return e.key === 'Backspace' || e.key === 'Delete';
  if (e.key.length === 1) return true;
  return e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete';
}
const blockEdit = (e: Event): void => {
  if (!editorGuardOn || !inGuardedEditor(e.target)) return;
  e.preventDefault(); e.stopImmediatePropagation(); noteEditBlocked();
};
for (const ev of ['beforeinput', 'paste', 'cut', 'drop'] as const) document.addEventListener(ev, blockEdit, true);
document.addEventListener('keydown', (e) => {
  if (!editorGuardOn || !inGuardedEditor(e.target) || !isEditingKey(e)) return;
  e.preventDefault(); e.stopImmediatePropagation(); noteEditBlocked();
}, true);
// A locked editor is not focusable, so keystrokes never reach it and the handlers above stay quiet.
// Give feedback on the click instead; nothing is prevented, so selecting and copying still work.
document.addEventListener('mousedown', (e) => {
  if (editorGuardOn && inGuardedEditor(e.target)) noteEditBlocked();
}, true);

// Ask what this host gets now (guarded, editor guard, close hold, uploads); the background also pushes changes.
type GuardAnswer = { guarded?: boolean; editorGuard?: boolean; holdClose?: boolean; uploadsOff?: boolean };
function applyGuardConfig(c: GuardAnswer | undefined): void {
  const was = reporting;
  reporting = Boolean(c?.guarded);
  if (reporting && !was) sendTypedBeforeReporting();
  if (c?.editorGuard) startEditorGuard(); else stopEditorGuard();
  setHoldClose(Boolean(c?.holdClose));
  setUploadGuard(Boolean(c?.uploadsOff));
  if (window.top === window) watchAppearances(reporting); // a site toast is framed only where refusals can come
}
void chrome.runtime.sendMessage({ type: 'guard:config' }).then(applyGuardConfig).catch(() => {});
chrome.runtime.onMessage.addListener((msg: GuardAnswer & { type?: string }) => {
  if (msg?.type === 'onlyread:config') applyGuardConfig(msg);
});

// ---- site identity on request (popup): what the page says about itself.
if (window.top === window) {
  chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
    if (msg?.type !== 'site:meta') return;
    void describePage().then(sendResponse);
    return true; // async response
  });
}

async function describePage(): Promise<{ siteName?: string; title: string; iconUrl?: string }> {
  const meta = (name: string, attr: 'property' | 'name') =>
    document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`)?.content?.trim() || undefined;
  let siteName = meta('og:site_name', 'property') ?? meta('application-name', 'name');
  if (!siteName) {
    const manifestHref = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
    if (manifestHref) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(manifestHref, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(t);
        const j = (await r.json()) as { short_name?: string; name?: string };
        siteName = (j.name && j.name.length <= 40 ? j.name : undefined) ?? j.short_name ?? undefined;
      } catch { /* no manifest or blocked; fall through */ }
    }
  }
  // Largest declared icon; apple-touch-icon is usually the best raster.
  // Not an icon a page declares for dark mode only (media="(prefers-color-scheme: dark)", GitHub's white mark) disappears on the white tile the UI draws icons on.
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')]
    .filter((l) => !/prefers-color-scheme:\s*dark/i.test(l.media));
  const score = (l: HTMLLinkElement) => {
    const m = /(\d+)x(\d+)/.exec(l.sizes?.value ?? '');
    const px = m ? Number(m[1]) : /apple-touch/.test(l.rel) ? 180 : /svg/.test(l.type) ? 512 : 16;
    return px;
  };
  const best = links.sort((a, b) => score(b) - score(a))[0];
  return { siteName, title: document.title, iconUrl: best?.href };
}
