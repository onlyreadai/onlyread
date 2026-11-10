// The in-page guards for sites whose reads and writes share one encrypted channel (site `socketGuard`): WhatsApp
// Web's stanzas (inpage/whatsapp-socket.ts) and Telegram Web's MTProto requests (inpage/telegram-worker.ts). Neither
// the Fetch domain nor a DNR rule can tell a read from a send on such a channel, so the site's profile blocks its
// sockets, and this module lifts that block tab by tab once the site's guard is in place there:
// - a held tab gets the guard through the debugger, for the page now and every document it loads after
//   (Page.addScriptToEvaluateOnNewDocument), and each of its workers gets it as it starts;
// - the tab is then "armed": the session rule buildSocketGuardRule lets its sockets to the site through;
// - a failure anywhere leaves the tab unarmed, its sockets refused: the site stops working there rather than
//   carrying writes unseen.
// The guard decides in the page (synchronously, so frames keep their order) and reports what it refuses through a
// binding; those reports land in the Activity log and show the page's notice like any refused request.
import { buildSocketGuardRule, replaceSessionRule, SOCKET_GUARD_RULE_ID } from './rules';
import { guardsHost, isTargetHost } from './decision';
import { S } from './state';
import type { Policy, SocketCodec } from '../shared/types';

export const BINDING = 'orSocketGuard';
const HOOK_FILES: Record<SocketCodec, string> = { whatsapp: 'dist/whatsapp-socket.js', telegram: 'dist/telegram-worker.js' };

type Session = chrome.debugger.DebuggerSession;

/** Tabs whose page carries the guard: the site's guard, and the id of the script that puts it in every new document. */
const armed = new Map<number, { id: string; codec: SocketCodec }>();
/** Armed tabs whose new document has not yet been seen to carry the guard: their sockets stay refused meanwhile. */
const confirming = new Set<number>();
/** Armed tabs with workers starting that do not carry the guard yet, by how many: their sockets stay refused too. */
const startingWorkers = new Map<number, number>();
/** Worker sessions whose guard has reported in, and the ones waiting to hear it. */
const reported = new Set<string>();
const reportWaiters = new Map<string, () => void>();
/** How long a starting worker has to report its guard in before it is put in the other way. */
const REPORT_MS = 1500;
/** Worker sessions that carry the guard, by tab: told of every configuration change. */
const workers = new Map<number, Set<string>>();
const hookSources = new Map<SocketCodec, Promise<string>>();
let ruleKey = '';

export interface SocketGuardConfig { mode: 'monitor' | 'enforce'; allow: string[]; hosts: string[]; binding: string }

/** What the guard in the page is told: the mode, the write shapes let through anyway (the policy's allowedShapes, and
 *  the read-tracking ones when that setting is on), and the hosts it acts on. */
export function guardConfig(codec: SocketCodec, p: Policy = S.policy): SocketGuardConfig {
  const e = p.effective;
  const tracking = p.allowReadTracking ? [...e.readTrackingShapes, ...e.siteRules.flatMap((r) => r.readTrackingShapes)] : [];
  const allowed = [...e.allowedShapes, ...e.siteRules.flatMap((r) => r.allowedShapes)];
  const allow = [...new Set([...allowed, ...tracking])].filter((s) => s.startsWith(`${codec}:`)).sort();
  const hosts = e.socketGuards.filter((g) => g.codec === codec).flatMap((g) => g.domains);
  return { mode: p.mode, allow, hosts, binding: BINDING };
}

/** The guard's source wrapped with its configuration: one expression, safe to run again (it then reconfigures). */
export function guardExpression(source: string, cfg: SocketGuardConfig): string {
  // Once in, it says so through the binding (a worker's report is how its tab learns the guard is there).
  const ready = `try { const b = globalThis[orSocketConfig.binding]; if (typeof b === 'function') b(JSON.stringify({ ready: true })); } catch {}`;
  return `(function (orSocketConfig) {\n${source}\n${ready}\n})(${JSON.stringify(cfg)});`;
}

function source(codec: SocketCodec): Promise<string> {
  let s = hookSources.get(codec);
  if (!s) {
    const file = HOOK_FILES[codec];
    s = fetch(chrome.runtime.getURL(file)).then((r) => {
      if (!r.ok) throw new Error(`${file}: ${r.status}`);
      return r.text();
    });
    hookSources.set(codec, s);
    s.catch(() => { hookSources.delete(codec); });
  }
  return s;
}

/** The guard a site takes, by a URL on it (a page, a worker's script, a blob: worker). */
function codecFor(url: string, p: Policy = S.policy): SocketCodec | undefined {
  const h = hostOf(url);
  // An allowed host under a site guard every site profiles is unguarded: no stanza guard there (guardsHost).
  return h && guardsHost(p.effective, h) ? p.effective.socketGuards.find((g) => isTargetHost(h, g.domains))?.codec : undefined;
}

const expressionFor = async (codec: SocketCodec) => guardExpression(await source(codec), guardConfig(codec));

const hostOf = (url: string): string => {
  try { return new URL(url.replace(/^blob:/, '')).hostname; } catch { return ''; }
};

/** Whether a URL is on a stanza-guarded site. */
export function guardedSocketHost(url: string, p: Policy = S.policy): boolean {
  return codecFor(url, p) !== undefined;
}

async function refreshRule(): Promise<void> {
  const rule = buildSocketGuardRule(S.policy.effective.socketGuardDomains, [...armed.keys()].filter((t) => !confirming.has(t) && !startingWorkers.get(t)));
  const key = JSON.stringify(rule);
  if (key === ruleKey) return;
  ruleKey = key;
  try { await replaceSessionRule(SOCKET_GUARD_RULE_ID, rule); } catch (err) { ruleKey = ''; console.warn('[onlyread] socket-guard rule failed:', err); }
}

async function disarm(tabId: number, why: string, log: (tabId: number, msg: string) => void): Promise<void> {
  const had = armed.delete(tabId);
  // A guard that could not go in is always said, armed before or not: a tab stuck unarmed has no other trace.
  if (!had && why !== 'released') log(tabId, `socket-guard-not-armed:${why}`);
  confirming.delete(tabId);
  startingWorkers.delete(tabId);
  workers.delete(tabId);
  await refreshRule();
  if (had) log(tabId, `socket-guard-disarmed:${why}`);
}

/** Runs an expression; rejects when it threw in the page (CDP answers that as a result with exceptionDetails). */
async function evaluate(send: (t: Session, m: string, p?: object) => Promise<unknown>, target: Session, expression: string): Promise<unknown> {
  const r = (await send(target, 'Runtime.evaluate', { expression, returnByValue: true })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
  if (r?.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown'}`.slice(0, 160));
  return r?.result?.value;
}

/** Whether the guard is in this page or worker now: what arming rests on, checked rather than assumed. */
const PRESENT = `typeof globalThis[Symbol.for('onlyread.socket-guard')]?.configure === 'function'`;
const present = async (send: (t: Session, m: string, p?: object) => Promise<unknown>, target: Session): Promise<boolean> =>
  (await evaluate(send, target, PRESENT)) === true;

/** Put the site's guard in a held tab's page (now, and in every document it loads) and arm the tab. Only for a tab on
 *  a socket-guarded site; a tab elsewhere is left alone (its navigation to one is caught by `committed`). */
export async function onTabHeld(tabId: number, url: string, send: (t: Session, m: string, p?: object) => Promise<unknown>, log: (tabId: number, msg: string) => void): Promise<void> {
  const codec = codecFor(url);
  if (armed.has(tabId) || !codec) return;
  try {
    const expr = await expressionFor(codec);
    await send({ tabId }, 'Runtime.addBinding', { name: BINDING });
    await send({ tabId }, 'Runtime.enable');
    // The script for every new document runs only with the Page domain on.
    await send({ tabId }, 'Page.enable');
    const r = (await send({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source: expr, runImmediately: true })) as { identifier?: string } | undefined;
    // The document already here gets it too (runImmediately covers its existing contexts; evaluate is the fallback).
    await evaluate(send, { tabId }, expr);
    if (!(await present(send, { tabId }))) throw new Error('not in the page after injection');
    armed.set(tabId, { id: r?.identifier ?? '', codec });
    await refreshRule();
    log(tabId, `socket-guard-armed:${codec}`);
  } catch (err) {
    await disarm(tabId, `inject-failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 120), log);
  }
}

/** After an armed tab loads a new document: the guard must be in it (the registered script ran at its start). If it is
 *  not, the tab is disarmed, its socket refused again, and the guard put in afresh. */
async function checkDocument(tabId: number, url: string, send: (t: Session, m: string, p?: object) => Promise<unknown>, log: (tabId: number, msg: string) => void): Promise<void> {
  // Until the new document is seen to carry the guard, its socket is refused (the page retries it).
  confirming.add(tabId);
  await refreshRule();
  for (const wait of [0, 50, 250, 1000]) {
    await new Promise((r) => setTimeout(r, wait));
    if (!armed.has(tabId)) return;
    try {
      if (await present(send, { tabId })) { confirming.delete(tabId); await refreshRule(); return; }
    } catch { /* the document is not ready to answer yet */ }
  }
  await disarm(tabId, 'missing-after-navigation', log);
  void onTabHeld(tabId, url, send, log);
}

/** The guard put before a worker script's first line, for a script on a socket-guarded site. */
export async function workerScriptPrefix(url: string): Promise<string | undefined> {
  const codec = codecFor(url);
  return codec ? expressionFor(codec) : undefined;
}

/** A worker's guard reported in through the binding (its session). */
export function onReady(sessionId: string): void {
  reported.add(sessionId);
  reportWaiters.get(sessionId)?.();
}

const reportedWithin = (sessionId: string, ms: number): Promise<boolean> => {
  if (reported.has(sessionId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { reportWaiters.delete(sessionId); resolve(reported.has(sessionId)); }, ms);
    reportWaiters.set(sessionId, () => { clearTimeout(t); reportWaiters.delete(sessionId); resolve(true); });
  });
};

/** A worker of a held tab, as it starts. A worker on a socket-guarded site normally carries the guard in its script
 *  (workerScriptPrefix) and reports in. One that does not (a blob: worker, a script a service worker answered) gets the guard put in through its session once it runs. If neither works, the tab is disarmed: its sockets
 *  are refused again. */
export async function onWorker(tabId: number, sessionId: string, url: string, send: (t: Session, m: string, p?: object) => Promise<unknown>, log: (tabId: number, msg: string) => void, ready: (sessionId: string) => Promise<boolean> = async () => true): Promise<void> {
  const codec = codecFor(url);
  if (!codec) return;
  try {
    if (!(await reportedWithin(sessionId, REPORT_MS))) await injectWorker(tabId, sessionId, codec, send, log, ready);
    if (!reported.has(sessionId)) return; // it never ran: nothing to guard
    const set = workers.get(tabId) ?? new Set<string>();
    set.add(sessionId);
    workers.set(tabId, set);
  } catch (err) {
    await disarm(tabId, `worker-inject-failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 120), log);
  } finally {
    workerStarted(tabId);
  }
}

/** Puts the guard into a running worker through its session: for one whose script did not carry it. */
async function injectWorker(tabId: number, sessionId: string, codec: SocketCodec, send: (t: Session, m: string, p?: object) => Promise<unknown>, log: (tabId: number, msg: string) => void, ready: (sessionId: string) => Promise<boolean>): Promise<void> {
  const target = { tabId, sessionId };
  await send(target, 'Runtime.enable');
  // Only into a worker that runs: one of a document being torn down never does, and goes without running code.
  if (!(await ready(sessionId))) { log(tabId, 'socket-guard-worker-never-ran'); return; }
  await evaluate(send, target, await expressionFor(codec));
  if (!(await present(send, target))) throw new Error('not in the worker after injection');
  reported.add(sessionId);
  log(tabId, 'socket-guard-worker-injected');
}

/** A worker of a held tab is about to start, before it runs: until its guard is in (onWorker), the tab's sockets to
 *  the site are refused, so a worker that opens one at once cannot open it unguarded. */
export async function workerStarting(tabId: number, sessionId: string, url: string, send: (t: Session, m: string, p?: object) => Promise<unknown>): Promise<void> {
  if (!codecFor(url)) return;
  // The binding its guard reports through, there before its first line runs (safe while it is held paused).
  await send({ tabId, sessionId }, 'Runtime.addBinding', { name: BINDING }).catch(() => {});
  if (!armed.has(tabId)) return;
  startingWorkers.set(tabId, (startingWorkers.get(tabId) ?? 0) + 1);
  await refreshRule();
}

function workerStarted(tabId: number): void {
  const n = startingWorkers.get(tabId);
  if (!n) return;
  if (n > 1) startingWorkers.set(tabId, n - 1); else startingWorkers.delete(tabId);
  void refreshRule();
}

export function onWorkerGone(tabId: number, sessionId: string): void {
  workers.get(tabId)?.delete(sessionId);
  reported.delete(sessionId);
  reportWaiters.get(sessionId)?.();
}

/** The tab is no longer held (detached, closed): nothing guards its socket now. */
export function onTabReleased(tabId: number, log: (tabId: number, msg: string) => void): void {
  void disarm(tabId, 'released', log);
}

/** A held tab committed a navigation: one that reached a stanza-guarded site gets the guard now. */
export function committed(tabId: number, url: string, held: boolean, send: (t: Session, m: string, p?: object) => Promise<unknown>, log: (tabId: number, msg: string) => void): void {
  if (!held || !guardedSocketHost(url)) return;
  if (armed.has(tabId)) void checkDocument(tabId, url, send, log);
  else void onTabHeld(tabId, url, send, log);
}

/** The policy changed: tell every armed page and worker the new configuration, and re-register the script for the
 *  documents still to load. A site switched off leaves its tabs unarmed (the rule names no domain then). */
/** A site switched on while its tabs were already held (for another site, or every tab): arm them now. */
async function armHeld(heldTabs: number[], send: (t: Session, m: string, p?: object) => Promise<unknown>, log: (tabId: number, msg: string) => void): Promise<void> {
  for (const tabId of heldTabs.filter((t) => !armed.has(t))) {
    const url = (await chrome.tabs.get(tabId).catch(() => undefined))?.url ?? '';
    if (codecFor(url)) await onTabHeld(tabId, url, send, log);
  }
}

export async function reconfigure(send: (t: Session, m: string, p?: object) => Promise<unknown>, log: (tabId: number, msg: string) => void, heldTabs: number[] = []): Promise<void> {
  await armHeld(heldTabs, send, log);
  if (!armed.size) { await refreshRule(); return; }
  for (const [tabId, { id, codec }] of [...armed]) {
    try {
      const expr = await expressionFor(codec);
      if (id) await send({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
      const r = (await send({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source: expr })) as { identifier?: string } | undefined;
      await evaluate(send, { tabId }, expr);
      armed.set(tabId, { id: r?.identifier ?? '', codec });
      for (const sessionId of workers.get(tabId) ?? []) await evaluate(send, { tabId, sessionId }, expr).catch(() => {});
    } catch (err) {
      await disarm(tabId, `reconfigure-failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 120), log);
    }
  }
  await refreshRule();
}

/** A report from the guard, as the binding delivers it. Undefined when it is not one. */
/** Whether a binding call is a guard reporting in. */
export function isReady(name: string, payload: string): boolean {
  if (name !== BINDING) return false;
  try { return (JSON.parse(payload) as { ready?: unknown } | null)?.ready === true; } catch { return false; }
}

export function parseReport(name: string, payload: string): { shape: string; enforced: boolean } | undefined {
  if (name !== BINDING) return undefined;
  try {
    const r = JSON.parse(payload) as { shape?: unknown; enforced?: unknown };
    if (typeof r !== 'object' || r === null) return undefined;
    if (typeof r.shape !== 'string' || !/^(?:whatsapp|telegram):[\w:.[\]-]{1,120}$/.test(r.shape)) return undefined;
    return { shape: r.shape, enforced: r.enforced === true };
  } catch {
    return undefined;
  }
}

/** The HTTP paths a site's guarded channel also takes: Telegram falls back from its socket to posting the same
 *  encrypted requests to `/apiw1`. The guard vets each request before it is encrypted, whichever way it then goes. */
const HTTP_CHANNELS: Partial<Record<SocketCodec, RegExp>> = { telegram: /^\/apiw1(?:_test)?$/ };

/** Whether a request takes an armed tab's guarded channel (its HTTP path, on the site the tab is armed for). */
function onChannel(rec: { tabId: number; method: string; url: string; path: string }): boolean {
  const a = armed.get(rec.tabId);
  if (!a || rec.method !== 'POST') return false;
  return Boolean(HTTP_CHANNELS[a.codec]?.test(rec.path)) && codecFor(rec.url) === a.codec;
}

/** Whether a request is the guarded channel of an armed tab (its guard decided it before encryption), so no other
 *  check applies: Telegram's `/apiw1` posts are as opaque to a judge as its socket frames. */
export function guardedChannel(rec: { tabId: number; method: string; url: string; path: string }): boolean {
  return onChannel(rec) && !confirming.has(rec.tabId) && !startingWorkers.get(rec.tabId);
}

/** Whether a request takes an armed tab's guarded channel before the guard is in every worker (a worker runs before
 *  it gets the guard by its session): such a request may never have been vetted, so it is refused, as the tab's
 *  sockets are meanwhile, and the client sends it again once the guard is in. It is not a write that was seen. */
export function guardStarting(rec: { tabId: number; method: string; url: string; path: string }): boolean {
  return onChannel(rec) && (confirming.has(rec.tabId) || Boolean(startingWorkers.get(rec.tabId)));
}

/** Tabs to reload when a change stops guarding their site's socket (the site or protection switched off): the guard
 *  runs inside the page and its workers, with no way to take it out, and it would go on refusing writes with the
 *  settings it last had. Reloaded, the page starts without it (and with SharedWorker back). Only tabs on that site. */
export function tabsToReloadOnGuardOff(prev: Policy, next: Policy, tabs: { id: number; url?: string }[]): number[] {
  const guarded = (p: Policy, url: string) => p.enabled !== false && codecFor(url, p) !== undefined;
  return tabs.filter((t) => t.url && guarded(prev, t.url) && !guarded(next, t.url)).map((t) => t.id);
}

export function armedTabs(): number[] {
  return [...armed.keys()];
}
