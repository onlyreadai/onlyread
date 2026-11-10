// The service worker's entry point: startup, policy changes and the top-level event listeners. The work
// itself lives in the modules it wires together (state, guard, interception, agent-session, messages, …).
import type { Message, Policy } from '../shared/types';
import { shouldPromptForKey } from './setup';
import { carryManaged, devServiceMove, getPolicy, lastWrittenPolicy, onPolicyChange, policyAccepted, setPolicy } from './policy';
import { tabsToReloadOnModeChange } from './recovery';
import * as audit from './audit';
import * as cache from './cache';
import * as observer from './observer';
import * as dbg from './debugger';
import * as uiactions from './uiactions';
import * as typedSecrets from './typed-secrets';
import * as sink from './sink';
import * as control from './control';
import { S, attachmentOn, getSecrets, hostOf, system } from './state';
import { selectJudges } from './judges';
import { broadcastEditorGuard, closesAttachGap, closing, holdGuardedTabs, liftHeldTab, refreshWorkerRule, refreshRules, retryUnguarded, scopeFor, unguarded } from './guard';
import { readDemo } from './demo';
import { markAgentTab, onBannerCancel, readAgentSession, syncAgentWatch, updateAgentSession, withAgentLock } from './agent-session';
import { forgetRecovery, onDecisionError, onDetach, onPaused, onSocketRefusal, onWebRequestError, repeats } from './interception';
import * as socketGuard from './socket-guard';
import * as sharedWorkers from './shared-workers';
import { assumeJudge, demoTabClosed, expireDemo, handle, importSiteVerdicts, judgeMissing, offWithoutJudge, openSetupWindow, putBackOutsideWrite, refusedStorageChange, restoreSiteVerdicts, settleMode } from './messages';
import { beginOutsideCheck, onOwnedChange } from './owned-storage';
import { isGuardedKey } from './protection';
import { MANAGED_POLL_TICK_MS, initManagedSync, managedPollDue, syncManagedSites } from './cloud-sync';
import { INSTALLED_KEY, reloadServicePages } from './agent-setup';
import { loadAgentBrowser, releaseAgentBrowser } from './agent-browser';
import { cloudSignOut, refreshUninstallUrl } from './cloud-session';
import { loadLockState } from './lock-state';
import { unstartedRefusal } from './startup-gate';
import { profiledSites } from './sites';
import { initDevControl } from './dev-control';
import { startDevReload } from './dev-reload';
import { messageAllowed } from './protection';
import { guardsHost } from './decision';
import { health, restoreHealth } from './storage-health';
import { ensurePush, onPush, pushActive } from './cloud-push';

// The dev sink, the control channel and its handlers (secrets, policy, experiments) exist only in development
// builds: scripts/build.mjs defines the flag as a literal, so esbuild drops every `if (!__ONLYREAD_DIST__)`
// branch, and the code only they reach, from a release. (A `const` alias of the flag is not folded; keep it inline.)
declare const __ONLYREAD_DIST__: boolean;

setInterval(() => void retryUnguarded(), 5000);
// The Pro account's site list (cloud-sync.ts): asked for every half hour while Web Push reaches this browser, every
// five minutes when it does not (managedPollDue), once a startup has read the policy.
initManagedSync({ whenReady: () => startedOnce });
setInterval(() => void pushActive().then((pushing) => { if (managedPollDue(pushing)) void syncManagedSites('poll'); }), MANAGED_POLL_TICK_MS);
// A worker can start that no guarded tab holds (a push, a sync): while any worker is judged rather than fenced,
// look again often, so such a worker's host goes back behind the rule.
setInterval(() => { if (S.workerHosts.length) void refreshWorkerRule(); }, 1000);
// A SharedWorker of a guarded site holds a connection no tab's session sees and no rule refuses: while enforcing, close
// any that runs (shared-workers.ts).
setInterval(() => {
  if (attachmentOn() && S.policy.mode === 'enforce' && (S.policy.effective.targetDomains.length || S.policy.effective.guardAll)) void sharedWorkers.sweep(S.policy.effective, dbg.heldTargetIds(), dbg.attachedTabs(), guardLog, dbg.command);
}, 2000);
// Web Push from OnlyRead Pro (cloud-push.ts): a push wakes this worker and the account's lists are asked for now; the
// push service replacing the subscription registers the new one. Registered at the top level, as every listener here.
type WaitUntil = Event & { waitUntil(p: Promise<unknown>): void };
self.addEventListener('push', (e) => (e as WaitUntil).waitUntil(onPush()));
self.addEventListener('pushsubscriptionchange', (e) => (e as WaitUntil).waitUntil(ensurePush('subscription-changed', true)));
chrome.tabs.onRemoved.addListener((tabId) => {
  if (unguarded.has(tabId)) void unguarded.remove([tabId]);
  void demoTabClosed(tabId); // the demo's tab closed: the demo is skipped
  uiactions.forget(tabId); // a closed tab's recent clicks are never needed again
  typedSecrets.forget(tabId);
  closing.removed(tabId);
  forgetRecovery(tabId);
});
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) void closing.committed(d.tabId); });
// A held tab that navigates to a stanza-guarded site (under all-tabs, it was held for another host) gets its guard.
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) socketGuard.committed(d.tabId, d.url, dbg.holds(d.tabId), dbg.command, guardLog); });

// MV3: event listeners must be registered synchronously at the top level, or a
// worker woken by an event misses it. They read the policy through S, so
// they are correct before and after the async startup below finishes.
observer.init(S.policy, () => attachmentOn());
const guardLog = (tabId: number, msg: string) => system(msg, tabId);
dbg.init({
  onPaused,
  onDetach: (tabId, reason) => { onDetach(tabId, reason); if (reason === 'canceled_by_user') onBannerCancel(); },
  onAttach: (tabId) => system('debugger-attached', tabId),
  onAttachFailed: (tabId) => { system('debugger-attach-failed', tabId); void unguarded.lost(tabId); },
  log: (tabId, msg) => system(msg, tabId),
  onWorkersChanged: () => void refreshWorkerRule(),
  onForeignDebugger: (tabId) => void markAgentTab(tabId),
  shouldAttach: (url) => attachmentOn() && scopeFor(S.policy)(url),
  // With attachScope all-tabs every tab is held: a request to any other host continues before its body is read.
  shouldJudge: (url) => guardsHost(S.policy.effective, hostOf(url)),
  onDecisionError,
  recentActions: (tabId) => uiactions.recent(tabId),
  onHeld: async (tabId, url) => {
    liftHeldTab(tabId); // its requests intercepted again: the rule refusing its writes goes now (guard.ts)
    await sharedWorkers.onTabHeld(tabId, S.policy.effective, dbg.command, guardLog);
    await socketGuard.onTabHeld(tabId, url, dbg.command, guardLog);
  },
  prepareWorker: (tabId, sessionId, url) => socketGuard.onWorker(tabId, sessionId, url, dbg.command, guardLog, (s) => dbg.contextReady(s)),
  workerStarting: (tabId, sessionId, url) => socketGuard.workerStarting(tabId, sessionId, url, dbg.command),
  workerScriptPrefix: socketGuard.workerScriptPrefix,
  onWorkerGone: socketGuard.onWorkerGone,
  onReleased: (tabId) => { sharedWorkers.onTabReleased(tabId); socketGuard.onTabReleased(tabId, guardLog); },
  onBinding: (tabId, name, payload, sessionId) => {
    if (sessionId && socketGuard.isReady(name, payload)) { socketGuard.onReady(sessionId); return; }
    const r = socketGuard.parseReport(name, payload);
    if (r) void chrome.tabs.get(tabId).then((t) => onSocketRefusal(tabId, t.url ?? '', r.shape, r.enforced)).catch(() => {});
  },
});
// chrome.debugger sessions die with the service worker; keep it alive while we hold any.
setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);

/** Verdicts saved under an older fingerprint format are dropped before anything is judged; the enabled
 *  verified sites' verdicts come back in the current format. */
/** A cache format change drops every stored verdict and imports the sites' labels again; otherwise any switched-on
 *  site's label that is missing (a cleared cache, an older install) is put back. */
async function reimportSiteVerdicts(): Promise<void> {
  if (await cache.ensureFormat()) {
    system(`cache-format:${cache.CACHE_FORMAT} old verdicts dropped, site verdicts re-imported:${await restoreSiteVerdicts(false)}`);
    return;
  }
  const n = await restoreSiteVerdicts(true);
  if (n) system(`site-verdicts-restored:${n}`);
}

/** Startup window: tabs already open are re-attached asynchronously. In enforce mode nothing non-GET may
 *  reach a target until that finishes. Skipped entirely when dormant (agent-session mode, no active
 *  session): stay detached, install no rules. */
async function guardOpenTabs(): Promise<void> {
  S.failClosed = S.policy.mode === 'enforce' && attachmentOn();
  await refreshRules();
  // The global block is lifted only once each guarded tab is either held or blocked on its own.
  if (attachmentOn()) await holdGuardedTabs(S.failClosed);
}

let starting: Promise<void> | null = null;
/** Startup finished once in this worker: a later onInstalled or onStartup has nothing to do. A
 *  startup that threw leaves this false, so the next trigger tries again. */
let started = false;
/** Resolves once a startup has finished. A startup that threw leaves it waiting for the next attempt: `starting` is null
 *  then too, so the next poll cannot lay the Pro account's list over the module defaults with no stored policy read. */
let markStarted = (): void => {};
const startedOnce = new Promise<void>((resolve) => { markStarted = resolve; });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Set once a production development build moved the stored local mock address to the real service (start). */
const DEV_SERVICE_MOVED = 'devServiceMoved';

function start(): Promise<void> {
  // onInstalled, onStartup and the top-level call can all fire together; run once.
  if (started) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    try {
      await restoreHealth();
      S.policy = await getPolicy();
      await readAgentSession();
      await readDemo(); // a first-run demo running when the worker stopped (demo.ts)
      await loadAgentBrowser(); // an agent's browser stays locked across restarts (agent-browser.ts)
      await loadLockState().catch(() => {}); // the PIN and wrong-PIN count the lock reads (lock-state.ts)
      await selectJudges(S.policy);
      void judgeMissing(); // a judge at work writes the first-judge record (messages.ts noteJudgeWorked)
      // No AI judge, no protection, whatever left it on with none while the worker was away. Not awaited: its write is
      // a policy change, applied after startup.
      void offWithoutJudge();
      void refreshUninstallUrl(); // removing OnlyRead signs this browser out of Pro (cloud-session.ts uninstallUrl)
      if (!__ONLYREAD_DIST__) { sink.configure(S.policy.devSink); control.configure(S.policy.devSink); }
      observer.updatePolicy(S.policy);
      // The sites' labels before the guard is up, so the first requests are not judged for want of them. Best
      // effort: a failed cache write here is reported in status and the guard still comes up, rather than ending
      // startup with no rules, no attachment and no agent polling.
      try { await reimportSiteVerdicts(); health.verdicts = undefined; } catch (err) { health.verdicts = errorText(err).slice(0, 160); console.warn('[onlyread] site verdicts not restored:', err); }
      await guardOpenTabs();
      syncAgentWatch();
      console.log(`[onlyread] mode=${S.policy.mode} judge=${S.judge.name} rules=${S.ruleReasons.size} attached=${dbg.attachedTabs().length} domains=${S.policy.effective.targetDomains.join(',')}`);
      started = true;
      markStarted();
      void syncManagedSites('startup');
      void settleMode('startup'); // one mode at a time: an install from before may have mixed them
      void ensurePush('startup'); // signed in: subscribed to the account's pushes (cheap when already done)
      void expireDemo(); // a demo the stopped worker left running ends once its time is up (demo.ts)
      // A stored policy that was repaired (getPolicy) is written back, so the invalid copy does not survive to the
      // next start; the notice about the repair stays until the person changes a setting. After the guard is up,
      // so the policy-change handler this write triggers (it runs once more, as for any own write: judges, rules,
      // attachment, all idempotent for an unchanged policy) does not overlap guardOpenTabs. A policy broken in more
      // than one way is not written back: the defaults are in use, and the invalid copy stays until a settings change.
      if (health.policyRepaired) await setPolicy(S.policy, { keepReport: true }).catch((err) => console.warn('[onlyread] repaired policy not written back:', err));
    } catch (err) {
      health.startup = errorText(err).slice(0, 160);
      console.error('[onlyread] startup failed:', err);
    } finally {
      starting = null;
    }
  })();
  return starting;
}

audit.clearBadge();
if (!__ONLYREAD_DIST__) void control.currentInstance().then((id) => sink.setInstance(id));

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.storage.local.set({ [INSTALLED_KEY]: Date.now() }).catch(() => {});
    // A fresh install starts with no activity: whatever an earlier copy of OnlyRead left in this profile (Chrome clears
    // an extension's storage when it is removed, but a copy loaded again under the same id was seen keeping its log)
    // is not this install's.
    void audit.clear().catch(() => {});
    void observer.clear().catch(() => {});
    // The agent-setup page that asked the person to install OnlyRead goes on by itself, and the account page's Browsers
    // list sees this browser: a page open before the install has no content script, so it is reloaded (agent-setup.ts
    // reloadServicePages).
    void start().then(() => reloadServicePages(S.policy.cloud.serviceUrl)).catch(() => {});
  }
  void start().then(async () => {
    // Ask for the AI key once, on a fresh install with no key stored. Updates and dev reloads never prompt.
    if (shouldPromptForKey(details.reason, await getSecrets())) {
      try { await openSetupWindow(); system('setup:prompted'); } catch (err) { console.warn('[onlyread] setup window failed:', err); }
    }
  });
});
chrome.runtime.onStartup.addListener(() => void start());
void start().then(moveDevService);

/** A development build made against production, finding the local mock's address from an earlier build: moved to the
 *  real service once (policy.ts devServiceMove), after startup; a later choice of service stands. */
async function moveDevService(): Promise<void> {
  if (__ONLYREAD_DIST__) return;
  const moved = Boolean((await chrome.storage.local.get(DEV_SERVICE_MOVED).catch(() => ({} as Record<string, unknown>)))[DEV_SERVICE_MOVED]);
  const to = devServiceMove(S.policy, moved);
  if (!to) return;
  await setPolicy({ ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: to } }).catch((err) => console.warn('[onlyread] dev service not moved:', err));
  await chrome.storage.local.set({ [DEV_SERVICE_MOVED]: true }).catch(() => {});
}

/** One policy change at a time, in order, and only after startup: a change written while start() reads the
 *  stored policy must not be overwritten by what it read (a policy landing during getPolicy would otherwise be
 *  replaced by the defaults start() had read, and the rules removed). */
let applying: Promise<void> = Promise.resolve();
function queueChange(work: () => Promise<void>): void {
  applying = applying.then(async () => { if (starting) await starting; await work(); }).catch((err) => console.warn('[onlyread] policy change failed:', err));
}

// The settings PIN, the judge's keys, the wrong-PIN count, the agent-browser mark, the Pro tokens, the setup's undo
// record and the first-judge record (protection.ts GUARDED_KEYS): a change the background did not write is checked
// against the lock like a policy
// written around it, and put back when it lowers protection while the lock holds (messages.ts putBackOutsideWrite).
// A new key on the options page takes effect without a reload once the change stands.
onOwnedChange((changes, own) => {
  if (!Object.keys(changes).some(isGuardedKey)) return;
  // Opened now, as the event arrives, so a settings message handled meanwhile waits for the verdict.
  const done = own ? () => {} : beginOutsideCheck();
  queueChange(async () => {
    try {
      if (!own && (await putBackOutsideWrite(changes))) return; // its own write's event re-selects the judges
      if (changes.secrets) { repeats.clear(); await selectJudges(S.policy); system(`judge-selected:${S.judge.name}`); }
      // A key removed, or the Pro sign-in dropped by a write from outside (no sign-out hook runs for that): with no judge
      // left, protection goes off.
      void offWithoutJudge();
    } finally { done(); }
  });
});

/** Built-in sites whose profile came to apply (switched on here, by the Pro account's list, or by guard every site)
 *  get their shipped labels, so their reads are not left to the judge. messages.ts setSite imports them too; this
 *  covers every other path. */
async function importGainedVerdicts(prev: Policy, p: Policy): Promise<void> {
  const was = new Set(profiledSites(prev).map((s) => s.id));
  // Together: guard every site gains every site at once, and tabs are held only after this.
  await Promise.all(profiledSites(p).map((s) => s.id).filter((x) => !was.has(x)).map(async (id) => {
    const n = await importSiteVerdicts(id, true).catch(() => 0);
    if (n) system(`site-verdicts-restored:${id}:${n}`);
  }));
}

/** A policy written to storage around the background (protection.ts) that lowers protection while the lock holds: the
 *  refusal and the policy that goes back. Measured from the policy in force, and what goes back is the policy as the
 *  background last wrote or accepted it (policy.ts lastWrittenPolicy): an own write still queued behind this change (the
 *  Pro account's list, say) is not written over by the one in force. A worker the write woke read it at startup
 *  (getPolicy), so the policy in force and the last written are the write itself and lower nothing: it is measured from
 *  the policy stored before it too, and that goes back. */
async function outsideRefusal(prev: Policy, p: Policy, old: Policy | undefined): Promise<{ message: string; putBack: Policy } | undefined> {
  const refused = await refusedStorageChange(prev, p);
  if (refused) return { message: refused, putBack: lastWrittenPolicy() ?? prev };
  const fromOld = old ? await refusedStorageChange(old, p) : undefined;
  return fromOld && old ? { message: fromOld, putBack: old } : undefined;
}

async function applyPolicy(p: Policy, own: boolean, old?: Policy): Promise<void> {
  const prev = S.policy;
  const refused = own ? undefined : await outsideRefusal(prev, p, old);
  if (refused) { system(`settings-locked:storage ${refused.message}`); await setPolicy(refused.putBack); return; }
  if (!own) policyAccepted(p); // the background builds on an accepted outside write from here
  const wasAttached = attachmentOn();
  S.policy = p;
  repeats.clear(); // an answer belongs to the policy and judges it was given under
  await selectJudges(p);
  void judgeMissing(); // as at startup: a judge now at work writes the first-judge record
  // Whatever the change was, protection is not left on with no AI judge to ask (an own-key provider with no key, a
  // write from outside turning it on). Not awaited: its write is another change, queued after this one.
  void offWithoutJudge();
  if (!__ONLYREAD_DIST__) { sink.configure(p.devSink); control.configure(p.devSink); }
  observer.updatePolicy(p);
  // A change that turns attachment on (protection switched on, Always with no session, a wider scope, a new guarded
  // domain under target-tabs) closes the gap the way startup and a session start do: the fail-closed rule goes in with
  // the rules and is lifted once the tabs are held (unguarded.settle). With the rules landing
  // first and the tabs attached after, a gray-zone POST sent in between (44 to 53 ms on the fixture) would go out
  // unjudged, while PUTs were already refused.
  if (closesAttachGap(prev, p, wasAttached, attachmentOn())) S.failClosed = true;
  await refreshRules();
  // A site switched on brings its labeled verdicts after its rules (the fail-closed block among them) and before its
  // tabs are held. Before the rules, the import left the site unguarded while it ran: a page opened at once sent its
  // writes through (CI's replay, all of Linear's). After the attach, the verdicts waited for the slowest tab, and the
  // site's first requests went to the judge meanwhile (X's paywall and live-updates calls, labeled telemetry and read).
  await importGainedVerdicts(prev, p);
  // Reconcile attachment with the (possibly changed) attachWhen: attach when active, detach when dormant.
  // A tab that cannot be held and cannot be fenced by its own rule falls back to the global block.
  if (attachmentOn()) await holdGuardedTabs(S.failClosed);
  else { await dbg.detachAll(); await unguarded.clear(); }
  void broadcastEditorGuard();
  await socketGuard.reconfigure(dbg.command, guardLog, dbg.attachedTabs());
  await sharedWorkers.reconfigure(p.effective, dbg.command, guardLog);
  syncAgentWatch();
  system(`policy-updated:mode=${p.mode}`);
  // A mode switch can leave a guarded tab's mutation pipeline half-configured; reload the guarded
  // tabs only (never the user's other open tabs, though the debugger attaches to those too).
  const reload = new Map<number, string>();
  if (prev.mode !== p.mode) {
    for (const tabId of tabsToReloadOnModeChange(prev, p, await tabUrls(dbg.attachedTabs()), p.effective.profileDomains)) reload.set(tabId, `mode-change-reload:${p.mode}`);
  }
  // A site whose pages carry the socket guard, switched off: its open pages reload without it. Every open tab of the
  // site, not only the ones this run armed: the guard may be in a page from before a restart of the background.
  const open = (await chrome.tabs.query({}).catch(() => [])).filter((t) => t.id !== undefined).map((t) => ({ id: t.id!, url: t.url }));
  for (const tabId of socketGuard.tabsToReloadOnGuardOff(prev, p, open)) reload.set(tabId, 'socket-guard-off-reload');
  for (const [tabId, why] of reload) {
    void chrome.tabs.reload(tabId).catch(() => {});
    system(why, tabId);
  }
}

const tabUrls = (ids: number[]) => Promise.all(ids.map(async (id) => ({ id, url: (await chrome.tabs.get(id).catch(() => undefined))?.url })));

onPolicyChange((p, own, old) => queueChange(() => applyPolicy(p, own, old)), (message) => queueChange(async () => {
  // An invalid policy written around the background: never legitimate, so the current one goes back; after
  // startup, like every change, so the revert never writes the defaults over the person's settings.
  system(`settings-locked:storage invalid policy (${message.slice(0, 120)})`);
  await setPolicy(lastWrittenPolicy() ?? S.policy).catch((err) => console.warn('[onlyread] policy not restored after an invalid write:', err));
}));

// DNR blocks are logged from webRequest (works in packed builds), not from the dev-only
// onRuleMatchedDebug. Registered synchronously at the top level like the other listeners.
chrome.webRequest.onErrorOccurred.addListener(onWebRequestError, { urls: ['<all_urls>'] });

// Dev-only evidence for channels webRequest never reports (WebTransport sessions): onRuleMatchedDebug exists
// only for unpacked extensions. Logged as system events so a dump shows which rule matched which channel.
const dnrDebug = (chrome.declarativeNetRequest as unknown as { onRuleMatchedDebug?: chrome.events.Event<(info: chrome.declarativeNetRequest.MatchedRuleInfoDebug) => void> }).onRuleMatchedDebug;
dnrDebug?.addListener((info) => {
  const r = info.request;
  if (r.type !== 'webtransport') return; // websocket matches are already visible through webRequest; WebTransport is not
  system(`dnr-match:${r.type}:${S.ruleReasons.get(info.rule.ruleId) ?? info.rule.ruleId}:${hostOf(r.url)}`, r.tabId);
});

// Test/debug hook (development builds): the service worker cannot message itself, so e2e reads status here.
const BORN = Date.now();
console.log(`[onlyread] worker start ${BORN}`);
if (!__ONLYREAD_DIST__) (globalThis as unknown as { __onlyread: unknown }).__onlyread = {
  status: () => handle({ type: 'status:get' }, {} as chrome.runtime.MessageSender),
  attached: () => dbg.attachedTabs(),
  /** A tab marked as not held, as a policy change marks one the debugger is still attaching to (e2e). */
  markUnguarded: (tabId: number) => unguarded.lost(tabId),
  born: () => BORN,
  // Tests set the policy as the background does (an own write), so the lock on outside writes does not apply. The
  // Pro account's list is carried as last written unless the patch sets it.
  setPolicy: (patch: Record<string, unknown>) => setPolicy('managed' in patch ? { ...S.policy, ...patch } : carryManaged({ ...S.policy, ...patch })),
  /** Resolves once startup has finished (or at once when it has). */
  ready: () => starting ?? Promise.resolve(),
  /** The pages show as with an AI judge set while the judge is still rules-only (messages.ts judgeMissing). */
  assumeJudge: (on: boolean) => assumeJudge(on),
  /** Sync now, without the settings page (e2e: the Pro account's site list). */
  syncManaged: () => syncManagedSites('test'),
  /** Signs out of Pro as the account page's release does (the mark cleared, then the tokens), as the background's own
   *  writes: a removal written around the background is put back in an agent's browser. */
  releaseForTest: async () => { await releaseAgentBrowser('test'); await cloudSignOut(); },
  /** Ends the agent session Playwright's own CDP session started, as the agent finishing would, so a suite can reach what
   *  the agent lock holds back (a lowering) with no agent at work. A page opened after it starts a new one. */
  endAgentSessionForTest: () => withAgentLock(async () => { S.declaredSession = false; S.agentTabs = new Set(); await updateAgentSession('test'); }),
};

if (!__ONLYREAD_DIST__) initDevControl();
// `npm run dev`: reloads by itself on every rebuild (dev-reload.ts).
if (!__ONLYREAD_DIST__) startDevReload();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  system('popup-opened');
  void syncManagedSites('popup-opened');
  port.onDisconnect.addListener(() => system('popup-closed'));
});

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  // Settings come only from OnlyRead's own pages; the content script (inside web pages) has its few messages.
  if (!messageAllowed(msg?.type, sender, { id: chrome.runtime.id, origin: chrome.runtime.getURL('') })) {
    system(`message-refused:${String(msg?.type).slice(0, 40)} from ${sender.url ? new URL(sender.url).origin : 'unknown'}`);
    sendResponse({ error: 'not allowed from this context' });
    return false;
  }
  // Nothing is handled before startup has read the stored policy; after a startup that failed, only reads
  // (startup-gate.ts).
  start()
    .then(() => {
      const refused = unstartedRefusal(msg?.type, started, health.startup);
      if (refused) throw new Error(refused);
      return handle(msg, sender);
    })
    .then(sendResponse, (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
  return true;
});
