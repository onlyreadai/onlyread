// What protects OnlyRead's own settings. An AI agent working in this browser must not be able to lower
// protection, whatever it clicks: while an agent session is active, every change that weakens the guard is
// refused, for the person too, until the agent finishes. An optional settings PIN (set in the options page)
// asks for the PIN before any weakening change, between sessions as well. Raising protection is never
// locked. Pure functions here; messages.ts applies them.
import type { Policy } from '../shared/types';
import { isTargetHost } from './decision';
import { guardAllInForce, sitesInForce } from './sites';

type Check = (prev: Policy, next: Policy) => string | string[] | false;

/** One entry per way to lower protection; each names the change in words for the person, or returns false. */
const CHECKS: Check[] = [
  (p, n) => p.enabled !== false && n.enabled === false && 'turn protection off',
  (p, n) => p.mode === 'enforce' && n.mode !== 'enforce' && 'switch to monitor mode',
  (p, n) => p.attachWhen === 'always' && n.attachWhen !== 'always' && 'guard only during agent sessions',
  (p, n) => p.attachScope === 'all-tabs' && n.attachScope !== 'all-tabs' && "hold only the guarded sites' own tabs",
  // The two site checks compare the lists in force (sites.ts sitesInForce, this browser's own and the Pro account's
  // together), so a site the account switches off or removes, a removal from the account made here, and management
  // switched off, signed out or lapsed each name the sites they drop, unless this browser's own settings still guard
  // them (cloud-sync.ts: the lists are a union).
  (p, n) => { const was = sitesInForce(p).sites, now = sitesInForce(n).sites; return Object.entries(was).filter(([id, s]) => s.enabled && !now[id]?.enabled).map(([id]) => `switch ${id} off`); },
  (p, n) => { const now = sitesInForce(n).customSites; return sitesInForce(p).customSites.filter((c) => c.enabled).map((c) => customSiteChange(c, now.find((x) => x.id === c.id))).filter((x): x is string => Boolean(x)); },
  // A removal from the account's list, waiting to be sent, lowers protection in every browser on the account, even when
  // this browser's own list still guards the site (so the checks above, on the union, see nothing): cloud-sync.ts
  // sends it as it is.
  (p, n) => { const was = new Set((p.accountEdits ?? []).map(editKey)); return (n.accountEdits ?? []).filter((e) => e.op === 'remove' && e.scope === 'account' && !was.has(editKey(e))).map((e) => `remove ${e.id} from your Pro account`); },
  // Guard everything, as in force over its three levels (sites.ts guardAllInForce): switching it off, or
  // a host newly left unguarded, lowers protection, whichever level the change came from.
  (p, n) => guardAllInForce(p).on && !guardAllInForce(n).on && 'guard only the listed sites',
  (p, n) => { const was = guardAllInForce(p), now = guardAllInForce(n); return was.on && now.on ? now.exclude.filter((h) => !isTargetHost(h, was.exclude)).map((h) => `exclude ${h}`) : []; },
  (p, n) => !p.uploads && Boolean(n.uploads) && 'allow file uploads',
  (p, n) => p.websockets === 'block' && n.websockets !== 'block' && 'allow WebSockets',
  (p, n) => !p.allowReadTracking && Boolean(n.allowReadTracking) && 'allow read-tracking writes',
  (p, n) => p.reviewBand !== n.reviewBand && n.reviewBand !== 'block' && 'change how uncertain requests are reviewed',
  (p, n) => Boolean(p.opaqueToReview) && !n.opaqueToReview && 'stop reviewing unreadable request bodies',
  (p, n) => JSON.stringify(p.judge) !== JSON.stringify(n.judge) && 'change the AI judge',
  (p, n) => p.cloud?.serviceUrl !== n.cloud?.serviceUrl && 'change the OnlyRead Pro service',
];

const editKey = (e: NonNullable<Policy['accountEdits']>[number]) => `${e.at}|${e.op}|${e.scope}|${e.id}`;

function customSiteChange(was: Policy['customSites'][number], now: Policy['customSites'][number] | undefined): string | undefined {
  if (!now) return `remove ${was.id}`;
  if (!now.enabled) return `switch ${was.id} off`;
  if (was.domains.some((d) => !now.domains.includes(d))) return `guard fewer of ${was.id}'s domains`;
  return undefined;
}

/** Each way `next` lowers protection compared with `prev`, in words for the person ("switch gmail off").
 *  Empty when the change keeps or raises protection. */
export function weakeningChanges(prev: Policy, next: Policy): string[] {
  return CHECKS.flatMap((check) => check(prev, next) || []);
}

/** Actions that are not settings but still lower protection: forgetting tested verdicts, erasing the record. */
export const WEAKENING_ACTIONS = {
  'cache:clear': 'clear the tested verdicts',
  'audit:clear': 'clear the activity log',
  'observations:clear': 'clear the request log',
} as const;

export type LockReason = 'agent' | 'pin';

/** Why a weakening change is refused right now, or undefined when it may go ahead. An active agent session
 *  refuses outright; otherwise a set PIN must have been entered recently. */
export function lockFor(changes: string[], state: { agentActive: boolean; agentBrowser?: boolean; pinSet: boolean; pinUnlocked: boolean }): { reason: LockReason; message: string } | undefined {
  if (!changes.length) return undefined;
  const what = changes[0]!;
  if (state.agentBrowser) {
    return { reason: 'agent', message: `This browser belongs to an AI agent, so OnlyRead can't ${what} here. To release it, sign it out from your OnlyRead Pro account page in your own browser.` };
  }
  if (state.agentActive) {
    return { reason: 'agent', message: `An AI agent is active in this browser, so OnlyRead can't ${what} until it finishes.` };
  }
  if (state.pinSet && !state.pinUnlocked) return { reason: 'pin', message: `Enter your settings PIN to ${what}.` };
  return undefined;
}

/** A refusal travels as a thrown error whose message starts with this, so the settings pages can tell it
 *  from a failure and show the sentence after it. */
export const LOCKED_PREFIX = 'locked:';

// ---- Storage keys, besides the policy, that hold up protection. The background writes them stamped (owned-storage.ts);
// a change to one that arrives unstamped was written around the background, and when it lowers protection while the
// lock holds, index.ts puts the old value back, so a driven settings page cannot remove the PIN, replace the judge's key,
// reset the wrong-PIN count, clear the agent-browser mark or drop the Pro tokens with `chrome.storage.local` directly,
// past the lock and with no line in the log. (The sign-in the account's list came from, `managedFrom`, is kept apart:
// cloud-sync.ts puts back any outside write to it, lock or not.)

export const GUARDED_KEYS = ['settingsPin', 'secrets', 'pinFailures', 'agentBrowser', 'cloudTokens', 'agentSetup', 'firstJudgeAt'] as const;
export type GuardedKey = (typeof GUARDED_KEYS)[number];
export function isGuardedKey(k: string): k is GuardedKey { return (GUARDED_KEYS as readonly string[]).includes(k); }

const present = (v: unknown): boolean => Boolean(v) && typeof v === 'object';
const keysOf = (v: unknown): Record<string, unknown> => (present(v) && present((v as { keys?: unknown }).keys) ? (v as { keys: Record<string, unknown> }).keys : {});
const num = (v: unknown, field: string): number => Number((v as Record<string, unknown> | null | undefined)?.[field]) || 0;

/** How a change to `key`, from `oldValue` to `newValue`, lowers protection, in words for the person, or undefined when it
 *  does not: a first key added, more wrong-PIN tries recorded and a sign-in raise or keep it. Setting a first PIN counts,
 *  as in messages.ts setPin: an agent must not set one the person does not know (lockFor refuses it only while an agent
 *  is at work). Any change to the Pro tokens counts only in a browser that belongs to an agent, where signing out and
 *  signing in again are refused. */
type Lowering = (oldValue: unknown, newValue: unknown, state: { agentBrowser: boolean }) => string | undefined;

function pinLowering(oldValue: unknown, newValue: unknown): string | undefined {
  if (present(oldValue) && !present(newValue)) return 'remove the settings PIN';
  if (present(oldValue)) return JSON.stringify(oldValue) === JSON.stringify(newValue) ? undefined : 'change the settings PIN';
  return present(newValue) ? 'set a settings PIN' : undefined;
}

function keyLowering(oldValue: unknown, newValue: unknown): string | undefined {
  const was = keysOf(oldValue), now = keysOf(newValue);
  for (const [id, k] of Object.entries(was)) {
    if (typeof k !== 'string' || !k.trim() || now[id] === k) continue;
    return typeof now[id] === 'string' && (now[id] as string).trim() ? "replace the AI judge's key" : "remove the AI judge's key";
  }
  return undefined;
}

const LOWERINGS: Record<GuardedKey, Lowering> = {
  settingsPin: pinLowering,
  secrets: keyLowering,
  pinFailures: (o, n) => (num(n, 'count') < num(o, 'count') || num(n, 'retryAt') < num(o, 'retryAt') ? 'reset the wrong-PIN count' : undefined),
  agentBrowser: (o, n) => (present(o) && !present(n) ? 'release this browser from its AI agent' : undefined),
  // In an agent's browser the sign-in is the setup link's, and only the background changes it (a refresh, a sign-out it
  // was told of): one written from outside, another account's included, would bring a list that is not the person's.
  cloudTokens: (o, n, state) => {
    if (!state.agentBrowser || JSON.stringify(o ?? null) === JSON.stringify(n ?? null)) return undefined;
    return present(o) && !present(n) ? 'sign out of OnlyRead Pro' : 'change the OnlyRead Pro sign-in';
  },
  // The setup's undo record (agent-setup.ts): a record written from outside would have Undo switch off what the person
  // set. Erasing one only takes the Undo away, which lowers nothing.
  // The first-judge record (shared/first-judge.ts): while there is none, choosing an AI judge passes an agent at work
  // (messages.ts firstJudgeChanges). Removing it would open that again; writing it (the setup and settings pages do)
  // only shuts it.
  firstJudgeAt: (o, n) => (o && !n ? 'set up a first AI judge again' : undefined),
  agentSetup: (o, n) => (present(n) && JSON.stringify(o) !== JSON.stringify(n) ? "change the AI agent setup's undo record" : undefined),
};

export function storageLowering(key: GuardedKey, oldValue: unknown, newValue: unknown, state: { agentBrowser: boolean }): string | undefined {
  return LOWERINGS[key](oldValue, newValue, state);
}

// ---- Who may send what. The content script runs inside web pages: it reports the agent's clicks and asks
// two read-only questions, nothing more. Everything else (every settings change) must come from OnlyRead's own
// pages (popup, options, setup), so nothing that reaches a page's world can ever change protection.

/** Messages the content script sends. (No `policy:get`: what the script needs per host comes in `guard:config`, so a
 *  page's world gets no copy of the settings.) */
/** `settings:open` only opens OnlyRead's settings page at its AI judge or Sites section, for the notice's "Sign in to
 *  Pro" and the demo's "Guard more sites"; it changes nothing, and is honored only from a top frame on a guarded or demo
 *  site (messages.ts), the only pages that show those buttons. */
/** `page:agent-setup-hello`, `-apply`, `-link` and `-agent` come from the Pro service's agent-setup page
 *  only (messages.ts); they only raise protection (agent-setup.ts), or note which agent runs the browser. */
/** `demo:state`, `demo:font`, `demo:skip` and `demo:done` serve the first-run demo's coach card (content/demo-coach.ts):
 *  all four answer only on the demo's own site (or OnlyRead's pages); the last two only end a demo the person started from the setup
 *  window (`demo:done` only once its write was refused), putting back their own settings through the settings lock, so
 *  an agent at work cannot use them. */
/** `page:frame-check` asks whether the Pro account page may frame this browser's own pages, and `page:which-browser`
 *  which row of its Browsers list this browser is: both change nothing and answer only the account's own page, for the
 *  account this browser is signed in to (messages.ts frameCheck, whichBrowser). */
const CONTENT_SCRIPT_MESSAGES = new Set(['demo:state', 'demo:font', 'demo:skip', 'demo:done', 'ui:action', 'secret:typed', 'page:closing', 'page:account-saved', 'page:signin-code', 'page:signin-link', 'page:agent-setup-hello', 'page:account-changed', 'page:signed-out', 'page:frame-check', 'page:which-browser', 'page:open-demo', 'page:agent-setup-apply', 'page:agent-setup-link', 'page:agent-setup-agent', 'guard:config', 'settings:open']);

/** Whether a message from this sender may be handled: OnlyRead's own pages may send anything; a content script
 *  (or anything else) only its few messages. */
export function messageAllowed(type: string, sender: { id?: string; url?: string }, own: { id: string; origin: string }): boolean {
  if (sender.id !== own.id) return false;
  if (sender.url?.startsWith(own.origin)) return true;
  return CONTENT_SCRIPT_MESSAGES.has(type);
}

// ---- Settings PIN. Stored as a salted PBKDF2-SHA-256 hash (PIN_ITERATIONS rounds), never the PIN itself. It
// keeps an agent (which does not know it) from lowering protection; it is not meant to resist someone who can read
// the extension's storage, but the rounds make a read copy worth something. Older
// versions stored one round of SHA-256 over `salt:pin`: such a hash still verifies (`iterations` absent) and is
// replaced on the next right entry (messages.ts checkPin).

export interface StoredPin { salt: string; hash: string; /** PBKDF2 rounds; absent for the older single-round hash. */ iterations?: number }

/** How long an entered PIN keeps the settings unlocked. */
export const PIN_UNLOCK_MS = 2 * 60_000;
/** OWASP's 2023 figure for PBKDF2-SHA-256; about 0.1 s in the worker, nothing against a wrong-PIN backoff of 30 s. */
export const PIN_ITERATIONS = 310_000;

export function validPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4,12}$/.test(pin);
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function pbkdf2Hex(pin: string, salt: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256));
}

/** Equal in time that does not depend on where they differ. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPin(pin: string, salt = crypto.randomUUID(), iterations = PIN_ITERATIONS): Promise<StoredPin> {
  return { salt, hash: await pbkdf2Hex(pin, salt, iterations), iterations };
}

/** A hash from before PBKDF2: re-hash it once the PIN is known to be right. */
export function needsRehash(stored: StoredPin): boolean {
  return !stored.iterations;
}

/** The most PBKDF2 rounds a stored PIN may ask for. A record written around the background could ask for so many that
 *  checking a PIN never ends (each try holds up the next, messages.ts checkPin); one beyond this matches no PIN. */
export const MAX_PIN_ITERATIONS = 10 * PIN_ITERATIONS;

export async function pinMatches(pin: unknown, stored: StoredPin | undefined): Promise<boolean> {
  if (!stored || !validPin(pin)) return false;
  const rounds = stored.iterations;
  // Absent: the older single-round hash. Present: a whole number of rounds, at most MAX_PIN_ITERATIONS.
  if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_PIN_ITERATIONS)) return false;
  const hash = rounds ? await pbkdf2Hex(pin, stored.salt, rounds) : await sha256Hex(`${stored.salt}:${pin}`);
  return sameHex(hash, stored.hash);
}
