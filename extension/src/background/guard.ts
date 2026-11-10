// What holds the guarded sites: the DNR rules, the tabs the debugger could not hold (see unguarded.ts), and
// the editor guard the content script applies.
import { refreshAccountLock } from './account-lock';
import type { Message, Policy } from '../shared/types';
import { applyRules, buildExtensionPageRule, buildExtensionUntabbedRule, buildUnguardedTabRule, buildWorkerOriginRule, replaceSessionRule, CLOSING_TAB_RULE_ID, EXTENSION_PAGE_RULE_ID, EXTENSION_UNTABBED_RULE_ID, UNGUARDED_TAB_RULE_ID, WORKER_ORIGIN_RULE_ID } from './rules';
import { UnguardedTabs } from './unguarded';
import { ClosingTabs } from './closing-tabs';
import { guardsHost, isTargetHost } from './decision';
import * as dbg from './debugger';
import { S, attachmentOn, system } from './state';

/** Which URLs the debugger attaches to under this policy. */
export function scopeFor(p: Policy): (url: string) => boolean {
  return (url) => {
    if (!/^https?:/i.test(url)) return false;
    if (p.attachScope === 'all-tabs') return true;
    try { return guardsHost(p.effective, new URL(url).hostname); } catch { return false; }
  };
}

let workerRuleKey: string | null = null;
async function setWorkerOriginRule(rule: chrome.declarativeNetRequest.Rule | null): Promise<void> {
  const key = JSON.stringify(rule);
  if (key === workerRuleKey) return;
  try {
    await replaceSessionRule(WORKER_ORIGIN_RULE_ID, rule);
    S.workerOrigin = Boolean(rule);
    workerRuleKey = key;
  } catch (err) {
    S.workerOrigin = false;
    workerRuleKey = null;
    console.warn('[onlyread] worker-origin session rule failed:', err);
  }
}

/** Hosts whose worker requests are judged rather than fenced: every running worker of the host (and of its
 *  subdomains, which the rule's initiator match also covers) is one the debugger holds, and at least one of
 *  them intercepts. A worker woken with no guarded tab open (a push, a sync) is not held, so its host stays
 *  fenced. The targets list does not say which workers are dedicated ones, whose requests carry their tab
 *  and go through its interception; a `blob:` script is one (a service worker's script is a same-origin
 *  https URL), so those are left out. */
export function judgedWorkerHosts(targets: { type: string; url: string; id: string }[], intercepted: string[], held: Set<string>): string[] {
  const host = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };
  const covers = (h: string, w: string) => w === h || w.endsWith(`.${h}`);
  const workers = targets.filter((t) => (t.type === 'worker' || t.type === 'other') && /^https?:/.test(t.url));
  return intercepted.filter((h) => workers.every((w) => !covers(h, host(w.url)) || held.has(w.id)));
}

let workerRuleRun: Promise<void> = Promise.resolve();
/** Re-derive the worker-origin rule from the workers held now. Runs one at a time. */
export function refreshWorkerRule(): Promise<void> {
  workerRuleRun = workerRuleRun.then(async () => {
    if (!attachmentOn() || S.policy.mode !== 'enforce') return setWorkerOriginRule(null);
    const intercepted = dbg.interceptedWorkerHosts();
    const hosts = intercepted.length ? judgedWorkerHosts(await chrome.debugger.getTargets(), intercepted, dbg.heldTargetIds()) : [];
    S.workerHosts = hosts;
    await setWorkerOriginRule(buildWorkerOriginRule(S.policy, hosts));
  }).catch((err: unknown) => console.warn('[onlyread] worker rule refresh failed:', err));
  return workerRuleRun;
}

let extensionPageKey: string | null = null;
/** The extension-page rules (rules.ts buildExtensionPageRule for a page in a tab, buildExtensionUntabbedRule for the
 *  popup) while enforcing and attached, none otherwise. Like the other write rules, they live only while protection is
 *  attached: dormant, nothing is refused. */
async function refreshExtensionPageRule(): Promise<void> {
  const on = attachmentOn() && S.policy.mode === 'enforce';
  const rule = on ? buildExtensionPageRule(S.policy) : null;
  const untabbed = on ? buildExtensionUntabbedRule(S.policy) : null;
  const key = JSON.stringify([rule, untabbed]);
  if (key === extensionPageKey) return;
  try {
    await replaceSessionRule(EXTENSION_PAGE_RULE_ID, rule);
    await replaceSessionRule(EXTENSION_UNTABBED_RULE_ID, untabbed);
    S.extensionPageRule = Boolean(rule && untabbed);
    extensionPageKey = key;
  } catch (err) {
    extensionPageKey = null;
    console.warn('[onlyread] extension-page session rule failed:', err);
  }
}

export async function refreshRules(): Promise<void> {
  await refreshAccountLock();
  await refreshExtensionPageRule();
  // Dormant (agent-session mode, no active session): install no rules, so normal browsing is untouched.
  if (!attachmentOn()) {
    S.ruleReasons = new Map();
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id) });
    await refreshWorkerRule();
    return;
  }
  S.ruleReasons = (await applyRules(S.policy, { failClosed: S.failClosed })).reasons;
  await refreshWorkerRule();
}

// Guarded tabs whose page is closing: their last writes leave after the debugger session ends (closing-tabs.ts).
export const closing = new ClosingTabs({
  ruleFor: (ids) => (attachmentOn() && S.policy.mode === 'enforce' ? buildUnguardedTabRule(S.policy, ids, CLOSING_TAB_RULE_ID) : null),
  install: (rule) => replaceSessionRule(CLOSING_TAB_RULE_ID, rule),
});

// Guarded tabs the debugger does not hold. The global fail-closed rule is lifted only once the per-tab
// rule is installed; until then the retry keeps re-sending it and lifts it after.
export const unguarded = new UnguardedTabs({
  ruleFor: (ids) => (attachmentOn() && S.policy.mode === 'enforce' ? buildUnguardedTabRule(S.policy, ids) : null),
  install: (rule) => replaceSessionRule(UNGUARDED_TAB_RULE_ID, rule),
  reattach: (tabId) => reattachUnheld(tabId),
  setGlobalBlock: async (on) => {
    const next = on && S.policy.mode === 'enforce' && attachmentOn();
    if (next === S.failClosed) return;
    S.failClosed = next;
    await refreshRules();
  },
  log: (msg) => system(msg),
});

/** Attach to every guarded tab. The ones that fail stay blocked by their own rule, and the global block
 *  (on when `globalOn`) is lifted only once that rule is installed.
 *  Each tab waits for its own attach only: before attaching, every guarded tab not held yet goes under the per-tab rule
 *  and the global block is lifted once that rule is in, and a tab leaves the rule the moment it is held (onHeld). Lifted
 *  only after the last attach, one slow tab (a CDP command timing out) kept every guarded site refusing writes and
 *  reads by POST alike for seconds: X's home timeline, opened among a dozen other tabs, came up empty. */
export async function holdGuardedTabs(globalOn: boolean): Promise<void> {
  if (globalOn) {
    const unheld = await dbg.unheldGuardedTabs();
    if (unheld.length) await unguarded.settle(unheld, true);
  }
  const r = await dbg.attachExisting();
  await unguarded.settle(r.failed, globalOn);
}

/** Whether a policy change must put the fail-closed rule in with the rules, before the tabs are attached, as startup
 *  (index.ts guardOpenTabs) and a session start (agent-session.ts) do: attachment turns on in enforce, the scope widens
 *  to every tab, or, under target-tabs, a domain is newly guarded (its tabs are not yet held). A change that keeps every
 *  held tab held (a mode switch, a site switched on under all-tabs) needs none: nothing is attached afresh. */
export function closesAttachGap(prev: Pick<Policy, 'attachScope' | 'effective'>, next: Pick<Policy, 'mode' | 'attachScope' | 'effective'>, wasAttached: boolean, attached: boolean): boolean {
  if (!attached || next.mode !== 'enforce') return false;
  if (!wasAttached) return true;
  if (next.attachScope === 'all-tabs') return prev.attachScope !== 'all-tabs';
  if (!prev.effective.guardAll && next.effective.guardAll) return true;
  const lower = (xs: string[] | undefined) => new Set((xs ?? []).map((d) => d.toLowerCase()));
  const was = lower(prev.effective.targetDomains);
  if (next.effective.targetDomains.some((d) => !was.has(d.toLowerCase()))) return true;
  // With everything guarded, a host leaving the allowed or exempt list is newly guarded too, though neither the listed
  // domains nor the switch moved: its open tabs are not yet held under target-tabs.
  if (!next.effective.guardAll) return false;
  const left = (key: 'excludeDomains' | 'exemptDomains') => { const now = lower(next.effective[key]); return [...lower(prev.effective[key])].some((d) => !now.has(d)); };
  return left('excludeDomains') || left('exemptDomains');
}

/** The unguarded-tab retry's attempt at one tab: held again, gone (closed, or no longer to be guarded), or still not
 *  held. A tab an agent look is letting go of and taking back is left to the look (debugger.ts foreignDebuggerOn): an
 *  attach in the middle of it would be taken for an agent's debugger, and the retry's change would be logged every
 *  few seconds while an agent works. */
export async function reattachUnheld(tabId: number): Promise<'held' | 'gone' | 'failed'> {
  if (dbg.lookingAt(tabId)) return 'failed';
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url || !attachmentOn() || !scopeFor(S.policy)(tab.url)) return 'gone';
  return (await dbg.attach(tabId, tab.url)) ? 'held' : 'failed';
}

/** A guarded tab held again (debugger.ts onHeld): the rule refusing its writes while it was not held is lifted now, not
 *  at the next five-second retry (a page that loads with POSTs, X's home timeline, failed in that window and stayed
 *  empty). Taken back by an agent look, the change is routine and not logged. */
export function liftHeldTab(tabId: number): void {
  if (unguarded.has(tabId)) void unguarded.remove([tabId], dbg.lookingAt(tabId));
}

export async function retryUnguarded(): Promise<void> {
  if (attachmentOn()) await unguarded.retry();
}

/** Should the content script lock rich-text editors on this host right now? Only while actually
 *  enforcing and attached, and only for sites that opted in (editorGuardDomains). */
export function editorGuardFor(host: string): boolean {
  // guardsHost too: an allowed host under a site guard every site profiles stays unguarded, editors included.
  return attachmentOn() && S.policy.mode === 'enforce' && guardsHost(S.policy.effective, host) && isTargetHost(host, S.policy.effective.editorGuardDomains);
}

export interface GuardConfig {
  /** A guarded site while protection is attached: the content script reports clicks and typed secrets. */
  guarded: boolean;
  editorGuard: boolean;
  holdClose: boolean;
  /** File inputs are disabled: a guarded site, attached, enforcing, with uploads off. */
  uploadsOff: boolean;
}

/** What the content script on this host does: report the agent's actions and typed secrets (guarded sites only,
 *  so nothing is sent from anywhere else), lock the editors, hold back the page's own close handlers
 *  (closing-tabs.ts) while writes to it are refused, and disable file inputs. Monitor mode refuses nothing, uploads
 *  included: a read pass needs the upload request sent so it can be labeled. */
export function guardConfig(host: string): GuardConfig {
  const guarded = attachmentOn() && guardsHost(S.policy.effective, host);
  const enforcing = guarded && S.policy.mode === 'enforce';
  return { guarded, editorGuard: editorGuardFor(host), holdClose: enforcing, uploadsOff: enforcing && !S.policy.uploads };
}

const webHost = (url: string): string => { try { return /^https?:/i.test(url) ? new URL(url).hostname : ''; } catch { return ''; } };

/** A tab's http(s) frames with their hosts, top page first; the top page alone when the frames cannot be listed. */
async function webFrames(tabId: number, topUrl: string): Promise<{ frameId?: number; host: string }[]> {
  try {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
    const out = frames.map((f) => ({ frameId: f.frameId, host: webHost(f.url) })).filter((f) => f.host).sort((a, b) => (a.frameId ?? 0) - (b.frameId ?? 0));
    if (out.length) return out;
  } catch { /* the tab is gone, or its frames cannot be listed */ }
  const host = webHost(topUrl);
  return host ? [{ host }] : [];
}

/** Push the current content-script answer to every web frame (policy or session changed), each for its own host, as
 *  the frame's own `guard:config` ask is answered (messages.ts). Pushed the top page's answer instead, an iframe of another origin in a guarded page would have its
 *  file inputs disabled and its editors locked for a host the background ignores, and a guarded site's iframe in an
 *  unguarded page would lose its guard until it reloaded. */
export async function broadcastEditorGuard(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => [] as chrome.tabs.Tab[]);
  for (const t of tabs) {
    if (t.id === undefined || !t.url) continue;
    for (const f of await webFrames(t.id, t.url)) {
      const msg = { type: 'onlyread:config', ...guardConfig(f.host) } satisfies Message;
      chrome.tabs.sendMessage(t.id, msg, f.frameId === undefined ? {} : { frameId: f.frameId }).catch(() => { /* no content script */ });
    }
  }
}
