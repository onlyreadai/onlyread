// The request path: every paused request on a guarded tab is decided here, refusals are recorded and shown,
// DNR-layer blocks are logged from webRequest, and a lost debugger session is covered until it is back.
import { Repeats } from './repeats';
import type { AuditEntry, Message, Policy, RequestRecord } from '../shared/types';
import { backgroundHosts, dnrReasonFor } from './rules';
import { detachNeedsCover } from './unguarded';
import { type Decision, decide, guardsHost, isTargetHost } from './decision';
import { guardedSiteName } from './sites';
import { RecoveryScheduler, recoveryFor } from './recovery';
import { guardStarting, guardedChannel } from './socket-guard';
import * as audit from './audit';
import * as cache from './cache';
import * as dbg from './debugger';
import * as sink from './sink';
import { closing, unguarded } from './guard';
import { S, attachmentOn, hostOf, system } from './state';
import { devBuild } from './policy';
import { proRefusalText } from './pro-refusal';
import { retryKey } from '../shared/refusals';
import { resendBody } from './codecs/index';
import { pathTemplate } from './fingerprint';
import { demoRefusal, foldsIntoDemo } from './demo';

// Recovery after a refused mutation (policy.onRefusedMutation). Deps are the real chrome calls;
// the sequencing and debounce live in the (unit-tested) scheduler.
const recovery = new RecoveryScheduler({
  reload: (tabId) => chrome.tabs.reload(tabId).catch(() => {}),
  clearOrigin: async (tabId) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab?.url) return;
    let origin: string;
    try { origin = new URL(tab.url).origin; } catch { return; }
    // The tab has a debugger session attached, so CDP can clear its storage directly.
    await chrome.debugger.sendCommand({ tabId }, 'Storage.clearDataForOrigin', {
      origin, storageTypes: 'indexeddb,cache_storage,service_workers',
    });
  },
  log: (tabId, msg) => system(msg, tabId),
});

/** Exact repeats answered from the judges' earlier answer (repeats.ts). Cleared when the judges change. */
export const repeats = new Repeats();

/** The refused request for the notice's Copy requests: development builds only (a release's notice never carries an
 *  address). */
const devRequest = (method: string, url: string) => (devBuild() ? `${method} ${url}` : undefined);

/** A closed tab: its pending recovery is cancelled (it would reload a tab that is gone) and its history forgotten. */
export function forgetRecovery(tabId: number): void { recovery.cancel(tabId); }

/** Names the change a refused request makes: its method, address and body, with what only marks a site's resend of it
 *  taken out (Codec.resend), so the resend counts as the same change. */
function changeKey(rec: RequestRecord): string {
  const body = rec.bodyFull ?? rec.bodyPreview ?? '';
  return retryKey(rec.method, rec.url, body && resendBody(rec.host, pathTemplate(rec.path), body));
}

/** A refusal enforced in a tab: the in-page notice, recovery of the app's queue, and the first-run demo's check. */
function tellTab(rec: RequestRecord, d: Decision, policy: Policy, key: string): void {
  // In-page notice so a person testing (or an agent reading the page) can tell a policy refusal from a network error;
  // not for the follow-ups of the demo's own write, which its notice already shows (demo.ts foldsIntoDemo).
  if (!foldsIntoDemo(rec.host)) chrome.tabs.sendMessage(rec.tabId, { type: 'onlyread:blocked', shape: rec.bodyShape, reason: d.reason, path: rec.path, site: guardedSiteName(policy, rec.host), request: devRequest(rec.method, rec.url), explain: d.reason.startsWith('judge-error:cloud:') ? proRefusalText() : undefined, sig: key } satisfies Message).catch(() => { /* no content script in this frame */ });
  // Recover the tab if configured: a refused write otherwise wedges the app's mutation queue.
  recovery.schedule(rec.tabId, recoveryFor(policy, true));
  void demoRefusal(rec.tabId, rec.host, { url: rec.url, shape: rec.bodyShape, body: rec.bodyFull ?? rec.bodyPreview }, d.reason); // the first-run demo's write (demo.ts)
}

export async function onPaused(rec: RequestRecord): Promise<dbg.Disposition> {
  const { policy } = S;
  if (!guardsHost(policy.effective, rec.host)) return 'continue';
  // An armed tab's guarded channel was decided in the page, request by request, before it was encrypted; while a
  // worker of the tab is still getting its guard, the channel is refused, unread and unjudged.
  const starting = guardStarting(rec);
  const d = guardedChannel(rec)
    ? { verdict: 'allow' as const, action: 'continue' as const, source: 'rule' as const, reason: 'socket-guarded' }
    : starting
      ? { verdict: 'block' as const, action: 'fail' as const, source: 'rule' as const, reason: 'socket-guard-starting' }
      : await decide(rec, { policy, judge: S.judge, cache, reviewJudge: S.reviewJudge, repeats });
  const enforced = policy.mode === 'enforce' && d.action === 'fail';
  const entry: AuditEntry = {
    kind: 'decision', ts: rec.ts, tabId: rec.tabId, method: rec.method, url: rec.url, resourceType: rec.resourceType,
    verdict: d.verdict, source: d.source, reason: d.reason, mode: policy.mode, enforced,
    pWrite: d.pWrite, latencyMs: d.latencyMs, judgeModel: d.judgeModel, judgeReason: d.judgeReason,
    fingerprint: rec.fingerprint, requestId: rec.requestId,
    contentType: rec.contentType, bodyShape: rec.bodyShape, bodyPreview: rec.bodyPreview,
    retryKey: d.verdict === 'block' ? changeKey(rec) : undefined,
    lastUiActions: rec.lastUiActions.length ? rec.lastUiActions : undefined,
  };
  void audit.record(entry);
  if (enforced && rec.tabId >= 0 && !starting) tellTab(rec, d, policy, entry.retryKey ?? changeKey(rec));
  // The dev sink (measurement only) also gets the full body when the preview was truncated, so opaque
  // payloads (Google's f.req) can be decoded offline. The persisted audit keeps the 2 KB preview.
  sink.send('decision', rec.bodyFull ? { ...entry, bodyFull: rec.bodyFull } : entry);
  if (!enforced) return 'continue';
  // Per-site block delivery: a host in rejectDomains answers with a rollback-triggering refusal so a
  // sync engine drops the optimistic change instead of queuing it offline; everything else drops the request.
  return isTargetHost(rec.host, policy.effective.rejectDomains) ? 'reject' : 'fail';
}

/** A stanza the socket guard refused (or, in monitor mode, would have): logged and shown like a refused request. The
 *  guard decided it in the page (socket-guard.ts); there is no request to answer. */
export function onSocketRefusal(tabId: number, url: string, shape: string, enforced: boolean): void {
  const { policy } = S;
  const host = hostOf(url);
  const entry: AuditEntry = {
    kind: 'decision', ts: Date.now(), tabId, method: 'WS', url: `wss://${host}/ws/chat`, resourceType: 'websocket',
    verdict: 'block', source: 'rule', reason: 'decoded-write', mode: policy.mode, enforced,
    fingerprint: `WS ${host}/ws/chat ${shape}`, bodyShape: shape,
  };
  void audit.record(entry);
  sink.send('decision', entry);
  if (enforced && tabId >= 0) {
    if (!foldsIntoDemo(host)) chrome.tabs.sendMessage(tabId, { type: 'onlyread:blocked', shape, reason: 'decoded-write', path: '/ws/chat', site: guardedSiteName(policy, host), request: devRequest('WS', entry.url) } satisfies Message).catch(() => { /* no content script in this frame */ });
    void demoRefusal(tabId, host, { url: entry.url, shape }, 'decoded-write');
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The decision path threw before a decision (a URL that does not parse, a redactor on an odd body, the cache
 *  layer). Monitor mode's contract is to decide and log, never to fail a request, so there the request continues
 *  and the log says why; enforce fails closed, and logs it too. */
export function onDecisionError(tabId: number, p: dbg.PausedParams, err: unknown): dbg.Disposition {
  const { policy } = S;
  const enforced = policy.mode === 'enforce';
  console.warn(`[onlyread] decision threw; ${enforced ? 'failing closed' : 'monitor mode, continuing'}:`, err);
  const entry: AuditEntry = {
    kind: 'decision', ts: Date.now(), tabId, method: p.request.method, url: p.request.url, resourceType: p.resourceType,
    verdict: 'block', source: 'rule', reason: `decision-error:${errorText(err).slice(0, 160)}`, mode: policy.mode, enforced,
    requestId: p.requestId,
  };
  void audit.record(entry);
  sink.send('decision', entry);
  return enforced ? 'fail' : 'continue';
}

const CLIENT_BLOCK = /ERR_BLOCKED_BY_CLIENT|BlockedByClient/i;

/** The extension's origin as a request's initiator: the background (no tab) or one of its pages (a tab). The background's
 *  own requests (its judge, Pro, the dev sink) are never a page's refusal; in a development build the dev sink's refused
 *  POST would otherwise be logged and sent to the sink again, each refusal breeding the next. A
 *  page's is logged: a driven settings page writing to a guarded host. */
function ownInitiator(initiator: string | undefined): boolean {
  if (!initiator) return false;
  try { return initiator.startsWith(sink.ownOrigin()); } catch { return false; }
}

/**
 * Log DNR-layer blocks. onRuleMatchedDebug fires only for unpacked extensions, so in a packed build
 * DNR blocks would be invisible. webRequest fires everywhere: a DNR block surfaces here as
 * ERR_BLOCKED_BY_CLIENT. We record it as a `dnr` decision when one of our own rules actually matches (so an
 * ad blocker's block on a target host is not misattributed to us). This is the path that captures the
 * unattached-tab blind spots — startup, a fresh origin's first navigation, a detached debugger — where DNR is
 * the sole guard. A request the debugger refused is never seen twice: the DNR rules apply before the Fetch pause,
 * so the two layers never both refuse one request. No dedup by id is needed (or possible: the debugger's refusals
 * carry the Fetch interception id, webRequest its own).
 */
/** A refused request of OnlyRead's own with no tab is the popup's when the untabbed extension-page rule is installed
 *  and the host is none of the background's services (rules.ts buildExtensionUntabbedRule). The
 *  background's own are never logged: the dev sink would feed its own refusals back. */
function popupRefusal(url: string, ownHosts: string[]): boolean {
  const host = hostOf(url);
  return S.extensionPageRule && !ownHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

interface WebRequestError { requestId: string; url: string; method: string; tabId: number; type: string; error: string; initiator?: string }
export function onWebRequestError(d: WebRequestError): void {
  const { policy } = S;
  if (!CLIENT_BLOCK.test(d.error)) return;
  const own = ownInitiator(d.initiator);
  const ownHosts = backgroundHosts(policy);
  if (own && d.tabId < 0 && !popupRefusal(d.url, ownHosts)) return;
  if (!guardsHost(policy.effective, hostOf(d.url))) return;
  const reason = dnrReasonFor(d.method, d.url, d.type, policy.effective, { failClosed: S.failClosed, websockets: policy.websockets, workerOrigin: S.workerOrigin, workerHosts: S.workerHosts, initiator: d.initiator, tabId: d.tabId, unguardedTabs: unguarded.tabs(), closingTabs: closing.list(), extensionPage: own && S.extensionPageRule, ownHosts });
  if (!reason) return; // not one of our rules — someone else blocked it
  const entry: AuditEntry = {
    kind: 'decision', ts: Date.now(), tabId: d.tabId, method: d.method, url: d.url, resourceType: d.type,
    verdict: 'block', source: 'dnr', reason, mode: policy.mode, enforced: true,
    requestId: d.requestId, retryKey: retryKey(d.method, d.url),
  };
  void audit.record(entry);
  sink.send('decision', entry);
  // The page is told as it is for the debugger's refusals: a PUT, PATCH or DELETE (LinkedIn's settings save its
  // language by PUT) never reaches the debugger, and without the notice the page's own error looked like a network
  // fault. Only the rules that refuse a write by what it is; the cover rules (a tab the debugger does not hold yet, a
  // closing tab, fail-closed) refuse reads too, and a closed live connection is reopened every second or two.
  const host = hostOf(d.url);
  if (dnrNotice(d.tabId, reason) && !foldsIntoDemo(host)) {
    chrome.tabs.sendMessage(d.tabId, { type: 'onlyread:blocked', shape: '', reason, path: pathOf(d.url), site: guardedSiteName(policy, host), request: devRequest(d.method, d.url), sig: entry.retryKey } satisfies Message).catch(() => { /* no content script in this frame */ });
    recovery.schedule(d.tabId, recoveryFor(policy, true));
  }
}

/** Whether a DNR-layer refusal gets the in-page notice: a tab's write refused by what it is (dnrReasonFor). */
export const dnrNotice = (tabId: number, reason: string): boolean =>
  tabId >= 0 && (reason === 'mutating-method' || reason === 'post-navigation' || reason.startsWith('blocked-get-path'));

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

export function onDetach(tabId: number, reason: string): void {
  system(`debugger-detached:${reason}`, tabId);
  // A closed tab, or dormant agent-session mode (a detach is expected): nothing to cover or reattach.
  if (!detachNeedsCover(reason, attachmentOn())) return;
  // This tab alone loses interception: block its writes by rule (not every guarded site), and lift that
  // only when this same tab is held again (a different tab reattaching proves nothing about this one).
  void unguarded.lost(tabId);
  // Any loss, Cancel on Chrome's infobar included: reattach once the tab settles, and the 5-second retry keeps
  // trying after that. A Cancel detaches every held tab at once, and leaving them fenced until they navigate
  // would leave every guarded tab half-working; protection holds and the bar comes back, so a person who wants it gone
  // switches protection off or to agent sessions, where a Cancel with no agent at work ends the session instead.
  setTimeout(async () => {
    if (!attachmentOn()) return; // the session the Cancel ended (agent-session.ts onBannerCancel) took its rules with it
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab?.url) { void unguarded.remove([tabId]); return; }
    const ok = await dbg.attach(tabId, tab.url);
    system(ok ? 'debugger-reattached' : 'debugger-reattach-failed', tabId);
    if (ok) void unguarded.remove([tabId]);
  }, 1000);
}
