import type { AccountEdit, CustomSite, EffectivePolicy, GuardAllLevel, Policy, SiteProfile, SiteRules, SiteView } from '../shared/types';
import { guardsHost, isTargetHost } from './decision';
import { BUILTIN_SITES } from './sites.generated';

export { BUILTIN_SITES };

export function builtinSite(id: string): SiteProfile | undefined {
  return BUILTIN_SITES.find((s) => s.id === id);
}

function customAsProfile(c: CustomSite): SiteProfile {
  return { id: c.id, name: c.name, domains: c.domains };
}

type SiteLists = Pick<Policy, 'sites' | 'customSites' | 'managed'> & Partial<Pick<Policy, 'accountEdits'>>;

/** The site lists in force: the browser's own, plus the Pro account's while it has one (cloud-sync.ts). The
 *  account's list is a registry every signed-in browser guards in addition to its own, not a
 *  replacement for it: a built-in site is on when either list switches it on, and the
 *  custom sites are the union by id, the account's entry giving the name and both giving domains (a site guarded here
 *  never guards fewer domains for being on the account too). Neither list is changed. */
export function sitesInForce(p: SiteLists): Pick<Policy, 'sites' | 'customSites'> {
  const local = { sites: p.sites ?? {}, customSites: p.customSites ?? [] };
  const edits = p.accountEdits ?? [];
  if (!p.managed && !edits.length) return local;
  // The account's list, then the sites the account page guards in this browser alone: each adds. Each with the changes
  // made here and not yet on the account laid over it (Pro mode, local first: cloud-sync.ts flushAccountEdits).
  const { account, browser } = accountLists(p);
  return addList(addList(local, account), browser);
}

/** The account's two lists as this browser sees them: the account's own and the one for this browser alone, each with
 *  the changes made here and not yet on the account laid over it. */
function accountLists(p: SiteLists): Record<AccountEdit['scope'], Pick<Policy, 'sites' | 'customSites'>> {
  const none = { sites: {}, customSites: [] };
  const edits = p.accountEdits ?? [];
  return { account: withEdits(p.managed ?? none, edits, 'account'), browser: withEdits(p.managed?.browserSites ?? none, edits, 'browser') };
}

/** Which of the account's lists guard this site (with the changes waiting laid over): a removal goes to each. */
export function accountScopesOf(p: SiteLists, id: string): AccountEdit['scope'][] {
  const lists = accountLists(p);
  return (['account', 'browser'] as const).filter((s) => listGuards(lists[s], id));
}

const listGuards = (l: Pick<Policy, 'sites' | 'customSites'>, id: string) => Boolean(l.sites[id]?.enabled || l.customSites.some((c) => c.id === id && c.enabled));

/** One list on the account with the changes waiting for it laid over, in the order they were made: an addition guards
 *  the site, a removal drops it from this list (another list may still guard it). */
function withEdits(list: Pick<Policy, 'sites' | 'customSites'>, edits: AccountEdit[], scope: AccountEdit['scope']): Pick<Policy, 'sites' | 'customSites'> {
  const mine = edits.filter((e) => e.scope === scope);
  if (!mine.length) return list;
  const sites = { ...list.sites };
  let customSites = [...list.customSites];
  for (const e of mine) {
    if (e.builtin) {
      if (e.op === 'add') sites[e.id] = { enabled: true }; else delete sites[e.id];
      continue;
    }
    customSites = customSites.filter((c) => c.id !== e.id);
    if (e.op === 'add') customSites.push({ id: e.id, name: e.name ?? e.id, domains: [e.id], enabled: true });
  }
  return { sites, customSites };
}

/** `base` with `list` added: a built-in site on when either has it on; custom sites by id, `list`'s entry giving the
 *  name and both giving domains. */
function addList(base: Pick<Policy, 'sites' | 'customSites'>, list: Pick<Policy, 'sites' | 'customSites'>): Pick<Policy, 'sites' | 'customSites'> {
  const sites = { ...base.sites };
  for (const [id, s] of Object.entries(list.sites)) if (s.enabled) sites[id] = { enabled: true };
  const extra = new Map(list.customSites.map((c) => [c.id, c]));
  const customSites = base.customSites.map((c) => {
    const a = extra.get(c.id);
    return a ? { ...c, name: a.name, domains: [...new Set([...a.domains, ...c.domains])], enabled: c.enabled || a.enabled } : c;
  });
  for (const a of list.customSites) if (!base.customSites.some((c) => c.id === a.id)) customSites.push(a);
  return { sites, customSites };
}

/** Sites currently guarded: enabled built-ins plus enabled custom sites, from the lists in force. */
function enabledSites(p: SiteLists): SiteProfile[] {
  const f = sitesInForce(p);
  const builtins = BUILTIN_SITES.filter((s) => f.sites[s.id]?.enabled);
  const customs = f.customSites.filter((c) => c.enabled).map(customAsProfile);
  return [...builtins, ...customs];
}

/** Sites in force that are not switched on, each with only its domains that guard every site guards (an allowed or
 *  exempt host stays unguarded, profile or not): every other built-in site, and every custom site this browser lists
 *  switched off. A custom site only the account lists, switched off, guards nothing anywhere (listSites leaves it out). */
function otherSites(p: SiteLists, unguarded: string[]): SiteProfile[] {
  const f = sitesInForce(p);
  const builtins = BUILTIN_SITES.filter((s) => !f.sites[s.id]?.enabled);
  const customs = f.customSites.filter((c) => !c.enabled && p.customSites?.some((l) => l.id === c.id)).map(customAsProfile);
  return [...builtins, ...customs]
    .map((s) => ({ ...s, domains: s.domains.filter((d) => !isTargetHost(d, unguarded)) }))
    .filter((s) => s.domains.length > 0);
}

type GuardAll = Pick<EffectivePolicy, 'guardAll' | 'excludeDomains' | 'exemptDomains'>;

/** profiledSites with the switched-on sites and guard every site already worked out. */
function profiledOf(p: SiteLists, on: SiteProfile[], all: GuardAll): SiteProfile[] {
  return all.guardAll ? [...on, ...otherSites(p, [...all.excludeDomains, ...all.exemptDomains])] : on;
}

/** The sites whose profile applies: the switched-on ones, and under guard every site every other one (otherSites).
 *  Guard every site behaves on a site as switching that site on does. */
export function profiledSites(p: SiteLists & Partial<Pick<Policy, 'guardAll' | 'excludeSites' | 'cloud'>>): SiteProfile[] {
  return profiledOf(p, enabledSites(p), guardAllFrom(p));
}

/** Ids of the sites currently guarded (built-in and custom), from the lists in force. */
export function guardedSiteIds(p: SiteLists): string[] {
  return enabledSites(p).map((s) => s.id);
}

/** The name of the guarded site that owns this host (the in-page notice's "OnlyRead kept <name> read-only"). */
export function guardedSiteName(p: SiteLists & Partial<Pick<Policy, 'guardAll' | 'excludeSites' | 'cloud'>>, host: string): string | undefined {
  return profiledSites(p).find((s) => isTargetHost(host, s.domains))?.name;
}

/** Whether the Pro account's list guards this site (built-in or custom): then this browser cannot switch it off, only
 *  remove it from the account (messages.ts, through the lock). */
export function accountGuards(p: SiteLists, id: string): boolean {
  return accountScopesOf(p, id).length > 0;
}

/** Whether the browser's own settings guard this site. */
function localGuards(p: SiteLists, id: string): boolean {
  return Boolean(p.sites?.[id]?.enabled || p.customSites?.some((c) => c.id === id && c.enabled));
}

const uniq = (xs: (string[] | undefined)[]): string[] => [...new Set(xs.flatMap((x) => x ?? []))];

/** A site's own allow-lists with its domains, for decision.ts to match on its hosts alone; undefined for a site
 *  with none (a custom site, Reddit, X). Not pooled into global lists: pooled,
 *  Linear's `sentry`, `datadog` and `segment`, LinkedIn's `/rum` and Facebook's `/ajax/presence/` would allow a POST on
 *  any other guarded host, and under guard-all on any host, without a judge; each pattern is backed by labels of its own
 *  app only (ARCHITECTURE.md, Telemetry patterns). */
function siteRulesOf(s: SiteProfile): SiteRules | undefined {
  const rules = { domains: s.domains, telemetryAllow: uniq([s.telemetryAllow]), allowedShapes: uniq([s.allowedShapes]), readTrackingShapes: uniq([s.readTrackingShapes]), readPutPaths: uniq([s.readPutPaths]) };
  return rules.telemetryAllow.length || rules.allowedShapes.length || rules.readTrackingShapes.length || rules.readPutPaths.length ? rules : undefined;
}

/** A host as the allow list keeps it: lower case, no scheme, path, port or leading "www."/"*."; undefined if none. */
export function excludeHost(s: string): string | undefined {
  const h = hostToSiteId(s.trim());
  return h && (validHost(h) || h === 'localhost') ? h : undefined;
}

/** Guard everything as it is in force, from three levels: the Pro account's (every browser on it), this
 *  browser's as set on the account page, and this browser's own. A higher level is never undone by a lower one: the
 *  guards add up. Everything is guarded when any level says so, and a host is left unguarded only when every level
 *  that guards everything allows it (an allowed host at one level is no exception at another). */
export function guardAllInForce(p: Pick<Policy, 'guardAll' | 'excludeSites' | 'managed'>): { on: boolean; exclude: string[] } {
  const levels = [p.managed?.guardAll, p.managed?.browser, { on: Boolean(p.guardAll), excludeSites: p.excludeSites ?? [] }]
    .filter((l): l is GuardAllLevel => Boolean(l?.on))
    .map((l) => [...new Set(l.excludeSites.map(excludeHost).filter((h): h is string => Boolean(h)))]);
  if (!levels.length) return { on: false, exclude: [] };
  // A host every level allows: each candidate from any level, kept when every level covers it.
  const candidates = [...new Set(levels.flat())];
  return { on: true, exclude: candidates.filter((h) => levels.every((l) => isTargetHost(h, l))) };
}

function guardAllFrom(p: Pick<Policy, 'managed'> & Partial<Pick<Policy, 'guardAll' | 'excludeSites' | 'cloud'>>): GuardAll {
  let service: string[] = [];
  try { service = p.cloud?.serviceUrl ? [new URL(p.cloud.serviceUrl).hostname] : []; } catch { /* no service */ }
  const g = guardAllInForce(p);
  return { guardAll: g.on, excludeDomains: g.exclude, exemptDomains: service };
}

export function resolveEffective(p: Pick<Policy, 'sites' | 'customSites' | 'managed' | 'telemetryAllow' | 'blockedGetPaths' | 'blockedShapes' | 'allowedShapes' | 'readTrackingShapes' | 'websockets' | 'blockResponse' | 'guardAll' | 'excludeSites' | 'cloud'>): EffectivePolicy {
  const on = enabledSites(p);
  const wsDefault = p.websockets ?? 'block';
  const brDefault = p.blockResponse ?? 'fail';
  const all = guardAllFrom(p);
  // Under guard every site a site that is not switched on is guarded all the same, so its whole profile applies on its
  // hosts as if it were on: its allow-lists (read tracking among them), block-lists, sockets, editors and block delivery.
  // Only the list stays apart (targetDomains): switching a site on still guards it with guard every site off.
  const prof = profiledOf(p, on, all);
  return {
    targetDomains: uniq(on.map((s) => s.domains)),
    profileDomains: uniq(prof.map((s) => s.domains)),
    ...all,
    // The global allow-lists stay global; each site's own go with its domains (siteRules). The block-lists pool: a
    // blocked path or a codec's write prefix only blocks more wherever it is seen.
    telemetryAllow: uniq([p.telemetryAllow]),
    blockedGetPaths: uniq([p.blockedGetPaths, ...prof.map((s) => s.blockedGetPaths)]),
    blockedShapes: uniq([p.blockedShapes, ...prof.map((s) => s.blockedShapes)]),
    allowedShapes: uniq([p.allowedShapes]),
    readTrackingShapes: uniq([p.readTrackingShapes]),
    siteRules: prof.map(siteRulesOf).filter((r): r is SiteRules => r !== undefined),
    // A site blocks WS by its own setting, or the global default when it has none. Only blocking sites' domains go in.
    websocketBlockDomains: uniq(prof.filter((s) => (s.websockets ?? wsDefault) === 'block').map((s) => s.domains)),
    websocketAllowDomains: uniq(prof.filter((s) => (s.websockets ?? wsDefault) === 'allow').map((s) => s.domains)),
    // Domains that deliver a block as a rollback-triggering rejection (site setting, else global default).
    rejectDomains: uniq(prof.filter((s) => (s.blockResponse ?? brDefault) === 'reject').map((s) => s.domains)),
    // Domains whose editors the content script locks (opt-in per site).
    editorGuardDomains: uniq(prof.filter((s) => s.editorGuard === true).map((s) => s.domains)),
    // Domains whose socket carries reads and writes alike, guarded stanza by stanza (socket-guard.ts).
    socketGuardDomains: uniq(prof.filter((s) => s.socketGuard !== undefined).map((s) => s.domains)),
    socketGuards: prof.flatMap((s) => (s.socketGuard ? [{ codec: s.socketGuard, domains: uniq([s.domains]) }] : [])),
  };
}

/** Every other site in force, built-in or custom. */
const otherProfiles = (p: SiteLists, id: string): SiteProfile[] => [...BUILTIN_SITES, ...sitesInForce(p).customSites.map(customAsProfile)].filter((s) => s.id !== id);

/** The other site living under domain `d` of a site, beyond the page the popup is on: allowing `d` would allow it too.
 *  Gmail's calendar.google.com is no such site from calendar.google.com (the same host), Gmail is under a custom
 *  google.com. */
function sharingSite(p: SiteLists, id: string, d: string, host?: string): SiteProfile | undefined {
  return otherProfiles(p, id).find((s) => s.domains.some((o) => isTargetHost(o, [d]) && !(host && isTargetHost(host, [o]))));
}

/** The domains allowing a site may allow: those that are its alone. Left out are a later domain over another of its own
 *  (a shared parent: Calendar's clients6.google.com, over calendar-pa.clients6.google.com, would allow every Google
 *  API host under it), never the first, its main one (x.com over api.x.com); and one another site lives under
 *  (sharingSite: Gmail under a custom google.com), unless that site is the very host the popup is on. */
function siteOwnDomains(p: SiteLists, id: string, domains: string[], host?: string): string[] {
  const sharedParent = (d: string, i: number) => i > 0 && domains.some((o) => o !== d && isTargetHost(o, [d]));
  return domains.filter((d, i) => !sharedParent(d, i) && !sharingSite(p, id, d, host));
}

/** `p` with the site off the account's lists (one asked for, or each that guards it): an addition still waiting is
 *  taken back, and the list the account has gets a removal made against the version this browser last saw. A site this
 *  browser's own list still guards (an install from before the move, cloud-sync.ts moveLocalSites) is switched off too. */
export function withAccountRemove<P extends SiteLists>(p: P, id: string, scope?: AccountEdit['scope']): P {
  const mine = (e: AccountEdit) => e.id === id && e.op === 'add' && (!scope || e.scope === scope);
  const kept = (p.accountEdits ?? []).filter((e) => !mine(e));
  const onAccount = accountScopesOf({ sites: {}, customSites: [], managed: p.managed }, id).filter((s) => !scope || s === scope);
  const builtin = Boolean(builtinSite(id));
  const removals = onAccount.map((s): AccountEdit => {
    const version = s === 'account' ? p.managed?.version : p.managed?.browserVersion;
    return { op: 'remove', scope: s, id, builtin, ...(version !== undefined ? { version } : {}), at: Date.now() };
  });
  const sites = p.sites?.[id]?.enabled ? { ...p.sites, [id]: { enabled: false } } : p.sites;
  return { ...p, sites, customSites: (p.customSites ?? []).filter((c) => c.id !== id), accountEdits: [...kept, ...removals] };
}

/** The allowed hosts a site's off switch adds (allowedOff), as stored: the on switch takes back these and the ones under
 *  them, and nothing more (an allowed parent the user set stays; switching the site on guards it under it). */
export function siteAllowHosts(p: SiteLists, id: string, domains: string[], host?: string): string[] {
  return [...new Set(siteOwnDomains(p, id, domains, host).map(excludeHost))].filter((x): x is string => Boolean(x));
}

/** The lists with a site allowed while every site is guarded: its domains added to this browser's allowed hosts, and its
 *  own setting here switched off (a switched-on site stays guarded under an allowed host). messages.ts setGuardAllSite
 *  saves this; listSites asks of it whether the site would then be unguarded. */
export function allowedOff<P extends SiteLists & Partial<Pick<Policy, 'guardAll' | 'excludeSites' | 'cloud'>>>(p: P, id: string, domains: string[], host?: string): P {
  const allow = p.excludeSites ?? [];
  // A set (siteAllowHosts): excludeHost drops "www.", so www.reddit.com is reddit.com again.
  const add = siteAllowHosts(p, id, domains, host).filter((x) => !allow.includes(x));
  const sites = p.sites[id]?.enabled ? { ...p.sites, [id]: { enabled: false } } : p.sites;
  const customSites = p.customSites.map((c) => (c.id === id && c.enabled ? { ...c, enabled: false } : c));
  return { ...p, excludeSites: [...allow, ...add], sites, customSites };
}

type ListLists = SiteLists & Partial<Pick<Policy, 'guardAll' | 'excludeSites' | 'cloud' | 'judge'>>;

/** Whether guard every site guards any of these hosts, with the sites switched on in `p`. */
function guardedIn(p: ListLists, hosts: string[]): string[] {
  const eff = { ...guardAllFrom(p), targetDomains: uniq(enabledSites(p).map((s) => s.domains)) };
  return hosts.filter((x) => guardsHost(eff, x));
}

/** A site's switch while every site is guarded (SiteView.guardAll), on `host` (the page the popup is on) or else its
 *  domains. Off allows the site's own domains here and switches its own setting here off (allowedOff); in Pro mode it
 *  also takes the site off the account's lists, as the popup's own switch does there. Fixed when that leaves it guarded
 *  (fixedReason). */
function guardAllSwitch(p: ListLists, id: string, domains: string[], host?: string): Pick<SiteView, 'guardAll'> {
  if (!guardAllFrom(p).guardAll) return {};
  const hosts = host ? [host] : domains;
  if (!guardedIn(p, hosts).length) return { guardAll: { on: false } };
  const onAccount = accountScopesOf(p, id).length > 0;
  const pro = p.judge?.provider === 'cloud' && Boolean(p.managed);
  // The account's list with an own key: changed on the account page only.
  if (onAccount && !pro) return { guardAll: { on: true, fixed: true } };
  const after = allowedOff(onAccount ? withAccountRemove(p, id) : p, id, domains, host);
  const still = guardedIn(after, hosts);
  return { guardAll: still.length ? { on: true, fixed: true, ...fixedReason(p, after, id, domains, still, host) } : { on: true } };
}

/** Why allowing a site leaves `still` guarded: another switched-on site covers it (`with`: Gmail's calendar.google.com
 *  under Calendar's switch); a domain covering it was left out as another site lives under it (`shares`: a custom
 *  google.com over Gmail) or as the site shares it (`shared`: Calendar's clients6.google.com); else the account guards
 *  every site without allowing it (guardAllInForce: every level must allow). */
function fixedReason(p: ListLists, after: ListLists, id: string, domains: string[], still: string[], host?: string): { with?: string; shares?: string; shared?: boolean } {
  const other = enabledSites(after).find((s) => still.some((x) => isTargetHost(x, s.domains)));
  if (other) return { with: other.name };
  const notAllowed = still.filter((x) => !isTargetHost(x, after.excludeSites ?? []));
  if (!notAllowed.length) return {};
  const sharing = domains.filter((d) => notAllowed.some((x) => isTargetHost(x, [d]))).map((d) => sharingSite(p, id, d, host)).find(Boolean);
  return sharing ? { shares: sharing.name } : { shared: true };
}

/** Every known site (enabled or not) as the popup shows it, flagging the one that owns `host`, and saying which list
 *  guards each: `local` (this browser's own settings), `account` (the Pro account's list), both or neither. */
export function listSites(p: ListLists, host?: string): SiteView[] {
  const h = (host ?? '').toLowerCase();
  const f = sitesInForce(p);
  // Guard every site: the switch says whether the site is guarded, on the host the popup is on (an allowed part of a
  // site the rest of which stays guarded shows off there), else on any of its domains.
  const byAll = (id: string, domains: string[], current: boolean) => guardAllSwitch(p, id, domains, current ? h : undefined);
  const scope = (id: string) => {
    const scopes = accountScopesOf(p, id);
    const waiting = (p.accountEdits ?? []).some((e) => e.id === id);
    return { local: localGuards(p, id), account: scopes.length > 0, ...(scopes.length ? { scopes } : {}), ...(waiting ? { waiting } : {}) };
  };
  const views: SiteView[] = BUILTIN_SITES.map((s) => ({
    id: s.id, name: s.name, domains: s.domains, enabled: Boolean(f.sites[s.id]?.enabled), builtin: true, verified: Boolean(s.verified), iconUrl: s.iconUrl, description: s.description, outOfScope: s.outOfScope,
    current: h !== '' && isTargetHost(h, s.domains), cacheSize: Object.keys(s.cache ?? {}).length, ...scope(s.id),
    ...byAll(s.id, s.domains, h !== '' && isTargetHost(h, s.domains)),
  }));
  // A custom site the account lists switched off, and this browser does not list, guards nothing anywhere: the account
  // page shows it; here it would only be a row with nothing to do.
  for (const c of f.customSites.filter((x) => x.enabled || p.customSites?.some((l) => l.id === x.id))) views.push({ id: c.id, name: c.name, domains: c.domains, enabled: c.enabled, builtin: false, verified: false, iconUrl: c.iconUrl, current: h !== '' && isTargetHost(h, c.domains), cacheSize: 0, ...scope(c.id), ...byAll(c.id, c.domains, h !== '' && isTargetHost(h, c.domains)) });
  return views;
}

/** The verified (built-in) site whose domains cover this host, if any. */
export function builtinForHost(host: string): SiteProfile | undefined {
  const h = hostToSiteId(host);
  return h ? BUILTIN_SITES.find((s) => isTargetHost(h, s.domains) || isTargetHost(`www.${h}`, s.domains)) : undefined;
}

/** Normalise a host typed or taken from a tab into a custom-site id/domain. */
export function hostToSiteId(host: string): string {
  // Parsed as a URL's host whether or not a scheme was given: a port or user name is dropped, a non-ASCII name becomes
  // its punycode (the host the browser requests), and anything that is no host comes back empty or fails validHost,
  // never a different host made by deleting characters (`app.example.com:8443` is not `app.example.com8443`).
  const raw = host.trim().toLowerCase();
  let h: string;
  try { h = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname; } catch { h = ''; }
  return h.replace(/^www\./, '');
}

/** A host as a custom site's id or domain is stored: lower-case labels, at least two of them (a single label is a
 *  registry's name, never a site's). The same rule as OnlyRead Pro's lib/managed.ts, which checks the account's list
 *  before it is stored, so what the account page refuses the extension leaves out too. */
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export function validHost(host: string): boolean { return HOST.test(host); }

/** Names that belong to a registry or a hosting platform, not to one site: guarding `co.uk` would judge every write to
 *  every .co.uk host. The common multi-label public suffixes are enough (the full list runs to
 *  thousands); a single label never passes `validHost`. Kept the same as OnlyRead Pro's lib/managed.ts. */
const PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'co.nz', 'net.nz', 'org.nz', 'co.za', 'org.za', 'web.za',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ne.kr', 'co.il', 'org.il', 'ac.il', 'net.il',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'com.br', 'net.br', 'org.br', 'com.mx', 'org.mx',
  'com.ar', 'com.tr', 'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.sg', 'com.tw', 'com.my', 'co.id', 'co.th', 'com.vn',
  'com.ph', 'com.pk', 'com.eg', 'com.sa', 'com.ua', 'com.pl', 'com.ru',
  'github.io', 'gitlab.io', 'vercel.app', 'pages.dev', 'workers.dev', 'netlify.app', 'herokuapp.com', 'fly.dev',
  'onrender.com', 'railway.app', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net',
  'amazonaws.com', 'blogspot.com', 'surge.sh', 'glitch.me', 'repl.co', 'replit.app', 'ngrok.io', 'ngrok.app',
  'ngrok-free.app', 'trycloudflare.com', 'webflow.io', 'wixsite.com', 'notion.site', 'myshopify.com', 'readthedocs.io',
]);
export function isPublicSuffix(host: string): boolean { return PUBLIC_SUFFIXES.has(host); }
