// Messages from the popup, the options and setup pages and the content script.
import type { AccountEdit, Message, Policy, Status, SupportList } from '../shared/types';
import { writeConsent } from './consent';
import { afterDemoPolicy, beginDemo, demoExpired, demoPolicy, demoState, endDemo, onDemoSite, setDemoTab, whenDemoStops } from './demo';
import { DEMO_SITES, demoSite } from '../shared/demo-sites';
import { RELEASE_SERVICE_URL, carryManaged, devBuild, devMockServiceUrl, lastWrittenPolicy, normalizePolicy, setPolicy } from './policy';
import { guardsHost, isTargetHost } from './decision';
import { accountGuards, accountScopesOf, excludeHost, builtinForHost, builtinSite, hostToSiteId, isPublicSuffix, listSites, sitesInForce, validHost } from './sites';
import { discoverSite } from './site-discover';
import { nameFromHost } from '../shared/names';
import { PROVIDERS, isKeyId, isProviderId, keyFor, type ByokChoice } from '../shared/providers';
import { summarizeActivity } from './activity';
import * as audit from './audit';
import { buildReport, supportBurst, supportContext, supportItems } from './support';
import * as cache from './cache';
import * as dbg from './debugger';
import * as observer from './observer';
import * as uiactions from './uiactions';
import * as typedSecrets from './typed-secrets';
import { markAgentBrowser } from './agent-browser';
import { ensurePush } from './cloud-push';
import { cloudClient, cloudSignOut, cloudStatus, finishSignIn, whenSignedOut, setAgentName, signInFallback, signInWithSetupLink, startSignIn, pendingSignIn, takeSignIn } from './cloud-session';
import { browserNameOf, isAgentName } from '../shared/agent-setup';
import { signInBack, withSignInResult } from '../shared/sign-in-result';
import { accountBrowsers, accountRefusal, applyPendingManaged, flushAccountEdits, notifyAccountPages, pendingManaged, syncManagedSites, whenLockOpens } from './cloud-sync';
import { proManaged } from '../shared/cloud-ui';
import { CloudError, isSignInDonePage, isSignInLinkPage } from './judge/cloud';
import { selectJudges, testAnthropic, testRecord, tryByokJudge } from './judges';
import { closing, guardConfig } from './guard';
import { updateAgentSession, withAgentLock } from './agent-session';
import { S, agentAtWork, attachmentOn, enabledSiteIds, getSecrets, settingsLock, storedPin, system } from './state';
import { health, storageProblem } from './storage-health';
import { INSTALLED_KEY, SETUP_KEY, type SetupRecord, type SetupRequest, isAgentSetupPage, linkRequest, linkRunsByItself, liveRecord, mergeRecords, planAgentSetup, setupRefusals, setupRequest, undoSetup } from './agent-setup';
import { type GuardedKey, LOCKED_PREFIX, PIN_UNLOCK_MS, WEAKENING_ACTIONS, hashPin, isGuardedKey, lockFor, needsRehash, pinMatches, storageLowering, validPin, weakeningChanges } from './protection';
import { type StorageChanges, outsideWritesSettled, ownRemove, ownSet } from './owned-storage';
import { refreshAccountLock } from './account-lock';
import { type PinFailures, lockFailures, noteLockValue } from './lock-state';
import type { StoredPin } from './protection';
import { FIRST_JUDGE_KEY, markFirstJudge } from '../shared/first-judge';

// ---- The lock on lowering protection (protection.ts): every settings change and every clear goes through it.

/** Throws a refusal (LOCKED_PREFIX + reason + ':' + sentence) when these changes may not happen now.
 *  `pinEntered`: the request itself carried the right PIN. `agentMay`: changes an agent at work does not hold back
 *  (firstJudgeChanges, the demo's put-back); a settings PIN and an agent's browser still do. */
async function assertMayWeaken(changes: string[], pinEntered = false, agentMay = false): Promise<void> {
  await outsideWritesSettled(); // an outside write still being checked may be the PIN or the agent mark
  const l = await settingsLock();
  const refusal = lockFor(changes, { agentActive: l.agent && !agentMay, agentBrowser: l.agentBrowser, pinSet: l.pinSet, pinUnlocked: l.pinUnlocked || pinEntered });
  if (!refusal) return;
  system(`settings-locked:${refusal.reason} ${changes.join('; ')}`);
  throw new Error(`${LOCKED_PREFIX}${refusal.reason}:${refusal.message}`);
}

/** A policy written to storage without going through the background (another extension context, or a debugger
 *  driving the browser's own pages): the refusal when it lowers protection while that is locked. */
export async function refusedStorageChange(prev: Policy, next: Policy, agentMay = false): Promise<string | undefined> {
  const changes = weakeningChanges(prev, next);
  const l = await settingsLock();
  return lockFor(changes, { agentActive: l.agent && !agentMay, agentBrowser: l.agentBrowser, pinSet: l.pinSet, pinUnlocked: l.pinUnlocked })?.message;
}

// ---- Setting up the first AI judge while an agent works. With no judge, protection cannot be on (judgeMissing), so
// the first judge raises protection, yet any change of judge counts as lowering it: an agent at work would keep the
// person from turning OnlyRead on at all. So while no AI judge works in this browser and none ever has (the first-judge
// record, shared/first-judge.ts), choosing one (a Pro sign-in, a provider, its key) passes an agent at work. Once a
// judge works or has worked, the window is shut for good: changing it is a change of judge like any other, and
// removing the record from outside is put back while the lock holds (protection.ts GUARDED_KEYS).
const FIRST_JUDGE_CHANGES: ReadonlySet<string> = new Set(['change the AI judge', "replace the AI judge's key", "remove the AI judge's key"]);

/** True when these changes are all part of choosing the first AI judge, and that is still to happen. */
async function firstJudgeChanges(changes: string[]): Promise<boolean> {
  if (!changes.length || !changes.every((c) => FIRST_JUDGE_CHANGES.has(c))) return false;
  if (!(await judgeMissing())) return false;
  const got = (await chrome.storage.local.get(FIRST_JUDGE_KEY).catch(() => ({}))) as Record<string, unknown>;
  return !got[FIRST_JUDGE_KEY];
}

/** What the demo put back (demo.ts afterDemoPolicy) that an agent at work does not hold back: guarding only during agent
 *  sessions again, which, with an agent at work, guards just as "always" does. Its mode goes back through the lock. */
const DEMO_PUT_BACK = 'guard only during agent sessions';

/** A change to the settings PIN, the judge's keys, the wrong-PIN count, the agent-browser mark, the Pro tokens or the
 *  setup's undo record written around the background (protection.ts GUARDED_KEYS): what it lowers
 *  and the lock's refusal, or undefined when it lowers nothing or the lock lets it through. Each key is judged with the
 *  state as it was before the change: storage already holds the new value, so a removed PIN must not unlock its own
 *  removal, and a removed agent-browser mark must not release its own lock (a worker woken by that
 *  removal reads the mark already gone at startup, and the removal, and the tokens dropped with it, would stand). */
export async function refusedOutsideWrite(changes: StorageChanges): Promise<{ what: string[]; message: string; keys: GuardedKey[] } | undefined> {
  const keys = Object.keys(changes).filter(isGuardedKey);
  const mark = changes.agentBrowser;
  const agentBrowser = mark ? Boolean(mark.oldValue && typeof mark.oldValue === 'object') : S.agentBrowser;
  const what = keys.flatMap((k) => storageLowering(k, changes[k]!.oldValue, changes[k]!.newValue, { agentBrowser }) ?? []);
  if (!what.length) return undefined;
  const l = await settingsLock();
  const pin = changes.settingsPin;
  const pinSet = pin ? Boolean(pin.oldValue && typeof pin.oldValue === 'object') : l.pinSet;
  const refusal = lockFor(what, { agentActive: l.agent, agentBrowser, pinSet, pinUnlocked: l.pinUnlocked });
  return refusal ? { what, message: refusal.message, keys } : undefined;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Checks an outside write and, when the lock refuses it, puts the old values back as the background's own write (a key
 *  that was absent is removed again). A key the background has written since (a token refresh landing after the
 *  outside write) is left as it now is: its value is no longer the outside one. A put-back mark
 *  of an agent's browser takes effect at once. Returns the refusal, or undefined when the change stands. */
export async function putBackOutsideWrite(changes: StorageChanges): Promise<{ what: string[]; message: string; keys: GuardedKey[] } | undefined> {
  const refused = await refusedOutsideWrite(changes);
  const lockKeys = (['settingsPin', 'pinFailures'] as const).filter((k) => k in changes);
  // The lock's copy (lock-state.ts) takes an outside write only now that it stands.
  if (!refused) { for (const k of lockKeys) noteLockValue(k, changes[k]!.newValue); return undefined; }
  system(`settings-locked:storage ${refused.what.join('; ')}`);
  const now = await chrome.storage.local.get(refused.keys);
  const keys = refused.keys.filter((k) => sameValue(now[k], changes[k]!.newValue));
  const back = keys.filter((k) => changes[k]!.oldValue !== undefined);
  const gone = keys.filter((k) => changes[k]!.oldValue === undefined);
  if (back.length) await ownSet(Object.fromEntries(back.map((k) => [k, changes[k]!.oldValue])));
  if (gone.length) await ownRemove(...gone);
  // The copy holds what was put back; a key the background wrote since already noted its own value.
  for (const k of lockKeys) if (keys.includes(k)) noteLockValue(k, changes[k]!.oldValue);
  if (back.includes('agentBrowser')) { S.agentBrowser = true; await refreshAccountLock(); }
  return refused;
}

/** The policy to build a change on: the one last written, which S.policy holds only once storage reports it (a write
 *  a moment ago, the harness's or another handler's, would otherwise be written over with the copy before it). */
const latest = (): Policy => lastWrittenPolicy() ?? S.policy;

/** setPolicy, unless the new policy lowers protection while that is locked. Lowering is measured from the policy last
 *  written (latest), the one the change is built on: measured from S.policy, a site added a moment ago and switched off
 *  straight after would not count as removed. The Pro account's list is carried as last written (policy.ts
 *  carryManaged), since cloud-sync.ts may have written it a moment ago with its change event still queued. */
async function save(next: Policy, opts: { demoPutBack?: boolean } = {}): Promise<Policy> {
  const changes = weakeningChanges(latest(), normalizePolicy(next));
  const agentMay = opts.demoPutBack ? changes.every((c) => c === DEMO_PUT_BACK) : await firstJudgeChanges(changes);
  await assertMayWeaken(changes, false, agentMay);
  return setPolicy(carryManaged(next));
}

// Wrong PINs: after a few, each further try waits longer (30 s, doubling, at most an hour), so a 4-digit PIN cannot
// be guessed by trying them all. The count lives in storage.local (`pinFailures`), not in worker memory: a
// service-worker restart (an extension reload, a crash, Chrome reclaiming an idle worker) must not hand out a
// fresh budget of five. The lock reads it, and the PIN, through lock-state.ts: the larger of
// the background's own copy and storage, so a reset written around the background cannot skip the wait before its
// check has even run.
const PIN_FAILURES_KEY = 'pinFailures';
async function setPinFailures(next: PinFailures): Promise<void> {
  noteLockValue('pinFailures', next);
  try { await ownSet({ [PIN_FAILURES_KEY]: next }); } catch { /* the in-memory copy still counts */ }
}
/** Writes the PIN as the background's own write, and as the lock's copy. */
async function writePin(p: StoredPin | undefined): Promise<void> {
  if (p) await ownSet({ settingsPin: p }); else await ownRemove('settingsPin');
  noteLockValue('settingsPin', p);
}
/** One try of a PIN: `ok`, or `wait` (the text to show) while wrong PINs make it wait, or neither for a wrong PIN.
 *  Tries run one at a time (pinTries), each its wait check, its count and its comparison together: handled side by
 *  side, ten thousand tries sent at once would all pass the wait check before the first was counted, and their counts
 *  would write over each other. Each try is counted before its PIN is compared, so one cut short (a worker restart
 *  during the comparison, a throw, the time limit) has still used a try; a right PIN then clears the count. */
type PinTry = { ok: true } | { ok: false; wait?: string };
/** How long one try may take before the next is let run: a storage call that never answers must not hold up every
 *  try behind it. A try past it fails (it has been counted already) and does nothing more when it does finish. */
export const PIN_TRY_LIMIT_MS = 30_000;
let pinTries: Promise<unknown> = Promise.resolve();
function checkPin(pin: unknown): Promise<PinTry> {
  const run = () => withinLimit(pin);
  const next = pinTries.then(run, run);
  pinTries = next.catch(() => undefined); // a try that throws does not stop the next
  return next;
}
function withinLimit(pin: unknown): Promise<PinTry> {
  const late = { now: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<PinTry>((resolve) => { timer = setTimeout(() => { late.now = true; resolve({ ok: false }); }, PIN_TRY_LIMIT_MS); });
  return Promise.race([checkPinNow(pin, late), limit]).finally(() => clearTimeout(timer));
}
/** One try; `late.now` once it has run past PIN_TRY_LIMIT_MS, after which it stops at its next step: it neither counts
 *  beside a newer try nor, matching at last, clears the count. */
async function checkPinNow(pin: unknown, late: { now: boolean }): Promise<PinTry> {
  await outsideWritesSettled();
  const now = Date.now();
  const before = await lockFailures(now);
  if (late.now) return { ok: false };
  if (now < before.retryAt) return { ok: false, wait: `Too many wrong PINs. Try again in ${Math.ceil((before.retryAt - now) / 1000)} s.` };
  const count = before.count + 1;
  await setPinFailures({ count, retryAt: count >= 5 ? now + Math.min(2 ** (count - 5) * 30_000, 60 * 60_000) : 0 });
  const stored = await storedPin();
  if (!(await pinMatches(pin, stored)) || late.now) return { ok: false };
  await setPinFailures({ count: 0, retryAt: 0 });
  // A hash from before PBKDF2 (one SHA-256 round): replace it now that the PIN is known to be right.
  if (stored && needsRehash(stored) && validPin(pin)) await writePin(await hashPin(pin));
  return { ok: true };
}

/** The settings PIN: set (or change, with the current one), clear (with it), or unlock for a few minutes. */
async function setPin(msg: Of<'pin:set'>) {
  if (!validPin(msg.pin)) return { ok: false, error: 'A PIN is 4 to 12 digits.' };
  await outsideWritesSettled();
  const current = await storedPin();
  // An agent must not set a PIN the person does not know: they could then not lower protection themselves.
  if (!current && agentAtWork()) throw new Error(`${LOCKED_PREFIX}agent:An AI agent is active in this browser, so OnlyRead can't set a PIN until it finishes.`);
  const tried = current ? await checkPin(msg.current) : undefined;
  if (tried && !tried.ok) return { ok: false, error: tried.wait ?? 'The current PIN is not right.' };
  await writePin(await hashPin(msg.pin));
  system(current ? 'settings-pin:changed' : 'settings-pin:set');
  return { ok: true };
}
async function clearPin(msg: Of<'pin:clear'>) {
  const tried = await checkPin(msg.pin);
  if (!tried.ok) return { ok: false, error: tried.wait ?? 'That PIN is not right.' };
  await assertMayWeaken(['remove the settings PIN'], true); // the PIN was just given; an agent session still refuses
  await writePin(undefined);
  S.pinUnlockedUntil = 0;
  system('settings-pin:cleared');
  void applyPendingManaged('pin-removed'); // a change from the Pro account that waited for the PIN
  return { ok: true };
}
async function unlockPin(msg: Of<'pin:unlock'>) {
  const tried = await checkPin(msg.pin);
  if (!tried.ok) return { ok: false, error: tried.wait ?? 'That PIN is not right.' };
  S.pinUnlockedUntil = Date.now() + PIN_UNLOCK_MS;
  void applyPendingManaged('pin'); // a change from the Pro account that waited for the PIN
  return { ok: true, unlockedForMs: PIN_UNLOCK_MS };
}

/** Stores or removes the own-key judge's key for one provider, or Anthropic's for the review model. Adding a first key
 *  raises protection; replacing or removing one goes through the lock, so an agent cannot point the judge at an
 *  account it controls. */
async function setKey(msg: Of<'secrets:key'>) {
  if (!isKeyId(msg.provider)) return { ok: false, error: 'unknown provider' };
  await outsideWritesSettled(); // the current key it compares with may be an outside write being put back
  const key = typeof msg.key === 'string' && msg.key.trim() ? msg.key.trim() : undefined;
  const secrets = await getSecrets();
  const current = secrets.keys?.[msg.provider];
  if (current === key) return ok;
  if (current) {
    const changes = [key ? "replace the AI judge's key" : "remove the AI judge's key"];
    await assertMayWeaken(changes, false, await firstJudgeChanges(changes)); // a mistyped first key can be put right
  }
  const keys = { ...secrets.keys };
  if (key) keys[msg.provider] = key; else delete keys[msg.provider];
  await ownSet({ secrets: { ...secrets, keys } });
  return ok;
}

async function guardedClear(type: keyof typeof WEAKENING_ACTIONS, clear: () => Promise<void>) {
  await assertMayWeaken([WEAKENING_ACTIONS[type]]);
  await clear();
  return ok;
}

/** Imports a verified site's label verdicts (from its test sessions) into the cache. Returns how many.
 *  `missingOnly`: leave the ones already there alone (the check at every start). */
export async function importSiteVerdicts(id: string, missingOnly = false): Promise<number> {
  const builtin = builtinSite(id);
  const puts: Promise<void>[] = [];
  for (const [fp, e] of Object.entries(builtin?.cache ?? {})) {
    if (missingOnly && (await cache.get(fp))) continue;
    puts.push(cache.put(fp, e.verdict, e.pWrite ?? (e.verdict === 'allow' ? 0 : 1), 'label'));
  }
  await Promise.all(puts); // together, so the cache writes them once or twice rather than once per label
  return puts.length;
}

/** Every switched-on site's shipped labels, back in the cache: they are the product's own data, so neither a
 *  cleared cache nor an older install may leave a verified site to the judge alone. */
export async function restoreSiteVerdicts(missingOnly: boolean): Promise<number> {
  let n = 0;
  for (const [id, s] of Object.entries(sitesInForce(S.policy).sites)) if (s.enabled) n += await importSiteVerdicts(id, missingOnly);
  return n;
}

/** Fills in a custom site's icon, and its name when it still has the name made from the host. */
const discovering = new Set<string>();
/** A stored icon that is a dark-mode variant (GitHub's `favicon-dark.svg`): white on the UI's white tile, so
 *  it is looked up again. */
const DARK_ICON = /[-_.]dark\.(svg|png|ico|webp)(\?|$)/i;
async function discoverAndPatch(id: string): Promise<void> {
  if (discovering.has(id)) return;
  discovering.add(id);
  try {
    const found = await discoverSite(id);
    // Built on the policy last written once the lookup is done (it takes seconds): a change made meanwhile, a site
    // added or removed, stays. Through save, which carries the Pro account's list as last written too.
    const base = latest();
    const site = base.customSites.find((c) => c.id === id);
    if (!site || (!found.iconUrl && !found.name)) return;
    const name = found.name && site.name === nameFromHost(id) ? found.name : site.name;
    const keep = (u: string | undefined) => (u && !DARK_ICON.test(u) ? u : undefined);
    await save({ ...base, customSites: base.customSites.map((c) => (c.id === id ? { ...c, name, iconUrl: keep(c.iconUrl) ?? found.iconUrl ?? c.iconUrl } : c)) });
    system(`site-discovered:${id} icon=${found.iconUrl ? 'yes' : 'no'}`);
  } finally {
    discovering.delete(id);
  }
}

/** The first-run key window: a small popup window, one at a time, focused if already open. */
/** Opens the setup window, or brings an open one forward. `step: 'demo'` goes straight to the demo's choice of site
 *  (setup.html#demo), to try the demo again or on another site. */
export async function openSetupWindow(step?: 'demo'): Promise<void> {
  const page = chrome.runtime.getURL('setup.html');
  const url = step ? `${page}#${step}` : page;
  // The extension's own open pages, found without the tabs permission (its host access covers web pages only).
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] }).catch(() => []);
  const ctx = open.find((c) => c.windowId >= 0 && c.documentUrl?.split('#')[0] === page);
  if (ctx) {
    if (step && ctx.tabId >= 0) await chrome.tabs.update(ctx.tabId, { url }).catch(() => {});
    await chrome.windows.update(ctx.windowId, { focused: true });
    return;
  }
  const box = await setupWindowBox();
  const win = await chrome.windows.create({ url, type: 'popup', focused: true, state: 'normal', ...box });
  // Opened from a browser window in full screen (macOS above all), Chrome can put the popup in full screen too, at once
  // or a moment later, and the setup filled the screen: it is put back to its own size.
  if (win?.id === undefined) return;
  const keepSize = async () => {
    const w = await chrome.windows.get(win.id!).catch(() => undefined);
    if (w && (w.state === 'fullscreen' || w.state === 'maximized')) {
      await chrome.windows.update(win.id!, { state: 'normal' }).catch(() => {});
      await chrome.windows.update(win.id!, { ...box, focused: true }).catch(() => {});
      system(`setup:window was ${w.state}, put back to its size`);
    }
  };
  await keepSize();
  setTimeout(() => { void keepSize(); }, 800);
}

/** The setup window's size and place: roomy enough for both judge cards without scrolling on most screens, and centred
 *  over the browser window last in front. No browser window: Chrome places it. */
async function setupWindowBox(): Promise<{ width: number; height: number; left?: number; top?: number }> {
  const width = 640, height = 820; // the welcome, the demo scene and both judge cards, no empty room and no scroll
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w.left === undefined || w.top === undefined || !w.width || !w.height) return { width, height };
    const h = Math.min(height, Math.max(560, w.height - 40));
    return { width, height: h, left: Math.round(w.left + (w.width - width) / 2), top: Math.round(w.top + Math.max(0, (w.height - h) / 2)) };
  } catch { return { width, height }; }
}

type Sender = chrome.runtime.MessageSender;
type Of<T extends Message['type']> = Extract<Message, { type: T }>;
type Handlers = { [T in Message['type']]?: (msg: Of<T>, sender: Sender) => unknown };

const ok = { ok: true } as const;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const hostOfUrl = (url: string | undefined): string => {
  try { return new URL(url ?? '').hostname; } catch { return ''; }
};

/** The Pro account page just saved its guarded-site list (the content script, on the page's "Saved" redirect): the
 *  list is fetched now, so a change made there reaches this browser at once, through the lock as any sync is.
 *  Taken only from the top frame of the service this browser is signed in to; a ping from any other
 *  page is nothing (it could at most cost one fetch of the account's own list). */
async function accountPageSaved(_msg: Of<'page:account-saved'>, sender: Sender) {
  if (sender.frameId !== 0 || !sender.url) return ok;
  try { if (new URL(sender.url).origin !== new URL(S.policy.cloud.serviceUrl).origin) return ok; } catch { return ok; }
  system('account-page-saved');
  await syncManagedSites('account-page');
  return ok;
}

/** The Pro account page signed out in this browser (content/account-nudge.ts): this browser signs out of Pro too, when
 *  it is signed in to that same account and the word comes from the configured service's page, top frame. Like the
 *  extension's own Sign out, with its checks (an agent's browser stays signed in; the lock may hold protection on). */
async function webSignedOut(msg: Of<'page:signed-out'>, sender: Sender) {
  if (sender.frameId !== 0 || !sender.url || typeof msg.account !== 'string') return ok;
  try { if (new URL(sender.url).origin !== new URL(S.policy.cloud.serviceUrl).origin) return ok; } catch { return ok; }
  if (!(await cloudClient().signedIn())) return ok;
  const email = (await cloudStatus(false)).account?.email;
  if (!email || email.toLowerCase() !== msg.account.trim().toLowerCase()) return ok;
  system('cloud:signed-out-on-account-page');
  await signOut().catch((err: unknown) => system(`cloud:sign-out refused ${errorText(err)}`.slice(0, 200)));
  return ok;
}

/** A guarded page is closing (pagehide in its top frame): refuse that tab's writes until it is gone or a new
 *  page commits, since what it sends now leaves after the debugger session (closing-tabs.ts). */
async function pageClosing(_msg: Of<'page:closing'>, sender: Sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !attachmentOn() || S.policy.mode !== 'enforce') return ok;
  if (!guardsHost(S.policy.effective, hostOfUrl(sender.url ?? sender.tab?.url))) return ok;
  await closing.add(tabId);
  system('page-closing', tabId);
  return ok;
}

/** Kept only for guarded sites: the judge's context, never collected elsewhere (privacy policy, store listing). */
function recordUiAction(msg: Of<'ui:action'>, sender: Sender) {
  const tabId = sender.tab?.id;
  const host = hostOfUrl(sender.url ?? sender.tab?.url); // the frame's own host: an ad's iframe is not the site
  if (tabId !== undefined && host && guardsHost(S.policy.effective, host)) uiactions.push(tabId, msg.action);
  return ok;
}

/** A sensitive field's value, held in memory to scrub it from bodies (typed-secrets.ts). Guarded sites only, and
 *  only while protection is on: with it off nothing is judged, so there is nothing to scrub. */
function recordTypedSecret(msg: Of<'secret:typed'>, sender: Sender) {
  const tabId = sender.tab?.id;
  const host = hostOfUrl(sender.url ?? sender.tab?.url);
  if (!S.policy.enabled || tabId === undefined || typeof msg.field !== 'string' || typeof msg.value !== 'string') return ok;
  if (host && guardsHost(S.policy.effective, host)) typedSecrets.remember(tabId, msg.field, msg.value);
  return ok;
}

/** Verdicts from a site's test sessions, imported by the harness: development builds only, since a stored allow
 *  outlasts every other check. */
async function importCache(msg: Of<'cache:import'>) {
  if (!devBuild()) throw new Error('importing verdicts exists only in development builds');
  let n = 0;
  for (const [fp, e] of Object.entries(msg.entries)) {
    if (e.verdict !== 'allow' && e.verdict !== 'block') continue;
    await cache.put(fp, e.verdict, e.pWrite ?? (e.verdict === 'allow' ? 0 : 1), 'label');
    n++;
  }
  system(`cache-imported:${n}`);
  return { ok: true, imported: n };
}

// ---- Sites. Two lists are guarded together (sites.ts sitesInForce): this browser's own (`scope: 'browser'`, the
// default) and the Pro account's (`scope: 'account'`, every browser signed in to it).

/** A site the Pro account guards stays guarded whatever this browser's own settings say, so its switch here is
 *  disabled; this is the backstop. */
const GUARDED_BY_ACCOUNT = { ok: false, error: 'Your Pro account guards this site. Remove it on your Pro account page to stop guarding it.' } as const;
/** With an own key there is no account: its lists are not changed from here. */
const ACCOUNT_EDITS_ELSEWHERE = { ok: false, error: 'Your Pro account\'s sites are changed on your account page.' } as const;

/** Pro mode: the guarded sites are the account's, and this browser's changes go to them (local first: kept in
 *  `accountEdits`, guarded at once, sent in order by cloud-sync.ts flushEdits). With an own key, this browser's list. */
const proMode = (p: Policy) => p.judge.provider === 'cloud' && Boolean(p.managed);

/** Which of the account's lists an addition goes to: the one asked for, else the account's own while this is its only
 *  browser, else this browser's list there (PLAN-PRO-UI D7). */
const addScope = (p: Policy, scope?: AccountEdit['scope']): AccountEdit['scope'] => scope ?? (accountBrowsers(p) <= 1 ? 'account' : 'browser');

/** `p` with an addition waiting for the account. */
function withAccountAdd(p: Policy, id: string, builtin: boolean, name: string | undefined, scope?: AccountEdit['scope']): Policy {
  const edit: AccountEdit = { op: 'add', scope: addScope(p, scope), id, builtin, ...(name ? { name } : {}), at: Date.now() };
  return { ...p, accountEdits: [...(p.accountEdits ?? []), edit] };
}

/** `p` with the site off the account's lists (one asked for, or each that guards it): an addition still waiting is
 *  taken back, and the list the account has gets a removal made against the version this browser last saw. A site this
 *  browser's own list still guards (an install from before the move, cloud-sync.ts moveLocalSites) is switched off too. */
function withAccountRemove(p: Policy, id: string, scope?: AccountEdit['scope']): Policy {
  const mine = (e: AccountEdit) => e.id === id && e.op === 'add' && (!scope || e.scope === scope);
  const kept = (p.accountEdits ?? []).filter((e) => !mine(e));
  const onAccount = accountScopesOf({ sites: {}, customSites: [], managed: p.managed }, id).filter((s) => !scope || s === scope);
  const builtin = Boolean(builtinSite(id));
  const removals = onAccount.map((s): AccountEdit => {
    const version = s === 'account' ? p.managed?.version : p.managed?.browserVersion;
    return { op: 'remove', scope: s, id, builtin, ...(version !== undefined ? { version } : {}), at: Date.now() };
  });
  const sites = p.sites[id]?.enabled ? { ...p.sites, [id]: { enabled: false } } : p.sites;
  return { ...p, sites, customSites: p.customSites.filter((c) => c.id !== id), accountEdits: [...kept, ...removals] };
}

/** Saves a Pro-mode site change (through the lock, like any) and sends it to the account. */
async function saveAccountEdit(next: Policy): Promise<Policy> {
  const saved = await save(next);
  void flushAccountEdits('edit');
  return saved;
}

/** The host typed or taken from a tab as a custom site's id, or a refusal: not a host, or a public suffix (`co.uk` is
 *  a registry's name, not a site's: guarding it would judge every write to every .co.uk host). */
function siteHost(raw: string): string {
  const id = hostToSiteId(raw);
  if (!validHost(id)) throw new Error(`not a host: ${raw}`);
  if (isPublicSuffix(id)) throw new Error(`not a site of its own: ${id} is a public suffix`);
  return id;
}

/** A custom site switched on or off in this browser's list. One the account lists but this browser does not is
 *  copied in, so switching it on here keeps it guarded should the account drop it. */
function withCustomSet(policy: Policy, id: string, enabled: boolean): Policy {
  if (policy.customSites.some((c) => c.id === id)) return { ...policy, customSites: policy.customSites.map((c) => (c.id === id ? { ...c, enabled } : c)) };
  const listed = sitesInForce(policy).customSites.find((c) => c.id === id);
  return listed ? { ...policy, customSites: [...policy.customSites, { id, name: listed.name, domains: listed.domains, enabled }] } : policy;
}

/** setSite in Pro mode: on or off on the account's lists. */
async function setAccountSite(policy: Policy, msg: Of<'site:set'>) {
  const builtin = builtinSite(msg.id);
  const listed = builtin ? undefined : sitesInForce(policy).customSites.find((c) => c.id === msg.id);
  if (!builtin && !listed) return { ok: false, error: 'not a site' };
  const onAccount = accountScopesOf(policy, msg.id).some((s) => !msg.scope || s === msg.scope);
  // Switching off also covers a site this browser's own list still guards (kept by cloud-sync.ts moveLocalSites):
  // withAccountRemove switches it off there.
  const ownList = !msg.scope && Boolean(policy.sites[msg.id]?.enabled || policy.customSites.some((c) => c.id === msg.id && c.enabled));
  if (msg.enabled ? onAccount : !(onAccount || ownList)) return listSites(policy, msg.host);
  const saved = await saveAccountEdit(msg.enabled ? withAccountAdd(policy, msg.id, Boolean(builtin), listed?.name, msg.scope) : withAccountRemove(policy, msg.id, msg.scope));
  if (msg.enabled && builtin?.cache) system(`site-enabled:${msg.id} cache-imported:${await importSiteVerdicts(msg.id)}`);
  else system(`site-${msg.enabled ? 'enabled' : 'disabled'}:${msg.id} (account)`);
  return listSites(saved, msg.host);
}

/** addSite in Pro mode: onto the account's list D7 picks, or the one asked for. */
async function addAccountSite(policy: Policy, msg: Of<'site:add'>, id: string) {
  const verified = builtinForHost(id);
  const siteId = verified?.id ?? id;
  if (accountScopesOf(policy, siteId).includes(addScope(policy, msg.scope))) return listSites(policy, msg.host);
  const saved = await saveAccountEdit(withAccountAdd(policy, siteId, Boolean(verified), verified ? undefined : msg.name?.trim() || nameFromHost(id), msg.scope));
  system(`site-added:${id}${verified ? `->${verified.id}` : ''} (account)`);
  if (verified?.cache) system(`site-enabled:${verified.id} cache-imported:${await importSiteVerdicts(verified.id)}`);
  return listSites(saved, msg.host);
}

async function setSite(msg: Of<'site:set'>) {
  const policy = latest();
  const builtin = builtinSite(msg.id);
  if (proMode(policy)) return setAccountSite(policy, msg);
  if (msg.scope === 'account') return ACCOUNT_EDITS_ELSEWHERE;
  if (!msg.enabled && accountGuards(policy, msg.id)) return GUARDED_BY_ACCOUNT;
  const next = builtin ? { ...policy, sites: { ...policy.sites, [msg.id]: { enabled: msg.enabled } } } : withCustomSet(policy, msg.id, msg.enabled);
  const saved = await save(next);
  if (msg.enabled && builtin?.cache) {
    system(`site-enabled:${msg.id} cache-imported:${await importSiteVerdicts(msg.id)}`);
  } else {
    system(`site-${msg.enabled ? 'enabled' : 'disabled'}:${msg.id}`);
  }
  return listSites(saved, msg.host);
}

/** Guard everything: this browser's own setting and its allowed hosts. Switching it off and allowing a
 *  host lower protection, so both go through the lock (protection.ts); the answer is the setting as saved. */
const guardAllView = (p: Policy) => ({ guardAll: Boolean(p.guardAll), excludeSites: p.excludeSites ?? [], effective: { guardAll: p.effective.guardAll, excludeDomains: p.effective.excludeDomains } });

async function setGuardAll(msg: Of<'guard-all:set'>) {
  const saved = await save({ ...latest(), guardAll: msg.on === true });
  system(`guard-all:${saved.guardAll ? 'on' : 'off'}`);
  return guardAllView(saved);
}

/** Read-tracking writes (each site's readTrackingShapes) through or refused. Letting them through lowers protection:
 *  refused during an agent session and under a PIN like any such change (save, protection.ts). */
async function setReadTracking(msg: Of<'read-tracking:set'>) {
  const saved = await save({ ...latest(), allowReadTracking: msg.on === true });
  system(`read-tracking:${saved.allowReadTracking ? 'on' : 'off'}`);
  return { allowReadTracking: saved.allowReadTracking };
}

async function excludeSite(msg: Of<'exclude:add'>) {
  const host = excludeHost(String(msg.host ?? ''));
  if (!host) return { ok: false, error: 'That is not a host name (like app.example.com).' };
  const allow = latest().excludeSites ?? [];
  const saved = allow.includes(host) ? latest() : await save({ ...latest(), excludeSites: [...allow, host] });
  system(`exclude:add ${host}`);
  return guardAllView(saved);
}

async function includeSite(msg: Of<'exclude:remove'>) {
  const saved = await save({ ...latest(), excludeSites: (latest().excludeSites ?? []).filter((h) => h !== msg.host) });
  system(`exclude:remove ${String(msg.host).slice(0, 100)}`);
  return guardAllView(saved);
}

async function addSite(msg: Of<'site:add'>) {
  const id = siteHost(msg.host);
  // A host a verified site already covers switches that site on (with its decoder and verdicts)
  // instead of adding a judge-only copy of it.
  const verified = builtinForHost(id);
  const policy = latest();
  if (proMode(policy)) return addAccountSite(policy, msg, id);
  if (msg.scope === 'account') return ACCOUNT_EDITS_ELSEWHERE;
  if (verified) {
    const saved = await save({ ...policy, sites: { ...policy.sites, [verified.id]: { ...policy.sites[verified.id], enabled: true } } });
    system(`site-added:${id}->${verified.id}`);
    return listSites(saved, msg.host);
  }
  if (policy.customSites.some((c) => c.id === id)) return listSites(policy, msg.host);
  const saved = await save({ ...policy, customSites: [...policy.customSites, { id, name: msg.name?.trim() || nameFromHost(id), domains: [id], enabled: true, iconUrl: msg.iconUrl }] });
  system(`site-added:${id}`);
  // Added by host name (the settings page, not an open tab): look up its icon and name afterwards.
  if (!msg.iconUrl) void discoverAndPatch(id);
  return listSites(saved, msg.host);
}

async function removeSite(msg: Of<'site:remove'>) {
  if (proMode(latest())) {
    const saved = await saveAccountEdit(withAccountRemove(latest(), msg.id, msg.scope));
    system(`site-removed:${msg.id} (account)`);
    return listSites(saved, msg.host);
  }
  if (msg.scope === 'account') return ACCOUNT_EDITS_ELSEWHERE;
  const saved = await save({ ...latest(), customSites: latest().customSites.filter((c) => c.id !== msg.id) });
  system(`site-removed:${msg.id}`);
  return listSites(saved, msg.host);
}

/** Save and test of an own key: the provider, with the key typed (or the one stored for it), is built and tested apart
 *  from the judge in force, and goes into force only once it has passed. Until then nothing is stored and the judge
 *  in force (Pro, or the provider before) stays: a provider picked, a key mistyped or a test failed leaves the browser
 *  as it was. Passed, the key is stored (replacing one through the lock) and the judge changes (through the lock;
 *  signed in to Pro, leaving it, leavePro). */
async function chooseByok(msg: Of<'judge:byok'>) {
  const c = msg.choice;
  if (!c || !isProviderId(c.id)) return { ok: false, error: 'unknown provider' };
  const byok: ByokChoice = { id: c.id, ...(c.model?.trim() ? { model: c.model.trim() } : {}) };
  const typed = typeof msg.key === 'string' && msg.key.trim() ? msg.key.trim() : undefined;
  const stored = await getSecrets();
  const secrets = typed ? { ...stored, keys: { ...stored.keys, [byok.id]: typed } } : stored;
  const tried = await tryByokJudge(byok, secrets, latest());
  if (!tried.ok) return 'problem' in tried ? { ok: false, problem: tried.problem } : { ...tried, tested: true };
  if (typed) await setKey({ type: 'secrets:key', provider: byok.id, key: typed });
  const judge: Policy['judge'] = { ...latest().judge, provider: 'byok', byok };
  // An own key while signed in to Pro: leaving Pro, as two modes never mix (leavePro).
  if (await cloudClient().signedIn()) await leavePro(judge);
  else await save({ ...latest(), judge });
  await selectJudges(latest());
  return { ...tried, judge: S.judge.name };
}

/** Agreeing to what the judge is sent lets it run; withdrawing stops it at once (consent.ts). Either way only more is
 *  refused or the judge the person chose comes back: nothing here lowers protection. */
async function setConsent(msg: Of<'consent:set'>) {
  if (typeof msg.agreed !== 'boolean') return { ok: false, error: 'agreed must be true or false' };
  await writeConsent(msg.agreed);
  await selectJudges(S.policy);
  return { ok: true, agreed: S.judgeConsent, judge: S.judge.name, problem: S.judgeProblem };
}

/** Pro mode begins, as a sign-in finishes (in the tab, or by a setup link): the judge becomes Pro in the same step,
 *  through the lock like any change of judge, and an own key, no longer used, is deleted. A change the lock refuses
 *  undoes the sign-in, so the browser stays in the mode it was in. */
async function enterPro(): Promise<void> {
  // Signing in to Pro is the agreement to what the judge is sent (shared/consent-ui.ts): the setup window and settings
  // page record it as the button is pressed; a setup link, signed in here by the background, has no button.
  await writeConsent(true);
  // A judge now works, so protection goes on (off for want of one until now, or since the last sign-out): raising it.
  const base = latest();
  if (base.judge.provider !== 'cloud' || !base.enabled) {
    try { await save({ ...base, enabled: true, judge: { ...base.judge, provider: 'cloud' } }); }
    catch (err) { await cloudSignOut().catch(() => {}); throw err; }
  }
  const secrets = await getSecrets();
  if (Object.keys(secrets.keys ?? {}).length) { await ownSet({ secrets: { ...secrets, keys: {} } }); system('secrets:keys-removed on Pro sign-in'); }
}

/** Own-key mode, chosen while signed in to Pro: the judge changes first (through the lock: refused, nothing changes),
 *  then the browser signs out of Pro. Never in an agent's browser, which only its person's account page releases. */
async function leavePro(judge: Policy['judge']): Promise<Policy> {
  if (S.agentBrowser) throw new Error(`${LOCKED_PREFIX}agent:This browser belongs to an AI agent, so it can't leave OnlyRead Pro here. To release it, sign it out from your OnlyRead Pro account page in your own browser.`);
  const saved = await save({ ...latest(), judge });
  await cloudSignOut();
  await syncManagedSites('signed-out');
  return saved;
}

/** One mode at a time, whatever left a mix (an install from before, a sign-in ended by the service): signed in with an
 *  own-key judge signs out (the key was chosen last), except in an agent's browser, which keeps Pro; a Pro judge with
 *  no sign-in becomes the own-key judge (no key: no judge, offWithoutJudge). The lock may hold the change of judge:
 *  tried again when it opens; meanwhile no judge answers, so uncertain writes are refused. */
export async function settleMode(why: string): Promise<void> {
  const signed = await cloudClient().signedIn();
  const base = latest();
  const provider = base.judge.provider;
  if (signed && provider !== 'cloud') {
    if (S.agentBrowser) { await save({ ...base, judge: { ...base.judge, provider: 'cloud' } }).catch((err: unknown) => system(`mode:pro-waits ${errorText(err)}`)); return; }
    system(`mode:signed-out (${why}: signed in with an own-key judge)`);
    await cloudSignOut(); // the hook settles the judge, if anything is left to settle
    await syncManagedSites('signed-out');
    return;
  }
  if (!signed && provider === 'cloud') {
    await save({ ...base, judge: { ...base.judge, provider: 'byok' } }).then(() => system(`mode:own-key (${why}: not signed in to Pro)`), (err: unknown) => system(`mode:own-key-waits ${errorText(err)}`));
  }
}

/** Starts a sign-in in the tab, on the service in force, or on the real Pro service when a development build's local
 *  mock is not running (cloud-session.ts signInFallback): saved like any change of the service (the lock applies), and
 *  the sign-in goes there at once, before the change reaches S.policy. */
async function beginSignIn(tabId: number, back: string): Promise<string> {
  const fallback = await signInFallback(S.policy);
  if (!fallback) return startSignIn(tabId, back);
  await save({ ...latest(), cloud: { ...latest().cloud, serviceUrl: fallback } });
  system(`cloud:service ${fallback} (the local mock did not answer)`);
  return startSignIn(tabId, back, fallback);
}

/** "Sign in" on the setup or settings page: that tab goes to the service's sign-in page and comes back when it ends
 *  (cloud-session.ts startSignIn; the result rides in the address, shared/sign-in-result.ts). */
async function signIn(_msg: Of<'cloud:signin'>, sender: Sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url) return { ok: false, error: 'Sign in from the OnlyRead settings page.', cloud: await cloudStatus(false) };
  // The sign-in makes Pro the judge (enterPro): asked of the lock now, before the tab leaves for nothing.
  if (S.policy.judge.provider !== 'cloud') {
    const next = { ...S.policy, judge: { ...S.policy.judge, provider: 'cloud' as const } };
    const refusal = await refusedStorageChange(S.policy, next, await firstJudgeChanges(weakeningChanges(S.policy, next)));
    if (refusal) return { ok: false, locked: true, error: refusal.replace(/^locked:[a-z-]+:/, ''), cloud: await cloudStatus(false) };
  }
  try {
    const url = await beginSignIn(tabId, signInBack(sender.url));
    await chrome.tabs.update(tabId, { url });
    return { ok: true, cloud: await cloudStatus(false) };
  } catch (err) { return { ok: false, error: errorText(err), cloud: await cloudStatus(false) }; }
}

/** The service's done page handing back a sign-in code (the content script). Taken only from that page's top frame,
 *  in the tab the sign-in started in, with the state it started with; a new sign-in takes the account's site list at
 *  once, and the tab goes back to the page that asked, with the result. */
async function proSignInCode(msg: Of<'page:signin-code'>, sender: Sender) {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !isSignInDonePage(sender.url, S.policy.cloud.serviceUrl)) return ok;
  if (typeof msg.code !== 'string' || typeof msg.state !== 'string') return ok;
  const pending = await takeSignIn(msg.state, tabId);
  if (!pending) return ok;
  let error: string | undefined;
  try {
    await finishSignIn(msg.code, pending);
    await enterPro();
    await syncManagedSites('signed-in');
    void ensurePush('signed-in');
    void notifyAccountPages('this-browser-changed'); // an account page open here now lists this browser as its own
  } catch (err) {
    error = errorText(err);
    system(`cloud:sign-in failed: ${error}`.slice(0, 200));
  }
  // The tab goes back to the page that asked, which shows the result (the setup window then goes on to its demo). A
  // sign-in from the settings page that went through goes on to the Pro account page instead, where Pro mode is
  // managed (PLAN-PRO-UI step 5), with the demo opened over it.
  const toPro = !error && pending.back.startsWith(chrome.runtime.getURL('options.html')) ? await proPage('overview') : undefined;
  // The first AI judge this browser sets up is followed by the demo, wherever it started (shared/first-judge.ts); a
  // sign-in from the settings page always is. The setup window goes on to its demo by itself (setup.ts, ?signin=ok);
  // anywhere else the setup window opens on it.
  const first = !error && (await markFirstJudge());
  const fromSetup = pending.back.startsWith(chrome.runtime.getURL('setup.html'));
  await chrome.tabs.update(tabId, { url: toPro ?? withSignInResult(pending.back, error) }).catch(() => {});
  if (!error && !fromSetup && (toPro || first)) {
    system(`demo:after-sign-in${first ? ' (first)' : ''}`);
    void openSetupWindow('demo').catch(() => {});
  }
  return ok;
}

/** May the Pro account page frame this browser's own pages (content/account-frames.ts)? Only its top frame, on the
 *  configured service, for the account this browser is signed in to (the page names it): another account's page, or
 *  a browser not signed in, gets the reason instead, which the page says in its own words. */
async function frameCheck(msg: Of<'page:frame-check'>, sender: Sender) {
  const service = S.policy.cloud.serviceUrl.replace(/\/$/, '');
  if (sender.frameId !== 0 || !sender.url?.startsWith(`${service}/`)) return { ok: false, reason: 'not-pro-page' };
  if (!(await cloudClient().signedIn())) return { ok: false, reason: 'signed-out' };
  const email = (await cloudStatus(false)).account?.email ?? (await cloudStatus(true)).account?.email;
  if (!email) return { ok: false, reason: 'unknown-account' };
  const same = typeof msg.account === 'string' && msg.account.trim().toLowerCase() === email.toLowerCase();
  return same ? { ok: true } : { ok: false, reason: 'other-account' };
}

/** Which of the Pro account page's browsers this one is (content/account-nudge.ts): its sign-in's id, for the same
 *  checks as framing (the configured service's top frame, signed in to the account the page names). Otherwise why
 *  not, which the page says in its own words. */
async function whichBrowser(msg: Of<'page:which-browser'>, sender: Sender) {
  const check = await frameCheck({ type: 'page:frame-check', account: msg.account }, sender);
  if (!check.ok) return check;
  const family = await cloudClient().family();
  return family ? { ok: true, family } : { ok: false, reason: 'unknown-account' };
}

/** The account page's "Try the demo", really clicked (content/account-nudge.ts): the demo's choice of site, in Pro mode
 *  where this browser's own settings page is out of the way. The same checks as framing: the configured service's top
 *  frame, signed in to the account the page names. Opens a window and changes nothing. */
async function openDemoFromPage(msg: Of<'page:open-demo'>, sender: Sender) {
  const check = await frameCheck({ type: 'page:frame-check', account: msg.account }, sender);
  if (!check.ok) return check;
  await openSetupWindow('demo');
  return ok;
}

/** The account page's word that the account changed (content/account-nudge.ts): the lists are asked for now. Only
 *  from a top frame of the configured service, while signed in; at most once every two seconds. */
let lastNudge = 0;
async function accountChanged(_msg: Of<'page:account-changed'>, sender: Sender) {
  const service = S.policy.cloud.serviceUrl.replace(/\/$/, '');
  if (sender.frameId !== 0 || !sender.url?.startsWith(`${service}/`) || !(await cloudClient().signedIn())) return ok;
  if (Date.now() - lastNudge < 2000) return ok;
  lastNudge = Date.now();
  void syncManagedSites('account-page');
  return ok;
}

/** The page an email sign-in link opened (the content script): the sign-in goes on in the tab it started in, so that
 *  tab and its window come forward, for the person not to look for the setup window among their windows, and the
 *  link's tab, done with, closes. Only from that page's top frame on the service this browser uses, and only while a
 *  sign-in waits. */
async function proSignInLink(_msg: Of<'page:signin-link'>, sender: Sender) {
  const linkTab = sender.tab?.id;
  if (linkTab === undefined || sender.frameId !== 0 || !isSignInLinkPage(sender.url, S.policy.cloud.serviceUrl)) return ok;
  const pending = await pendingSignIn();
  if (!pending || pending.tabId === linkTab) return ok;
  const started = await chrome.tabs.get(pending.tabId).catch(() => undefined);
  if (started?.windowId === undefined) return ok;
  await chrome.tabs.update(pending.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(started.windowId, { focused: true }).catch(() => {});
  system('cloud:sign-in link opened, its window brought forward');
  setTimeout(() => { void chrome.tabs.remove(linkTab).catch(() => {}); }, 1500);
  return ok;
}

// ---- Setup by an AI agent, from the Pro service's agent-setup page (agent-setup.ts). Both messages come from the
// content script and are taken only from that page's top frame, of the service this browser uses.

function fromSetupPage(sender: Sender): boolean {
  return sender.frameId === 0 && sender.tab?.id !== undefined && isAgentSetupPage(sender.url, S.policy.cloud.serviceUrl);
}

/** What the setup page shows the agent: that OnlyRead is here, and what it guards now. */
async function setupHello(_msg: Of<'page:agent-setup-hello'>, sender: Sender) {
  if (!fromSetupPage(sender)) return undefined;
  const { policy } = S;
  return {
    version: chrome.runtime.getManifest().version,
    enabled: policy.enabled,
    mode: policy.mode,
    allTabs: policy.attachWhen === 'always',
    sites: listSites(policy).filter((s) => s.enabled).map((s) => s.name),
    pro: { chosen: policy.judge.provider === 'cloud', signedIn: (await cloudStatus(false)).signedIn },
  };
}

async function hasOwnKey(): Promise<boolean> {
  const secrets = await getSecrets();
  return Object.keys(secrets.keys ?? {}).some((id) => isProviderId(id) && Boolean(keyFor(secrets, id)));
}

/** A setup link's code: signs this browser in to the Pro account that made the link. Never over a sign-in this
 *  browser already has, or a key of its own: a link only connects a browser that has neither. */
async function connectLink(code: string, ownKey: boolean): Promise<{ connected?: string; connectError?: string }> {
  if (ownKey) return { connectError: 'This browser uses its own AI key, so the link did not connect it to Pro.' };
  if ((await cloudStatus(false)).signedIn) return { connectError: 'This browser is already signed in to OnlyRead Pro. The link was not used.' };
  try {
    const st = await signInWithSetupLink(code);
    await enterPro();
    await syncManagedSites('signed-in');
    void ensurePush('signed-in');
    void notifyAccountPages('this-browser-changed'); // an account page open here now lists this browser as its own
    return { connected: st.account?.name || st.account?.email || 'your account' };
  } catch (err) {
    system(`agent-setup:link failed ${errorText(err)}`.slice(0, 200));
    const gone = err instanceof CloudError && err.code === 'not_signed_in';
    return { connectError: gone ? 'The setup link has expired or was already used. Make a new one on your account page.' : `The setup link could not be used (${errorText(err)}).` };
  }
}

/** Keeps what a setup changed, merged with an earlier one of the last day, for the settings page's Undo. */
async function keepRecord(record: SetupRecord): Promise<void> {
  const kept = liveRecord((await chrome.storage.local.get(SETUP_KEY))[SETUP_KEY]);
  await ownSet({ [SETUP_KEY]: mergeRecords(kept, record) }); // the background's own (owned-storage.ts)
}

type SetupOutcome = { ok: false; error: string } | { ok: true; added: string[]; already: string[]; unknown: string[]; connected?: string; connectError?: string };

/** A setup: only what raises protection, kept so the person can undo it; a setup link's code signs this browser in
 *  to Pro there and then. */
/** Setups run one at a time, each planned from the policy last written (policy.ts lastWrittenPolicy, as cloud-sync.ts
 *  offer does): two handled together would plan from the same S.policy and each write a whole policy, the second
 *  without the first's site, as an own write the change handler takes. */
let setups: Promise<unknown> = Promise.resolve();
function runSetup(req: SetupRequest): Promise<SetupOutcome> {
  const run = () => runSetupNow(req);
  const next = setups.then(run, run);
  setups = next.catch(() => undefined);
  return next;
}

async function runSetupNow(req: SetupRequest): Promise<SetupOutcome> {
  const ownKey = await hasOwnKey();
  const base = lastWrittenPolicy() ?? S.policy;
  // With no AI judge the setup does not turn protection on (it could not stay on); a setup link's sign-in does, once
  // it has signed in (enterPro).
  const plan = planAgentSetup(base, req, ownKey, Date.now(), !(await judgeMissing()));
  const refused = setupRefusals(base, normalizePolicy(plan.next), plan.record);
  if (refused.length) {
    system(`agent-setup:refused ${refused.join('; ')}`.slice(0, 200));
    return { ok: false, error: `Setup only adds protection, so it can't ${refused[0]}.` };
  }
  if (plan.changed) {
    await setPolicy(carryManaged(plan.next));
    for (const id of plan.record.sites) await importSiteVerdicts(id);
  }
  const link = req.connect ? await connectLink(req.connect, ownKey) : {};
  const record = link.connected
    ? { ...plan.record, connected: true, summary: [plan.record.summary, `signed it in to OnlyRead Pro as ${link.connected}`].filter(Boolean).join(', ') }
    : plan.record;
  if (plan.changed || link.connected) await keepRecord(record);
  system(`agent-setup:${record.summary || 'nothing to change'}`.slice(0, 200));
  return { ok: true, added: plan.added, already: plan.already, unknown: plan.unknown, ...link };
}

/** The setup the agent pressed Apply for (sites it typed in). A setup link, not this form, connects the browser to a
 *  Pro account. */
async function setupApply(msg: Of<'page:agent-setup-apply'>, sender: Sender) {
  if (!fromSetupPage(sender)) return undefined;
  return runSetup(setupRequest({ sites: msg.sites, allTabs: msg.allTabs }));
}

/** A setup link opened in this browser: no choices, it guards every tab, refuses writes and signs in to the Pro
 *  account that made the link, whose sites it then guards. It runs as the page loads within LINK_FRESH_INSTALL_MS of
 *  install, and otherwise only after a real click (agent-setup.ts linkRunsByItself). */
async function setupLink(msg: Of<'page:agent-setup-link'>, sender: Sender) {
  if (!fromSetupPage(sender)) return undefined;
  const req = setupRequest({ sites: [], connect: msg.connect });
  if (!req.connect) return { ok: false, error: 'This setup link is not complete. Ask the person for a new one from their account page.' };
  if (msg.clicked !== true && !linkRunsByItself((await chrome.storage.local.get(INSTALLED_KEY))[INSTALLED_KEY])) return { ok: true, needsClick: true };
  const result = await runSetup(linkRequest(req.connect));
  if (!result.ok) return result;
  if (result.connected) await markAgentBrowser(result.connected);
  const cloud = await cloudStatus(false);
  return {
    ...result,
    signedInAs: cloud.signedIn ? cloud.account?.name || cloud.account?.email || result.connected || '' : undefined,
    guards: listSites(S.policy).filter((s) => s.enabled).map((s) => s.name),
    allTabs: S.policy.attachWhen === 'always',
    mode: S.policy.mode,
  };
}

/** The agent says which it is, by its name on the setup page: kept, and reported to the Pro service, whose account
 *  page shows its name and mark on this browser's row. Changes no protection. */
async function setupAgent(msg: Of<'page:agent-setup-agent'>, sender: Sender) {
  if (!fromSetupPage(sender)) return undefined;
  if (!isAgentName(msg.agent)) return { ok: false, error: 'unknown agent' };
  await setAgentName(msg.agent, msg.name);
  return { ok: true, agent: msg.agent, name: browserNameOf(msg.name), signedIn: (await cloudStatus(false)).signedIn };
}

/** A browser that belongs to an AI agent (agent-browser.ts) is managed from the Pro account alone: its
 *  sites, guard-everything, allowed hosts, guard switches and PIN are not edited here, adding included. Elsewhere the
 *  handler runs as it is (a lowering still through the lock). */
function accountManaged<M extends Message, R>(fn: (msg: M, sender: Sender) => R): (msg: M, sender: Sender) => R {
  return (msg, sender) => {
    if (S.agentBrowser) throw new Error(`${LOCKED_PREFIX}agent:This browser belongs to an AI agent, so its settings are managed from your OnlyRead Pro account page, not here.`);
    return fn(msg, sender);
  };
}

/** The settings page's Undo: what the last setup changed, put back, through the lock (an agent cannot undo it while
 *  it works, and a set PIN is asked for). */
async function undoAgentSetup() {
  await outsideWritesSettled(); // the record and the agent mark may be outside writes being put back
  const record = liveRecord((await chrome.storage.local.get(SETUP_KEY))[SETUP_KEY]);
  if (!record) return ok;
  if (S.agentBrowser) throw new Error(`${LOCKED_PREFIX}agent:This browser belongs to an AI agent, so its setup can't be undone here. To release it, sign it out from your OnlyRead Pro account page in your own browser.`);
  await save(undoSetup(latest(), record));
  await ownRemove(SETUP_KEY);
  // A browser the setup link signed in is signed out again (after the lock let the rest through).
  if (record.connected) await signOut();
  system('agent-setup:undone');
  return ok;
}

/** Development builds only (index.ts __onlyread.assumeJudge): the e2e suites run rules-only, with no AI judge, yet test
 *  the full settings page and popup, which a missing judge replaces with the way to set one. */
let judgeAssumed = false;
export function assumeJudge(on: boolean): void { judgeAssumed = on; }

/** No AI judge to ask: none agreed to, Pro chosen and not signed in, or the own key missing. OnlyRead is not used without
 *  one: protection cannot be turned on, and the settings and popup offer only the way to set one. */
export async function judgeMissing(): Promise<boolean> {
  if (judgeAssumed) return false;
  const missing = !S.judgeConsent || (S.policy.judge.provider === 'cloud' ? !(await cloudClient().signedIn()) : Boolean(S.judgeProblem));
  if (!missing) void noteJudgeWorked();
  return missing;
}

/** A judge works: the first-judge record is written, if the page that set it up has not (a Pro chosen by an agent's
 *  setup link, an install from before the record), so the first-judge window (firstJudgeChanges) shuts on every path. */
let judgeWorkedNoted = false;
async function noteJudgeWorked(): Promise<void> {
  if (judgeWorkedNoted) return;
  judgeWorkedNoted = true;
  const got = (await chrome.storage.local.get(FIRST_JUDGE_KEY).catch(() => ({}))) as Record<string, unknown>;
  if (!got[FIRST_JUDGE_KEY]) await ownSet({ [FIRST_JUDGE_KEY]: Date.now() }).catch(() => { judgeWorkedNoted = false; });
}

async function signOut() {
  await outsideWritesSettled(); // the agent mark may be an outside removal being put back
  // An agent's browser stays signed in to its person's account: only the account page, elsewhere, releases it.
  if (S.agentBrowser) throw new Error(`${LOCKED_PREFIX}agent:This browser belongs to an AI agent, so it can't sign out of OnlyRead Pro here. To release it, sign it out from your OnlyRead Pro account page in your own browser.`);
  const cloud = await cloudSignOut();
  await syncManagedSites('signed-out');
  await offWithoutJudge();
  return cloud;
}

/** Signed out of the judge it used, with no key of its own: protection goes off until an AI judge is set, as before one
 *  ever was. Whoever ended the sign-in: this browser (signOut), or OnlyRead Pro (the account page signed it out, it ran
 *  out), which left protection on with no judge to ask. */
export async function offWithoutJudge(): Promise<void> {
  if (!S.policy.enabled) return;
  // The judge as last written, not as applied so far: the sign-out has just moved it to the own key (settleMode), and
  // that change is applied on its own queue (index.ts applyPolicy), which sets S.policy before its selectJudges runs.
  // Asked in between, S.judgeProblem still described Pro, a missing own key looked like a working judge, and protection
  // stayed on with none (with "Always", attached the whole time). Nothing asked again afterwards.
  await selectJudges(latest());
  if (!(await judgeMissing())) return;
  // The lock (an agent at work, a settings PIN) may refuse it: it is tried again when the lock opens (whenLockOpens),
  // and meanwhile the switch stays shown so the person can turn it off with the PIN.
  await save({ ...latest(), enabled: false }).catch((err: unknown) => system(`judge-missing:protection-left-on ${err instanceof Error ? err.message : String(err)}`));
}
whenSignedOut(() => { void settleMode('signed-out').then(offWithoutJudge); void notifyAccountPages('this-browser-changed'); });
whenLockOpens(() => { void settleMode('lock-opened').then(offWithoutJudge); });

// ---- The first-run demo (demo.ts): started from the setup window, guided by the coach card on the site, ended by the
// first refused write there, by a skip, or by its time running out.

/** Step 2 lasts as long as OnlyRead's notice (the coach card says when it closed: demo:done); if no word comes, the demo
 *  ends this long after its write was refused. */
const DEMO_END_DELAY_MS = 20_000;

async function startDemo(msg: Of<'demo:start'>, sender: Sender) {
  const site = demoSite(msg.site);
  if (!site) return { ok: false, error: 'That site has no demo.' };
  // As the protection switch: without an AI judge protection cannot be on, and the demo turns it on.
  if (await judgeMissing()) return { ok: false, error: 'Set an AI judge first: the demo turns protection on, and OnlyRead needs one to protect.' };
  await beginDemo(site.id, S.policy, sender.tab?.id);
  try {
    await save(demoPolicy(S.policy, site.id)); // raises protection only: never refused by the lock
  } catch (err) {
    await endDemo();
    throw err;
  }
  system(`demo:start ${site.id}`);
  // In the person's own browser window, not beside the setup window (which closes): the demo plays out on the site.
  const main = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const tab = await chrome.tabs.create({ url: site.url, active: true, ...(main?.id !== undefined ? { windowId: main.id } : {}) });
  if (tab.id !== undefined) await setDemoTab(tab.id);
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return ok;
}

/** The demo as the asker sees it: a content script only on the demo's own site, the setup window always. */
function demoView(_msg: Of<'demo:state'>, sender: Sender) {
  const d = demoState();
  const own = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!d || (!own && !onDemoSite(hostOfUrl(sender.url ?? sender.tab?.url)))) return { active: false };
  const site = demoSite(d.site)!;
  return { active: true, site: site.id, name: site.name, action: site.action, hint: site.hint, change: site.change, stopped: d.stopped?.name };
}

/** The coach card's word that step 2 is over: ends a demo whose write was refused, and nothing else. */
async function demoDone(_msg: Of<'demo:done'>, sender: Sender) {
  const d = demoState();
  if (!d?.stopped || !onDemoSite(hostOfUrl(sender.url ?? sender.tab?.url))) return { ok: false };
  return finishDemo(false);
}

/** The coach card's "Skip": ends the demo, from the setup window or the demo's own site only, like demo:done. Skipped on
 *  the site, OnlyRead's page comes forward next (openDetails: the Pro account page or the settings page, in its open tab
 *  if there is one): where the person goes on from (the setup window's own "Skip demo" opens it too, through
 *  settings:open). */
async function demoSkip(_msg: Of<'demo:skip'>, sender: Sender) {
  const own = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!own && !onDemoSite(hostOfUrl(sender.url ?? sender.tab?.url))) return { ok: false };
  const done = await finishDemo(true);
  if (!own) await openDetails().catch(() => {});
  return done;
}

/** The notice's "Sign in to Pro" (the AI judge section) and the demo's "Guard more sites" (Sites): the settings page at
 *  one of those two sections, only ever a new tab. From OnlyRead's own pages, or a content script's top frame on a site
 *  that can show those buttons: a guarded one (the notice), or a demo site (the coach card, also after the demo ended). */
/** The report dialog's refusals (a refusal and the rest of its burst, support.ts supportBurst) as a report would carry
 *  them, this extension's settings, and the signed-in account's email to suggest. */
async function supportList(msg: Of<'support:list'>): Promise<SupportList> {
  return { items: supportBurst(await audit.list(), listSites(S.policy), typeof msg.key === 'string' ? msg.key : undefined), ...(await supportContextNow()) };
}

/** This extension's settings for a report, and the signed-in account's email. */
async function supportContextNow(): Promise<Omit<SupportList, 'items'>> {
  const c = cloudClient();
  const email = (await c.signedIn()) ? (await cloudStatus().catch(() => undefined))?.account?.email : undefined;
  return {
    context: supportContext(S.policy, chrome.runtime.getManifest().version, devBuild(), navigator.userAgent),
    ...(email ? { email } : {}),
  };
}

/** Sends the picked refusals to OnlyRead support; answers with the report's id, or why it was not sent. */
async function sendSupport(msg: Of<'support:send'>): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const keys = Array.isArray(msg.keys) ? msg.keys.filter((k) => typeof k === 'string') : [];
  const items = supportItems(await audit.list(), listSites(S.policy), keys);
  const report = buildReport(items, keys, (await supportContextNow()).context, msg.note, msg.email);
  if ('error' in report) return { ok: false, error: report.error };
  try {
    const id = await cloudClient().sendSupport(report);
    system(`support:sent ${report.requests.length} ${id}`);
    return { ok: true, id };
  } catch (err) {
    const detail = err instanceof CloudError ? err.detail : undefined;
    if (detail === 'rate_limited') return { ok: false, error: 'Too many reports from here just now. Try again in an hour.' };
    return { ok: false, error: `The report could not be sent${detail ? ` (${detail})` : ''}. Try again, or write to support@onlyread.ai.` };
  }
}

/** The Pro account page's section for a settings section, in Pro mode while the service is reachable; else undefined
 *  (this browser's own settings page: own-key mode, Pro out of reach, or a section only it has). */
const PRO_SECTIONS: Partial<Record<NonNullable<Of<'settings:open'>['section']>, string>> = { overview: '', 'guarded-sites': '#sites', security: '#protection' };
async function proPage(section: NonNullable<Of<'settings:open'>['section']>): Promise<string | undefined> {
  const hash = PRO_SECTIONS[section];
  if (hash === undefined || latest().judge.provider !== 'cloud') return undefined;
  if (!proManaged(await cloudStatus(false))) return undefined;
  return `${S.policy.cloud.serviceUrl.replace(/\/$/, '')}/account${hash}`;
}

/** Opens `url` in the browser window the person was last in (not the setup window, a popup) and brings that window
 *  forward: on macOS a window in full screen has a Space of its own, and a tab opened there without it would leave the
 *  person on the desktop once the setup window closes. No ordinary window left: a new one. */
async function openInBrowserWindow(url: string): Promise<void> {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  if (win?.id === undefined) { await chrome.windows.create({ url, focused: true }); return; }
  await chrome.tabs.create({ url, windowId: win.id, active: true });
  await chrome.windows.update(win.id, { focused: true }).catch(() => {});
}

/** OnlyRead's own page: the Pro account page in Pro mode while the service is reachable, else this browser's settings
 *  page. Already open in a tab (any section of it): that tab, brought forward in its window, where the person left it;
 *  else a new tab in the person's browser window. Where the demo ends, skipped or closed, and the popup's settings. */
export async function openDetails(): Promise<void> {
  const url = (await proPage('overview')) ?? chrome.runtime.getURL('options.html');
  const open = await openTabOf(url);
  if (!open) { await openInBrowserWindow(url); return; }
  await chrome.tabs.update(open.tabId, { active: true });
  await chrome.windows.update(open.windowId, { focused: true }).catch(() => {});
}

/** A tab showing `page` (its query and hash aside), the one in the window last in front first. The extension's own
 *  pages come from runtime.getContexts (no tabs permission: tabs.query gives no address for them); web pages, from
 *  tabs.query (the host access covers them). */
async function openTabOf(page: string): Promise<{ tabId: number; windowId: number } | undefined> {
  const bare = (u?: string) => u?.replace(/[?#].*$/, '');
  const found: { tabId: number; windowId: number }[] = [];
  if (page.startsWith(chrome.runtime.getURL(''))) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] }).catch(() => []);
    for (const c of ctx) if (c.tabId >= 0 && c.windowId >= 0 && bare(c.documentUrl) === page) found.push({ tabId: c.tabId, windowId: c.windowId });
  } else {
    const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
    for (const t of tabs) if (t.id !== undefined && bare(t.url) === page) found.push({ tabId: t.id, windowId: t.windowId });
  }
  if (found.length < 2) return found[0];
  const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  return found.find((f) => f.windowId === last?.id) ?? found[0];
}

async function openSettings(msg: Of<'settings:open'>, sender: Sender) {
  const own = sender.url?.startsWith(chrome.runtime.getURL(''));
  const host = hostOfUrl(sender.url ?? sender.tab?.url);
  const shows = host !== '' && (guardsHost(S.policy.effective, host) || DEMO_SITES.some((d) => isTargetHost(host, builtinSite(d.id)?.domains ?? [])));
  if (!own && (sender.frameId !== 0 || !shows)) return { ok: false };
  if (msg.section === 'demo') { await openSetupWindow('demo'); return ok; }
  // The Pro account page's "Install on" (a setup link for an AI assistant's own browser), signed in or after signing in.
  if (msg.section === 'install-agent') {
    await openInBrowserWindow(`${S.policy.cloud.serviceUrl.replace(/\/$/, '')}/account?install=agent`);
    return ok;
  }
  // The page itself (the demo's Skip, Close and Done, the popup's settings): the Pro account page in Pro mode, else
  // this browser's settings page, in the tab already showing it if there is one.
  if ((msg.section ?? 'overview') === 'overview') { await openDetails(); return ok; }
  // Pro mode, with the service reachable: OnlyRead is managed on the Pro account page (PLAN-PRO-UI step 5, D9); the
  // AI judge choice and the report dialog stay on this browser's own page.
  const pro = await proPage(msg.section!);
  if (pro) { await openInBrowserWindow(pro); return ok; }
  // Support: the Activity list, with the report dialog open on the newest refusal (options/report.ts).
  const section = msg.section === 'guarded-sites' || msg.section === 'security' ? msg.section : msg.section === 'support' ? 'report' : 'ai-judge';
  await openInBrowserWindow(chrome.runtime.getURL(`options.html#${section}`));
  return ok;
}

/** Manrope for the coach card, read from the extension's own fonts: handed to the demo's site only, while it runs, so
 *  no page can load the extension's files (which would tell any site that OnlyRead is installed). */
async function demoFont(_msg: Of<'demo:font'>, sender: Sender) {
  if (!demoState() || !onDemoSite(hostOfUrl(sender.url ?? sender.tab?.url))) return { ok: false };
  const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL('assets/fonts/manrope.woff2'))).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { ok: true, font: btoa(bin) };
}

/** Ends the demo: the settings it changed go back through the lock (refused under a PIN not entered: then they stay,
 *  and the summary says so), and the site's tabs hear. An agent at work does not hold back guarding only during agent
 *  sessions again (DEMO_PUT_BACK): it is put back first, on its own; the mode follows through the lock as usual. */
async function finishDemo(skipped: boolean): Promise<{ ok: true; restored: boolean }> {
  const d = demoState();
  if (!d) return { ok: true, restored: true };
  let restored = true;
  const back = afterDemoPolicy(latest(), d.prev);
  try {
    await save({ ...back, mode: latest().mode }, { demoPutBack: true });
    if (back.mode !== latest().mode) await save({ ...latest(), mode: back.mode });
  } catch { restored = false; }
  await endDemo();
  system(`demo:${skipped ? 'skipped' : 'ended'} ${d.site}${restored ? '' : ' (settings kept: locked)'}`);
  const ended: Message = { type: 'demo:ended', site: d.site, stopped: d.stopped?.name, restored, skipped };
  await tellDemo(d.site, ended); // the coach card shows the summary on the site itself
  return { ok: true, restored };
}

/** The setup window and every tab of the demo's site. */
async function tellDemo(site: string, msg: Message): Promise<void> {
  void chrome.runtime.sendMessage(msg).catch(() => {}); // the setup window, if open
  const domains = builtinSite(site)?.domains ?? [];
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const t of tabs) if (t.id !== undefined && isTargetHost(hostOfUrl(t.url), domains)) void chrome.tabs.sendMessage(t.id, msg).catch(() => {});
}

// The demo's write was refused: the site's tabs show step 2 at once; the demo ends when the coach card says the notice
// closed, or at the latest DEMO_END_DELAY_MS later.
whenDemoStops(() => {
  const d = demoState();
  if (!d?.stopped) return;
  void tellDemo(d.site, { type: 'demo:stopped', site: d.site, name: d.stopped.name });
  // Ends this demo only: one ended by its coach card first, and another started since ("Try another site"), are left
  // alone (a timer from the last demo once ended the next one a few seconds in).
  const started = d.startedAt;
  setTimeout(() => { if (demoState()?.startedAt === started) void finishDemo(false); }, DEMO_END_DELAY_MS);
});

/** A tab closed while a demo runs: closing the tab the demo opened skips it, whatever other tabs of the site are open
 *  (an earlier demo's tab left open kept the demo, and protection with it, on all the time). A demo with no tab of its
 *  own (started before it kept one) ends once no tab of its site is left, the closed one aside; a tab still loading its
 *  page counts by the address it is going to. */
export async function demoTabClosed(closed: number): Promise<void> {
  const d = demoState();
  if (!d) return;
  if (d.tabId !== undefined) {
    if (closed === d.tabId) await finishDemo(true);
    return;
  }
  const domains = builtinSite(d.site)?.domains ?? [];
  const tabs = await chrome.tabs.query({}).catch(() => undefined);
  if (!tabs) return;
  if (!tabs.some((t) => t.id !== closed && isTargetHost(hostOfUrl(t.url || t.pendingUrl), domains))) await finishDemo(true);
}

/** A demo left running ends on its own (checked with each status, which the pages ask for often), and so does one whose
 *  write was refused when the worker stopped before its end came. */
export async function expireDemo(now = Date.now()): Promise<void> {
  const d = demoState();
  if (d?.stopped && now - d.stopped.at >= DEMO_END_DELAY_MS + 5_000) await finishDemo(false);
  else if (demoExpired(now)) await finishDemo(true);
}

/** Development builds: the Pro service this browser uses, the local mock or production. A sign-in belongs to the service
 *  it was made on, so the browser signs out of the one it leaves; an agent's browser keeps its sign-in and cannot switch.
 *  Saved like any change of the service (the lock applies, protection.ts). */
async function setService(msg: Of<'cloud:service-set'>) {
  if (!devBuild()) throw new Error('choosing the Pro service exists only in development builds');
  const url = msg.service === 'local' ? devMockServiceUrl(S.policy.devSink) : RELEASE_SERVICE_URL;
  if (!url) return { ok: false, error: 'This build has no local mock service (no dev sink).' };
  if (url === S.policy.cloud.serviceUrl.replace(/\/$/, '')) return cloudStatus(false);
  if (S.agentBrowser) throw new Error(`${LOCKED_PREFIX}agent:This browser belongs to an AI agent, so it stays on the service it is signed in to.`);
  const leaving = cloudClient();
  await save({ ...latest(), cloud: { ...latest().cloud, serviceUrl: url } });
  if (await leaving.signedIn()) await leaving.signOut();
  system(`cloud:service ${url}`);
  return { ...(await cloudStatus(false)), serviceUrl: url };
}

/** Options page: patch the guard controls together. enabled=false is the Off state. */
async function setGuard(msg: Of<'guard:set'>) {
  if (msg.enabled === true && !latest().enabled && (await judgeMissing())) throw new Error('Set an AI judge first: OnlyRead needs one to protect.');
  const next = { ...latest() };
  if (msg.enabled !== undefined) next.enabled = msg.enabled;
  if (msg.mode !== undefined) next.mode = msg.mode;
  if (msg.attachWhen !== undefined) next.attachWhen = msg.attachWhen;
  return save(next);
}

/** Agent session start/stop. Only changes attachment under attachWhen='agent-session'; the flag is still
 *  recorded in 'always' mode (a no-op there). */
async function setSession(msg: Of<'session:set'>) {
  S.declaredSession = Boolean(msg.active);
  await withAgentLock(() => updateAgentSession('declared'));
  return { ok: true, agentSession: S.agentSession, attachWhen: S.policy.attachWhen, active: attachmentOn(), attachedTabs: dbg.attachedTabs().length };
}

/** A canned gray-zone request, so the options page can prove the key and gateway work. */
async function testJudge() {
  const rec = testRecord();
  const t0 = Date.now();
  const { judge } = S;
  const p = S.policy;
  const anthropic = p.judge.provider === 'byok' ? testAnthropic(p.judge.byok, await getSecrets(), p, rec) : Promise.resolve(undefined); // at once, beside the judge
  try {
    const r = await judge.classify(rec);
    return { ok: true, judge: judge.name, model: r.model, pWrite: r.pWrite, latencyMs: Date.now() - t0, reason: r.reason, anthropic: await anthropic };
  } catch (err) {
    return { ok: false, judge: judge.name, error: errorText(err), latencyMs: Date.now() - t0, anthropic: await anthropic };
  }
}

/** What chrome.storage.local holds, when the browser can say (the call is missing in some test stubs). */
async function storageBytes(): Promise<number | undefined> {
  try { return await chrome.storage.local.getBytesInUse?.(null); } catch { return undefined; }
}

async function setupShown(): Promise<Status['agentSetup']> {
  const r = liveRecord((await chrome.storage.local.get(SETUP_KEY).catch(() => ({})) as Record<string, unknown>)[SETUP_KEY]);
  return r ? { at: r.at, summary: r.summary } : undefined;
}

async function status(): Promise<Status> {
  void expireDemo(); // the pages ask often: a demo left running ends here once its time is up
  const { policy } = S;
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return {
    version: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    mode: policy.mode,
    dynamicRules: rules.length,
    targetDomains: policy.effective.targetDomains,
    sites: enabledSiteIds(policy),
    attachedTabs: dbg.attachedTabs().length,
    inFlight: dbg.pending(),
    observations: await observer.count(),
    cacheSize: await cache.size(),
    judge: S.judge.name,
    judgeProblem: S.judgeProblem,
    judgeMissing: await judgeMissing(),
    judgeConsent: S.judgeConsent,
    byokLabel: PROVIDERS[policy.judge.byok.id]?.label,
    failClosed: S.failClosed,
    blockResponse: policy.blockResponse,
    enabled: policy.enabled,
    attachWhen: policy.attachWhen,
    agentSession: S.agentSession,
    agentWhere: await agentWhere(),
    attachmentActive: attachmentOn(),
    devBuild: devBuild(),
    devServices: devBuild() ? { local: devMockServiceUrl(policy.devSink), production: RELEASE_SERVICE_URL } : undefined,
    cloud: await cloudStatus(false),
    lock: await settingsLock(),
    storageProblem: storageProblem(),
    startupProblem: health.startup,
    verdictsProblem: health.verdicts,
    policyProblem: health.policy,
    policyRepaired: health.policyRepaired,
    storageBytes: await storageBytes(),
    managed: policy.managed ? { version: policy.managed.version, at: policy.managed.fetchedAt, ...(policy.managed.browsers !== undefined ? { browsers: policy.managed.browsers } : {}) } : undefined,
    managedPending: pendingManaged(),
    accountRefused: accountRefusal(),
    agentSetup: await setupShown(),
    guardAll: {
      local: Boolean(policy.guardAll), excludeSites: policy.excludeSites ?? [], inForce: policy.effective.guardAll, excludeInForce: policy.effective.excludeDomains,
      ...(policy.managed?.guardAll ? { account: policy.managed.guardAll } : {}), ...(policy.managed?.browser ? { browser: policy.managed.browser } : {}),
    },
    allowReadTracking: policy.allowReadTracking,
  };
}

/** One handler per message type the background answers. */
/** The host of the first tab holding the agent session, for the status card. */
async function agentWhere(): Promise<string | undefined> {
  const [first] = S.agentTabs;
  if (first === undefined) return undefined;
  const tab = await chrome.tabs.get(first).catch(() => undefined);
  try { return tab?.url ? new URL(tab.url).hostname.replace(/^www\./, '') || undefined : undefined; } catch { return undefined; }
}

const HANDLERS: Handlers = {
  'ui:action': recordUiAction,
  'page:closing': pageClosing,
  'page:account-saved': accountPageSaved,
  'page:signin-code': proSignInCode,
  'page:account-changed': accountChanged,
  'page:signed-out': webSignedOut,
  'page:frame-check': frameCheck,
  'page:which-browser': whichBrowser,
  'page:open-demo': openDemoFromPage,
  'page:signin-link': proSignInLink,
  'page:agent-setup-hello': setupHello,
  'page:agent-setup-apply': setupApply,
  'page:agent-setup-link': setupLink,
  'page:agent-setup-agent': setupAgent,
  'agent-setup:undo': undoAgentSetup,
  'secret:typed': recordTypedSecret,
  'audit:list': () => audit.list(),
  'activity:get': async (msg) => summarizeActivity(await audit.list(), listSites(S.policy), Date.now(), msg.limit, msg.offset),
  'settings:open': openSettings,
  'support:list': supportList,
  'support:send': sendSupport,
  'audit:clear': () => guardedClear('audit:clear', audit.clear),
  'observations:list': () => observer.list(),
  'observations:clear': () => guardedClear('observations:clear', observer.clear),
  'cache:list': () => cache.list(),
  // Clears what was learned or imported; the switched-on sites' shipped labels come straight back.
  'cache:clear': () => guardedClear('cache:clear', async () => { await cache.clear(); await restoreSiteVerdicts(false); }),
  'cache:import': importCache,
  'sites:list': (msg) => listSites(S.policy, msg.host),
  'site:set': accountManaged(setSite),
  'site:add': accountManaged(addSite),
  'guard-all:set': accountManaged(setGuardAll),
  'read-tracking:set': setReadTracking,
  'demo:start': startDemo,
  'demo:state': demoView,
  'demo:skip': demoSkip,
  'demo:done': demoDone,
  'demo:font': demoFont,
  'exclude:add': accountManaged(excludeSite),
  'exclude:remove': accountManaged(includeSite),
  // Sites added before their icon was looked up (or while offline): look them up once.
  'sites:discover': () => {
    for (const c of S.policy.customSites.filter((x) => (!x.iconUrl || DARK_ICON.test(x.iconUrl)) && !discovering.has(x.id))) void discoverAndPatch(c.id);
    return ok;
  },
  'site:remove': accountManaged(removeSite),
  // The current normalized policy, as the background holds it (not read and re-normalized from storage for
  // each asker). `policy:set` has no handler here: no page sends it, and the dev control channel has its own.
  'policy:get': () => S.policy,
  // The Pro account's site list is not a local setting: a reset keeps it (the account switches it off).
  // Without an AI judge, the mode changes and protection stays as it is (off): it cannot be turned on (judgeMissing).
  'mode:set': async (msg) => save({ ...latest(), mode: msg.mode, enabled: latest().enabled || !(await judgeMissing()) }),
  'judge:byok': chooseByok,
  'cloud:signin': signIn,
  'cloud:signout': signOut,
  'cloud:service-set': setService,
  // Sync now: the account's site list, fetched and applied (or kept pending) before the status answers.
  'cloud:sync': async (m) => { await syncManagedSites(m.reason === 'settings' ? 'settings-shown' : 'sync-now'); return status(); },
  'cloud:status': (msg) => cloudStatus(Boolean(msg.refresh)),
  'guard:set': accountManaged(setGuard),
  'secrets:key': setKey,
  'session:set': setSession,
  // Content script asks for its own frame's host (sender.url is the frame, tab.url the top page).
  'guard:config': (_msg, sender) => guardConfig(hostOfUrl(sender.url ?? sender.tab?.url)),
  'setup:open': async (msg) => { await openSetupWindow(msg.step === 'demo' ? 'demo' : undefined); return ok; },
  'judge:test': testJudge,
  'consent:set': setConsent,
  'status:get': status,
  'pin:set': accountManaged(setPin),
  'pin:clear': clearPin,
  'pin:unlock': unlockPin,
};

/** Answers a message from the popup, the settings pages or the content script; unknown types get undefined. */
export async function handle(msg: Message, sender: Sender): Promise<unknown> {
  const handler = HANDLERS[msg.type] as ((m: Message, s: Sender) => unknown) | undefined;
  return handler?.(msg, sender);
}
