import { PROVIDERS } from '../shared/providers';
import type { EffectivePolicy, Policy } from '../shared/types';

type Rule = chrome.declarativeNetRequest.Rule;
type ResourceType = `${chrome.declarativeNetRequest.ResourceType}`;
type RequestMethod = `${chrome.declarativeNetRequest.RequestMethod}`;

/** Dynamic rule ids start here so they never collide with anything static. */
export const RULE_ID_BASE = 1000;
/** Emergency rule: block every non-GET to targets while a debugger session is missing. */
export const FAIL_CLOSED_RULE_ID = RULE_ID_BASE + 900;
/** Session rule (dynamic rules cannot use tabIds): non-GET requests that belong to no tab, i.e. service/shared workers. */
export const WORKER_ORIGIN_RULE_ID = RULE_ID_BASE + 901;
/** Session rule: non-GET requests from guarded tabs OnlyRead could not attach to. */
export const UNGUARDED_TAB_RULE_ID = RULE_ID_BASE + 902;
/** Session rule: non-GET requests from guarded tabs whose page is closing (closing-tabs.ts). */
export const CLOSING_TAB_RULE_ID = RULE_ID_BASE + 904;
/** Session rule: while an AI agent works in this browser, the Pro account page's changes that lower protection
 *  (account-lock.ts). */
export const ACCOUNT_LOCK_RULE_ID = RULE_ID_BASE + 905;
/** The fail-closed rule's POST half, which leaves out the background's own requests by initiator. */
export const FAIL_CLOSED_POST_RULE_ID = RULE_ID_BASE + 906;
/** Session rule: every non-GET request an extension page in a tab (options, setup) sends to a guarded host. */
export const EXTENSION_PAGE_RULE_ID = RULE_ID_BASE + 907;
/** Session rule: every non-GET request an extension page in no tab (the popup) sends to a guarded host other than the
 *  background's own services. */
export const EXTENSION_UNTABBED_RULE_ID = RULE_ID_BASE + 908;
/** Session rule: a stanza-guarded site's socket, let through in the tabs where the guard is in place (socket-guard.ts). */
export const SOCKET_GUARD_RULE_ID = RULE_ID_BASE + 909;
/** Session rule of the development `blockall:set` command (refuse every request to the guarded domains). */
export const BLOCK_ALL_RULE_ID = RULE_ID_BASE + 903;

/** Resource types a side-effecting GET can be. Static assets are excluded on purpose. */
const SIDE_EFFECT_TYPES: ResourceType[] = ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'other'];

const MUTATING = new Set(['PUT', 'PATCH', 'DELETE']);
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const SIDE_EFFECT_TYPE_SET = new Set<string>(SIDE_EFFECT_TYPES);
/** The methods DNR names; any other (WebDAV's PROPPATCH or MOVE, QUERY, a custom verb) is its `other`. */
const NAMED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'CONNECT', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** What the cover rules refuse (fail-closed, worker-origin, unguarded and closing tabs): every method that can carry a
 *  write, `other` included, so a request with a non-standard method does not pass wherever DNR is the only guard; the
 *  debugger path sends such a method to the judge. */
const COVER_METHODS: RequestMethod[] = ['post', 'put', 'patch', 'delete', 'other'];
/** A method a cover rule refuses: a POST, a mutating method, or one DNR files under `other`. */
const covered = (m: string): boolean => m === 'POST' || MUTATING.has(m) || !NAMED_METHODS.has(m);

/**
 * Mirror DNR's `urlFilter: "<p>^"` matching: the pattern occurs in the URL followed by DNR's
 * separator (end of URL, or any char that is not a letter, digit, _, -, . or %). No constraint on
 * what precedes, so "action=RESPOND" matches "?action=RESPOND&x" but "/logout" does not match
 * "/logoutHelper.js". This is the blockedGetPaths semantics the compiled rule actually uses.
 */
export function urlFilterHit(url: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  const u = url.toLowerCase();
  for (let from = 0; ; from += 1) {
    const i = u.indexOf(p, from);
    if (i === -1) return false;
    const after = i + p.length >= u.length ? '' : u[i + p.length]!;
    if (after === '' || !/[a-z0-9_\-.%]/.test(after)) return true;
    from = i;
  }
}

interface DnrOptions {
  failClosed?: boolean; websockets?: 'block' | 'allow'; workerOrigin?: boolean; tabId?: number; unguardedTabs?: number[];
  /** Hosts whose workers the debugger holds (their requests are judged, not fenced), and this request's initiator. */
  workerHosts?: string[]; initiator?: string;
  /** Guarded tabs whose page is closing (closing-tabs.ts). */
  closingTabs?: number[];
  /** The request's initiator is this extension, and the extension-page rules are installed (enforce). */
  extensionPage?: boolean;
  /** The hosts the background sends its own requests to (backgroundHosts), which the untabbed extension-page rule lets
   *  pass; without them a request from no tab is not labeled the extension page's. */
  ownHosts?: string[];
}

const hostOfOrigin = (origin: string): string => { try { return new URL(origin).hostname; } catch { return ''; } };

/** The effective policy as dnrReasonFor reads it: the blocked GET paths, and for a socket the fields the socket rule is
 *  built from (optional, so a caller that labels no sockets need not carry them). */
type DnrEffective = Pick<EffectivePolicy, 'blockedGetPaths'> & Partial<Pick<EffectivePolicy, 'targetDomains' | 'guardAll' | 'excludeDomains' | 'exemptDomains' | 'websocketBlockDomains' | 'websocketAllowDomains' | 'telemetryAllow' | 'siteRules'>>;

/** Whether `host` is one of `domains` or under one, as a DNR domain condition matches it. */
const underAny = (host: string, domains: string[]): boolean => domains.some((d) => host === d || host.endsWith(`.${d}`));

/** Whether the socket rule buildRules makes refuses a socket to `host`: with everything guarded and the global default
 *  blocking, every host but the left-out ones; otherwise the blocking sites' domains alone. Labelling from the global default alone
 *  would claim every refused socket while it is `block` (another extension's block on Linear, whose profile allows
 *  sockets, included), and none while it is `allow`, though a profile may still block. */
function websocketRefused(host: string, eff: DnrEffective, websockets: 'block' | 'allow' | undefined): boolean {
  const wsDomains = normalizeDomains(eff.websocketBlockDomains ?? []);
  if (eff.guardAll && (websockets ?? 'block') === 'block') {
    const listed = normalizeDomains(eff.targetDomains ?? []);
    return !underAny(host, leftOut({ excludeDomains: eff.excludeDomains ?? [], exemptDomains: eff.exemptDomains ?? [] }, eff.websocketAllowDomains ?? [], wsDomains.filter((d) => underAny(d, listed))));
  }
  // Under guard every site an allowed host stays out, unless a listed site covers it (buildRules `freed`).
  const freed = eff.guardAll ? leftOut({ excludeDomains: eff.excludeDomains ?? [], exemptDomains: eff.exemptDomains ?? [] }, [], normalizeDomains(eff.targetDomains ?? [])) : [];
  return underAny(host, wsDomains) && !underAny(host, freed);
}

/** What may follow a telemetry endpoint (a telemetryAllow pattern with a path in it) before the query, fragment or end:
 *  nothing, a trailing slash, or a real file extension ("/TealeafTarget" for "/TealeafTarget.jsp", Blue Triangle's "/analytics.rcv"). A short fixed list,
 *  so an RPC verb suffix ("/api/analytics.delete") does not pass as an extension. Shared by the list's matcher
 *  (decision.ts) and the beacon rules, so the two end a match alike. */
export const TELEMETRY_PATH_END = '(?:/|\\.(?:jsp|php|aspx?|do|cgi|gif|png|js|json|html?|rcv))?(?:[?#]|$)';

/** A telemetry address (telemetryAllow) as a URL regex for a beacon's allow rule, or undefined when it cannot be one
 *  exactly. Never broader than the exclude-list: a path pattern must start the path (the list's match may sit anywhere
 *  on token boundaries), a host pattern must name the host (a subdomain of it too), and the match must end the path as
 *  the list's does (TELEMETRY_PATH_END: then a trailing `/` or a known file extension at most, then `?`, `#` or the end),
 *  unless the pattern ends in `/` or `*` (a prefix). `re:` patterns and `endpoint?query` forms are left out: their
 *  beacons stay refused. */
export function beaconTelemetryRegex(pattern: string): string | undefined {
  let t = String(pattern ?? '').trim();
  if (!t || t.startsWith('re:') || t.includes('?')) return undefined;
  const prefix = t.endsWith('*') || t.endsWith('/');
  if (t.endsWith('*')) t = t.slice(0, -1);
  if (!t || t.includes('*')) return undefined;
  const end = prefix ? '' : TELEMETRY_PATH_END;
  if (t.startsWith('/')) return `^https?://[^/?#]+${escapeRegex(t)}${end}`;
  const slash = t.indexOf('/');
  if (slash <= 0 || !/^[a-z0-9.-]+$/i.test(t.slice(0, slash))) return undefined;
  return `^https?://(?:[^/?#]*\\.)?${escapeRegex(t)}${end}`;
}

/** Whether a beacon to `url` goes to a telemetry address of the global list, or of a site whose domains cover its host:
 *  the allow rules buildRules makes over the beacon refusal. */
function beaconToTelemetry(url: string, eff: DnrEffective): boolean {
  const host = hostOfOrigin(url);
  const own = (eff.siteRules ?? []).filter((r) => underAny(host, normalizeDomains(r.domains)));
  const patterns = [...(eff.telemetryAllow ?? []), ...own.flatMap((r) => r.telemetryAllow)];
  return patterns.some((p) => { const re = beaconTelemetryRegex(p); return re !== undefined && new RegExp(re, 'i').test(url); });
}

/** POSTs refused by resource type alone: page loads (post-navigation) and beacons. */
const POST_RULE_TYPES: Record<string, string | undefined> = { main_frame: 'post-navigation', sub_frame: 'post-navigation', ping: 'beacon' };

/** Whether the extension-page rules refuse a request of OnlyRead's own: from a page in a tab (a driven settings page), or
 *  from one in no tab (the popup) to a host that is not one of the background's own services. */
function extensionPageRefused(opts: DnrOptions, host: string): boolean {
  if (!opts.extensionPage || opts.tabId === undefined) return false;
  if (opts.tabId >= 0) return true;
  return opts.tabId === -1 && opts.ownHosts !== undefined && !underAny(host, opts.ownHosts);
}

/** The rules that cover a write the debugger cannot judge, highest priority first. */
function coverReason(opts: DnrOptions, host: string): string | null {
  if (extensionPageRefused(opts, host)) return 'extension-page';
  // Fail-closed rule has the highest priority: it blocks every non-GET method on any type.
  if (opts.failClosed) return 'fail-closed:debugger-detached';
  // A request from no tab (service/shared worker) never reaches the tab-attached debugger; in enforce it is refused.
  if (opts.workerOrigin && opts.tabId === -1 && !(opts.initiator && opts.workerHosts?.includes(hostOfOrigin(opts.initiator)))) return 'worker-origin';
  // A guarded tab the debugger does not hold: its writes are refused by rule until it does.
  if (opts.tabId !== undefined && opts.unguardedTabs?.includes(opts.tabId)) return 'unguarded-tab';
  if (opts.tabId !== undefined && opts.closingTabs?.includes(opts.tabId)) return 'closing-tab';
  return null;
}

/**
 * Why the DNR layer would block this request, or null if no rule matches. The same conditions
 * buildRules() compiles into declarativeNetRequest rules, evaluated per request. Used to label a
 * DNR block observed through webRequest, since onRuleMatchedDebug fires only for unpacked builds.
 * `resourceType` is a lowercase webRequest type (main_frame, xmlhttprequest, websocket, …).
 */
export function dnrReasonFor(
  method: string,
  url: string,
  resourceType: string | undefined,
  eff: DnrEffective,
  opts: DnrOptions = {},
): string | null {
  const m = method.toUpperCase();
  const type = (resourceType ?? '').toLowerCase();
  const cover = covered(m) ? coverReason(opts, hostOfOrigin(url)) : null;
  if (cover) return cover;
  if ((type === 'websocket' || type === 'webtransport') && websocketRefused(hostOfOrigin(url), eff, opts.websockets)) return 'websocket';
  if (MUTATING.has(m)) return 'mutating-method';
  if (m === 'POST' && type === 'ping' && beaconToTelemetry(url, eff)) return null;
  if (m === 'POST' && POST_RULE_TYPES[type]) return POST_RULE_TYPES[type]!;
  if (SAFE.has(m) && SIDE_EFFECT_TYPE_SET.has(type)) {
    const hit = eff.blockedGetPaths.find((p) => p && urlFilterHit(url, p));
    if (hit) return `blocked-get-path:${hit}`;
  }
  return null;
}

const ALL_TYPES: ResourceType[] = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
];

interface BuiltRules {
  rules: Rule[];
  /** rule id → human-readable reason, used when logging DNR matches. */
  reasons: Map<number, string>;
}

/** "https://App.Example.com:443/x" → "app.example.com". Drops empties and duplicates. */
export function normalizeDomains(domains: string[]): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    let d = String(raw ?? '').trim().toLowerCase();
    if (!d) continue;
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
    d = d.split('/')[0] ?? '';                     // path
    d = d.split(':')[0] ?? '';                     // port
    if (d) out.add(d);
  }
  return [...out];
}

type DomainCondition = Pick<chrome.declarativeNetRequest.RuleCondition, 'requestDomains' | 'excludedRequestDomains' | 'excludedInitiatorDomains'>;

/** With everything guarded, the hosts a rule leaves out: the allowed and exempt ones and `extra`, except any that
 *  overlaps one of `keep` (a domain the rule must cover) either way: one with a kept domain under it (a DNR exclusion
 *  takes its subdomains with it), and one at or under a kept domain (a listed site guards its subdomains whatever the
 *  allowances say, decision.ts guardsHost, so an allowed child of a listed site stays in the socket and page-load
 *  rules). */
function leftOut(e: Pick<EffectivePolicy, 'excludeDomains' | 'exemptDomains'>, extra: string[], keep: string[]): string[] {
  const covers = (parent: string, d: string) => d === parent || d.endsWith(`.${parent}`);
  return normalizeDomains([...e.excludeDomains, ...e.exemptDomains, ...extra]).filter((a) => !keep.some((d) => covers(a, d) || covers(d, a)));
}

/** This extension's id, the host of its own requests' initiator; undefined outside Chrome (unit tests). */
function ownExtensionId(): string | undefined {
  try { return (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id; } catch { return undefined; }
}

/** OnlyRead's background requests (its judge, its Pro service, the dev sink) carry the extension's origin as their
 *  initiator. They are all POSTs or GETs, with no tab, so only the rules that refuse such a POST leave them out by it: the
 *  worker-origin session rule (tabIds [-1]) and the fail-closed rule's POST half. With everything guarded those rules
 *  have no request domains and would refuse them; on a listed host the worker-origin rule would refuse the dev sink's
 *  POSTs to a guarded `localhost`, each logged refusal breeding the next. The other rules name no initiator: an extension
 *  page shares the background's initiator, and a dynamic rule cannot tell a tab from none (`tabIds` is for session rules
 *  only), so exempting the initiator there would let a driven settings page PUT and DELETE on a guarded host. */
export function ownInitiator(): Pick<DomainCondition, 'excludedInitiatorDomains'> {
  const own = ownExtensionId();
  return own ? { excludedInitiatorDomains: [own] } : {};
}

/** The hosts a rule covers: the guarded sites' domains, or, when everything is guarded, every host but
 *  the allowed and exempt ones. An allowed host that has a listed site's domain at or under it is not left out here
 *  (a DNR exclusion takes its subdomains with it): such a rule then also covers the allowed host's other subdomains,
 *  which only blocks more; the debugger layer (decision.ts guardsHost) tells them apart exactly. Null: no host. */
export function guardedDomains(policy: Pick<Policy, 'effective'>): DomainCondition | null {
  const e = policy.effective;
  const listed = normalizeDomains(e.targetDomains);
  if (!e.guardAll) return listed.length ? { requestDomains: listed } : null;
  const out = leftOut(e, [], listed);
  return out.length ? { excludedRequestDomains: out } : {};
}

/**
 * Requests issued by a site's service worker or shared worker carry no tab (chrome.tabs.TAB_ID_NONE): Facebook's
 * worker uploads Messenger's encrypted messages with GraphQL mutations that way. A worker the debugger holds
 * (auto-attached through a guarded tab, debugger.ts) has its requests judged like the page's; `workerHosts` are
 * the hosts whose every running worker is held, and only their requests are let past this rule. Every other
 * non-GET request from no tab on a guarded domain is refused in enforce. Session-scoped because `tabIds` is not
 * allowed in dynamic rules.
 */
export function buildWorkerOriginRule(policy: Policy, workerHosts: string[] = []): Rule | null {
  const domains = guardedDomains(policy);
  if (!domains) return null;
  return {
    id: WORKER_ORIGIN_RULE_ID, priority: 250, action: { type: 'block' },
    condition: {
      ...domains, requestMethods: COVER_METHODS, resourceTypes: ALL_TYPES, tabIds: [-1],
      ...(() => { const out = [...workerHosts, ...(ownInitiator().excludedInitiatorDomains ?? [])].sort(); return out.length ? { excludedInitiatorDomains: out } : {}; })(),
    },
  };
}

/** Blocks writes from guarded tabs the debugger could not attach to (an attach error or a setup timeout
 *  on a paused tab): without it, such a tab would have no interception at all. Scoped to those tabs, so
 *  one failure does not block every healthy tab. Null when every tab is held. */
export function buildUnguardedTabRule(policy: Policy, tabIds: number[], id = UNGUARDED_TAB_RULE_ID): Rule | null {
  const domains = guardedDomains(policy);
  if (!domains || tabIds.length === 0) return null;
  return {
    id, priority: 250, action: { type: 'block' },
    condition: { ...domains, requestMethods: COVER_METHODS, resourceTypes: ALL_TYPES, tabIds: [...tabIds] },
  };
}

/** Every non-GET request an extension page in a tab sends to a guarded host: OnlyRead's settings and setup pages never
 *  send one (they talk to the background), so such a request comes from a page driven by something else, a debugger
 *  that drives OnlyRead's own pages included, which the debugger layer never holds (it attaches to web tabs only).
 *  Session-scoped for `excludedTabIds`: the background's own requests have no tab and pass. The popup has no tab
 *  either: buildExtensionUntabbedRule covers it. Null outside Chrome (no extension id) or with no guarded host. */
export function buildExtensionPageRule(policy: Policy): Rule | null {
  const domains = guardedDomains(policy);
  const own = ownExtensionId();
  if (!domains || !own) return null;
  return {
    id: EXTENSION_PAGE_RULE_ID, priority: 250, action: { type: 'block' },
    condition: { ...domains, initiatorDomains: [own], excludedTabIds: [-1], requestMethods: COVER_METHODS, resourceTypes: ALL_TYPES },
  };
}

/** The hosts OnlyRead's background sends its own requests to: the Pro service, the dev sink (and its control channel,
 *  on the same host), and every BYOK provider's judge endpoints, all of them so a change of provider needs no new rule.
 *  The background and the popup share an initiator and both have no tab, so these hosts are what tells them apart. */
export function backgroundHosts(policy: Pick<Policy, 'cloud' | 'devSink'>): string[] {
  const providers = Object.values(PROVIDERS).flatMap((p) => [p.jev.endpoint, p.review.baseUrl]);
  return normalizeDomains([policy.cloud?.serviceUrl ?? '', policy.devSink ?? '', ...providers]).sort();
}

/** Every non-GET request an extension page in no tab sends to a guarded host: the popup, which a debugger driving
 *  OnlyRead's own pages can make send one, and which the extension-page rule (excludedTabIds [-1]) leaves out. The
 *  worker-origin rule and the fail-closed POST half leave out OnlyRead's initiator for the background's sake, so its
 *  POSTs would otherwise pass. The background's own requests go to backgroundHosts only, so those hosts are left
 *  out here; a POST from the popup to one of them (OnlyRead's own services) still passes. Null outside Chrome or with no
 *  guarded host. */
export function buildExtensionUntabbedRule(policy: Policy): Rule | null {
  const domains = guardedDomains(policy);
  const own = ownExtensionId();
  if (!domains || !own) return null;
  const excluded = normalizeDomains([...(domains.excludedRequestDomains ?? []), ...backgroundHosts(policy)]);
  return {
    id: EXTENSION_UNTABBED_RULE_ID, priority: 250, action: { type: 'block' },
    condition: { ...domains, excludedRequestDomains: excluded, initiatorDomains: [own], tabIds: [-1], requestMethods: COVER_METHODS, resourceTypes: ALL_TYPES },
  };
}

/** Lets a stanza-guarded site's socket through in the tabs whose page and workers carry the guard
 *  (socket-guard.ts): the site's profile blocks its sockets, so a tab where the guard could not be put in place keeps
 *  them refused. Above the socket rule (100); below the cover rules (250), which name no websockets. Null when no tab
 *  is armed. */
export function buildSocketGuardRule(domains: string[], tabIds: number[]): Rule | null {
  const d = normalizeDomains(domains);
  if (!d.length || !tabIds.length) return null;
  return {
    id: SOCKET_GUARD_RULE_ID, priority: 200, action: { type: 'allow' },
    condition: { requestDomains: d, resourceTypes: ['websocket'], tabIds: [...tabIds].sort((a, b) => a - b) },
  };
}

/** Replaces the one session rule with this id (removes it when `rule` is null), leaving every other
 *  session rule alone. Each session rule has its own id, so one command never removes another's rule. */
export async function replaceSessionRule(id: number, rule: Rule | null): Promise<void> {
  if (rule && rule.id !== id) throw new Error(`rule id ${rule.id} does not match ${id}`);
  const sess = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: sess.filter((r) => r.id === id).map((r) => r.id),
    addRules: rule ? [rule] : [],
  });
}

/**
 * Layer 0: deterministic rules that hold even with no debugger attached.
 * Pure function so it can be unit-tested without chrome.*.
 */
export function buildRules(policy: Policy, opts: { failClosed?: boolean } = {}): BuiltRules {
  const rules: Rule[] = [];
  const reasons = new Map<number, string>();
  const guarded = guardedDomains(policy);
  if (!guarded) return { rules, reasons };
  // The profiled sites' own domains (the listed ones, and under guard every site every other site's): the rules that
  // know a site (its GET paths) apply to them only. Every other host guarding everything takes in is judged by the
  // debugger, sign-ins and searches included.
  const domains = normalizeDomains(policy.effective.profileDomains);

  if (opts.failClosed) {
    // Two halves: the POSTs, leaving out the background's own (its judge must answer while the tabs are attached), and
    // every other covered method, which the background never sends, for everyone.
    rules.push({
      id: FAIL_CLOSED_RULE_ID, priority: 200, action: { type: 'block' },
      condition: { ...guarded, requestMethods: COVER_METHODS.filter((m) => m !== 'post'), resourceTypes: ALL_TYPES },
    });
    rules.push({
      id: FAIL_CLOSED_POST_RULE_ID, priority: 200, action: { type: 'block' },
      condition: { ...guarded, ...ownInitiator(), requestMethods: ['post'], resourceTypes: ALL_TYPES },
    });
    reasons.set(FAIL_CLOSED_RULE_ID, 'fail-closed:debugger-detached');
    reasons.set(FAIL_CLOSED_POST_RULE_ID, 'fail-closed:debugger-detached');
  }

  let id = RULE_ID_BASE;
  const block = { type: 'block' as const };

  rules.push({
    id, priority: 100, action: block,
    condition: { ...guarded, requestMethods: ['put', 'patch', 'delete'], resourceTypes: ALL_TYPES },
  });
  reasons.set(id++, 'mutating-method');

  id = pushAllows(rules, reasons, id, 150, readPutAllows(policy));

  // A POST page load (form submit, or a link that posts into a new tab) is a write in practice,
  // and the first navigation into an origin with no attached page or worker never reaches the
  // debugger. Blocking it here closes that gap deterministically. Cost: SAML/OIDC callbacks that
  // POST into a guarded origin are refused while the site is guarded. On every guarded host, the
  // ones everything-guarded takes in included, so a form posting into a new tab cannot reach an unlisted host
  // before the debugger holds the tab.
  rules.push({
    id, priority: 100, action: block,
    condition: { ...guarded, requestMethods: ['post'], resourceTypes: ['main_frame', 'sub_frame'] },
  });
  reasons.set(id++, 'post-navigation');

  // A beacon (navigator.sendBeacon, <a ping>) is fire-and-forget: a page sends it as it closes, after the
  // debugger session ended, so it is never judged. Refused, except to the telemetry addresses the allow-lists name
  // (Facebook's /ajax/bnzai): those are allowed when sent any other way, and a site sending its logs as beacons
  // otherwise shows as a refusal for nothing.
  rules.push({
    id, priority: 100, action: block,
    condition: { ...guarded, requestMethods: ['post'], resourceTypes: ['ping'] },
  });
  reasons.set(id++, 'beacon');
  id = pushAllows(rules, reasons, id, 101, beaconTelemetryAllows(policy, guarded));

  // WebSockets are blocked only for the guarded domains that opt to block them (per-site, else the
  // global default). A site whose real-time reads ride a socket (Linear) keeps its domains out.
  const wsDomains = normalizeDomains(policy.effective.websocketBlockDomains);
  // An allowed host under a site guard every site profiles stays unguarded: out of that site's socket and GET-path rules
  // (one under a listed site stays guarded, guardsHost).
  const freed = policy.effective.guardAll ? leftOut(policy.effective, [], normalizeDomains(policy.effective.targetDomains)) : [];
  // A rule's exclusions: the freed hosts under its own domains (one elsewhere it never matches anyway).
  const freedUnder = (ds: string[]) => { const out = freed.filter((a) => underAny(a, ds)); return out.length ? { excludedRequestDomains: out } : {}; };
  if (policy.effective.guardAll && (policy.websockets ?? 'block') === 'block') {
    // Everything guarded: the global default refuses sockets on every guarded host, the sites that allow them and
    // the allowed and exempt hosts left out, so an unlisted host's socket, which the debugger never inspects, cannot
    // carry writes.
    // Only a listed site keeps an allowed host under it guarded; one guard every site profiles leaves it out.
    const listed = normalizeDomains(policy.effective.targetDomains);
    const out = leftOut(policy.effective, policy.effective.websocketAllowDomains, wsDomains.filter((d) => underAny(d, listed)));
    rules.push({
      id, priority: 100, action: block,
      condition: { ...(out.length ? { excludedRequestDomains: out } : {}), resourceTypes: ['websocket', 'webtransport'] },
    });
    reasons.set(id++, 'websocket');
  } else if (wsDomains.length) {
    rules.push({
      id, priority: 100, action: block,
      // WebTransport (HTTP/3) is the same class of channel: Facebook's gateway falls back to it when its
      // websockets are blocked and carried Messenger sends that way. webRequest never reports these sessions.
      condition: { requestDomains: wsDomains, ...freedUnder(wsDomains), resourceTypes: ['websocket', 'webtransport'] },
    });
    reasons.set(id++, 'websocket');
  }

  for (const path of domains.length ? policy.effective.blockedGetPaths : []) {
    const p = String(path ?? '').trim();
    if (!p) continue;
    // "^" is DNR's separator token: the pattern must be followed by end-of-URL or a
    // separator such as / ? # :, so "/logout" cannot match "/assets/LogoutHelper.js".
    // Side-effecting GETs are navigations and API calls, never scripts or images.
    rules.push({
      id, priority: 100, action: block,
      condition: { urlFilter: `${p}^`, requestDomains: domains, ...freedUnder(domains), requestMethods: ['get'], resourceTypes: SIDE_EFFECT_TYPES },
    });
    reasons.set(id++, `blocked-get-path:${p}`);
  }

  return { rules, reasons };
}

/** A site's live-updates subscription sent as a PUT (SiteProfile.readPutPaths): let through to the debugger, which
 *  allows it by the same list (decision.ts). Installed above the mutating-method rule (100) and below the fail-closed
 *  and cover rules (200, 250), so a tab the debugger does not hold keeps it refused. */
/** Adds allow rules from `id` on, at `priority`; answers the next free id. */
function pushAllows(rules: Rule[], reasons: Map<number, string>, id: number, priority: number, allows: { condition: Rule['condition']; reason: string }[]): number {
  for (const { condition, reason } of allows) {
    rules.push({ id, priority, action: { type: 'allow' }, condition });
    reasons.set(id++, reason);
  }
  return id;
}

/** The beacon refusal's exceptions: one allow rule per telemetry address that can be a URL regex exactly
 *  (beaconTelemetryRegex), the global list's on every guarded host, a site's on its domains alone. */
function beaconTelemetryAllows(policy: Policy, guarded: DomainCondition): { condition: Rule['condition']; reason: string }[] {
  const ping = { requestMethods: ['post'] as RequestMethod[], resourceTypes: ['ping'] as ResourceType[] };
  const of = (patterns: string[], scope: Partial<Rule['condition']>) => patterns.flatMap((p) => {
    const regexFilter = beaconTelemetryRegex(p);
    return regexFilter ? [{ condition: { ...scope, ...ping, regexFilter } as Rule['condition'], reason: `beacon-telemetry:${p}` }] : [];
  });
  return [
    ...of(policy.effective.telemetryAllow, guarded),
    ...policy.effective.siteRules.flatMap((site) => of(site.telemetryAllow, { requestDomains: normalizeDomains(site.domains) })),
  ];
}

function readPutAllows(policy: Policy): { condition: Rule['condition']; reason: string }[] {
  return policy.effective.siteRules.flatMap((site) => (site.readPutPaths ?? []).flatMap((path) => normalizeDomains(site.domains).map((d) => ({
    condition: { urlFilter: `||${d}${path}^`, requestMethods: ['put'], resourceTypes: ['xmlhttprequest'] } as Rule['condition'],
    reason: `read-put:${path}`,
  }))));
}

let chain: Promise<unknown> = Promise.resolve();

/** Replace all dynamic rules with the ones derived from the policy. Calls are serialized:
 *  two overlapping updates would otherwise race on remove/add and fail with duplicate ids. */
export function applyRules(policy: Policy, opts: { failClosed?: boolean } = {}): Promise<BuiltRules> {
  const run = async (): Promise<BuiltRules> => {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const built = buildRules(policy, opts);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: built.rules,
    });
    return built;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/** The Pro account page's addresses that lower protection for every browser on the account: a site switched off or
 *  removed (/account/sites/off, and the form without JavaScript, /account/sites), a browser signed out, a browser's
 *  "guard every site" switched off or a host allowed for it (/account/browsers/off), the account deleted. Changes that add protection go elsewhere (the service's lib/site-edit.ts), so they stay open. */
const ACCOUNT_LOWERING_PATHS = '/account/(?:sites(?:/off)?|browsers/(?:signout|off)|delete(?:/[^?#]*)?)/?(?:[?#].*)?$';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rule that refuses those addresses, in every tab, for the service at `serviceUrl`; null when it is no web
 *  address. Not a guarded site's rule: it holds whether or not OnlyRead is attached anywhere. */
export function buildAccountLockRule(serviceUrl: string): Rule | null {
  let u: URL;
  try { u = new URL(serviceUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const base = `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  return {
    id: ACCOUNT_LOCK_RULE_ID,
    priority: 100,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      regexFilter: `^${escapeRegex(base)}${ACCOUNT_LOWERING_PATHS}`,
      requestMethods: ['post', 'put', 'patch', 'delete'] as chrome.declarativeNetRequest.RequestMethod[],
      // Every type: a beacon (`ping`) from the page's own script carries the same POST, cookies and Origin as a fetch
      // or page load.
      resourceTypes: ALL_TYPES,
    },
  };
}
