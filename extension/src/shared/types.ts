import type { ByokChoice, KeyId } from './providers';
type Mode = 'monitor' | 'enforce';

/** A site the extension knows how to guard: domains plus its rules and the verdicts from its test sessions. */
export interface SiteProfile {
  id: string;
  name: string;
  /** Hostnames; subdomains included. */
  domains: string[];
  /** True when the profile went through a recorded enforce run (apps/<app>/README.md). */
  verified?: boolean;
  /** Official product icon, loaded at runtime; the popup falls back to the site favicon. */
  iconUrl?: string;
  /** One sentence for the marketplace card: what reads work, what writes are refused. */
  description?: string;
  /** Parts of the product the guard does not cover; shown on the site's card so nobody relies on them. */
  outOfScope?: string[];
  telemetryAllow?: string[];
  blockedGetPaths?: string[];
  blockedShapes?: string[];
  allowedShapes?: string[];
  /** Decoded shapes that only record that the user looked at or arranged their own view
   *  (read receipts, view preferences, filters, UI flags). Allowed only when policy.allowReadTracking. */
  readTrackingShapes?: string[];
  /** Exact paths on the site's domains where a PUT is a read: a live-updates subscription (LinkedIn's
   *  /realtime/realtimeFrontendSubscriptions). Let through by an allow rule above the mutating-method rule and allowed by
   *  rule in the decision (reason `read-put`); every other PUT, PATCH and DELETE stays refused. */
  readPutPaths?: string[];
  /** Whether to allow this site's WebSockets. Default (unset) follows the global policy (block).
   *  A site whose real-time reads ride a socket (Linear's wss://sync.linear.app) sets 'allow'. */
  websockets?: 'block' | 'allow';
  /** How to deliver a block for this site. Default (unset) follows the global policy (fail).
   *  A local-first app that queues blocked writes offline (Linear) sets 'reject' to force a rollback. */
  blockResponse?: 'fail' | 'reject';
  /** UI guard: make the site's rich-text editors non-editable so a content edit is never authored.
   *  For apps that push content writes over a channel the extension cannot inspect (Linear's sync
   *  socket). Defense-in-depth, not a network guarantee. */
  editorGuard?: boolean;
  /** Stanza guard for a site whose reads and writes share one encrypted socket (WhatsApp Web): the debugger puts
   *  inpage/<id>-socket.ts in the page and its workers, which refuses write stanzas before they are encrypted. The
   *  socket itself stays blocked by rule in each tab until the guard is in place there (background/socket-guard.ts). */
  socketGuard?: SocketCodec;
  /** Verdicts from the site's labeled test sessions, imported when the site is enabled. */
  cache?: Record<string, { verdict: 'allow' | 'block'; pWrite?: number; note?: string }>;
}

/** The in-page guards for sites whose reads and writes share one encrypted channel: WhatsApp's stanzas
 *  (inpage/whatsapp-socket.ts), Telegram's MTProto requests (inpage/telegram-worker.ts). */
export type SocketCodec = 'whatsapp' | 'telegram';

/** A site added from the popup ("guard this site"): judge-only, no codec, no tested verdicts. */
export interface CustomSite {
  id: string;
  name: string;
  domains: string[];
  enabled: boolean;
  /** Icon discovered when the site was added (tab favicon or the page's own icon link). */
  iconUrl?: string;
}

/** The guarded-site list the person set on their OnlyRead Pro account, guarded in addition to the browser's own `sites`
 *  and `customSites` while present (sites.ts `sitesInForce`, a union). Fetched and applied through
 *  the settings lock by cloud-sync.ts. */
export interface ManagedSites {
  /** The account's list version (GET /v1/config). */
  version: number;
  /** Built-in site ids this extension knows; ids it does not are dropped (policy.ts normalizeManaged). */
  sites: Record<string, { enabled: boolean }>;
  customSites: CustomSite[];
  /** When this version was applied here (ms since epoch). */
  fetchedAt: number;
  /** Guard every site, for every browser on the account, and the hosts it leaves unguarded. */
  guardAll?: GuardAllLevel;
  /** The same, set on the account page for this browser alone (its sign-in). */
  browser?: GuardAllLevel;
  /** Sites the account page guards in this browser alone, in addition to the account's. */
  browserSites?: { sites: Record<string, { enabled: boolean }>; customSites: CustomSite[] };
  /** This browser's own list version on the account: its removals are made against it. */
  browserVersion?: number;
  /** How many browsers are signed in to the account (one: a site goes on the account's list; more: this browser's). */
  browsers?: number;
}

/** A change to a list on the Pro account made in this browser, in Pro mode (D10 local first): guarded or not here at
 *  once (sites.ts sitesInForce lays it over the lists), and sent when the account can be reached. A removal carries the
 *  list version it was made against: another change since makes the account refuse it, and it is undone here. */
export interface AccountEdit {
  op: 'add' | 'remove';
  /** The account's list (every browser) or this browser's own. */
  scope: 'account' | 'browser';
  /** A built-in site's id, or the host of a site of its own. */
  id: string;
  builtin: boolean;
  /** A site of its own's name, for an addition. */
  name?: string;
  version?: number;
  /** When it was made (ms since epoch). */
  at: number;
}

/** One level's "guard every site": on or off, and its allowed hosts. */
export interface GuardAllLevel { on: boolean; excludeSites: string[] }

/** What a page says about itself; gathered by the content script on request. */
export interface SiteMeta {
  /** og:site_name, application-name, or the web-app manifest name, in that order. */
  siteName?: string;
  title: string;
  /** Best icon the page declares (largest <link rel=icon> or apple-touch-icon), absolute URL. */
  iconUrl?: string;
}

/** What the popup shows per site. */
export interface SiteView {
  id: string;
  name: string;
  domains: string[];
  enabled: boolean;
  builtin: boolean;
  verified: boolean;
  iconUrl?: string;
  description?: string;
  outOfScope?: string[];
  /** The site owns the host the popup was opened on. */
  current: boolean;
  cacheSize: number;
  /** This browser's own settings guard the site ("This browser"). */
  local: boolean;
  /** The Pro account's list guards the site ("Pro account"): it cannot be switched off here, only removed from the
   *  account, through the settings lock (messages.ts). */
  account: boolean;
  /** Which of the account's lists guard it: `account` (every browser on it), `browser` (this browser alone). Absent
   *  when none does. */
  scopes?: ('account' | 'browser')[];
  /** Pro mode: a change of this site made here has not reached the account yet (it is in force here meanwhile). */
  waiting?: boolean;
}

/** Where a site is added or removed: this browser's own settings, or the Pro account's list (every browser on it). */
type SiteScope = 'browser' | 'account';

/** One enabled site's own allow-lists, matched only for requests to its domains (decision.ts ruleDecision). Pooled
 *  into the global lists, one site's patterns (Linear's `sentry` and `segment`) would allow a POST on any other guarded
 *  host without a judge. */
export interface SiteRules {
  domains: string[];
  telemetryAllow: string[];
  allowedShapes: string[];
  readTrackingShapes: string[];
  readPutPaths: string[];
}

/** Lists derived from the enabled sites plus the global base lists. Recomputed on every policy change. */
export interface EffectivePolicy {
  /** The guarded sites' domains. With `guardAll`, every other host is guarded as well (decision.ts guardsHost). */
  targetDomains: string[];
  /** Guard every site except `excludeDomains`: the browser's own setting, or the Pro account's. */
  guardAll: boolean;
  /** With `guardAll`, the hosts left unguarded: allowed at every level that guards everything, and guarded by no list. */
  excludeDomains: string[];
  /** Never guarded by `guardAll`: OnlyRead's own Pro service (its pages have their own lock, account-lock.ts). */
  exemptDomains: string[];
  /** The global allow-lists, for every guarded host; a site's own are in `siteRules`, for its domains alone. */
  telemetryAllow: string[];
  /** The global list plus every enabled site's: a blocked path only blocks more, so pooling costs nothing. */
  blockedGetPaths: string[];
  /** The global list plus every enabled site's: codec write prefixes, blocked wherever they are seen. */
  blockedShapes: string[];
  allowedShapes: string[];
  readTrackingShapes: string[];
  /** Each enabled site's own allow-lists with its domains. */
  siteRules: SiteRules[];
  /** Target domains whose WebSockets are blocked: enabled sites that block WS (site setting, else the
   *  global default). A site that allows WS keeps its domains out of this list. Empty → no WS rule. */
  websocketBlockDomains: string[];
  /** Target domains of sites that allow WebSockets: with everything guarded, the socket rule leaves them out. */
  websocketAllowDomains: string[];
  /** Target domains that answer a block with a rollback-triggering rejection instead of a network
   *  failure (site blockResponse, else the global default). A host not in this list uses 'fail'. */
  rejectDomains: string[];
  /** Target domains whose rich-text editors the content script locks (site editorGuard=true). */
  editorGuardDomains: string[];
  /** Target domains whose socket the stanza guard watches (site socketGuard), allowed tab by tab once it is armed. */
  socketGuardDomains: string[];
  /** The same domains by the guard each takes (site socketGuard). */
  socketGuards: { codec: SocketCodec; domains: string[] }[];
}

export interface Policy {
  /**
   * Master switch. false = Off: never attach the debugger, install no rules, no banner, nothing
   * intercepted. true = active in `mode` (subject to `attachWhen`). The three effective states are
   * Off (enabled false), Monitor (enabled true, mode monitor) and Enforce (enabled true, mode enforce).
   */
  enabled: boolean;
  /** monitor: decide and log, never fail a request (DNR rules still apply). enforce: fail blocked requests. */
  mode: Mode;
  /** Built-in sites (extension/policy/sites/*.json) and whether each is guarded. */
  sites: Record<string, { enabled: boolean }>;
  /** Sites added from the popup. */
  customSites: CustomSite[];
  /** The Pro account's site list, guarded in addition to `sites` and `customSites` while present (cloud-sync.ts). */
  managed?: ManagedSites;
  /** Pro mode: changes to the lists on the account made here, guarded (or not) at once and kept until the account has
   *  them (cloud-sync.ts flushAccountEdits). */
  accountEdits?: AccountEdit[];
  /** Derived: the union over enabled sites and the global lists below. Not edited by hand. */
  effective: EffectivePolicy;
  /** Judge thresholds on p(write). Below allow → pass. Above block → block. Between → reviewBand.
   *  reviewAllow / reviewBlock are the review model's own lines (they default to allow / block): the first
   *  judge's allow line is tuned on Jev's scores, which say nothing about the review model's. */
  thresholds: { allow: number; block: number; reviewAllow?: number; reviewBlock?: number };
  reviewBand: 'block' | 'llm' | 'human';
  judge: {
    /** Who classifies uncertain requests: the user's own key (BYOK) or OnlyRead Pro (subscription). */
    provider: 'byok' | 'cloud';
    /** The own-key provider, model and server (see shared/providers.ts). Keys live in `secrets`. */
    byok: ByokChoice;
    /** Budget for Jev inside a paused request. Fail closed past it. */
    timeoutMs: number;
    /** Budget for the review model in the uncertain band. */
    llmTimeoutMs: number;
  };
  /** OnlyRead Pro client settings (used when judge.provider = 'cloud'). */
  cloud: {
    /** Base URL of the Pro API. Official builds point at OnlyRead Pro; forks may point elsewhere. */
    serviceUrl: string;
    /** Budget for one Pro classification (the server may run two models). Fail closed past it. */
    timeoutMs: number;
  };
  /** Global URL substrings treated as telemetry and allowed without judging (sites add their own). */
  telemetryAllow: string[];
  /** Global URL substrings of GET paths known to have side effects. Blocked by rule (sites add their own). */
  blockedGetPaths: string[];
  /** Body-shape prefixes decoded by a per-app codec that are writes by construction (e.g. gcal:sync:w). Blocked without a judge. */
  blockedShapes?: string[];
  /** Exact decoded shapes deliberately tolerated although they are writes (e.g. "gmail:s:w[^u]" to let
   *  Gmail mark an opened message read). Checked before blockedShapes. Empty by default: strict read-only. */
  allowedShapes?: string[];
  /** Exact decoded shapes that only record that the user looked at or arranged their own view
   *  (read receipts, view preferences, filters, UI flags). Sites add their own. Allowed with reason
   *  "read-tracking" only when allowReadTracking is true; otherwise the judge/cache decides. */
  readTrackingShapes?: string[];
  /** Opt-in: allow the curated read-tracking shapes above. Off by default (strict: the judge decides). */
  allowReadTracking: boolean;
  websockets: 'block' | 'allow';
  downloads: boolean;
  uploads: boolean;
  /**
   * What to do with a guarded tab after a request is refused in enforce mode. Sync-engine apps
   * wedge their mutation queue behind the refused write.
   * - notice (default): only show the in-page notice, change nothing.
   * - reload: reload the tab, abandoning the in-memory pipeline.
   * - discard: clear the origin's IndexedDB/Cache/service workers, then reload, so a persisted
   *   queue does not retry the refused write.
   */
  onRefusedMutation: 'notice' | 'reload' | 'discard';
  /**
   * How an enforced block is delivered to the page (CDP-handled requests only).
   * - fail (default): drop the request at the network layer. Local-first sync engines (Linear, Gmail)
   *   read this as "offline" and KEEP the optimistic change, queuing it to retry later.
   * - reject: answer with a well-formed refusal (a GraphQL errors body for GraphQL, else 403), so the
   *   sync engine rolls the optimistic change back and does not retry. Needs CORS headers echoed back.
   */
  blockResponse: 'fail' | 'reject';
  /**
   * When the judge cannot see semantics (bare positional arrays, binary or unknown content
   * types, missing bodies), never auto-allow on a low score: the floor is the review band.
   */
  opaqueToReview: boolean;
  /** Which tabs get a debugger session. all-tabs catches cross-tab requests to targets. */
  attachScope: 'all-tabs' | 'target-tabs';
  /** Guard every site, not only the listed ones, except the hosts in `excludeSites`. Unprofiled sites are
   *  judged like a custom site: reads pass, clear writes are refused, the rest goes to the AI judge. */
  guardAll?: boolean;
  /** With `guardAll`, the hosts this browser leaves unguarded (each with its subdomains). */
  excludeSites?: string[];
  /**
   * When the extension attaches the debugger (and installs DNR rules).
   * - always (default): attached for the whole browsing session; the debugger banner is persistent.
   * - agent-session: attached only while an agent session is active (signaled via `session:set`);
   *   dormant otherwise, so the banner is off and normal browsing is not intercepted.
   */
  attachWhen: 'always' | 'agent-session';
  /** Dev only: POST decisions/observations here so a real Chrome profile can be measured without UI. */
  devSink: string | null;
}

export type Verdict = 'allow' | 'block' | 'review';
export type Source = 'dnr' | 'rule' | 'cache' | 'rules-only' | 'jev' | 'llm' | 'cloud' | 'label' | 'system';

export interface UiAction {
  ts: number;
  type: 'click' | 'submit' | 'enter' | 'file';
  tag: string;
  role?: string;
  name?: string;
  href?: string;
  formAction?: string;
  formMethod?: string;
  fields?: string[];
  url: string;
  /** A password, one-time-code or card field: its name is dropped before storage (R5). */
  sensitive?: boolean;
}

export interface RequestRecord {
  ts: number;
  tabId: number;
  requestId: string;
  sessionId?: string;
  method: string;
  url: string;
  host: string;
  path: string;
  queryKeys: string[];
  contentType?: string;
  resourceType?: string;
  initiator?: string;
  hasBody: boolean;
  bodyPreview?: string;
  /** Full request body (capped at 64 KB), kept in memory only and forwarded to the dev sink; never persisted. */
  bodyFull?: string;
  bodyTruncated?: boolean;
  /** Identity of the raw body (repeats.ts), to tell an exact repeat; absent when the body could not be read. */
  bodyHash?: string;
  bodyShape: string;
  fingerprint: string;
  lastUiActions: UiAction[];
}

export interface AuditEntry {
  kind: 'decision' | 'system';
  ts: number;
  tabId: number;
  method: string;
  url: string;
  resourceType?: string;
  verdict: Verdict;
  source: Source;
  reason: string;
  mode: Mode;
  /** true when the request was actually failed. false in monitor mode or for allows. */
  enforced: boolean;
  pWrite?: number;
  latencyMs?: number;
  /** Judge model that produced pWrite, and its one-line reason when it gives one. */
  judgeModel?: string;
  judgeReason?: string;
  fingerprint?: string;
  requestId?: string;
  contentType?: string;
  bodyShape?: string;
  bodyPreview?: string;
  /** Names the change this request makes (refusals.ts retryKey): the same for the site resending it. Refusals only. */
  retryKey?: string;
  lastUiActions?: UiAction[];
}

/** One refused request in a support report: the activity log's entry with its address masked (secret-named query
 *  values and token-like runs) and its body preview as the log already keeps it (redacted, at most 2 KB). */
export interface SupportRequest {
  ts: number;
  method: string;
  url: string;
  verdict: Verdict;
  source: Source;
  reason: string;
  pWrite?: number;
  judgeModel?: string;
  judgeReason?: string;
  fingerprint?: string;
  contentType?: string;
  bodyShape?: string;
  bodyPreview?: string;
  lastUiActions?: { type: string; tag: string; role?: string; name?: string }[];
}

/** What POST /v1/support receives: the person's note and email, this extension's settings that bear on a refusal, and
 *  the refusals they picked. */
export interface SupportReport {
  note?: string;
  email?: string;
  extension: { version: string; build: 'release' | 'development'; mode: Mode; attachWhen: string; judge: 'byok' | 'cloud'; readTracking: boolean; sites: string[] };
  userAgent: string;
  requests: SupportRequest[];
}

/** A refusal on the settings page's Support list: what it would send, and how to show it. */
export interface SupportItem { key: string; siteName: string; what: string; /** What stopped it, in words ("AI judge"). */ by: string; request: SupportRequest }

export interface SupportList { items: SupportItem[]; context: Omit<SupportReport, 'note' | 'email' | 'requests'>; email?: string }

export interface Observation {
  ts: number;
  requestId: string;
  tabId: number;
  method: string;
  url: string;
  type: string;
  initiator?: string;
  bodyPreview?: string;
  outcome?: 'completed' | 'error';
  status?: number;
  error?: string;
  endTs?: number;
}

export interface CacheEntry {
  verdict: 'allow' | 'block';
  pWrite: number;
  source: Source;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface Status {
  version: string;
  extensionId: string;
  mode: Mode;
  dynamicRules: number;
  targetDomains: string[];
  /** Enabled site ids. */
  sites: string[];
  attachedTabs: number;
  inFlight: number;
  observations: number;
  cacheSize: number;
  judge: string;
  /** Why the own-key judge cannot run (no key, no model, …); undefined when it can, or in Pro mode. */
  judgeProblem?: string;
  /** No AI judge to ask (messages.ts judgeMissing): protection cannot be turned on until one is set. */
  judgeMissing?: boolean;
  /** The person agreed to what the AI judge is sent (background/consent.ts); without it no judge runs. */
  judgeConsent?: boolean;
  /** The own-key provider's name ("OpenRouter"), for the settings page's status card. */
  byokLabel?: string;
  failClosed: boolean;
  blockResponse: 'fail' | 'reject';
  /** Master switch. false = Off (dormant, no banner). */
  enabled: boolean;
  attachWhen: 'always' | 'agent-session';
  /** An agent session is active (detected or declared). Gates attachment under attachWhen='agent-session', and in
   *  both modes locks the settings that would lower protection. */
  agentSession: boolean;
  /** The site of a tab holding the agent session (its host), shown so a session is never a mystery. */
  agentWhere?: string;
  /** Whether the debugger is attached and rules are installed right now (always mode, or an active session). */
  attachmentActive: boolean;
  /** A development build: Monitor mode and the developer controls are available. */
  devBuild: boolean;
  /** Development builds: the Pro services this build can use (the local mock on the dev sink's host, and production). */
  devServices?: { local?: string; production: string };
  cloud: CloudStatus;
  /** What stops protection being lowered right now: an active AI agent, or a settings PIN not yet entered. */
  lock: SettingsLock;
  /** Tabs whose person cancelled the debugger: fenced by rule (writes refused) until they navigate. */
  /** A storage write that failed (the activity log, the verdicts or the request log may be behind). */
  storageProblem?: string;
  /** A startup step that failed; the guard may be incomplete until the extension is reloaded. */
  startupProblem?: string;
  /** The stored settings were invalid and the defaults are in use (the old copy is kept). */
  /** Why the sites' tested verdicts were not restored at startup; their reads are judged meanwhile. */
  verdictsProblem?: string;
  policyProblem?: string;
  /** The one stored setting reset to its default (policyProblem says why); absent when the settings were not repaired. */
  policyRepaired?: string;
  /** What chrome.storage.local holds, in bytes, when the browser can say. */
  storageBytes?: number;
  /** The Pro account's site list in force: its version (for the log and tests; no page shows it) and when it was
   *  applied. Absent while the account has no list in force. */
  managed?: { version: number; at: number; browsers?: number };
  /** Pro mode: the last change made here that the account refused, and what became of it, in words (cloud-sync.ts),
   *  until a later change is taken. */
  accountRefused?: string;
  /** A change from the Pro account that lowers protection and waits for the settings lock, in words. */
  managedPending?: string;
  /** The last setup by an AI agent (background/agent-setup.ts), while it can still be undone. */
  agentSetup?: { at: number; summary: string };
  /** Guard every site: this browser's own setting and allowed hosts, and whether it is in force. */
  guardAll?: { local: boolean; excludeSites: string[]; inForce: boolean; excludeInForce: string[]; account?: GuardAllLevel; browser?: GuardAllLevel };
  /** Read-tracking writes go through (policy.allowReadTracking). */
  allowReadTracking?: boolean;
}

/** The settings page's Overview counts and Activity list (background/activity.ts summarizeActivity). */
export interface ActivitySummary {
  /** Since local midnight: refusals, requests a judge was asked about, and every request decided. */
  today: { refused: number; judged: number; seen: number };
  /** The most recent refusals, newest first: what in words, what stopped it, and the internal codes for Details. */
  recent: ActivityItem[];
  /** The log holds more refusals after `recent`. */
  more: boolean;
  /** Every refusal the log holds, and where `recent` starts among them (the settings page's pages). */
  total: number;
  offset: number;
}

export interface ActivityItem {
  /** The entry's key, for its report (support:list). */
  key: string;
  ts: number;
  host: string;
  siteName: string;
  siteId?: string;
  iconUrl?: string;
  builtin: boolean;
  /** The operation's name when the body shape names one, else "A change on <site>". */
  what: string;
  /** "Stopped by rule", "Tested list", "Decoded as a write", "AI judge", "Pro couldn't check it", … */
  by: string;
  /** A judge decided it (its chip is in the accent). */
  judge: boolean;
  /** Method, body shape and reason code. */
  code: string;
  /** More than one: this many of the same refusal close together, shown as one row (background/activity.ts). */
  count?: number;
  /** A site's live connections (WebSockets) kept closed, all of them as one quiet row: not a write anyone made, so not
   *  counted among the refused writes (background/activity.ts). */
  socket?: boolean;
}

export interface SettingsLock {
  /** An AI agent is working in this browser: lowering protection is refused until it finishes. */
  agent: boolean;
  /** This browser belongs to an AI agent (set up with a setup link): lowering is refused here until the person signs it
   *  out from the Pro account page in their own browser. */
  agentBrowser?: boolean;
  /** A settings PIN is set. */
  pinSet: boolean;
  /** The PIN was entered in the last few minutes. */
  pinUnlocked: boolean;
}

export type Message =
  | { type: 'audit:list' }
  /** options → background: today's counts and the most recent refusals (background/activity.ts). */
  | { type: 'activity:get'; limit?: number; offset?: number }
  /** content script → background: open the settings page at a section (the notice's "Sign in to Pro", the demo's "Guard
   *  more sites"), or `demo`: the setup window's demo step, to try another site (the demo summary's "Try another"). */
  | { type: 'settings:open'; section?: 'overview' | 'ai-judge' | 'guarded-sites' | 'security' | 'support' | 'demo' | 'install-agent' }
  /** options → background: a refusal as a support report would carry it (background/support.ts): the one with `key`,
   *  or the newest. */
  | { type: 'support:list'; key?: string }
  /** options → background: send the chosen refusals (by `key`) to OnlyRead support, with the person's note and email. */
  | { type: 'support:send'; keys: string[]; note?: string; email?: string }
  | { type: 'audit:clear' }
  | { type: 'observations:list' }
  | { type: 'observations:clear' }
  | { type: 'cache:list' }
  | { type: 'cache:clear' }
  | { type: 'cache:import'; entries: Record<string, { verdict: 'allow' | 'block'; pWrite?: number; note?: string }> }
  | { type: 'policy:get' }
  | { type: 'policy:set'; policy: Policy }
  | { type: 'mode:set'; mode: Mode }
  | { type: 'status:get' }
  /** options / setup → background: choose the own-key provider (also switches to own-key mode). */
  /** Save and test of an own key: `key` typed (else the one stored for the provider); in force only once it passed. */
  | { type: 'judge:byok'; choice: ByokChoice; key?: string }
  | { type: 'cloud:signin' }
  | { type: 'cloud:signout' }
  | { type: 'cloud:status'; refresh?: boolean }
  /** options / popup → background: fetch the Pro account's site list now (Sync now), and answer with the status. */
  /** Fetch the account's list now. `reason: 'settings'`: the settings page opened or was shown again (throttled). */
  | { type: 'cloud:sync'; reason?: 'settings' }
  | { type: 'judge:test' }
  /** setup / options → background: agree to (or withdraw from) what the AI judge is sent (consent.ts). */
  | { type: 'consent:set'; agreed: boolean }
  /** `step: 'demo'`: straight to the demo's choice of site (the settings page's "Try the demo"). */
  | { type: 'setup:open'; step?: 'demo' }
  | { type: 'secrets:get' }
  | { type: 'secrets:key'; provider: KeyId; key?: string }
  | { type: 'ui:action'; action: UiAction }
  /** Content script: the current value of a password, one-time-code or card field (typed-secrets.ts). */
  | { type: 'secret:typed'; field: string; value: string }
  | { type: 'page:closing' }
  /** The Pro account page just saved its list (content script): the background fetches it now. */
  | { type: 'page:account-saved' }
  | { type: 'page:signin-code'; code: string; state: string }
  /** Content script on the page an email sign-in link opened: the window the sign-in started in comes forward. */
  | { type: 'page:signin-link' }
  /** Content script on the Pro service's agent-setup page: is OnlyRead here, and what does it guard (agent-setup.ts)? */
  | { type: 'page:agent-setup-hello' }
  | { type: 'page:account-changed' }
  | { type: 'page:signed-out'; account: string }
  | { type: 'page:frame-check'; account: string }
  | { type: 'page:which-browser'; account: string }
  | { type: 'page:open-demo'; account: string }
  /** Content script: the setup page's Apply, really clicked. Only raises protection. */
  | { type: 'page:agent-setup-apply'; sites: string[]; allTabs: boolean }
  /** agent-setup page (content script) → background: a setup link's code, sent on load, or after a real click
   *  (`clicked`) when the page asked for one. */
  | { type: 'page:agent-setup-link'; connect: string; clicked: boolean }
  /** agent-setup page (content script) → background: the agent says which it is (a real click on its name). */
  | { type: 'page:agent-setup-agent'; agent: string; name?: string }
  /** options → background: undo what the last agent setup changed (through the settings lock). */
  | { type: 'agent-setup:undo' }
  /** options → background: guard every site (or only the listed ones), and the hosts left unguarded. */
  | { type: 'guard-all:set'; on: boolean }
  /** setup window → background: start the first-run demo on a verified site (background/demo.ts). */
  | { type: 'demo:start'; site: string }
  /** content script or setup window → background: the demo running now, if any, as it concerns the asker. */
  | { type: 'demo:state' }
  /** content script or setup window → background: end the demo now, its settings put back (through the lock). */
  | { type: 'demo:skip' }
  /** content script → background: the demo's step 2 is over (OnlyRead's notice closed): end it, its write refused. */
  | { type: 'demo:done' }
  /** content script → background: the demo's font (Manrope), base64, on the demo's own site only. */
  | { type: 'demo:font' }
  /** background → setup window and the demo site's tabs: the demo's write was refused. */
  | { type: 'demo:stopped'; site: string; name: string }
  /** background → setup window and the demo site's tabs: the demo ended. */
  | { type: 'demo:ended'; site: string; stopped?: string; restored: boolean; skipped: boolean }
  /** options → background: let read-tracking writes through (marking things seen, read receipts, view settings). */
  | { type: 'read-tracking:set'; on: boolean }
  /** options → background, development builds only: use the local mock Pro service or production. */
  | { type: 'cloud:service-set'; service: 'local' | 'production' }
  | { type: 'exclude:add'; host: string }
  | { type: 'exclude:remove'; host: string }
  | { type: 'sites:list'; host?: string }
  /** `scope: 'account'`: switch the site on or off in the Pro account's list instead of this browser's settings. */
  | { type: 'site:set'; id: string; enabled: boolean; host?: string; scope?: SiteScope }
  /** `scope: 'account'`: add it to the Pro account's list, for every browser signed in to it. */
  | { type: 'site:add'; host: string; name?: string; iconUrl?: string; scope?: SiteScope }
  /** popup → content script: describe the page (name, icon). */
  | { type: 'site:meta' }
  /** `scope: 'account'`: remove it from the Pro account's list (through the settings lock). */
  | { type: 'site:remove'; id: string; host?: string; scope?: SiteScope }
  /** options → background: look up icons and names for added sites that have none yet. */
  | { type: 'sites:discover' }
  /** background → content script: a request from this tab was refused in enforce mode. `request` (method and address)
   *  only in development builds, for the notice's Copy requests. `explain`: OnlyRead Pro's own words for refusing to
   *  check it (the plan), said in place of the notice's own. */
  | { type: 'onlyread:blocked'; shape: string; reason: string; path: string; site?: string; request?: string; explain?: string; sig?: string }
  /** agent harness → background: an agent session started (attach) or ended (detach). Only acts under attachWhen='agent-session'. */
  | { type: 'session:set'; active: boolean }
  /** options page → background: patch the guard controls (enabled / mode / attachWhen) atomically. */
  | { type: 'guard:set'; enabled?: boolean; mode?: Mode; attachWhen?: 'always' | 'agent-session' }
  /** content script → background: what does this frame's host get right now (background/guard.ts guardConfig)? */
  | { type: 'guard:config' }
  /** background → content script: pushed when the answer to guard:config changes. */
  | { type: 'onlyread:config'; guarded?: boolean; editorGuard: boolean; holdClose?: boolean; uploadsOff?: boolean }
  /** options → background: the optional settings PIN (see background/protection.ts). */
  | { type: 'pin:set'; pin: string; current?: string }
  | { type: 'pin:clear'; pin: string }
  | { type: 'pin:unlock'; pin: string };

/** The signed-in OnlyRead Pro account, as returned by GET /v1/me. */
export interface CloudAccount {
  email: string;
  /** What the account is called on screen, in place of the email: the name from its sign-in, or its handle (the
   *  service's lib/display-name.ts). Absent for an email sign-in, and from an older service. */
  name?: string;
  plan: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | string;
  usage: number;
  cap: number;
  resetsAt: string;
  /** While Pro is had through free credits (no subscription): the judged requests left of those granted. */
  credits?: { left: number; total: number };
  links: { pricing: string; manage: string };
  // The service's own words and verdict, so a change of plan needs no release of the extension. Each is optional: an
  // older service leaves them out and the extension falls back to its own (shared/cloud-ui.ts).
  /** Whether Pro judges for this account now. */
  active?: boolean;
  /** The account's state, shown after the e-mail ("active", "trial ends Nov 12"). */
  statusText?: string;
  /** What is used and what is left ("4% of this month's usage · resets Nov 1"). */
  usageText?: string;
  /** The label of the button to the account's page ("Manage subscription"). */
  manageLabel?: string;
  /** How to get Pro while it is not active: the button's label and the page it opens. */
  offer?: { label: string; url: string };
}

export type CloudErrorCode = 'not_signed_in' | 'subscription_inactive' | 'credits_exhausted' | 'limit_reached' | 'unavailable' | 'bad_response';

export interface CloudStatus {
  provider: 'byok' | 'cloud';
  serviceUrl: string;
  signedIn: boolean;
  account?: CloudAccount;
  /** Last failure seen by the Pro judge, cleared by the next success. */
  lastError?: { code: CloudErrorCode; at: number; message?: string };
  /** When the service ended this browser's sign-in (a refused refresh), until the next sign-in or sign-out. */
  signedOutAt?: number;
}
