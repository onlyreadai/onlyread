// OnlyRead Pro: the subscription alternative to bring-your-own-key. The server runs both judges and
// returns its decision (the judge stage in judge/stage.ts, the same on both sides), so the extension makes
// one call per uncertain request and applies the answer as it is. Every failure
// becomes a CloudError; the decision code turns any judge error into a refusal (fail closed).
import type { CloudAccount, CloudErrorCode, CustomSite, RequestRecord, SupportReport } from '../../shared/types';
import type { Judge, JudgeAsk, JudgeResult } from './types';
import { buildJudgeState } from './state';
import type { StageOutcome } from './stage';

export class CloudError extends Error {
  /** `detail`: what the server said (its error code for a refused edit, `too-many`, `conflict`; an http status), kept
   *  apart from the message so messages.ts can put it in words. */
  /** `serverMessage`: the service's own words for a refusal ("Your trial ended…"), shown as given. */
  constructor(readonly code: CloudErrorCode, readonly detail?: string, readonly serverMessage?: string) {
    super(`cloud:${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'CloudError';
  }
}

/** The error an answer other than 2xx, 401 and an accepted status stands for. */
function failureFor(status: number, error: string | undefined, message?: string): CloudError {
  // Any refusal of the plan (a 402, whatever its code) is the plan's: the service's message says which.
  if (status === 402) return new CloudError(error === 'credits_exhausted' ? 'credits_exhausted' : 'subscription_inactive', undefined, message);
  // The service's per-minute cap (cloud lib/accounts.ts takeMinute) passes within the minute: not the month's
  // allowance used up, which the popup would say.
  if (status === 429) return error === 'rate_limited' ? new CloudError('unavailable', 'rate_limited') : new CloudError('limit_reached', undefined, message);
  if (status >= 500) return new CloudError('unavailable', `http ${status}`);
  return new CloudError('bad_response', `http ${status}`);
}

/** A string from the service, trimmed and capped; undefined when it is not a non-empty string. */
function text(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** The account with the service's own words (CloudAccount) kept only when well formed: an offer opens only a web page. */
function withServiceWords(a: CloudAccount): CloudAccount {
  const { active, statusText, usageText, manageLabel, offer, ...rest } = a as CloudAccount & Record<string, unknown>;
  const out: CloudAccount = { ...rest } as CloudAccount;
  if (typeof active === 'boolean') out.active = active;
  const words = { statusText: text(statusText, 80), usageText: text(usageText, 160), manageLabel: text(manageLabel, 40) };
  for (const [k, v] of Object.entries(words)) if (v) (out as unknown as Record<string, string>)[k] = v;
  const o = offer as { label?: unknown; url?: unknown } | undefined;
  const label = text(o?.label, 40);
  const url = typeof o?.url === 'string' && /^https?:\/\//.test(o.url) ? o.url : undefined;
  if (label && url) out.offer = { label, url };
  return out;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** The sign-in's uninstall token: the service's goodbye page signs this browser out with it when the extension is
   *  removed (cloud-session.ts uninstallUrl). Given at sign-in only, so kept across refreshes. */
  uninstallToken?: string;
}

/** Where tokens live (chrome.storage.local in the extension, memory in tests). */
interface TokenStore {
  get(): Promise<Tokens | undefined>;
  set(t: Tokens | undefined): Promise<void>;
}

interface CloudClientOptions {
  serviceUrl: string;
  store: TokenStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The service refused a refresh, so the tokens were dropped: the sign-in is over (cloud-session.ts says so). */
  onRefreshRefused?: () => void;
  /** This browser, as sent to the service with every GET /v1/me (`x-onlyread-browser`); omitted when unset. */
  browser?: () => BrowserInfo;
  /** A classify call was answered, so the account's count of judged requests moved (cloud-session.ts refetches it). */
  onJudged?: () => void;
}

/** What GET /v1/me tells the service about this browser, which it records per sign-in (a contract shared with
 *  OnlyRead Pro): its platform, how many sites it guards now (this browser's and the account's, enabled), and the
 *  extension's version. Nothing else. */
export interface BrowserInfo {
  platform: 'mac' | 'windows' | 'linux' | 'chromeos' | 'other';
  sites: number;
  version: string;
  /** The AI agent that said it runs this browser, on the agent-setup page, and the name it gave it. */
  agent?: string;
  name?: string;
}

/** The header's value: compact JSON, keys in this order. */
export function browserHeader(b: BrowserInfo): string {
  return JSON.stringify({ platform: b.platform, sites: b.sites, version: b.version, ...(b.agent ? { agent: b.agent } : {}), ...(b.name ? { name: b.name } : {}) });
}

/** The platform from `navigator.userAgentData.platform` ("macOS", "Windows", "Chrome OS", …), else from the user agent. */
export function browserPlatform(nav: { userAgent?: string; userAgentData?: { platform?: string } }): BrowserInfo['platform'] {
  const p = nav.userAgentData?.platform || nav.userAgent || '';
  if (/android|iphone|ipad/i.test(p)) return 'other';
  if (/cros|chrome ?os/i.test(p)) return 'chromeos';
  if (/mac/i.test(p)) return 'mac';
  if (/win/i.test(p)) return 'windows';
  if (/linux|x11/i.test(p)) return 'linux';
  return 'other';
}

interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; uninstall_token?: unknown }

/** GET /v1/config: the guarded-site list the account manages, or that it manages none (cloud-sync.ts). */
/** `browserVersion`: this browser's own list version on the account, which its removals are made against;
 *  `browsers`: how many browsers are signed in to the account (one: a site goes on the account's list; more: asked). */
/** `family` and `scope`: the sign-in the service made the answer for and what its token may do, from the token it
 *  checked (cloud-sync.ts trusts a lowering by them, never by the token kept here, which is read unverified). */
type ConfigExtras = { browserVersion?: number; browsers?: number; family?: string; scope?: 'full' | 'agent' };
export type CloudConfig =
  | ({ managed: true; version: number; sites: Record<string, { enabled: boolean }>; customSites: CustomSite[]; guardAll?: unknown; browser?: unknown; browserSites?: unknown } & ConfigExtras)
  | ({ managed: false; version: number } & ConfigExtras);

/** One edit to a list on the account (POST /v1/config/sites): add a built-in site by id or a site by host, or remove
 *  one by id; to the account's list (every browser) or to this browser's own. `version`: the list version a removal was
 *  made against (edits are made here first and sent later): another change since is refused as `conflict`. */
export type SiteEdit = ({ add: { id: string } } | { add: { host: string; name?: string } } | { remove: { id: string } }) & { scope?: 'account' | 'browser'; version?: number };

/** A config answer: unchanged since `etag` (304), or the list with the ETag to send next time. */
type ConfigResult = { changed: false } | { changed: true; etag?: string; config: CloudConfig };


/** A config answer's body, checked: the list (or that there is none) with its ETag. */
async function readConfig(res: Response, what: string): Promise<{ changed: true; etag?: string; config: CloudConfig }> {
  const d = (await res.json().catch(() => undefined)) as Partial<Record<string, unknown>> | undefined;
  const version = d?.version;
  if (!Number.isInteger(version) || (version as number) < 0 || typeof d?.managed !== 'boolean') throw new CloudError('bad_response', what);
  const tag = res.headers.get('etag') ?? undefined;
  const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
  const family = typeof d.family === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(d.family)
    ? { family: d.family, ...(d.scope === 'agent' || d.scope === 'full' ? { scope: d.scope } : {}) } : {};
  const extras: ConfigExtras = { ...(count(d.browserVersion) !== undefined ? { browserVersion: count(d.browserVersion) } : {}), ...(count(d.browsers) !== undefined ? { browsers: count(d.browsers) } : {}), ...family };
  if (!d.managed) return { changed: true, etag: tag, config: { managed: false, version: version as number, ...extras } };
  if (!d.sites || typeof d.sites !== 'object' || !Array.isArray(d.customSites)) throw new CloudError('bad_response', `${what}: sites`);
  return { changed: true, etag: tag, config: { managed: true, version: version as number, sites: d.sites as Record<string, { enabled: boolean }>, customSites: d.customSites as CustomSite[], guardAll: d.guardAll, browser: d.browser, browserSites: d.browserSites, ...extras } };
}

/** Refresh this long before expiry, so a request never races the clock. */
const EXPIRY_MARGIN_MS = 30_000;

/** POST /v1/support's answer: the report's id, or the CloudError it stands for. */
async function supportId(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; error?: unknown };
  if (res.status === 429) throw new CloudError('unavailable', 'rate_limited');
  if (res.status === 404) throw new CloudError('unavailable', 'this OnlyRead service does not take support reports yet');
  if (res.status >= 500) throw new CloudError('unavailable', `http ${res.status}`);
  if (!res.ok) throw new CloudError('bad_response', typeof body.error === 'string' ? body.error.slice(0, 40) : `http ${res.status}`);
  if (typeof body.id !== 'string' || !body.id) throw new CloudError('bad_response', 'support');
  return body.id.slice(0, 40);
}

export class CloudClient {
  readonly serviceUrl: string;
  private readonly store: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onRefreshRefused: () => void;
  private readonly browser?: () => BrowserInfo;
  private readonly onJudged: () => void;
  private refreshing: Promise<Tokens> | null = null;

  constructor(o: CloudClientOptions) {
    this.serviceUrl = o.serviceUrl.replace(/\/$/, '');
    this.store = o.store;
    // Never store the bare global: fetch detached from its receiver throws in a service worker.
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => Date.now());
    this.onRefreshRefused = o.onRefreshRefused ?? (() => {});
    this.browser = o.browser;
    this.onJudged = o.onJudged ?? (() => {});
  }

  /** This browser's sign-in on the account (the `fam` claim of its own access token, read, not verified: the token is
   *  its own), for the account page to tell this browser apart in its list; undefined when signed out or not known. */
  async family(): Promise<string | undefined> {
    const t = await this.store.get();
    const part = t?.accessToken.split('.')[1];
    if (!part) return undefined;
    try {
      const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { fam?: unknown };
      return typeof claims.fam === 'string' && /^[0-9a-f-]{36}$/i.test(claims.fam) ? claims.fam : undefined;
    } catch { return undefined; }
  }

  async signedIn(): Promise<boolean> {
    return Boolean(await this.store.get());
  }

  /** Exchange the one-time sign-in code (PKCE) for tokens and store them. */
  async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<void> {
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
    await this.store.set(t);
  }

  /** Exchange a setup link's one-time code (made on the account page, background/agent-setup.ts) for tokens. */
  async redeemSetupLink(code: string): Promise<void> {
    const t = await this.tokenRequest({ grant_type: 'setup_link', code });
    await this.store.set(t);
  }

  async signOut(): Promise<void> {
    const t = await this.store.get();
    await this.store.set(undefined);
    if (!t) return;
    try {
      await this.fetchImpl(`${this.serviceUrl}/v1/signout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: t.refreshToken }) });
    } catch { /* best effort: the tokens are already gone locally */ }
  }

  async me(): Promise<CloudAccount> {
    const res = await this.authed('/v1/me', { method: 'GET', headers: this.browserHeaders() });
    const a = (await res.json().catch(() => undefined)) as CloudAccount | undefined;
    if (!a || typeof a.email !== 'string' || typeof a.status !== 'string') throw new CloudError('bad_response', 'me');
    return withServiceWords(a);
  }

  /** The key to subscribe to Web Push with (GET /v1/push), or undefined while the service has none: a service without
   *  push (`key: null`) or from before it (404). The browser then keeps its poll alone, every five minutes. */
  async pushKey(): Promise<string | undefined> {
    const res = await this.authed('/v1/push', { method: 'GET', cache: 'no-store' }, false, [404]);
    if (res.status === 404) return undefined;
    const b = (await res.json().catch(() => ({}))) as { key?: unknown };
    return typeof b.key === 'string' && b.key ? b.key : undefined;
  }

  /** Keeps this browser's push subscription on the account (POST /v1/push): the service pushes to it, with no content,
   *  when what this browser guards changes. Its sign-out drops it on the service. */
  async registerPush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    await this.authed('/v1/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
  }

  /** `x-onlyread-browser` for GET /v1/me and GET /v1/config; nothing when no browser is described or describing it fails. */
  private browserHeaders(): Record<string, string> {
    try { return this.browser ? { 'x-onlyread-browser': browserHeader(this.browser()) } : {}; } catch { return {}; }
  }

  /** The account's guarded-site list. `etag` is the ETag of the last answer: unchanged gives `{ changed: false }`.
   *  A 404 is a server from before managed sites: nothing is managed. The list itself is checked again by
   *  policy.ts normalizeManaged before it is used. */
  async config(etag?: string): Promise<ConfigResult> {
    // With this browser's description, as on /v1/me: the poll is also its check-in on the account page.
    const headers = { ...this.browserHeaders(), ...(etag ? { 'if-none-match': etag } : {}) };
    const res = await this.authed('/v1/config', { method: 'GET', cache: 'no-store', headers }, false, [304, 404]);
    if (res.status === 304) return { changed: false };
    if (res.status === 404) return { changed: true, config: { managed: false, version: 0 } };
    return readConfig(res, 'config');
  }

  /** One edit to a list on the account (POST /v1/config/sites), answered with the whole config as `config` answers
   *  it. A refused edit (a host the server will not take, a list at its cap, a removal made against an older version:
   *  `conflict`) is a CloudError naming the server's reason in `detail`; a 404 is a server from before this route. */
  async editSites(edit: SiteEdit): Promise<{ changed: true; etag?: string; config: CloudConfig }> {
    const res = await this.authed('/v1/config/sites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(edit) }, false, [400, 404, 409]);
    if (res.status === 404) throw new CloudError('unavailable', 'this OnlyRead Pro service cannot change the list from here yet');
    if (res.status !== 200) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new CloudError('bad_response', typeof body.error === 'string' ? body.error.slice(0, 40) : `http ${res.status}`);
    }
    return readConfig(res, 'config sites');
  }

  /** Pro runs the judge stage (judge/stage.ts, the same on both sides) and answers with its decision. With
   *  `readTracking` Jev is asked the question that lets read tracking through, and with `binary` (a binary or compressed
   *  body) Jev's write goes to the review model too, which is told how beacons look (judge/questions.ts). Only the redacted
   *  `state` is sent, never the raw fingerprint, whose query can keep token-like values and typed codes. */
  async decide(state: unknown, opaque: boolean, ask: JudgeAsk = {}): Promise<StageOutcome> {
    const flags = { ...(ask.readTracking ? { readTracking: true } : {}), ...(ask.binary ? { binary: true } : {}) };
    const res = await this.authed('/v1/classify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, opaque, ...flags }) });
    const d = (await res.json().catch(() => undefined)) as Partial<Record<keyof StageOutcome, unknown>> | undefined;
    const p = d?.pWrite;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new CloudError('bad_response', 'classify');
    if (d?.outcome !== 'allow' && d?.outcome !== 'block' && d?.outcome !== 'unsure') throw new CloudError('bad_response', 'classify outcome');
    if (d.stage !== 'primary' && d.stage !== 'review') throw new CloudError('bad_response', 'classify stage');
    if (typeof d.reason !== 'string') throw new CloudError('bad_response', 'classify reason');
    this.onJudged();
    return {
      outcome: d.outcome, stage: d.stage, reason: d.reason.slice(0, 200), pWrite: p,
      model: typeof d.model === 'string' ? d.model : 'cloud', judgeReason: typeof d.judgeReason === 'string' ? d.judgeReason.slice(0, 300) : undefined,
    };
  }

  /** A support report (POST /v1/support), answered with its id. Sent with the sign-in when there is one, so support
   *  can see the account; without one, or if the sign-in is refused, it goes anonymously. Too many reports from one
   *  place is `unavailable` with detail `rate_limited`; a 404 is a service without this route. */
  async sendSupport(report: SupportReport): Promise<string> {
    const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) };
    let res: Response | undefined;
    if (await this.signedIn()) {
      try { res = await this.authed('/v1/support', init, false, [400, 404, 413, 429]); } catch (err) {
        if (!(err instanceof CloudError) || err.code !== 'not_signed_in') throw err;
      }
    }
    if (!res) {
      try { res = await this.fetchImpl(`${this.serviceUrl}/v1/support`, init); } catch (err) {
        throw new CloudError('unavailable', err instanceof Error ? err.message : String(err));
      }
    }
    return supportId(res);
  }

  /** An authenticated call: refresh before expiry, retry once on an expired token, map failures to CloudError. */
  private async authed(path: string, init: RequestInit, retried = false, accept: number[] = []): Promise<Response> {
    let t = await this.store.get();
    if (!t) throw new CloudError('not_signed_in');
    if (t.expiresAt - EXPIRY_MARGIN_MS <= this.now()) t = await this.refresh(t);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.serviceUrl}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${t.accessToken}` } });
    } catch (err) {
      throw new CloudError('unavailable', err instanceof Error ? err.message : String(err));
    }
    if (res.ok || accept.includes(res.status)) return res;
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string; message?: unknown };
    if (res.status === 401) {
      if (body.error === 'token_expired' && !retried) {
        await this.refresh(t);
        return this.authed(path, init, true, accept);
      }
      // The account page signed this browser out (or the extension was removed elsewhere with its token): the service
      // says so at once, before the access token runs out. Told as a refused refresh is (the popup says why).
      if (body.error === 'signed_out') this.onRefreshRefused();
      await this.store.set(undefined);
      throw new CloudError('not_signed_in', body.error);
    }
    throw failureFor(res.status, body.error, text(body.message, 300));
  }

  /** One refresh at a time: concurrent requests share it. A refused refresh signs the user out. */
  private refresh(t: Tokens): Promise<Tokens> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
          const kept = t.uninstallToken ? { ...next, uninstallToken: t.uninstallToken } : next;
          await this.store.set(kept);
          return kept;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  private async tokenRequest(body: Record<string, string>): Promise<Tokens> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.serviceUrl}/v1/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
      throw new CloudError('unavailable', err instanceof Error ? err.message : String(err));
    }
    if (res.status === 400 || res.status === 401) {
      if (body.grant_type === 'refresh_token') { await this.store.set(undefined); this.onRefreshRefused(); }
      throw new CloudError('not_signed_in', 'token request refused');
    }
    if (!res.ok) throw new CloudError('unavailable', `http ${res.status}`);
    const d = (await res.json().catch(() => undefined)) as TokenResponse | undefined;
    if (!d?.access_token || !d.refresh_token || !(d.expires_in > 0)) throw new CloudError('bad_response', 'token');
    const uninstall = typeof d.uninstall_token === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(d.uninstall_token) ? { uninstallToken: d.uninstall_token } : {};
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: this.now() + d.expires_in * 1000, ...uninstall };
  }
}

export class CloudJudge implements Judge {
  readonly name = 'cloud' as const;
  constructor(
    private readonly client: CloudClient,
    private readonly onResult?: (err: CloudError | null) => void,
  ) {}

  async decide(rec: RequestRecord, opaque: boolean, ask?: JudgeAsk): Promise<StageOutcome> {
    try {
      const o = await this.client.decide(buildJudgeState(rec), opaque, ask);
      this.onResult?.(null);
      return o;
    } catch (err) {
      const e = err instanceof CloudError ? err : new CloudError('unavailable', err instanceof Error ? err.message : String(err));
      this.onResult?.(e);
      throw e;
    }
  }

  /** The deciding model's probability alone (the settings page's test of the judge). */
  async classify(rec: RequestRecord, ask?: JudgeAsk): Promise<JudgeResult> {
    const t0 = Date.now();
    const o = await this.decide(rec, false, ask);
    return { pWrite: o.pWrite, latencyMs: Date.now() - t0, model: o.model, reason: o.judgeReason };
  }
}

// ---- Sign-in helpers (PKCE, RFC 7636) ----

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** The service's sign-in page. `handoff=page`: after the user approves, the service sends the same tab to
 *  its done page (`signInDoneUrl`) with the code in the fragment, where the content script hands it to the extension;
 *  the code stays bound to `redirectUri`, the extension's chromiumapp.org address, which nothing loads. */
export function signInUrl(serviceUrl: string, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(`${serviceUrl.replace(/\/$/, '')}/signin`);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('handoff', 'page');
  return u.toString();
}

/** The page Chrome opens when OnlyRead is removed: while signed in to Pro, the service's goodbye page with the
 *  sign-in's uninstall token (in the fragment, which never reaches a server log), which signs this browser out, so it
 *  leaves the account's list of browsers at once instead of when its sign-in runs out; signed out, none. */
export function uninstallUrl(serviceUrl: string, t: Pick<Tokens, 'uninstallToken'> | undefined): string {
  return t?.uninstallToken ? `${serviceUrl.replace(/\/$/, '')}/goodbye#${new URLSearchParams({ t: t.uninstallToken })}` : '';
}

/** Whether `url` is the page at `path` on the service. */
function isServicePage(url: string | undefined, serviceUrl: string, path: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const page = new URL(`${serviceUrl.replace(/\/$/, '')}${path}`);
    return u.origin === page.origin && u.pathname.replace(/\/$/, '') === page.pathname;
  } catch { return false; }
}

/** Whether `url` is the service's sign-in done page (the only page whose code the extension takes). */
export function isSignInDonePage(url: string | undefined, serviceUrl: string): boolean {
  return isServicePage(url, serviceUrl, '/signin/done');
}

/** Whether `url` is the page an email sign-in link opens on the service (the sign-in goes on in the tab it started in). */
export function isSignInLinkPage(url: string | undefined, serviceUrl: string): boolean {
  return isServicePage(url, serviceUrl, '/sign-in/verify');
}
