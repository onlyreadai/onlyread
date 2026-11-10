import { CODEC_WRITE_PREFIXES } from './codecs/index';
import { PROVIDERS, isProviderId } from '../shared/providers';
import type { AccountEdit, CustomSite, ManagedSites, Policy } from '../shared/types';
import defaults from '../../policy/default.json';
import { BUILTIN_SITES, builtinForHost, builtinSite, isPublicSuffix, resolveEffective, validHost } from './sites';
import { health } from './storage-health';
import { onOwnedChange, ownSet } from './owned-storage';

const KEY = 'policy';
/** Where an invalid stored policy is kept (with the error and when) instead of being lost. */
export const BACKUP_KEY = 'policyBackup';

// Replaced by esbuild at build time (see scripts/build.mjs). Absent under vitest, hence the guard.
declare const __ONLYREAD_DIST__: boolean;
function distBuild(): boolean {
  try { return __ONLYREAD_DIST__ === true; } catch { return false; }
}
declare const __ONLYREAD_DEV_SERVICE__: string;
/** A development build built to start on the real Pro service (ONLYREAD_DEV_SERVICE=production, scripts/build.mjs). */
function devOnProduction(): boolean {
  try { return __ONLYREAD_DEV_SERVICE__ === 'production'; } catch { return false; }
}

/** A local mock Pro service's address (the fixture server), as a development build may have stored it. */
const LOCAL_SERVICE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

/** A development build made against production (ONLYREAD_DEV_SERVICE=production) that finds the local mock's address
 *  stored from an earlier build: the address to move to, once (index.ts). Undefined otherwise. Later choices, the
 *  settings page's Pro service or a test's, stand. */
export function devServiceMove(p: Policy, moved: boolean): string | undefined {
  if (moved || distBuild() || !devOnProduction() || !LOCAL_SERVICE.test(p.cloud.serviceUrl)) return undefined;
  return RELEASE_SERVICE_URL;
}

/** Development builds (unpacked from the repo) expose Monitor mode for adding a site; releases always enforce. */
export function devBuild(): boolean { return !distBuild(); }

/** The real OnlyRead Pro service, as a release uses it (policy/default.json). */
export const RELEASE_SERVICE_URL: string = (defaults as Policy).cloud.serviceUrl;

/** The local mock Pro backend a development build defaults to: the fixture server (fixtures/cloud/mock.ts), on the
 *  dev sink's host. Derived rather than written out, so no localhost address reaches a release bundle. */
export function devMockServiceUrl(devSink: string | null | undefined): string | undefined {
  if (!devSink) return undefined;
  try { return new URL('/cloud', devSink).toString().replace(/\/$/, ''); } catch { return undefined; }
}

export function defaultPolicy(): Policy {
  const d = structuredClone(defaults as Policy);
  // Every site codec's write prefix is refused by default; the codecs declare them (codecs/index.ts).
  d.blockedShapes = union(d.blockedShapes ?? [], [...CODEC_WRITE_PREFIXES]);
  if (distBuild()) {
    // Distribution build: drop the dev sink (also turns off the localhost control channel). Agent
    // sessions are detected on their own (agent-detect.ts), so the default stays "during agent sessions".
    // Releases always enforce; Monitor is a development tool.
    d.devSink = null;
    d.mode = 'enforce';
  } else {
    // Dev builds talk to the mock Pro backend in the fixture server; a sign-in falls back to the real service when
    // the mock does not answer (cloud-session.ts signInFallback). Built with ONLYREAD_DEV_SERVICE=production, the real
    // one from the start.
    if (!devOnProduction()) d.cloud.serviceUrl = devMockServiceUrl(d.devSink) ?? d.cloud.serviceUrl;
  }
  return d;
}

/** Only the judge fields this version knows; anything else a stored policy carries is dropped. */
function pickJudge(j: Policy['judge']): Policy['judge'] {
  const byok = j.byok && typeof j.byok === 'object' ? j.byok : { id: 'openrouter' as const };
  return {
    provider: j.provider,
    byok: { id: byok.id, ...(byok.model ? { model: byok.model } : {}) },
    timeoutMs: j.timeoutMs,
    llmTimeoutMs: j.llmTimeoutMs,
  };
}

const union = (a: string[], b: unknown): string[] => [...new Set([...a, ...(Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : [])])];

type PolicyCheck = [ok: (p: Policy) => boolean, message: (p: Policy) => string];

const inRange = (lo: number, hi: number) => lo >= 0 && lo <= hi && hi <= 1;
const HTTPS_URL = /^https:\/\/[^/]+/;
const DEV_SERVICE_URL = /^https:\/\/[^/]+|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
/** A release talks to OnlyRead Pro over https only; a development build may also use the local mock. */
const safeServiceUrl = (url: string): boolean => (distBuild() ? HTTPS_URL : DEV_SERVICE_URL).test(url);

/** Every field a stored or imported policy must get right, with the message that names it. */
const POLICY_CHECKS: PolicyCheck[] = [
  [(p) => typeof p.enabled === 'boolean', () => 'enabled must be a boolean'],
  [(p) => p.mode === 'monitor' || p.mode === 'enforce', (p) => `mode must be monitor|enforce, got ${String(p.mode)}`],
  [(p) => typeof p.sites === 'object' && p.sites !== null, () => 'sites must be an object'],
  [(p) => inRange(p.thresholds.allow, p.thresholds.block), () => 'thresholds must satisfy 0 <= allow <= block <= 1'],
  [(p) => inRange(p.thresholds.reviewAllow ?? p.thresholds.allow, p.thresholds.reviewBlock ?? p.thresholds.block),
    () => 'review thresholds must satisfy 0 <= reviewAllow <= reviewBlock <= 1'],
  [(p) => p.websockets === 'block' || p.websockets === 'allow', () => 'websockets must be block|allow'],
  [(p) => ['notice', 'reload', 'discard'].includes(p.onRefusedMutation), () => 'onRefusedMutation must be notice|reload|discard'],
  [(p) => p.blockResponse === 'fail' || p.blockResponse === 'reject', () => 'blockResponse must be fail|reject'],
  [(p) => typeof p.allowReadTracking === 'boolean', () => 'allowReadTracking must be a boolean'],
  [(p) => p.judge.provider === 'byok' || p.judge.provider === 'cloud', () => 'judge.provider must be byok|cloud'],
  [(p) => Boolean(p.judge.byok) && isProviderId(p.judge.byok.id), () => `judge.byok.id must be one of ${Object.keys(PROVIDERS).join('|')}`],
  [(p) => p.judge.timeoutMs > 0, () => 'judge.timeoutMs must be positive'],
  [(p) => p.judge.llmTimeoutMs > 0, () => 'judge.llmTimeoutMs must be positive'],
  [(p) => safeServiceUrl(p.cloud.serviceUrl ?? ''), () => `cloud.serviceUrl must be https${distBuild() ? '' : ' (or http://localhost for development)'}`],
  [(p) => p.cloud.timeoutMs > 0, () => 'cloud.timeoutMs must be positive'],
  [(p) => p.attachWhen === 'always' || p.attachWhen === 'agent-session', () => 'attachWhen must be always|agent-session'],
  [(p) => p.attachScope === 'all-tabs' || p.attachScope === 'target-tabs', (p) => `attachScope must be all-tabs|target-tabs, got ${String(p.attachScope)}`],
  [(p) => p.guardAll === undefined || typeof p.guardAll === 'boolean', () => 'guardAll must be a boolean'],
  [(p) => p.guardAllOff === undefined || (Array.isArray(p.guardAllOff) && p.guardAllOff.length <= 500 && p.guardAllOff.every((id) => typeof id === 'string' && id.length <= 255)), () => 'guardAllOff must be at most 500 site ids'],
  [(p) => p.excludeSites === undefined || (Array.isArray(p.excludeSites) && p.excludeSites.length <= 500 && p.excludeSites.every((h) => typeof h === 'string' && h.length <= 255)), () => 'excludeSites must be at most 500 host names'],
  [(p) => p.reviewBand === 'block' || p.reviewBand === 'llm' || p.reviewBand === 'human', (p) => `reviewBand must be block|llm|human, got ${String(p.reviewBand)}`],
  // decision.ts tests `!policy.uploads`: a stored `uploads: "no"` would allow uploads.
  [(p) => typeof p.uploads === 'boolean', () => 'uploads must be a boolean'],
  [(p) => typeof p.downloads === 'boolean', () => 'downloads must be a boolean'],
  [(p) => typeof p.opaqueToReview === 'boolean', () => 'opaqueToReview must be a boolean'],
  [(p) => Array.isArray(p.blockedGetPaths) && Array.isArray(p.telemetryAllow), () => 'path lists must be arrays'],
];

/** A custom site as stored: an id, at least one domain, each a non-empty string, a boolean `enabled`, and a string name
 *  when it has one. Checking only the id's type and the array's length is not enough: a stored `domains: [123]` would
 *  make `isTargetHost` throw on `toLowerCase` for every request in every held tab (each paused request then hanging
 *  unanswered) and in every guard check. */
const validCustomSite = (c: CustomSite): boolean =>
  Boolean(c) && typeof c.id === 'string' && Array.isArray(c.domains) && c.domains.length > 0
  && c.domains.every((d) => typeof d === 'string' && d.length > 0) && typeof c.enabled === 'boolean'
  && (c.name === undefined || typeof c.name === 'string');

function validateCustomSites(sites: Policy['customSites']): void {
  for (const c of sites) if (!validCustomSite(c)) throw new Error('customSites entries need an id, string domains and a boolean enabled');
}

const validManagedCustom = (c: unknown): boolean => validCustomSite(c as CustomSite);

/** OnlyRead Pro's lib/managed.ts stores at most this many custom sites, with names of at most MAX_SITE_NAME characters;
 *  a longer list is not the account's. Without the cap a crafted or broken answer with 5,000 sites would make a
 *  917 KB policy with 5,002 target domains. */
const MAX_MANAGED_CUSTOM = 100;
const MAX_SITE_NAME = 60;

/** A custom site from the account's list as a site of its own, or undefined to leave it out: every host a host name,
 *  none a public suffix (`co.uk` would guard every .co.uk host), none covered by a built-in site (the account
 *  page refuses such a host and says to tick that site; here it would be guarded by the judge alone, without the site's
 *  codec and verdicts), and its id not a built-in site's (which would import that site's verdicts and show two rows). Left out one by one rather than failing the list: an older server may hold a suffix from before the
 *  check, and a newer extension may ship a built-in site for a host the account added as custom. */
function siteOfItsOwn(c: CustomSite): CustomSite | undefined {
  const hosts = [c.id, ...c.domains];
  if (hosts.some((h) => !validHost(h) || isPublicSuffix(h) || builtinForHost(h)) || builtinSite(c.id)) return undefined;
  const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : c.id;
  return { id: c.id, name: name.slice(0, MAX_SITE_NAME), domains: [...new Set(c.domains)], enabled: c.enabled };
}

/** The Pro account's site list when well-formed, else undefined: dropped, never an error, so a bad copy cannot make
 *  the whole policy invalid (cloud-sync.ts). Only built-in ids this version knows are kept (the server's catalog may
 *  be newer); custom sites must be valid as local ones are, and each a site of its own (`siteOfItsOwn`), at most
 *  MAX_MANAGED_CUSTOM of them, each id once. Dropping it is itself checked by the lock wherever a change is: a policy
 *  written around the background without it lowers protection and is put back. */
export function normalizeManaged(m: unknown): ManagedSites | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const { version, sites, customSites, fetchedAt, guardAll, browser, browserSites, browserVersion, browsers } = m as Partial<Record<keyof ManagedSites, unknown>>;
  if (!Number.isInteger(version) || (version as number) < 1) return undefined;
  if (!sites || typeof sites !== 'object' || !Array.isArray(customSites)) return undefined;
  const custom = managedCustomSites(customSites);
  if (!custom) return undefined;
  const known = knownSites(sites);
  const levels = { ...withLevel('guardAll', guardAll), ...withLevel('browser', browser), ...withBrowserSites(browserSites) };
  const counts = { ...(count(browserVersion) !== undefined ? { browserVersion: count(browserVersion) } : {}), ...(count(browsers) !== undefined ? { browsers: count(browsers) } : {}) };
  return { version: version as number, sites: known, customSites: custom, fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : 0, ...levels, ...counts };
}

const count = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

/** At most this many changes wait for the account: more than a person makes while offline. */
const MAX_ACCOUNT_EDITS = 100;

/** The changes waiting for the account (types.ts AccountEdit), each checked: a built-in id this version knows, or a
 *  host that can be a site of its own. A malformed one is dropped (it could only ever be refused by the account). */
function normalizeAccountEdits(v: unknown): AccountEdit[] | undefined {
  const out = Array.isArray(v) ? v.slice(-MAX_ACCOUNT_EDITS).map(accountEdit).filter((e): e is AccountEdit => e !== undefined) : [];
  return out.length ? out : undefined;
}

function accountEdit(e: unknown): AccountEdit | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const { op, scope, id, builtin, name, version, at } = e as Record<string, unknown>;
  if ((op !== 'add' && op !== 'remove') || (scope !== 'account' && scope !== 'browser') || typeof id !== 'string' || typeof builtin !== 'boolean') return undefined;
  if (builtin ? !BUILTIN_SITES.some((b) => b.id === id) : !siteOfItsOwn({ id, name: id, domains: [id], enabled: true })) return undefined;
  return { op, scope, id, builtin, ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 60) } : {}), ...(count(version) !== undefined ? { version: count(version) } : {}), at: typeof at === 'number' ? at : 0 };
}

/** Built-in sites this extension knows, from a list's `sites`; ids it does not are dropped. */
function knownSites(sites: unknown): ManagedSites['sites'] {
  const known: ManagedSites['sites'] = {};
  for (const b of BUILTIN_SITES) {
    const v = (sites as Record<string, unknown>)[b.id];
    if (v && typeof v === 'object') known[b.id] = { enabled: (v as { enabled?: unknown }).enabled === true };
  }
  return known;
}

/** The sites the account page guards in this browser alone; left out when malformed (the account's own list and
 *  this browser's still stand) or empty. */
function withBrowserSites(v: unknown): Pick<ManagedSites, 'browserSites'> {
  if (!v || typeof v !== 'object') return {};
  const { sites, customSites } = v as { sites?: unknown; customSites?: unknown };
  if (!sites || typeof sites !== 'object' || !Array.isArray(customSites)) return {};
  const custom = managedCustomSites(customSites);
  if (!custom) return {};
  const known = knownSites(sites);
  return Object.values(known).some((s) => s.enabled) || custom.some((c) => c.enabled) ? { browserSites: { sites: known, customSites: custom } } : {};
}

/** A "guard every site" level from the account: present only when on or carrying allowed hosts, its hosts kept as
 *  given (sites.ts excludeHost cleans them when the effective policy is built); a malformed one is left out, which
 *  can only guard more (an allow list that fails to parse allows nothing). */
function withLevel(key: 'guardAll' | 'browser', v: unknown): Partial<Pick<ManagedSites, 'guardAll' | 'browser'>> {
  if (!v || typeof v !== 'object') return {};
  const { on, excludeSites } = v as { on?: unknown; excludeSites?: unknown };
  const exclude = Array.isArray(excludeSites) ? excludeSites.filter((h): h is string => typeof h === 'string' && h.length <= 255).slice(0, 500) : [];
  return on === true ? { [key]: { on: true, excludeSites: exclude } } : {};
}

/** The account's custom sites, each a site of its own and each id once, or undefined when an entry is malformed or
 *  more than MAX_MANAGED_CUSTOM remain. */
function managedCustomSites(customSites: unknown[]): CustomSite[] | undefined {
  if (!customSites.every(validManagedCustom)) return undefined;
  const custom: CustomSite[] = [];
  for (const c of customSites as CustomSite[]) {
    const own = siteOfItsOwn(c);
    if (own && !custom.some((x) => x.id === own.id)) custom.push(own);
  }
  return custom.length > MAX_MANAGED_CUSTOM ? undefined : custom;
}

/** `re:` entries in telemetryAllow must be valid regular expressions. */
function validateTelemetryPatterns(patterns: unknown[]): void {
  for (const pat of patterns) {
    if (typeof pat !== 'string' || !pat.trim().startsWith('re:')) continue;
    const src = pat.trim().slice(3);
    if (!src) throw new Error('telemetryAllow: empty regex');
    try { new RegExp(src); } catch { throw new Error(`telemetryAllow: invalid regex ${pat}`); }
  }
}

/** Throws with the first broken field. Order matters only for which message a doubly broken policy gets. */
function validatePolicy(p: Policy): void {
  for (const [ok, message] of POLICY_CHECKS.slice(0, 3)) if (!ok(p)) throw new Error(message(p));
  validateCustomSites(p.customSites);
  for (const [ok, message] of POLICY_CHECKS.slice(3)) if (!ok(p)) throw new Error(message(p));
  validateTelemetryPatterns(p.telemetryAllow as unknown[]);
}

/** Absent rather than undefined, so a stored copy has no such key (no list; nothing waiting for the account). */
function dropAbsent(p: Policy): void {
  for (const k of ['managed', 'accountEdits'] as const) if (p[k] === undefined) delete p[k];
}

/** Fill missing fields from defaults and reject obviously broken values. */
export function normalizePolicy(input: unknown): Policy {
  if (typeof input !== 'object' || input === null) throw new Error('policy must be an object');
  const d = defaultPolicy();
  const p = input as Partial<Policy>;
  const out: Policy = {
    ...d,
    ...p,
    // The judge's thresholds are part of the product, tuned on the evaluation set, and not a user setting
    // (no UI edits them): a stored copy is only an old default, so the shipped values always win.
    thresholds: { ...d.thresholds },
    // The global rule lists ship with the product and no UI edits them. Allow-lists always come from the
    // shipped version, so a stored copy can neither keep an allowance that was removed nor hide a new one.
    // Block-lists are the shipped list plus any stored entries: stored entries can only add blocking.
    telemetryAllow: [...(d.telemetryAllow ?? [])],
    allowedShapes: [...(d.allowedShapes ?? [])],
    readTrackingShapes: [...(d.readTrackingShapes ?? [])],
    blockedGetPaths: union(d.blockedGetPaths ?? [], p.blockedGetPaths),
    blockedShapes: union(d.blockedShapes ?? [], p.blockedShapes),
    // The judge's time limits ship with the product and no UI edits them: in a release a stored copy is only an old
    // default, so the shipped ones win. A development build keeps stored ones (tests set
    // their own).
    judge: pickJudge({ ...d.judge, ...(p.judge ?? {}), ...(distBuild() ? { timeoutMs: d.judge.timeoutMs, llmTimeoutMs: d.judge.llmTimeoutMs } : {}) }),
    // A release's Pro address ships with it and no UI edits it: a stored copy is only an old default, so a release
    // that moves the service reaches the new address. A development build keeps the stored one (the mock or the real
    // service, chosen at sign-in in messages.ts).
    cloud: { ...d.cloud, ...(p.cloud ?? {}), ...(distBuild() ? { serviceUrl: d.cloud.serviceUrl } : {}) },
    sites: { ...Object.fromEntries(BUILTIN_SITES.map((b) => [b.id, { enabled: false }])), ...d.sites, ...(p.sites ?? {}) },
    customSites: Array.isArray(p.customSites) ? p.customSites : d.customSites,
    managed: normalizeManaged(p.managed),
    accountEdits: normalizeAccountEdits(p.accountEdits),
    effective: d.effective,
  };
  dropAbsent(out);
  validatePolicy(out);
  // Monitor mode and the dev sink are for development builds only: a release never logs a write instead of
  // refusing it, and a stored or imported policy cannot turn the localhost control channel back on.
  if (distBuild()) { out.mode = 'enforce'; out.devSink = null; }
  out.effective = resolveEffective(out);
  return out;
}

/** The field the first failed check names: `uploads must be a boolean` → uploads, `judge.provider must…` →
 *  judge.provider, `customSites entries need…` → customSites. */
function brokenField(message: string): string[] | undefined {
  const m = /^([A-Za-z]+(?:\.[A-Za-z]+)?)/.exec(message);
  return m ? m[1]!.split('.') : undefined;
}

/** A stored policy with one bad value repaired: that value, then its whole top-level field, reset to the default
 *  (one field is repaired rather than discarding the person's sites). Undefined
 *  when it is broken in more than one way, or in a way no field explains; the defaults are used then. */
function repairPolicy(stored: unknown, message: string): { policy: Policy; field: string } | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const field = brokenField(message);
  if (!field) return undefined;
  const paths = field.length === 2 ? [field, [field[0]!]] : [field];
  for (const path of paths) {
    const copy = structuredClone(stored) as Record<string, unknown>;
    if (path.length === 2) {
      const inner = copy[path[0]!];
      if (!inner || typeof inner !== 'object') continue;
      delete (inner as Record<string, unknown>)[path[1]!];
    } else {
      delete copy[path[0]!];
    }
    try { return { policy: normalizePolicy(copy), field: path.join('.') }; } catch { /* still broken: the wider field, then give up */ }
  }
  return undefined;
}

export async function getPolicy(): Promise<Policy> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  if (stored === undefined) {
    const d = defaultPolicy();
    await store(d); // its own write, so the change handler does not treat the first-run defaults as an outside change
    return d;
  }
  try {
    const p = normalizePolicy(stored);
    health.policy = undefined;
    health.policyRepaired = undefined;
    lastWritten = p;
    return p;
  } catch (err) {
    // One bad value is reset to its default and the rest kept; a policy broken in more ways gives way to the
    // defaults, which have every site switched off, so the person's sites would seem to vanish.
    // Either way the copy is kept under BACKUP_KEY and status says so. The invalid copy stays under KEY until the
    // next setPolicy, which replaces it with a valid one.
    const message = err instanceof Error ? err.message : String(err);
    const repaired = repairPolicy(stored, message);
    console.warn(`[onlyread] stored policy invalid, ${repaired ? `${repaired.field} reset` : 'using defaults'}:`, err);
    health.policy = repaired
      ? `The stored settings had an invalid value (${message}); ${repaired.field} was reset to its default and the old copy is kept under ${BACKUP_KEY}`
      : `The stored settings were invalid (${message}); the defaults are in use and the old copy is kept under ${BACKUP_KEY}`;
    health.policyRepaired = repaired?.field;
    try { await chrome.storage.local.set({ [BACKUP_KEY]: { policy: stored, error: message, at: Date.now() } }); } catch { /* storage failing too; the problem is reported */ }
    lastWritten = repaired?.policy ?? defaultPolicy();
    return lastWritten;
  }
}

/** The stored policy as the background last knew it: what `store` last wrote (set as the write starts, so a change
 *  built in the same tick already sees it), what `getPolicy` read at startup, or an outside write index.ts accepted
 *  (`policyAccepted`). It runs ahead of `S.policy` while a change event is still queued, and is never a refused outside
 *  write. A settings change built from `S.policy` carries this copy's `managed` (`carryManaged`), cloud-sync.ts lays
 *  the account's list over it, and index.ts puts it back after a refused outside write, so none of them writes over
 *  what another wrote a moment ago. */
let lastWritten: Policy | undefined;
export function lastWrittenPolicy(): Policy | undefined { return lastWritten; }
/** index.ts: an outside write passed the lock and is in force; the background builds on it from here. */
export function policyAccepted(p: Policy): void { lastWritten = p; }

/** `p` with the Pro account's list set to `managed` (undefined: the browser's own site lists are in force). */
export function withManaged(p: Policy, managed: ManagedSites | undefined): Policy {
  const { managed: _drop, ...rest } = p;
  return managed ? { ...rest, managed } : rest;
}

/** A settings change built from `S.policy`, carrying the Pro account's list as last written. cloud-sync.ts may have
 *  written the list a moment ago with its change event still queued; without the carry such a change (the settings page
 *  sends `sites:discover` and `cloud:sync` on the same open) would write the policy back without it, so the guard would
 *  fall back to the local lists with no log line, and the next poll's 304 would restore nothing. */
export function carryManaged(p: Policy): Policy {
  return lastWritten ? withManaged(p, lastWritten.managed) : p;
}

/** Writes a policy as the background's own: a nonce-stamped write (owned-storage.ts), so the change handler tells it
 *  from a policy written around the background, which is checked against the lock. */
async function store(p: Policy): Promise<void> {
  const before = lastWritten;
  lastWritten = p;
  try {
    await ownSet({ [KEY]: p });
  } catch (err) {
    if (lastWritten === p) lastWritten = before; // nothing was written, unless a later write has taken over meanwhile
    throw err;
  }
}

/** Stores a policy. `keepReport`: the stored copy is being replaced by its own repair (startup), so what status
 *  says about it stays until the person changes a setting. */
export async function setPolicy(p: unknown, opts: { keepReport?: boolean } = {}): Promise<Policy> {
  const normalized = normalizePolicy(p);
  await store(normalized);
  if (!opts.keepReport) { health.policy = undefined; health.policyRepaired = undefined; } // a valid policy is stored again
  return normalized;
}

/** `cb` for every valid change (own: the background wrote it); `onInvalid` for one that does not validate. The
 *  background only ever writes valid policies, so an invalid change came from around it and is never
 *  legitimate: the caller puts the current policy back, so a copy that is both invalid and weakening never sits in
 *  storage until the next start repairs its one bad value and takes the rest. */
export function onPolicyChange(cb: (p: Policy, own: boolean, old: Policy | undefined) => void, onInvalid: (message: string) => void): void {
  onOwnedChange((changes, own) => {
    if (!changes[KEY]) return; // an own write of an unchanged policy, or of another key: nothing to apply here
    let p: Policy;
    try {
      p = normalizePolicy(changes[KEY].newValue);
    } catch (err) {
      console.warn('[onlyread] invalid policy written to storage:', err);
      onInvalid(err instanceof Error ? err.message : String(err));
      return;
    }
    // The policy stored before the change, as well: a worker woken by an outside write reads that write at startup, so
    // the policy in force is already the new one, and only the old value shows what the write lowers.
    let old: Policy | undefined;
    try { old = changes[KEY].oldValue === undefined ? undefined : normalizePolicy(changes[KEY].oldValue); } catch { old = undefined; }
    cb(p, own, old);
  });
}
