// Mock of the OnlyRead Pro service for dev builds and tests: the contract the extension relies on (sign-in with PKCE,
// token, classify, me, config, config/sites, push, signout, support) plus a control endpoint that forces every failure case. Mounted by the fixture server under /cloud.
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { judgeStage } from '../../extension/src/background/judge/stage.ts';

interface MockState {
  email: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';
  plan: 'cloud' | 'none';
  usage: number;
  cap: number;
  /** Pro through free credits instead of a subscription (status `none`): judged requests granted and used. Each
   *  answered classify takes one; with none left classify answers 402 credits_exhausted. Account features stay on. */
  credits?: { total: number; used: number } | null;
  /** Seconds an access token lives. */
  tokenTtl: number;
  /** Make every API call answer 503. */
  down: boolean;
  /** Answer classify 429 rate_limited, as the service's per-minute cap does. */
  rateLimited?: boolean;
  /** Probability returned by classify when the heuristic does not match (tests pin it). */
  defaultP?: number;
  /** The account's managed site list (GET /v1/config). `POST /__mock {managed: {...}}` replaces it and moves the
   *  version on, as a save on the account page does. Once there is one (version above 0) it is in force while the
   *  subscription is, whatever `enabled` says. */
  managed: { enabled: boolean; sites: Record<string, { enabled: boolean }>; customSites: unknown[]; version: number; guardAll?: unknown; browser?: unknown; browserSites?: unknown };
  /** Answer /v1/config with 404, as a service without managed sites would. */
  noConfig?: boolean;
  /** Refuse the next POST /v1/config/sites with this error code (400; 409 for `conflict`), as a server whose rules are
   *  newer than the extension's would (a public suffix it knows and the extension does not), then answer as usual. */
  refuseEdit?: string | null;
  /** The VAPID public key GET /v1/push answers; unset, push is off (`key: null`), as on a service without it. Tests
   *  set one to have the extension subscribe. */
  pushKey?: string | null;
}

const initial = (): MockState => ({
  email: 'test.user@example.com', status: 'active', plan: 'cloud', usage: 0, cap: 5000, tokenTtl: 3600, down: false,
  managed: { enabled: false, sites: {}, customSites: [], version: 0 },
});

/** The built-in sites, as the service lists them: id and domains. */
const CATALOG: { id: string; domains: string[] }[] = (() => {
  const dir = new URL('../../extension/policy/sites/', import.meta.url);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')) as { id: string; domains: string[] });
})();

type Managed = MockState['managed'];
/** What a sign-in may do: `agent` for a setup link's, which may add to the account's list but never remove from it. */
type Scope = 'full' | 'agent';
type Custom = { id: string; name: string; domains: string[]; enabled: boolean };

/** One site edit with the contract's validation, as far as the mock can without the public-suffix
 *  list (the extension refuses those before it asks; `refuseEdit` stands in for a server whose rules are newer):
 *  `{add: {id}}`, `{add: {host, name?}}` (a host a built-in covers switches that site on), `{remove: {id}}`. Adding
 *  switches management on. The server's error code for a body that is not one operation (`invalid_request`), a built-in
 *  id the catalog does not know (`unknown-site`), a host that is not one (`not-a-host`) or a name past 60 characters
 *  (`name-too-long`), so a refused host can be tested end to end. */
type Edit = { add?: { id?: unknown; host?: unknown; name?: unknown }; remove?: { id?: unknown } };
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
function edited(m: Managed, b: Edit): Managed | string {
  const sites = { ...m.sites };
  const customSites = [...(m.customSites as Custom[])];
  const removeId = b.remove?.id;
  if (typeof removeId === 'string' && !b.add) {
    delete sites[removeId]; // as the service does (lib/managed.ts applyEdit)
    return { ...m, sites, customSites: customSites.filter((c) => c.id !== removeId) };
  }
  if (!b.add || b.remove) return 'invalid_request';
  const addId = b.add.id;
  if (typeof addId === 'string') return CATALOG.some((s) => s.id === addId) ? { ...m, enabled: true, sites: { ...sites, [addId]: { enabled: true } }, customSites } : 'unknown-site';
  const host = String(b.add.host ?? '').toLowerCase().replace(/^www\./, '');
  if (!HOST.test(host)) return 'not-a-host';
  const builtin = CATALOG.find((s) => s.domains.some((d) => host === d || host.endsWith(`.${d}`)));
  if (builtin) return { ...m, enabled: true, sites: { ...sites, [builtin.id]: { enabled: true } }, customSites };
  const name = typeof b.add.name === 'string' && b.add.name ? b.add.name : host;
  if (name.length > 60) return 'name-too-long';
  const i = customSites.findIndex((c) => c.id === host);
  if (i >= 0) customSites[i] = { ...customSites[i]!, enabled: true };
  else customSites.push({ id: host, name, domains: [host], enabled: true });
  return { ...m, enabled: true, sites, customSites };
}

const PLATFORMS = new Set(['mac', 'windows', 'linux', 'chromeos', 'other']);
/** `x-onlyread-browser`, checked as the service checks it: `{"platform","sites","version"}`, else null. */
function parseBrowser(raw: string | null): { platform: string; sites: number; version: string } | null {
  if (!raw || raw.length > 200) return null;
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    if (typeof b.platform !== 'string' || !PLATFORMS.has(b.platform) || !Number.isInteger(b.sites) || (b.sites as number) < 0 || typeof b.version !== 'string') return null;
    return { platform: b.platform, sites: b.sites as number, version: b.version };
  } catch { return null; }
}

export function cloudRouter(): express.Router {
  let state = initial();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  /** Setup links' one-time codes (made on the account page; here POST /__setup-link). */
  const setupLinks = new Set<string>();
  /** Access tokens: when each expires (ms), its sign-in (family) and what it may do. */
  const access = new Map<string, { exp: number; family: string; scope: Scope }>();
  /** Refresh tokens: each one's sign-in and scope, once rotated the token that replaced it, and `dead` once revoked
   *  without being rotated (the token a retry evicted, or the one the retry spent): presenting a dead token is a replay. */
  const refresh = new Map<string, { family: string; scope: Scope; next?: string; dead?: true }>();
  /** Sign-ins ended: signed out, a replayed refresh token, or signed out from the account page. */
  const ended = new Set<string>();
  const log: { ts: number; path: string; status: number }[] = [];
  /** The flags of the last classify call (GET /__mock `lastAsk`). */
  let lastAsk: { readTracking: boolean; binary: boolean } | null = null;
  /** The last `x-onlyread-browser` GET /v1/me or GET /v1/config carried, parsed; null when the
   *  last call had none, or one that is not the contract's JSON (then `browserRaw` holds it). */
  let browser: { platform: string; sites: number; version: string } | null = null;
  /** The sign-ins that checked in (GET /v1/me or /v1/config), as the service's browsers rows: counted in /v1/config's
   *  `browsers` and able to have sites of their own. */
  const seen = new Set<string>();
  /** The version of this browser's own list (the service's settings_version), which a removal is made against. */
  let browserVersion = 0;
  let browserRaw: string | null = null;
  const r = express.Router();
  const token = () => crypto.randomBytes(18).toString('base64url');
  // Sign-in families are uuids and access tokens JWT-shaped with the family in `fam`, as the service's (lib/tokens.ts):
  // the extension reads its own family from its token (judge/cloud.ts family). The signature part is random here.
  const jwt = (family: string, scope: Scope) => [{ alg: 'HS256' }, { fam: family, scp: scope }].map((o) => Buffer.from(JSON.stringify(o)).toString('base64url')).concat(token()).join('.');
  const issue = (family: string = crypto.randomUUID(), scope: Scope = 'full') => {
    const a = jwt(family, scope), rt = token();
    access.set(a, { exp: Date.now() + state.tokenTtl * 1000, family, scope });
    refresh.set(rt, { family, scope });
    return { access_token: a, refresh_token: rt, token_type: 'Bearer', expires_in: state.tokenTtl };
  };
  /** A refresh: a live token is rotated. A rotated one presented again while the token that replaced it was never used
   *  is a retry whose answer was lost: a fresh pair, the unused one dead, and the presented one spent (dead too), so
   *  the retry is honoured once. Any other replay (a rotated token whose successor was used, a dead token) ends the
   *  sign-in, as the service does (cloud app/v1/token/route.ts). */
  /** A new sign-in, with its uninstall token (the page Chrome opens when the extension is removed signs it out with it,
   *  cloud app/v1/uninstall). */
  const uninstall = new Map<string, string>();
  const signIn = (scope: Scope = 'full') => {
    const out = issue(undefined, scope);
    const u = crypto.randomBytes(32).toString('base64url');
    uninstall.set(u, refresh.get(out.refresh_token)!.family);
    return { ...out, uninstall_token: u };
  };
  const rotate = (rt: string) => {
    const t = refresh.get(rt);
    if (!t || ended.has(t.family)) return undefined;
    if (t.dead) { ended.add(t.family); return undefined; }
    if (t.next) {
      const successor = refresh.get(t.next);
      if (!successor || successor.next || successor.dead) { ended.add(t.family); return undefined; }
      successor.dead = true;
      t.dead = true;
    }
    const out = issue(t.family, t.scope);
    t.next = out.refresh_token;
    return out;
  };
  const resetsAt = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(); };
  const links = { pricing: 'http://localhost:4173/cloud/pricing', manage: 'http://localhost:4173/cloud/manage' };
  const onCredits = () => Boolean(state.credits) && state.status !== 'active' && state.status !== 'trialing';
  const left = () => (state.credits ? Math.max(0, state.credits.total - state.credits.used) : 0);
  // The account in the service's own words (extension: CloudAccount active, statusText, usageText, manageLabel, offer;
  // the service words them the same way), so the extension shows what the service says.
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const percent = (usage: number, cap: number) => (usage <= 0 ? 0 : Math.min(100, Math.max(1, Math.ceil((usage / Math.max(1, cap)) * 100))));
  const STATUS_TEXT: Record<string, string> = { active: 'active', trialing: 'trial', past_due: 'payment due', canceled: 'canceled', none: 'no subscription' };
  const creditsWords = () => {
    const active = left() > 0;
    return {
      active, statusText: active ? 'early access' : 'free requests used up',
      usageText: `${left().toLocaleString('en-US')} of ${state.credits!.total.toLocaleString('en-US')} free judged requests left`,
      manageLabel: 'Manage account', ...(active ? {} : { offer: { label: 'Add a code', url: links.manage } }),
    };
  };
  const subscriptionWords = () => {
    const active = state.status === 'active' || state.status === 'trialing';
    return {
      active, statusText: STATUS_TEXT[state.status] ?? state.status,
      usageText: `${percent(state.usage, state.cap)}% of this month's usage, resets ${day(resetsAt())}`,
      manageLabel: 'Manage subscription', ...(active ? {} : { offer: { label: 'Get Pro', url: links.pricing } }),
    };
  };
  const refusal = {
    subscriptionInactive: "Your OnlyRead Pro subscription isn't active, so requests no rule covers are refused. Get Pro on your account page.",
    creditsExhausted: 'Your free OnlyRead Pro requests are used up, so requests no rule covers are refused. Add a code on your account page.',
    limitReached: () => `This month's OnlyRead Pro usage is used up until ${day(resetsAt())}, so requests no rule covers are refused.`,
  };
  const me = () => onCredits()
    ? { email: state.email, plan: 'cloud', status: left() > 0 ? 'active' : 'credits_exhausted', usage: state.credits!.used, cap: state.credits!.total,
        resetsAt: resetsAt(), credits: { left: left(), total: state.credits!.total }, links, ...creditsWords() }
    : { email: state.email, plan: state.plan, status: state.status, usage: state.usage, cap: state.cap, resetsAt: resetsAt(), links, ...subscriptionWords() };

  r.use((req, res, next) => {
    res.on('finish', () => { if (!req.path.startsWith('/__')) log.push({ ts: Date.now(), path: `${req.method} ${req.path}`, status: res.statusCode }); });
    if (state.down && req.path.startsWith('/v1/')) { res.status(503).json({ error: 'unavailable' }); return; }
    next();
  });

  // Browser sign-in: approve at once and redirect back with a one-time code (the service shows a form); with
  // `handoff=page` (the extension's sign-in), to the done page instead.
  r.get('/signin', (req, res) => {
    const redirect = String(req.query.redirect_uri ?? ''), challenge = String(req.query.code_challenge ?? ''), st = String(req.query.state ?? '');
    if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(redirect) && !/^http:\/\/localhost[:/]/.test(redirect)) { res.status(400).send('bad redirect_uri'); return; }
    if (req.query.code_challenge_method !== 'S256' || !challenge) { res.status(400).send('PKCE S256 required'); return; }
    const code = token();
    codes.set(code, { challenge, redirect });
    if (req.query.handoff === 'page') {
      // The extension's tab sign-in: the done page, with the code in the fragment for the content script.
      res.redirect(302, `${req.protocol}://${req.get('host')}${req.baseUrl}/signin/done#${new URLSearchParams({ code, state: st })}`);
      return;
    }
    const u = new URL(redirect); u.searchParams.set('code', code); u.searchParams.set('state', st);
    res.redirect(302, u.toString());
  });
  r.get('/signin/done', (_req, res) => {
    res.type('html').send('<!doctype html><title>Signed in</title><p>Finishing sign-in…</p>');
  });

  // The agent-setup page: the form the content script reads, and a
  // record of what the extension posted back, for the tests (e2e/agent-setup.spec.ts).
  r.get('/agent-setup', (_req, res) => {
    res.type('html').send(`<!doctype html><title>Set up OnlyRead</title>
<textarea id="onlyread-sites"></textarea>
<label><input type="checkbox" id="onlyread-all-tabs"> Guard every tab</label>
<button type="button" id="onlyread-apply">Apply to OnlyRead</button>
<button type="button" id="onlyread-connect">Connect</button>
<input type="text" id="onlyread-agent-name">
<button type="button" data-onlyread-agent="grok">Grok</button>
<script>
  window.__onlyread = [];
  addEventListener('message', (e) => { if (e.source === window && e.data && e.data.source === 'onlyread-extension') window.__onlyread.push(e.data); });
  window.postMessage({ source: 'onlyread-setup-page', type: 'hello' }, location.origin);
</script>`);
  });

  r.post('/v1/token', (req, res) => {
    const b = req.body ?? {};
    if (b.grant_type === 'authorization_code') {
      const c = codes.get(String(b.code));
      codes.delete(String(b.code));
      const ok = c && crypto.createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url') === c.challenge && c.redirect === b.redirect_uri;
      if (!ok) { res.status(400).json({ error: 'invalid_grant' }); return; }
      res.json(signIn()); return;
    }
    if (b.grant_type === 'setup_link') {
      if (!setupLinks.delete(String(b.code))) { res.status(400).json({ error: 'invalid_grant' }); return; }
      // An agent's browser: it may add to the account's list but never remove from it. Its row exists from the start,
      // with the link's sites as its own list at version 1 (the service's lib/setup-link.ts startBrowser).
      const out = signIn('agent');
      seen.add(refresh.get(out.refresh_token)!.family);
      browserVersion = Math.max(browserVersion, 1);
      res.json(out); return;
    }
    if (b.grant_type === 'refresh_token') {
      const next = rotate(String(b.refresh_token));
      if (!next) { res.status(400).json({ error: 'invalid_grant' }); return; }
      res.json(next); return;
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  /** Each sign-in's push subscription (POST /v1/push), by its family. */
  const pushSubs: Record<string, { endpoint: string; keys: { p256dh: string; auth: string } }> = {};

  const auth: express.RequestHandler = (req, res, next) => {
    const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const a = access.get(t);
    if (a === undefined) { res.status(401).json({ error: 'invalid_token' }); return; }
    // Signed out (from the account page, or the extension removed): refused at once, as the service does.
    if (ended.has(a.family)) { res.status(401).json({ error: 'signed_out' }); return; }
    if (a.exp < Date.now()) { res.status(401).json({ error: 'token_expired' }); return; }
    res.locals.token = a;
    next();
  };

  r.get('/v1/me', auth, (req, res) => {
    seen.add((res.locals.token as { family: string }).family);
    const raw = req.header('x-onlyread-browser') ?? null;
    browserRaw = raw;
    browser = parseBrowser(raw);
    res.json(me());
  });

  // The ETag says whether the list is in force as well as its version.
  const active = () => state.status === 'active' || state.status === 'trialing' || onCredits();
  const config = (family?: string, scope?: Scope) => {
    const m = state.managed;
    const own = m.browserSites as { sites?: Record<string, { enabled: boolean }>; customSites?: Custom[] } | undefined;
    const ownOn = Boolean(own && (Object.values(own.sites ?? {}).some((x) => x.enabled) || (own.customSites ?? []).some((c) => c.enabled)));
    const on = active(); // an active account always has its lists, empty ones too (lib/managed.ts configFor)
    // Guard every site: the account's, and this browser's from the account page, passed as set.
    const browserLevel = m.browser as { on?: boolean; excludeSites?: string[] } | undefined;
    const levels = { ...(m.guardAll ? { guardAll: m.guardAll } : {}), ...(browserLevel ? { browser: browserLevel } : {}), ...(ownOn ? { browserSites: own } : {}) };
    // How many browsers are signed in, and this browser's own list version, as the service answers (lib/managed.ts).
    const count = [...seen].filter((f) => !ended.has(f)).length;
    const extras = { ...(family && seen.has(family) ? { browserVersion } : {}), browsers: count };
    const etag = !on ? `"${m.version}-off-c${count}"` : browserVersion ? `"${m.version}-b${browserVersion}-c${count}"` : `"${m.version}-c${count}"`;
    const body = on ? { ...extras, version: Math.max(1, m.version), managed: true, sites: m.sites, customSites: m.customSites, updatedAt: new Date().toISOString(), ...levels } : { ...extras, version: m.version, managed: false };
    // The sign-in the answer was made for and its token's scope, from the token checked (the extension's cloud-sync.ts
    // trusts these, not what it stores).
    return { etag, body: family ? { ...body, family, scope: scope ?? 'full' } : body };
  };
  r.get('/v1/config', auth, (req, res) => {
    // The poll is the browser's check-in too.
    const raw = req.header('x-onlyread-browser') ?? null;
    browserRaw = raw;
    browser = parseBrowser(raw);
    if (state.noConfig) { res.status(404).json({ error: 'not_found' }); return; }
    const { family, scope } = res.locals.token as { family: string; scope: Scope };
    seen.add(family);
    const { etag, body } = config(family, scope);
    res.set('cache-control', 'no-store').set('etag', etag);
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.json(body);
  });

  // One edit from the extension: the version moves on when the list
  // changes, and the answer is the whole config with its ETag.
  r.post('/v1/config/sites', auth, (req, res) => {
    if (state.noConfig) { res.status(404).json({ error: 'not_found' }); return; }
    // A removal: never from an agent's browser, and only while the sign-in is live (an access token outlives a signout).
    if (typeof req.body?.remove?.id === 'string' && !req.body.add) {
      const t = res.locals.token as { family: string; scope: Scope };
      if (t.scope === 'agent') { res.status(403).json({ error: 'agent_scope' }); return; }
      if (ended.has(t.family)) { res.status(401).json({ error: 'signed_out' }); return; }
    }
    if (!active()) { res.status(402).json({ error: 'subscription_inactive', status: state.status }); return; }
    if (state.refuseEdit) { const error = state.refuseEdit; state.refuseEdit = null; res.status(error === 'conflict' ? 409 : 400).json({ error }); return; }
    // Where it goes (the account's list, or this browser's own), and the version a removal was made against: another
    // change since is a conflict, as on the service.
    const b = req.body ?? {};
    const scope = b.scope === undefined || b.scope === 'account' ? 'account' : b.scope === 'browser' ? 'browser' : undefined;
    if (!scope) { res.status(400).json({ error: 'invalid_request' }); return; }
    const { scope: _s, version: v, ...op } = b;
    const removing = typeof op.remove?.id === 'string' && !op.add;
    const family = (res.locals.token as { family: string }).family;
    if (scope === 'browser') {
      if (!seen.has(family)) { res.status(404).json({ error: 'not_found' }); return; }
      if (removing && Number.isInteger(v) && v !== browserVersion) { res.status(409).json({ error: 'conflict' }); return; }
      const own = (state.managed.browserSites ?? { sites: {}, customSites: [] }) as { sites: Record<string, { enabled: boolean }>; customSites: Custom[] };
      const next = edited({ ...state.managed, sites: own.sites ?? {}, customSites: own.customSites ?? [] }, op);
      if (typeof next === 'string') { res.status(400).json({ error: next }); return; }
      if (next.customSites.length > 100) { res.status(400).json({ error: 'too-many' }); return; }
      const list = { sites: next.sites, customSites: next.customSites };
      if (JSON.stringify(list) !== JSON.stringify({ sites: own.sites ?? {}, customSites: own.customSites ?? [] })) { state.managed = { ...state.managed, browserSites: list }; browserVersion++; }
    } else {
      if (removing && Number.isInteger(v) && v !== state.managed.version) { res.status(409).json({ error: 'conflict' }); return; }
      const next = edited(state.managed, op);
      if (typeof next === 'string') { res.status(400).json({ error: next }); return; }
      if (next.customSites.length > 100) { res.status(400).json({ error: 'too-many' }); return; }
      if (JSON.stringify(next) !== JSON.stringify(state.managed)) state.managed = { ...next, version: state.managed.version + 1 };
    }
    const { etag, body } = config(family, (res.locals.token as { scope: Scope }).scope);
    res.set('cache-control', 'no-store').set('etag', etag).json(body);
  });

  // The service runs the judge stage (extension/src/background/judge/stage.ts) with its two models; here both are
  // one keyword heuristic, so the stage's own logic is what the tests exercise.
  // Web Push (cloud lib/push.ts): the key to subscribe with, and each sign-in's subscription, kept to be read back through
  // GET /__mock. The mock never sends a push: tests wake the extension themselves.
  r.get('/v1/push', auth, (_req, res) => { res.json({ key: state.pushKey ?? null }); });
  r.post('/v1/push', auth, (req, res) => {
    if (!state.pushKey) { res.status(404).json({ error: 'push_off' }); return; }
    const b = req.body ?? {};
    if (typeof b.endpoint !== 'string' || !b.endpoint.startsWith('https://') || typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string') { res.status(400).json({ error: 'invalid_subscription' }); return; }
    pushSubs[(res.locals.token as { family: string }).family] = { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } };
    res.json({ ok: true });
  });
  r.delete('/v1/push', auth, (_req, res) => { delete pushSubs[(res.locals.token as { family: string }).family]; res.json({ ok: true }); });

  r.post('/v1/classify', auth, async (req, res) => {
    if (onCredits()) {
      if (left() <= 0) { res.status(402).json({ error: 'credits_exhausted', credits: { left: 0, total: state.credits!.total, used: state.credits!.used }, message: refusal.creditsExhausted }); return; }
    } else if (state.status !== 'active' && state.status !== 'trialing') { res.status(402).json({ error: 'subscription_inactive', status: state.status, message: refusal.subscriptionInactive }); return; }
    if (state.rateLimited) { res.status(429).set('retry-after', '30').json({ error: 'rate_limited', retryAfter: 30 }); return; }
    if (onCredits()) state.credits!.used++;
    else if (state.usage >= state.cap) { res.status(429).json({ error: 'limit_reached', resetsAt: resetsAt(), message: refusal.limitReached() }); return; }
    else state.usage++;
    const s = req.body?.state ?? {};
    // The method is judged separately; matching it as text would make every POST a write.
    const text = `${s.path ?? ''} ${s.bodyShape ?? ''} ${s.bodyPreview ?? ''} ${s.triggeredBy?.name ?? ''}`;
    const pWrite = String(s.method).toUpperCase() === 'GET' ? 0.02
      : /mutation|create|update|delete|send|archive|mark|save|publish/i.test(text) ? 0.96
      : state.defaultP ?? 0.08;
    const answer = async () => ({ pWrite, model: 'mock-cloud-1', reason: pWrite > 0.5 ? 'looks like a write' : 'looks like a read' });
    // What the extension asked for besides the request (read tracking allowed, a binary body), as the service reads it.
    lastAsk = { readTracking: req.body?.readTracking === true, binary: req.body?.binary === true };
    res.json(await judgeStage({ primary: answer, review: answer, lines: { allow: 0.3, block: 0.75, reviewAllow: 0.3, reviewBlock: 0.75 }, opaque: req.body?.opaque === true, binary: lastAsk.binary }));
  });

  // A support report: anyone may send one. A live sign-in names the account; an expired one is refreshed first (401
  // token_expired, as everywhere), and one the service does not know is sent on as anonymous, never signed out over
  // a report. At most SUPPORT_PER_HOUR from one place an hour, as the service limits them.
  const reports: { id: string; at: number; email?: string; account?: string; body: unknown }[] = [];
  const SUPPORT_PER_HOUR = 5;
  r.post('/v1/support', (req, res) => {
    const t = access.get((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (t && t.exp < Date.now()) { res.status(401).json({ error: 'token_expired' }); return; }
    const b = req.body ?? {};
    const requests = Array.isArray(b.requests) ? b.requests : [];
    if (!requests.length || requests.length > 50 || typeof b.extension?.version !== 'string') { res.status(400).json({ error: 'invalid_request' }); return; }
    if (reports.filter((x) => x.at > Date.now() - 3_600_000).length >= SUPPORT_PER_HOUR) { res.status(429).json({ error: 'rate_limited' }); return; }
    const id = crypto.randomBytes(4).toString('hex').toUpperCase();
    reports.push({ id, at: Date.now(), ...(typeof b.email === 'string' ? { email: b.email } : {}), ...(t ? { account: state.email } : {}), body: b });
    res.json({ id });
  });

  r.post('/v1/signout', (req, res) => {
    const t = refresh.get(String(req.body?.refresh_token ?? ''));
    if (t) { ended.add(t.family); delete pushSubs[t.family]; }
    res.json({ ok: true });
  });

  r.post('/v1/uninstall', (req, res) => {
    const family = uninstall.get(String(req.body?.token ?? ''));
    if (family) { uninstall.delete(String(req.body.token)); ended.add(family); }
    res.json({ ok: true, signedOut: Boolean(family) });
  });

  r.get('/pricing', (_req, res) => { res.type('html').send('<h1>OnlyRead Pro pricing (mock)</h1>'); });
  r.get('/manage', (_req, res) => { res.type('html').send('<h1>Manage subscription (mock)</h1>'); });

  // Test control: GET state and call log, POST a partial state, POST {reset:true}, POST {expireTokens:true},
  // POST {managed: {enabled, sites, customSites}} (a save on the account page: the version moves on),
  // POST {refuseEdit: '<code>'} (the next edit is refused with it).
  // The account page's site changes: here only that a request
  // arrived, for e2e/agent-setup.spec.ts's account-lock test.
  /** The account routes reached (their paths), for the account-lock test: a refused request never gets here. */
  const accountHits: string[] = [];
  for (const route of ['/account/sites/edit', '/account/sites/off', '/account/browsers/signout']) {
    r.post(route, (req, res) => { accountHits.push(req.path); res.json({ ok: true }); });
  }
  r.post('/__setup-link', (_req, res) => {
    const code = crypto.randomBytes(32).toString('base64url');
    setupLinks.add(code);
    res.json({ code });
  });
  // A stand-in for the account page's framed sections (the extension's content/account-frames.ts): placeholders naming
  // the account given in ?account=, as the real account page renders them.
  r.get('/__frames', (req, res) => {
    const account = String(req.query.account ?? '').replace(/[^a-z0-9@._+-]/gi, '');
    res.type('html').send(`<!doctype html><html><body><h1>Account</h1>
<div id="activity" data-onlyread-frame="activity" data-account="${account}">Install OnlyRead to see this browser's activity.</div>
<div id="security" data-onlyread-frame="security" data-account="${account}">Install OnlyRead to see this browser's protection.</div>
</body></html>`);
  });
  r.get('/__mock', (_req, res) => { res.json({ state, log, browser, browserRaw, accountHits, reports, lastAsk, pushSubs }); });
  r.post('/__mock', (req, res) => {
    const b = req.body ?? {};
    if (b.reset) { state = initial(); codes.clear(); access.clear(); refresh.clear(); ended.clear(); log.length = 0; browser = null; browserRaw = null; reports.length = 0; for (const f of Object.keys(pushSubs)) delete pushSubs[f]; seen.clear(); browserVersion = 0; }
    if (b.expireTokens) for (const a of access.values()) a.exp = 0;
    // Signed out from the account page: every sign-in ends (its refresh tokens refused, access tokens lapsed).
    if (b.signOutAll) { for (const t of refresh.values()) ended.add(t.family); for (const a of access.values()) a.exp = 0; }
    const { reset: _r, expireTokens: _e, signOutAll: _s, managed, ...patch } = b;
    state = { ...state, ...patch };
    if (managed?.browser || managed?.browserSites) browserVersion++;
    if (managed) state.managed = { enabled: managed.enabled === true, sites: managed.sites ?? {}, customSites: managed.customSites ?? [], version: state.managed.version + 1, guardAll: managed.guardAll, browser: managed.browser, browserSites: managed.browserSites };
    res.json({ state });
  });
  return r;
}
