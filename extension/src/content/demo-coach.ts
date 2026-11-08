// The first-run demo's coach (background/demo.ts), on the site the person chose, top frame only. Step 1: a card in the
// bottom-left corner saying what to try, with a pulse while OnlyRead waits for the click. Step 2: the write refused, the
// card grows into a frame around OnlyRead's own notice (actions.ts, in the same corner), so the person sees what OnlyRead
// shows when it stops a change, while the demo winds down. Then the summary over the page, with a burst of confetti.
// Step 2 lasts as long as the notice stays, and at most its timer, which closes the notice too. Its own shadow roots, like the notice. It changes nothing itself: Skip, and the
// notice closing, ask the background, which ends the demo through the settings lock.
import wordmarkUrl from '../../assets/wordmark-small.png';
import { confettiBurst } from '../shared/confetti';
import { NOTICE_MS } from '../shared/refusals';
import { type FramedToast, closeNotice, noticeBox, onToastFramed } from './notice-root';
import { holePath } from './site-toast';

type DemoView = { active: boolean; site?: string; name?: string; action?: string; hint?: string; change?: string; stopped?: string };
type Phase = 'waiting' | 'stopped' | 'ended';

const CSS = `
:host { all: initial; direction: ltr; } /* all: initial leaves direction alone, and an RTL page would flip the card */
.glass { --glass: rgba(255,255,255,.82); --edge: rgba(255,255,255,.8); --ink: #1d1320; --muted: rgba(29,19,32,.66);
  --faint: rgba(29,19,32,.45); --chip: rgba(255,255,255,.6); --line: rgba(29,19,32,.12); --accent: #db2777; --ok: #be185d;
  box-sizing: border-box; background: var(--glass); color: var(--ink); border: 1px solid var(--edge);
  backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow: 0 18px 50px rgba(15,23,42,.22), 0 2px 8px rgba(15,23,42,.10), inset 0 1px 0 rgba(255,255,255,.6);
  font: 500 13px/1.45 "OnlyRead Manrope", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.glass.dark { --glass: rgba(31,26,34,.86); --edge: rgba(255,255,255,.14); --ink: #f5eef3; --muted: rgba(245,238,243,.72);
  --faint: rgba(245,238,243,.5); --chip: rgba(255,255,255,.1); --line: rgba(255,255,255,.16); --accent: #ec4899; --ok: #f472b6;
  box-shadow: 0 20px 50px -14px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.08); }
/* The corner card. Step 2 moves and sizes it (left, bottom, width, height) to frame the notice, smoothly. */
.card { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; width: min(320px, calc(100vw - 32px));
  padding: 14px 16px; border-radius: 20px; animation: rise .7s cubic-bezier(.2,.9,.25,1.25) both;
  transition: left .55s cubic-bezier(.2,.9,.25,1.1), bottom .55s cubic-bezier(.2,.9,.25,1.1), width .55s cubic-bezier(.2,.9,.25,1.1), height .55s cubic-bezier(.2,.9,.25,1.1); }
.card.framing { padding: 12px 14px; border-radius: 26px;
  /* Liquid glass around the notice: clear, blurred and bright at the edge, so the notice inside stays the focus. */
  background: linear-gradient(160deg, rgba(255,255,255,.42), rgba(255,255,255,.14) 45%, rgba(255,255,255,.26));
  border: 1px solid rgba(255,255,255,.7); backdrop-filter: blur(30px) saturate(190%); -webkit-backdrop-filter: blur(30px) saturate(190%);
  box-shadow: 0 30px 70px -20px rgba(15,23,42,.35), inset 0 1px 0 rgba(255,255,255,.85), inset 0 -1px 0 rgba(255,255,255,.25); }
.card.framing.dark { background: linear-gradient(160deg, rgba(52,42,60,.66), rgba(22,17,27,.5) 45%, rgba(44,35,52,.6));
  border-color: rgba(255,255,255,.16); box-shadow: 0 30px 70px -20px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.22), inset 0 -1px 0 rgba(255,255,255,.06); }
.card.leaving { animation: leave .45s ease-in both; }
@keyframes rise { from { opacity: 0; transform: translateY(28px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes leave { to { opacity: 0; transform: translateY(18px) scale(.97); } }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.head img { height: 17px; width: auto; display: block; }
.head .tag { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--accent);
  padding: 2px 7px; border-radius: 99px; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.steps { display: flex; gap: 4px; margin-left: auto; }
.steps i { width: 16px; height: 4px; border-radius: 99px; background: var(--line); transition: background .4s, width .4s; }
.steps i.on { background: var(--accent); width: 24px; }
.body { display: grid; gap: 3px; }
.title { font-size: 15px; font-weight: 700; letter-spacing: -.01em; }
.sub { color: var(--muted); }
.wait { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 9px 12px; border-radius: 12px; background: var(--chip); color: var(--muted); font-size: 12px; }
.pulse { position: relative; width: 10px; height: 10px; flex: none; }
.pulse::before, .pulse::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: var(--accent); }
.pulse::after { animation: ping 1.6s cubic-bezier(0,0,.2,1) infinite; }
@keyframes ping { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(2.8); opacity: 0; } }
.bar { height: 3px; border-radius: 99px; background: var(--line); margin-top: 2px; overflow: hidden; }
.bar i { display: block; height: 100%; width: 100%; background: var(--accent); transform-origin: left; animation: drain var(--ms, 4000ms) linear forwards; }
@keyframes drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
.acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
button { cursor: pointer; font: 700 12px/1 "OnlyRead Manrope", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 8px 12px; border-radius: 9px;
  border: 1px solid var(--line); background: transparent; color: var(--muted); transition: background .15s, color .15s, transform .12s, filter .15s; }
button:hover { background: var(--chip); color: var(--ink); transform: translateY(-1px); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary { background: var(--accent); color: #fff; border-color: transparent; }
button.primary:hover { background: var(--accent); color: #fff; filter: brightness(1.07); }
.swap { animation: swap .5s cubic-bezier(.2,.9,.25,1.15) both; }
@keyframes swap { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
/* Step 2: the page behind the frame and the notice, blurred. Under both (the notice sits at the top layer). */
.backdrop { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; background: rgba(12,8,14,.28);
  backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); animation: fade .4s ease-out both; }
.backdrop.dark { background: rgba(6,4,9,.5); }
/* The summary, over the page. */
.scrim { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;
  background: rgba(12,8,14,.42); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); animation: fade .4s ease-out both; }
.scrim.leaving { animation: fade-out .35s ease-in both; }
@keyframes fade { from { opacity: 0; } } @keyframes fade-out { to { opacity: 0; } }
.sheet { width: min(380px, 100%); padding: 24px 22px 18px; border-radius: 24px; text-align: center; animation: pop .6s cubic-bezier(.2,.9,.25,1.25) both; }
@keyframes pop { from { opacity: 0; transform: translateY(20px) scale(.94); } to { opacity: 1; transform: none; } }
/* The summary's opening: what OnlyRead just did, shown as it happens to an agent, 4.8 s on a loop. An AI agent's
   cursor comes to the change's button and clicks; the button shakes into OnlyRead's lock; OnlyRead's shield stamps
   "Refused" beside it. */
.stage { position: relative; width: 236px; height: 96px; margin: 0 auto 14px; border-radius: 18px; overflow: hidden; display: grid; place-items: center;
  background: radial-gradient(120% 120% at 50% 0%, rgba(236,72,153,.16), rgba(236,72,153,0) 70%), rgba(255,255,255,.04); border: 1px solid var(--line); }
.stage .act { position: relative; display: inline-flex; align-items: center; gap: 7px; padding: 9px 18px; border-radius: 999px; overflow: hidden;
  font: 700 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: #3b82f6; animation: st-press 4.8s infinite; }
.stage .act svg { width: 14px; height: 14px; }
/* Each demo site's own control, as it looks there (shared/demo-sites.ts ids). */
.stage .act.x { gap: 6px; padding: 8px 12px; background: transparent; color: #71767b; font: 400 14px/1 -apple-system, "Segoe UI", sans-serif; }
.stage .act.x svg { width: 19px; height: 19px; }
.stage .act.linkedin, .stage .act.facebook { gap: 7px; padding: 9px 14px; border-radius: 6px; background: transparent; color: #a8a8a8; font: 600 14px/1 -apple-system, "Segoe UI", sans-serif; }
.stage .act.linkedin svg, .stage .act.facebook svg { width: 18px; height: 18px; }
.stage .act.facebook { color: #b0b3b8; border-radius: 6px; }
.stage .act.calendar { padding: 10px 22px; border-radius: 999px; background: #a8c7fa; color: #062e6f; font: 500 14px/1 "Google Sans", Roboto, -apple-system, sans-serif; }
.stage .act.linear { gap: 7px; padding: 7px 11px; border-radius: 6px; background: #26272b; border: 1px solid #36373c; color: #d2d3d6; font: 500 13px/1 Inter, -apple-system, sans-serif; }
.stage .act.linear .bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.stage .act.linear .bars i { width: 3px; border-radius: 1px; background: #d2d3d6; }
.stage .act.linear .bars i:nth-child(1) { height: 5px; } .stage .act.linear .bars i:nth-child(2) { height: 8px; } .stage .act.linear .bars i:nth-child(3) { height: 12px; }
.stage .act.x .lock, .stage .act.linkedin .lock, .stage .act.facebook .lock, .stage .act.linear .lock { border-radius: 999px; }
.stage .lock { position: absolute; inset: 0; display: grid; place-items: center; background: linear-gradient(135deg, #f472b6, #db2777 55%, #be185d); opacity: 0; animation: st-lock 4.8s infinite; }
.stage .lock svg { width: 16px; height: 16px; animation: st-pop 4.8s cubic-bezier(.2,.9,.25,1.6) infinite; }
.stage .agent { position: absolute; left: calc(50% + 12px); top: calc(50% + 4px); display: flex; align-items: flex-start; gap: 3px; animation: st-cursor 4.8s cubic-bezier(.45,.05,.25,1) infinite; }
.stage .agent svg { filter: drop-shadow(0 2px 3px rgba(0,0,0,.4)); }
.stage .agent .tag { margin-top: 13px; display: flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px; font: 700 10.5px/1.2 system-ui, -apple-system, sans-serif;
  color: #fff; background: #1d1320; border: 1px solid rgba(255,255,255,.2); white-space: nowrap; }
.stage .stamp { position: absolute; top: 10px; right: 10px; display: flex; align-items: center; gap: 5px; padding: 4px 9px 4px 6px; border-radius: 999px;
  font: 800 11px/1 system-ui, -apple-system, sans-serif; color: #fff; background: linear-gradient(135deg, #f472b6, #db2777 55%, #be185d); box-shadow: 0 6px 16px -6px rgba(219,39,119,.9);
  opacity: 0; animation: st-stamp 4.8s cubic-bezier(.2,.9,.25,1.5) infinite; }
.stage .stamp svg { width: 14px; height: 14px; }
@keyframes st-cursor { 0%, 8% { transform: translate(70px, 34px); opacity: 0; } 14% { opacity: 1; } 30% { transform: translate(0, 0); } 33% { transform: translate(0, 0) scale(.82); } 36%, 72% { transform: translate(0, 0); opacity: 1; } 82%, 100% { transform: translate(40px, 30px); opacity: 0; } }
@keyframes st-press { 0%, 32% { transform: none; } 33% { transform: scale(.92); } 36% { transform: none; } 38% { translate: -4px; } 40% { translate: 4px; } 42% { translate: -2px; } 44%, 100% { translate: 0; } }
@keyframes st-lock { 0%, 35% { opacity: 0; } 38%, 88% { opacity: 1; } 95%, 100% { opacity: 0; } }
@keyframes st-pop { 0%, 35% { transform: scale(.3); } 41% { transform: scale(1.3); } 46%, 100% { transform: scale(1); } }
@keyframes st-stamp { 0%, 40% { opacity: 0; transform: scale(1.6) rotate(-12deg); } 46% { opacity: 1; transform: scale(.94) rotate(3deg); } 50%, 88% { opacity: 1; transform: none; } 95%, 100% { opacity: 0; } }
/* "Stopped:" in the brand's gradient; what was stopped struck through as the sheet lands. */
.sheet h2 .verb { background: linear-gradient(135deg, #f472b6, #db2777 60%, #be185d); -webkit-background-clip: text; background-clip: text; color: transparent; }
.sheet h2 .what { background: linear-gradient(currentColor, currentColor) 0 56% / 0 2px no-repeat; animation: strike .5s .85s ease-out forwards; }
@keyframes strike { to { background-size: 100% 2px; } }
.sheet h2 { margin: 0 0 4px; font-size: 19px; font-weight: 800; font-family: "OnlyRead Manrope", system-ui, sans-serif; letter-spacing: -.02em; text-wrap: balance; }
.sheet .lede { margin: 0; color: var(--muted); font-size: 13px; }
/* The three facts as one calm list: one card, hairlines between, every row one line high, the same mark size. */
.facts { display: grid; gap: 0; margin: 16px 0 4px; text-align: left; border-radius: 14px; background: var(--chip); border: 1px solid var(--line); overflow: hidden; }
.fact + .fact { border-top: 1px solid var(--line); }
.fact { display: flex; gap: 11px; align-items: center; padding: 11px 14px; white-space: nowrap;
  font-size: 12.5px; animation: swap .5s cubic-bezier(.2,.9,.25,1.15) both; animation-delay: calc(.55s + var(--i, 0) * 110ms); }
.fact .dot { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; flex: none; font-size: 10px; font-weight: 800; color: #fff;
  background: linear-gradient(135deg, #f472b6, #db2777 55%, #be185d); }
.fact .dot.plain { background: transparent; box-shadow: inset 0 0 0 1.5px var(--accent); color: var(--accent); }
.fact .dot { animation: tick .5s cubic-bezier(.2,.9,.25,1.6) both; animation-delay: calc(.75s + var(--i, 0) * 110ms); }
@keyframes tick { from { transform: scale(0) rotate(-40deg); } 60% { transform: scale(1.3) rotate(8deg); } to { transform: none; } }
.sheet .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
.sheet .acts button { padding: 11px 12px; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.sheet .acts button svg { width: 15px; height: 15px; flex: none; }
.sheet .acts button.primary { grid-column: 1 / -1; padding: 12px; font-size: 13.5px; position: relative; overflow: hidden;
  background: linear-gradient(135deg, #f472b6, #db2777 55%, #be185d); animation: cta 2.8s 1.2s ease-in-out infinite; }
.sheet .acts button.primary:hover { background: linear-gradient(135deg, #f472b6, #db2777 55%, #be185d); }
.sheet .acts button.primary::after { content: ''; position: absolute; inset: 0; background: linear-gradient(110deg, transparent 35%, rgba(255,255,255,.3) 50%, transparent 65%);
  transform: translateX(-100%); animation: shine 4s 1.4s ease-in-out infinite; pointer-events: none; }
@keyframes cta { 0%, 100% { box-shadow: 0 10px 24px -10px rgba(236,72,153,.75), 0 0 0 0 rgba(236,72,153,.35); } 50% { box-shadow: 0 14px 30px -10px rgba(236,72,153,.95), 0 0 0 6px rgba(236,72,153,0); } }
@keyframes shine { 0%, 60% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 2147483647; }
@media (prefers-reduced-motion: reduce) { .card, .card.leaving, .swap, .pulse::after, .bar i, .scrim, .sheet, .fact, .backdrop,
  .stage *, .sheet h2 .what, .fact .dot, .sheet .acts button.primary, .sheet .acts button.primary::after { animation: none !important; }
  .card { transition: none; } .sheet h2 .what { background-size: 100% 2px; }
  .stage .lock, .stage .stamp { opacity: 1; } .stage .agent { display: none; } }
`;

const STAGE_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
/** Each demo site's control, drawn after its own: what the agent clicks there. */
const THUMB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-7a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.3l-1.4 8a2 2 0 0 1-2 1.7H7"/></svg>';
const STAGE_CONTROLS: Record<string, string> = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M16.7 3.9c-1.9 0-3.5 1-4.7 2.6C10.8 4.9 9.2 3.9 7.3 3.9 4.4 3.9 2 6.2 2 9.3c0 5.4 7.4 9.9 10 11.4 2.6-1.5 10-6 10-11.4 0-3.1-2.4-5.4-5.3-5.4Z"/></svg>128',
  linkedin: `${THUMB}Like`,
  facebook: `${THUMB}Like`,
  calendar: 'Save',
  linear: '<span class="bars"><i></i><i></i><i></i></span>High',
};
const STAGE_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const STAGE_CURSOR = '<svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true"><path d="M1 1v15l4.2-3.9 2.8 6.4 2.9-1.3-2.8-6.3H14z" fill="#fff" stroke="#1d1320" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="tag"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>AI agent</span>';
const STAGE_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/></svg>';

let host: HTMLElement | null = null;
/** The card's shadow root, closed: the page's scripts can neither read the card nor click Skip or its other buttons. */
let root: ShadowRoot | null = null;
let card: HTMLElement | null = null;
let phase: Phase | undefined;
let view: DemoView = { active: false };
/** Whether the demo's settings went back (messages.ts finishDemo): no, while an agent works or under a PIN. */
let restored = true;
/** Keeps the step-2 frame on the notice as the notice changes size. */
let framing: ResizeObserver | null = null;
/** Step 2's timer: its end closes the notice and ends the demo. */
let windDown: ReturnType<typeof setTimeout> | undefined;
/** Watches OnlyRead's notice during step 2, to end the demo when it closes. */
let watching: ReturnType<typeof setInterval> | undefined;
/** Room around the notice inside the frame. */
const PAD = 10;

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Dark glass when the system is dark, or the page is: the demo follows the person's own dark mode either way. */
function pageIsDark(): boolean {
  if (matchMedia('(prefers-color-scheme: dark)').matches) return true;
  const bg = getComputedStyle(document.body ?? document.documentElement).backgroundColor;
  const [r = 255, g = 255, b = 255, a = 1] = (bg.match(/[\d.]+/g) ?? []).map(Number);
  if (a < 0.5) return matchMedia('(prefers-color-scheme: dark)').matches;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function mount(): HTMLElement {
  if (card) return card;
  host = el('div');
  host.setAttribute('data-onlyread', 'demo');
  root = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = CSS;
  card = el('div', `glass card${pageIsDark() ? ' dark' : ''}`);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  card.setAttribute('aria-label', 'OnlyRead demo');
  root.append(style, card);
  document.documentElement.appendChild(host);
  return card;
}

/** The OnlyRead wordmark, "Demo", and the two steps. */
function header(step: 1 | 2): HTMLElement {
  const head = el('div', 'head');
  const logo = el('img');
  logo.src = wordmarkUrl;
  logo.alt = 'OnlyRead';
  const steps = el('div', 'steps');
  steps.append(Object.assign(el('i'), { className: 'on' }), Object.assign(el('i'), { className: step === 2 ? 'on' : '' }));
  head.append(logo, el('span', 'tag', 'Demo'), steps);
  return head;
}

/** The summary's button icons: a shield with a plus, arrows going round, a tick. */
const ICONS = {
  guard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M12 9v6M9 12h6"/></svg>',
  again: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
};

/** The personal AI assistants that run a browser of their own, which OnlyRead is set up in through a link from the Pro
 *  account page ("Install on", its Browsers section): Grok Bot and OpenAI Dot, with the marks the account page draws
 *  (Grok Bot's ball in white; Felipe for OpenAI Dot). Named in turn on the summary's button. */
function button(label: string, onClick: () => void, primary = false, icon?: keyof typeof ICONS): HTMLButtonElement {
  const b = el('button', primary ? 'primary' : '');
  if (icon) b.innerHTML = ICONS[icon]; // fixed markup of our own
  b.append(label);
  b.type = 'button';
  b.addEventListener('click', (e) => { e.stopPropagation(); if (e.isTrusted) onClick(); }); // real input only
  return b;
}

/** Sizes the card into a frame around the notice: its header above the notice, the notice inside. */
function frame(box: HTMLElement, c: HTMLElement, head: HTMLElement): void {
  const r = box.getBoundingClientRect();
  const headH = head.getBoundingClientRect().height;
  c.style.left = `${Math.max(4, r.left - PAD)}px`;
  c.style.bottom = `${Math.max(4, innerHeight - r.bottom - PAD)}px`;
  c.style.width = `${r.width + 2 * PAD}px`;
  c.style.height = `${r.height + 2 * PAD + headH + 8}px`;
  cutToastWindow(c);
}

/** The site toast the notice frames, as it last reported it. */
let framedToast: FramedToast | null = null;

/** The notice frames the page's own toast with a window over it (actions.ts): the card and the backdrop, between the
 *  notice and the page, get the same window, or it would show them, blurred, instead of the toast. */
function cutToastWindow(c: HTMLElement): void {
  const t = framedToast;
  const backdrop = root?.querySelector<HTMLElement>('.backdrop');
  if (!t) { c.style.clipPath = ''; if (backdrop) backdrop.style.clipPath = ''; return; }
  const cr = c.getBoundingClientRect();
  const at = (left: number, top: number) => ({ left: t.rect.left - left, top: t.rect.top - top, width: t.rect.width, height: t.rect.height });
  c.style.clipPath = holePath(cr.width, cr.height, at(cr.left, cr.top), t.radius);
  if (backdrop) backdrop.style.clipPath = holePath(innerWidth, innerHeight, at(0, 0), t.radius, 0);
}

function render(next: Phase): void {
  if (phase === next) return;
  const first = phase === undefined;
  phase = next;
  if (next === 'ended') { hide(); summary(); return; }
  const c = mount();
  const body = el('div', first ? 'body' : 'body swap');
  if (next === 'waiting') {
    body.append(el('div', 'title', `Try it: ${(view.action ?? 'make a change').toLowerCase()}`), el('div', 'sub', view.hint ?? ''));
    const wait = el('div', 'wait');
    wait.append(el('span', 'pulse'), el('span', '', 'Waiting for your click…'));
    body.append(wait);
    const acts = el('div', 'acts');
    acts.append(button('Skip demo', skip));
    c.replaceChildren(header(1), body, acts);
    return;
  }
  stopped(c, body);
}

/** Step 2: the card frames OnlyRead's notice, with a caption and the wind-down; the summary follows. It ends when the
 *  notice closes, or at the end of its timer at the latest: then the notice is closed too (it stays open while the
 *  pointer is on it or its details are open), and the card goes. */
function stopped(c: HTMLElement, body: HTMLElement): void {
  const head = el('div');
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.setProperty('--ms', `${NOTICE_MS}ms`);
  bar.append(fill);
  head.append(header(2), bar);
  body.append(head);
  c.replaceChildren(body);
  // The rest of the page steps back, blurred as under the summary, so the frame and OnlyRead's notice stand out.
  root?.prepend(el('div', `backdrop${pageIsDark() ? ' dark' : ''}`));
  confetti(c);
  clearTimeout(windDown);
  windDown = setTimeout(() => { closeNotice(); done(); }, NOTICE_MS);
  // The notice may come a moment before or after the news: look for it for up to a second, then frame it and keep
  // framing it while it changes size. With none (a page that hides it), the card simply says so.
  const t0 = performance.now();
  const seek = () => {
    const box = noticeBox();
    if (box) {
      c.classList.add('framing');
      onToastFramed((t) => { framedToast = t; cutToastWindow(c); });
      c.addEventListener('transitionend', () => cutToastWindow(c)); // the card's own resize, done: the window lines up
      frame(box, c, head);
      framing?.disconnect();
      framing = new ResizeObserver(() => frame(box, c, head));
      framing.observe(box);
      watchNotice();
      return;
    }
    if (performance.now() - t0 < 1000) { requestAnimationFrame(seek); return; }
    body.append(el('div', 'sub', `OnlyRead refused it before it reached ${view.name ?? 'the site'}.`));
  };
  requestAnimationFrame(seek);
}

/** Step 2 ends early when OnlyRead's notice closes (on its own, or dismissed); else its timer ends it (stopped). */
function watchNotice(): void {
  clearInterval(watching);
  watching = setInterval(() => { if (!noticeBox()) done(); }, 250);
}

/** Tells the background step 2 is over; it ends the demo and the summary comes. */
function done(): void {
  clearTimeout(windDown);
  clearInterval(watching);
  watching = undefined;
  if (phase === 'stopped') void chrome.runtime.sendMessage({ type: 'demo:done' }).catch(() => {});
}

/** Manrope for the coach, from the background on the demo's site only (no page can load the extension's files), added
 *  to the page's fonts under a name of OnlyRead's own. Without it, the system font. */
let fontAsked = false;
function loadFont(): void {
  if (fontAsked) return;
  fontAsked = true;
  void chrome.runtime.sendMessage({ type: 'demo:font' }).then(async (r: { ok?: boolean; font?: string } | undefined) => {
    if (!r?.ok || !r.font) return;
    const bytes = Uint8Array.from(atob(r.font), (ch) => ch.charCodeAt(0));
    const face = new FontFace('OnlyRead Manrope', bytes, { weight: '400 800' });
    document.fonts.add(await face.load());
  }).catch(() => {});
}

function hide(): void {
  clearInterval(watching);
  watching = undefined;
  framing?.disconnect();
  framing = null;
  onToastFramed(null);
  framedToast = null;
  if (!card || !host) return;
  const h = host;
  card.classList.add('leaving');
  setTimeout(() => h.remove(), reducedMotion() ? 0 : 450);
  host = null; root = null; card = null;
}

function skip(): void {
  void chrome.runtime.sendMessage({ type: 'demo:skip' }).catch(() => {});
  phase = undefined;
  hide();
}

/** A short burst from the card (shared/confetti.ts), on a canvas in the card's shadow root. */
function confetti(from: HTMLElement): void {
  if (reducedMotion() || !root) return;
  const canvas = el('canvas');
  root.append(canvas);
  const r = from.getBoundingClientRect();
  confettiBurst(canvas, r.left + r.width / 2, r.top);
}

/** The summary over the page: what was stopped, what still worked, what happens now; the burst of confetti. */
function summary(): void {
  const h = el('div');
  h.setAttribute('data-onlyread', 'demo-summary');
  const root = h.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = CSS;
  const scrim = el('div', 'scrim');
  const sheet = el('div', `glass sheet${pageIsDark() ? ' dark' : ''}`);
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'demo-title');
  const name = view.name ?? 'the site';
  // An agent doing what the person just did, and OnlyRead refusing it, on the site's own control (X's heart, the Like of
  // LinkedIn and Facebook, Calendar's Save, Linear's priority); a plain Send anywhere else. Fixed markup of our own.
  const stage = el('div', 'stage');
  stage.setAttribute('aria-hidden', 'true');
  const look = STAGE_CONTROLS[view.site ?? ''];
  const act = el('span', look ? `act ${view.site}` : 'act');
  act.innerHTML = look ?? `Send${STAGE_SEND}`;
  const lock = el('span', 'lock');
  lock.innerHTML = STAGE_LOCK;
  act.append(lock);
  const agent = el('span', 'agent');
  agent.innerHTML = STAGE_CURSOR;
  const stamp = el('span', 'stamp');
  stamp.innerHTML = STAGE_SHIELD;
  stamp.append('Refused');
  stage.append(act, agent, stamp);
  // The words are the page's text (the site's name, the change): text nodes, not markup.
  const title = el('h2');
  title.append(el('span', 'verb', 'Stopped:'), ' ', el('span', 'what', view.change ?? 'your change'), ` on ${name}`);
  title.id = 'demo-title';
  const facts: [string, string, boolean][] = [
    ['✓', `${name.charAt(0).toUpperCase()}${name.slice(1)} never received it`, true],
    ['✓', 'Browsing kept working', true],
    restored ? ['→', 'From now on, it steps in only for AI agents', false] : ['!', 'Still on all the time: your settings are locked', false],
  ];
  const list = el('div', 'facts');
  list.append(...facts.map(([mark, text, strong], i) => {
    const row = el('div', 'fact');
    row.style.setProperty('--i', String(i));
    row.append(el('span', strong ? 'dot' : 'dot plain', mark), el('span', '', text));
    return row;
  }));
  const close = () => { scrim.classList.add('leaving'); setTimeout(() => h.remove(), reducedMotion() ? 0 : 350); };
  const more = button('Guard more sites', () => { void chrome.runtime.sendMessage({ type: 'settings:open', section: 'guarded-sites' }).catch(() => {}); close(); }, true, 'guard');
  // Another site, or the same one again: the setup window's choice of site (background/messages.ts openSetupWindow).
  const again = button('Try another site', () => { void chrome.runtime.sendMessage({ type: 'settings:open', section: 'demo' }).catch(() => {}); close(); }, false, 'again');
  // Done: back to OnlyRead's page, in its open tab if there is one (background/messages.ts openDetails).
  const done = button('Done', () => { void chrome.runtime.sendMessage({ type: 'settings:open', section: 'overview' }).catch(() => {}); close(); }, false, 'done');
  const acts = el('div', 'acts');
  acts.append(more, again, done); // the main action across the top, the two plain ones side by side under it
  sheet.append(stage, title, el('p', 'lede', 'Just as it would stop an AI agent.'), list, acts);
  scrim.append(sheet);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  root.append(style, scrim);
  document.documentElement.appendChild(h);
  more.focus();
  if (!reducedMotion()) {
    const canvas = el('canvas');
    root.append(canvas);
    setTimeout(() => confettiBurst(canvas, innerWidth / 2, innerHeight * 0.3), 450);
  }
}

function show(v: DemoView): void {
  view = { ...view, ...v };
  if (!v.active) return;
  loadFont();
  render(v.stopped ? 'stopped' : 'waiting');
}

export function installDemoCoach(): void {
  if (window.top !== window) return;
  const ask = () => void chrome.runtime.sendMessage({ type: 'demo:state' }).then((v: DemoView | undefined) => { if (v?.active) show(v); }).catch(() => {});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ask, { once: true }); else ask();
  chrome.runtime.onMessage.addListener((msg: { type?: string; name?: string; restored?: boolean; skipped?: boolean }) => {
    if (msg?.type === 'demo:stopped') { view = { ...view, active: true, stopped: msg.name }; loadFont(); render('stopped'); }
    if (msg?.type === 'demo:ended') {
      restored = msg.restored !== false;
      if (msg.skipped && !view.stopped) { phase = undefined; hide(); } else render('ended');
    }
  });
}
