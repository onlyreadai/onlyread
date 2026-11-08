import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { cloudRouter } from '../../../../fixtures/cloud/mock.ts';
import { CloudClient, CloudError, CloudJudge, browserHeader, browserPlatform, isSignInDonePage, pkceChallenge, randomToken, signInUrl, uninstallUrl, type Tokens } from './cloud';
import { decide, type CacheLike } from '../decision';
import { defaultPolicy, normalizePolicy } from '../policy';
import type { RequestRecord } from '../../shared/types';

let server: http.Server;
let base = '';
const REDIRECT = 'http://localhost/cb';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/cloud', cloudRouter());
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}/cloud`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const mock = (patch: Record<string, unknown>) =>
  fetch(`${base}/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });

function memoryStore(initial?: Tokens) {
  let t = initial;
  return { get: async () => t, set: async (n: Tokens | undefined) => { t = n; } };
}

/** The code in the done page's address (`#code=…&state=…`), as the content script takes it. */
const codeOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('code')!;

/** The whole browser sign-in, minus the browser: follow the sign-in page's redirect to the done page by hand. */
async function signIn(client: CloudClient): Promise<void> {
  const verifier = randomToken(32), state = randomToken(16);
  const res = await fetch(signInUrl(client.serviceUrl, REDIRECT, state, await pkceChallenge(verifier)), { redirect: 'manual' });
  expect(res.status).toBe(302);
  await client.exchangeCode(codeOf(res.headers.get('location')!), verifier, REDIRECT);
}

const rec = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  ts: 0, tabId: 1, requestId: 'r', method: 'POST', url: 'https://app.example.com/api/items', host: 'app.example.com', path: '/api/items',
  queryKeys: [], contentType: 'application/json', resourceType: 'XHR', hasBody: true, bodyPreview: '{"q":"report"}',
  bodyShape: 'json:q', fingerprint: 'POST app.example.com/api/items json:q', lastUiActions: [], ...over,
});
const noCache: CacheLike = { get: async () => undefined, touch: async () => {} };

beforeEach(async () => { await mock({ reset: true }); });

describe('OnlyRead Pro client', () => {
  it('signs in with PKCE and reads the account', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    expect(await c.signedIn()).toBe(false);
    await signIn(c);
    expect(await c.signedIn()).toBe(true);
    const a = await c.me();
    expect(a.email).toBe('test.user@example.com');
    expect(a.status).toBe('active');
  });

  it('keeps the sign-in\'s uninstall token across refreshes, and the goodbye page it names signs that browser out', async () => {
    let now = Date.now();
    const store = memoryStore();
    const c = new CloudClient({ serviceUrl: base, store, now: () => now });
    await signIn(c);
    const token = (await store.get())!.uninstallToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    now += 3600_000;
    await c.me(); // refreshed: the refresh answer carries no uninstall token, the sign-in's is kept
    expect((await store.get())!.uninstallToken).toBe(token);
    
    const url = uninstallUrl(`${base}/`, await store.get());
    expect(url).toBe(`${base}/goodbye#t=${token}`);
    expect(uninstallUrl(base, undefined)).toBe('');
    // What the goodbye page does with it: the sign-in ends.
    const bye = await fetch(`${base}/v1/uninstall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(new URL(url).hash.slice(1)).get('t') }) });
    expect(await bye.json()).toEqual({ ok: true, signedOut: true });
    now += 3600_000;
    await expect(c.me()).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('learns at its next call that the account signed this browser out, before its access token runs out', async () => {
    let told = 0;
    const store = memoryStore();
    const c = new CloudClient({ serviceUrl: base, store, onRefreshRefused: () => { told++; } });
    await signIn(c);
    // The sign-in ended elsewhere (the account page): its access token is still within its quarter hour.
    await fetch(`${base}/v1/signout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: (await store.get())!.refreshToken }) });
    await expect(c.me()).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(await store.get()).toBeUndefined();
    expect(told).toBe(1); // said as the service ending the sign-in
  });

  it('rejects a done page whose state does not match, and knows the done page of its service only', () => {
    expect(isSignInDonePage('https://pro.example/signin/done', 'https://pro.example')).toBe(true);
    expect(isSignInDonePage('https://pro.example/base/signin/done/', 'https://pro.example/base')).toBe(true);
    expect(isSignInDonePage('https://pro.example/signin/done', 'https://pro.example/base')).toBe(false);
    expect(isSignInDonePage('https://evil.example/signin/done', 'https://pro.example')).toBe(false);
    expect(isSignInDonePage('https://pro.example/account', 'https://pro.example')).toBe(false);
    expect(isSignInDonePage(undefined, 'https://pro.example')).toBe(false);
  });
  it('refuses a code exchange with the wrong verifier', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    const state = randomToken(16);
    const res = await fetch(signInUrl(base, REDIRECT, state, await pkceChallenge('right-verifier')), { redirect: 'manual' });
    const code = codeOf(res.headers.get('location')!);
    await expect(c.exchangeCode(code, 'wrong-verifier', REDIRECT)).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('classifies reads low and writes high', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    expect(await c.decide({ method: 'POST', path: '/api/search', bodyShape: 'json:q' }, false)).toMatchObject({ outcome: 'allow', stage: 'primary', reason: 'p<allow' });
    // An unreadable body: a low first score is not trusted, so the review model decides.
    expect(await c.decide({ method: 'POST', path: '/rpc', bodyShape: 'json[]:nn' }, true)).toMatchObject({ outcome: 'allow', stage: 'review', reason: 'review-band:opaque-body,llm-allow(p1=0.08)' });
    expect(await c.decide({ method: 'POST', path: '/api/items', triggeredBy: { name: 'Send' } }, false)).toMatchObject({ outcome: 'block', reason: 'p>block' });
  });

  it('tells the service when read tracking is allowed and when the body is binary, and a binary write goes to review', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    const lastAsk = async () => ((await (await fetch(`${base}/__mock`)).json()) as { lastAsk: unknown }).lastAsk;
    await c.decide({ method: 'POST', path: '/api/search', bodyShape: 'json:q' }, false);
    expect(await lastAsk()).toEqual({ readTracking: false, binary: false });
    // A write the first model is sure of, on a binary body: the review model has the last word.
    expect(await c.decide({ method: 'POST', path: '/api/items', triggeredBy: { name: 'Send' } }, true, { readTracking: true, binary: true }))
      .toMatchObject({ stage: 'review', reason: expect.stringMatching(/^review-band:binary-body,/) });
    expect(await lastAsk()).toEqual({ readTracking: true, binary: true });
  });

  it('says when a request was judged, and only then', async () => {
    let judged = 0;
    const c = new CloudClient({ serviceUrl: base, store: memoryStore(), onJudged: () => { judged++; } });
    await signIn(c);
    await c.decide({ method: 'POST', path: '/api/items' }, false);
    expect(judged).toBe(1);
    await mock({ status: 'none', credits: { total: 1, used: 1 } });
    await expect(c.decide({ method: 'POST' }, false)).rejects.toMatchObject({ code: 'credits_exhausted' });
    expect(judged).toBe(1);
  });

  it('refreshes and retries once when the server says the token expired', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await mock({ expireTokens: true });
    expect((await c.me()).email).toBe('test.user@example.com');
    const { log } = await (await fetch(`${base}/__mock`)).json() as { log: { path: string; status: number }[] };
    expect(log.map((l) => `${l.path} ${l.status}`)).toEqual(expect.arrayContaining(['GET /v1/me 401', 'POST /v1/token 200', 'GET /v1/me 200']));
  });

  it('refreshes before sending when the token is about to expire', async () => {
    let now = Date.now();
    const store = memoryStore();
    const c = new CloudClient({ serviceUrl: base, store, now: () => now });
    await signIn(c);
    const before = (await store.get())!.accessToken;
    now += 3600_000; // an hour later: past expiry
    await c.me();
    expect((await store.get())!.accessToken).not.toBe(before);
  });

  it('signs out locally when the refresh token is refused', async () => {
    const store = memoryStore({ accessToken: 'stale', refreshToken: 'unknown', expiresAt: 0 });
    let refused = 0;
    const c = new CloudClient({ serviceUrl: base, store, onRefreshRefused: () => { refused++; } });
    await expect(c.me()).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(await store.get()).toBeUndefined();
    // The owner is told, so the sign-out is logged and shown rather than silent.
    expect(refused).toBe(1);
  });

  it('maps subscription, quota and outage answers to distinct errors', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await mock({ status: 'canceled' });
    await expect(c.decide({ method: 'POST' }, false)).rejects.toMatchObject({ code: 'subscription_inactive' });
    // Free credits used up: its own error, so the popup says to add a code, not to subscribe.
    await mock({ status: 'none', credits: { total: 1, used: 1 } });
    await expect(c.decide({ method: 'POST' }, false)).rejects.toMatchObject({ code: 'credits_exhausted' });
    await mock({ credits: null });
    await mock({ status: 'active', usage: 10, cap: 10 });
    await expect(c.decide({ method: 'POST' }, false)).rejects.toMatchObject({ code: 'limit_reached' });
    // The per-minute cap is a pause, not the month used up.
    await mock({ usage: 0, rateLimited: true });
    await expect(c.decide({ method: 'POST' }, false)).rejects.toMatchObject({ code: 'unavailable', detail: 'rate_limited' });
    await mock({ rateLimited: false, down: true });
    await expect(c.decide({ method: 'POST' }, false)).rejects.toMatchObject({ code: 'unavailable' });
    const offline = new CloudClient({ serviceUrl: 'http://127.0.0.1:1', store: memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }) });
    await expect(offline.decide({ method: 'POST' }, false)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('is not signed in without tokens, and sign-out clears them', async () => {
    const store = memoryStore();
    const c = new CloudClient({ serviceUrl: base, store });
    await expect(c.me()).rejects.toMatchObject({ code: 'not_signed_in' });
    await signIn(c);
    await c.signOut();
    expect(await store.get()).toBeUndefined();
  });
});

describe('this browser, told to the service with GET /v1/me and GET /v1/config (x-onlyread-browser)', () => {
  const seen = async () => ((await (await fetch(`${base}/__mock`)).json()) as { browser: unknown; browserRaw: string | null });

  it('sends compact JSON with the platform, the sites guarded now and the version on every GET /v1/me', async () => {
    let sites = 3;
    const c = new CloudClient({ serviceUrl: base, store: memoryStore(), browser: () => ({ platform: 'mac', sites, version: '1.0.0' }) });
    await signIn(c);
    await c.me();
    expect(await seen()).toMatchObject({ browser: { platform: 'mac', sites: 3, version: '1.0.0' }, browserRaw: '{"platform":"mac","sites":3,"version":"1.0.0"}' });
    sites = 5; // read again for each call: the count as it is now
    await c.me();
    expect((await seen()).browser).toEqual({ platform: 'mac', sites: 5, version: '1.0.0' });
  });

  it('sends it again on the retry after a refresh, and with the site-list poll, its check-in', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore(), browser: () => ({ platform: 'linux', sites: 1, version: '0.2.0' }) });
    await signIn(c);
    await mock({ expireTokens: true });
    await c.me();
    expect((await seen()).browser).toEqual({ platform: 'linux', sites: 1, version: '0.2.0' });
    await mock({ reset: true });
    await signIn(c);
    expect((await seen()).browserRaw).toBeNull();
    await c.config();
    expect((await seen()).browser).toEqual({ platform: 'linux', sites: 1, version: '0.2.0' });
  });

  it('sends no header without a browser, or when describing it fails', async () => {
    const plain = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(plain);
    await plain.me();
    expect((await seen()).browserRaw).toBeNull();
    const broken = new CloudClient({ serviceUrl: base, store: memoryStore(), browser: () => { throw new Error('no storage'); } });
    await signIn(broken);
    expect((await broken.me()).email).toBe('test.user@example.com');
    expect((await seen()).browserRaw).toBeNull();
  });

  it('keeps the keys in the contract\'s order', () => {
    expect(browserHeader({ version: '1.2.3', sites: 0, platform: 'other' } as never)).toBe('{"platform":"other","sites":0,"version":"1.2.3"}');
    expect(browserHeader({ version: '1.2.3', sites: 2, platform: 'linux', agent: 'grok' })).toBe('{"platform":"linux","sites":2,"version":"1.2.3","agent":"grok"}');
  });

  it('reads the platform from userAgentData, else the user agent', () => {
    expect(browserPlatform({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(browserPlatform({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(browserPlatform({ userAgentData: { platform: 'Linux' } })).toBe('linux');
    expect(browserPlatform({ userAgentData: { platform: 'Chrome OS' } })).toBe('chromeos');
    expect(browserPlatform({ userAgentData: { platform: 'Android' } })).toBe('other');
    expect(browserPlatform({ userAgentData: { platform: '' }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' })).toBe('mac');
    expect(browserPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('windows');
    expect(browserPlatform({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)' })).toBe('chromeos');
    expect(browserPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
    expect(browserPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })).toBe('other');
    expect(browserPlatform({})).toBe('other');
  });
});

describe('the account\'s site list (GET /v1/config)', () => {
  it('reads an active account\'s empty lists, then the list with its ETag, then 304 while it holds', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    // The ETag carries the browser count (c1: this browser, checked in by the poll itself).
    // No list saved yet: an active account still has its lists, empty (the extension's Pro mode keeps its sites there).
    // Each answer names the sign-in it was made for (cloud-sync.ts trusts a lowering by it).
    const family = await c.family();
    expect(family).toMatch(/^[0-9a-f-]{36}$/);
    expect(await c.config()).toEqual({ changed: true, etag: '"0-c1"', config: { managed: true, version: 1, sites: {}, customSites: [], browserVersion: 0, browsers: 1, family, scope: 'full' } });
    await mock({ managed: { enabled: true, sites: { gmail: { enabled: true } }, customSites: [] } });
    const r = await c.config('"0-c1"');
    expect(r).toEqual({ changed: true, etag: '"1-c1"', config: { managed: true, version: 1, sites: { gmail: { enabled: true } }, customSites: [], browserVersion: 0, browsers: 1, family, scope: 'full' } });
    expect(await c.config('"1-c1"')).toEqual({ changed: false });
  });
  it('keeps the sign-in an answer names only when it is a sign-in id', async () => {
    const answer = (family: unknown, scope?: unknown) => new CloudClient({ serviceUrl: base, store: memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }), fetchImpl: async () => new Response(JSON.stringify({ managed: true, version: 1, sites: {}, customSites: [], family, scope }), { status: 200 }) }).config();
    const f = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(await answer(f)).toMatchObject({ config: { family: f } });
    for (const bad of ['not-a-family', 7, null, undefined]) expect((await answer(bad, 'agent')) as { config: object }).not.toHaveProperty('config.family');
    // The token's scope, with the sign-in only, and only as the service names them.
    expect(await answer(f, 'agent')).toMatchObject({ config: { family: f, scope: 'agent' } });
    expect(await answer(f, 'full')).toMatchObject({ config: { family: f, scope: 'full' } });
    expect((await answer(f, 'admin')) as { config: object }).not.toHaveProperty('config.scope');
    expect((await answer('bad', 'agent')) as { config: object }).not.toHaveProperty('config.scope');
  });
  it('reads a 404 (a server from before managed sites) as not managed, and a 402 as an inactive subscription', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await mock({ noConfig: true });
    expect(await c.config()).toEqual({ changed: true, config: { managed: false, version: 0 } });
    const paywalled = new CloudClient({ serviceUrl: base, store: memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }), fetchImpl: async () => new Response('{"error":"subscription_inactive"}', { status: 402 }) });
    await expect(paywalled.config()).rejects.toMatchObject({ code: 'subscription_inactive' });
  });
  it('refuses an answer it cannot read', async () => {
    const answering = (body: unknown) => new CloudClient({ serviceUrl: base, store: memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }), fetchImpl: async () => Response.json(body) });
    await expect(answering({ managed: true }).config()).rejects.toMatchObject({ code: 'bad_response' });
    await expect(answering({ version: 2, managed: true, sites: {} }).config()).rejects.toMatchObject({ code: 'bad_response' });
    await expect(answering({ version: -1, managed: false }).config()).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('the service\'s own words (GET /v1/me, refusals)', () => {
  const tokens = () => memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
  const account = { email: 'a@example.com', plan: 'cloud', status: 'active', usage: 1, cap: 10, resetsAt: '2026-11-01T00:00:00Z', links: { pricing: 'https://pro.example/pricing', manage: 'https://pro.example/account' } };
  it('keeps the words and the offer when well formed, and drops what is not', async () => {
    const me = (extra: object) => new CloudClient({ serviceUrl: base, store: tokens(), fetchImpl: async () => Response.json({ ...account, ...extra }) }).me();
    expect(await me({ active: false, statusText: ' trial ended ', usageText: '1 of 10', manageLabel: 'Manage billing', offer: { label: 'Subscribe', url: 'https://pro.example/pricing?plan=month' } }))
      .toMatchObject({ active: false, statusText: 'trial ended', usageText: '1 of 10', manageLabel: 'Manage billing', offer: { label: 'Subscribe', url: 'https://pro.example/pricing?plan=month' } });
    const odd = await me({ active: 'yes', statusText: 7, usageText: '', offer: { label: 'Go', url: 'javascript:alert(1)' } });
    for (const k of ['active', 'statusText', 'usageText', 'manageLabel', 'offer']) expect(odd).not.toHaveProperty(k);
    expect((await me({ statusText: 'x'.repeat(500) })).statusText).toHaveLength(80);
  });
  it('carries a refusal\'s message, whatever the code of a 402', async () => {
    const refusing = (status: number, body: unknown) => new CloudClient({ serviceUrl: base, store: tokens(), fetchImpl: async () => Response.json(body, { status }) });
    await expect(refusing(402, { error: 'trial_ended', message: 'Your trial ended.' }).me()).rejects.toMatchObject({ code: 'subscription_inactive', serverMessage: 'Your trial ended.' });
    await expect(refusing(429, { error: 'limit_reached', message: 'Used up until Nov 1.' }).me()).rejects.toMatchObject({ code: 'limit_reached', serverMessage: 'Used up until Nov 1.' });
    await expect(refusing(402, { error: 'credits_exhausted' }).me()).rejects.toMatchObject({ code: 'credits_exhausted', serverMessage: undefined });
  });
});

describe('editing the account\'s site list (POST /v1/config/sites)', () => {
  const tokens = () => memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
  it('sends one edit and reads the whole list back with its ETag, which a GET then answers 304', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await c.config(); // checked in: counted, and able to have sites of its own
    expect(await c.editSites({ add: { host: 'tools.example.net', name: 'Tools' } })).toEqual({
      changed: true, etag: '"1-c1"', config: { managed: true, version: 1, sites: {}, customSites: [{ id: 'tools.example.net', name: 'Tools', domains: ['tools.example.net'], enabled: true }], browserVersion: 0, browsers: 1, family: await c.family(), scope: 'full' },
    });
    expect(await c.config('"1-c1"')).toEqual({ changed: false });
    expect((await c.editSites({ remove: { id: 'tools.example.net' } })).config).toMatchObject({ version: 2, customSites: [] });
  });
  it('names the server\'s reason for a refused edit; a 404 is a server from before the route; a 402 an inactive subscription', async () => {
    const answering = (status: number, body: unknown) => new CloudClient({ serviceUrl: base, store: tokens(), fetchImpl: async () => Response.json(body, { status }) });
    await expect(answering(400, { error: 'too-many' }).editSites({ add: { host: 'x.example.com' } })).rejects.toThrow('cloud:bad_response (too-many)');
    // The server's code travels as `detail`, apart from the message, so messages.ts can put it in words.
    await expect(answering(409, { error: 'conflict' }).editSites({ add: { host: 'x.example.com' } })).rejects.toMatchObject({ code: 'bad_response', detail: 'conflict' });
    await expect(answering(400, { error: 'public-suffix' }).editSites({ add: { host: 'co.uk' } })).rejects.toMatchObject({ code: 'bad_response', detail: 'public-suffix' });
    await expect(answering(400, {}).editSites({ add: { host: 'x.example.com' } })).rejects.toMatchObject({ code: 'bad_response', detail: 'http 400' });
    await expect(answering(404, { error: 'not_found' }).editSites({ add: { id: 'gmail' } })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(answering(402, { error: 'subscription_inactive' }).editSites({ add: { id: 'gmail' } })).rejects.toMatchObject({ code: 'subscription_inactive' });
    await expect(answering(200, { managed: true }).editSites({ add: { id: 'gmail' } })).rejects.toMatchObject({ code: 'bad_response' });
    await expect(new CloudClient({ serviceUrl: base, store: memoryStore() }).editSites({ add: { id: 'gmail' } })).rejects.toMatchObject({ code: 'not_signed_in' });
  });
  // The mock answers the server's codes for what it can check itself, and refuses on request
  // for what it cannot (a server whose public-suffix list is newer than the extension's).
  it('the mock validates as the service does, and refuses the next edit with a given code on request', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await expect(c.editSites({ add: { id: 'notasite' } })).rejects.toMatchObject({ detail: 'unknown-site' });
    await expect(c.editSites({ add: { host: 'localhost' } })).rejects.toMatchObject({ detail: 'not-a-host' });
    await expect(c.editSites({ add: { host: 'ok.example.org', name: 'x'.repeat(61) } })).rejects.toMatchObject({ detail: 'name-too-long' });
    await expect(c.editSites({ add: { id: 'gmail' }, remove: { id: 'gmail' } } as never)).rejects.toMatchObject({ detail: 'invalid_request' });
    await mock({ refuseEdit: 'public-suffix' });
    await expect(c.editSites({ add: { host: 'tools.example.net' } })).rejects.toMatchObject({ detail: 'public-suffix' });
    await mock({ refuseEdit: 'conflict' });
    await expect(c.editSites({ add: { host: 'tools.example.net' } })).rejects.toMatchObject({ detail: 'conflict' });
    expect((await c.editSites({ add: { host: 'tools.example.net' } })).config).toMatchObject({ version: 1, customSites: [{ id: 'tools.example.net' }] }); // the next edit lands
    const { log } = (await (await fetch(`${base}/__mock`)).json()) as { log: { path: string; status: number }[] };
    expect(log.filter((l) => l.path === 'POST /v1/config/sites').map((l) => l.status)).toEqual([400, 400, 400, 400, 400, 409, 200]);
  });
  it('edits this browser\'s own list once it has checked in; the config says its version and how many browsers there are', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    // Not checked in yet (no /v1/me or /v1/config): the service has no row for this browser.
    await expect(c.editSites({ add: { host: 'crm.example.com' }, scope: 'browser' })).rejects.toMatchObject({ code: 'unavailable' });
    const first = await c.config();
    expect(first).toMatchObject({ changed: true, config: { managed: true, browsers: 1, browserVersion: 0 } });
    const r = await c.editSites({ add: { host: 'crm.example.com', name: 'CRM' }, scope: 'browser' });
    expect(r.config).toMatchObject({ managed: true, browserVersion: 1, browsers: 1, browserSites: { customSites: [{ id: 'crm.example.com', name: 'CRM' }] } });
    expect(r.config).toMatchObject({ customSites: [] }); // the account's own list is untouched
  });
  it('a removal made against an older version is refused as conflict, in either list; an addition never is', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await c.config();
    await c.editSites({ add: { host: 'tools.example.net' } }); // account list, version 1
    await c.editSites({ add: { host: 'other.example.net' } }); // version 2
    await expect(c.editSites({ remove: { id: 'tools.example.net' }, version: 1 })).rejects.toMatchObject({ code: 'bad_response', detail: 'conflict' });
    expect((await c.editSites({ remove: { id: 'tools.example.net' }, version: 2 })).config).toMatchObject({ version: 3 });
    expect((await c.editSites({ add: { host: 'late.example.net' }, version: 1 })).config).toMatchObject({ version: 4 });
    await c.editSites({ add: { id: 'linear' }, scope: 'browser' }); // this browser's list, version 1
    await expect(c.editSites({ remove: { id: 'linear' }, scope: 'browser', version: 0 })).rejects.toMatchObject({ detail: 'conflict' });
    expect((await c.editSites({ remove: { id: 'linear' }, scope: 'browser', version: 1 })).config).toMatchObject({ browserVersion: 2 });
  });
});

describe('Pro judge in the decision path', () => {
  it('allows a read and refuses a write, reporting success to the listener', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    const seen: (string | null)[] = [];
    const judge = new CloudJudge(c, (e) => seen.push(e ? e.code : null));
    const policy = normalizePolicy({ ...defaultPolicy(), judge: { ...defaultPolicy().judge, provider: 'cloud' } });
    const read = await decide(rec({ bodyPreview: '{"q":"quarterly report"}' }), { policy, judge, cache: noCache });
    expect(read.verdict).toBe('allow');
    expect(read.source).toBe('cloud');
    const write = await decide(rec({ bodyPreview: '{"title":"x"}', lastUiActions: [{ ts: 0, type: 'click', tag: 'button', name: 'Send', url: '' }] }), { policy, judge, cache: noCache });
    expect(write.verdict).toBe('block');
    expect(seen).toEqual([null, null]);
  });

  it('fails closed with the reason when the subscription is inactive', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await mock({ status: 'past_due' });
    const seen: string[] = [];
    const judge = new CloudJudge(c, (e) => { if (e) seen.push(e.code); });
    const policy = normalizePolicy({ ...defaultPolicy(), judge: { ...defaultPolicy().judge, provider: 'cloud' } });
    const d = await decide(rec(), { policy, judge, cache: noCache });
    expect(d.verdict).toBe('block');
    expect(d.reason).toMatch(/cloud:subscription_inactive/);
    expect(seen).toEqual(['subscription_inactive']);
  });

  it('refuses an answer that is still unsure after the server reviewed it', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    await mock({ defaultP: 0.5 });
    const policy = normalizePolicy({ ...defaultPolicy(), reviewBand: 'llm', judge: { ...defaultPolicy().judge, provider: 'cloud' } });
    const d = await decide(rec(), { policy, judge: new CloudJudge(c), cache: noCache });
    expect(d).toMatchObject({ verdict: 'review', action: 'fail', source: 'cloud', reason: 'review-band:llm-unsure(p1=0.50)' });
  });

  it('allows an unreadable read once the server\'s review says it reads, as the own-key judges do', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(c);
    const policy = normalizePolicy({ ...defaultPolicy(), judge: { ...defaultPolicy().judge, provider: 'cloud' } });
    const d = await decide(rec({ bodyShape: 'json[]:nn', bodyPreview: '[1,2]' }), { policy, judge: new CloudJudge(c), cache: noCache });
    expect(d).toMatchObject({ verdict: 'review', action: 'continue', source: 'cloud', reason: 'review-band:opaque-body,llm-allow(p1=0.08)' });
  });

  it('wraps an unexpected failure as a Pro error', async () => {
    const judge = new CloudJudge({ decide: async () => { throw new TypeError('boom'); } } as unknown as CloudClient);
    await expect(judge.classify(rec())).rejects.toBeInstanceOf(CloudError);
  });
});

describe('Pro policy settings', () => {
  it('defaults to OnlyRead Pro, with the dev build pointing at the mock', () => {
    const p = defaultPolicy();
    expect(p.judge.provider).toBe('cloud');
    expect(p.cloud.serviceUrl).toBe('http://localhost:4173/cloud');
  });
  it('rejects an unknown provider and a plain-http service address', () => {
    const d = defaultPolicy();
    expect(() => normalizePolicy({ ...d, judge: { ...d.judge, provider: 'other' } })).toThrow(/provider/);
    expect(() => normalizePolicy({ ...d, cloud: { ...d.cloud, serviceUrl: 'http://api.example.com' } })).toThrow(/serviceUrl/);
    expect(normalizePolicy({ ...d, cloud: { ...d.cloud, serviceUrl: 'https://api.example.com' } }).cloud.serviceUrl).toBe('https://api.example.com');
  });
});

describe('support reports (POST /v1/support)', () => {
  const report = (n = 1) => ({
    extension: { version: '1.0.0', build: 'release' as const, mode: 'enforce' as const, attachWhen: 'agent-session', judge: 'cloud' as const, readTracking: true, sites: ['linkedin'] },
    userAgent: 'test', note: 'opening a message',
    requests: Array.from({ length: n }, (_, i) => ({ ts: i, method: 'POST', url: 'https://www.linkedin.com/x', verdict: 'block' as const, source: 'jev' as const, reason: 'jev' })),
  });
  const reports = async () => ((await (await fetch(`${base}/__mock`)).json()) as { reports: { id: string; account?: string }[] }).reports;

  it('goes anonymously without a sign-in, and names the account with one', async () => {
    const anon = new CloudClient({ serviceUrl: base, store: memoryStore() });
    const id = await anon.sendSupport(report());
    expect(id).toMatch(/^[0-9A-F]{8}$/);
    const signed = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await signIn(signed);
    await signed.sendSupport(report());
    expect((await reports()).map((r) => r.account)).toEqual([undefined, 'test.user@example.com']);
  });

  it('refreshes an expired sign-in, and a sign-in the service does not know neither fails the report nor is dropped for it', async () => {
    const store = memoryStore();
    const c = new CloudClient({ serviceUrl: base, store });
    await signIn(c);
    await mock({ expireTokens: true });
    await c.sendSupport(report());
    expect((await reports())[0]?.account).toBe('test.user@example.com');
    const stranger = memoryStore({ accessToken: 'unknown', refreshToken: 'unknown', expiresAt: Date.now() + 3_600_000 });
    await new CloudClient({ serviceUrl: base, store: stranger }).sendSupport(report());
    expect((await reports())[1]?.account).toBeUndefined();
    expect(await stranger.get()).toBeDefined();
  });

  it('says when there are too many, and when the report is refused', async () => {
    const c = new CloudClient({ serviceUrl: base, store: memoryStore() });
    await expect(c.sendSupport(report(0))).rejects.toMatchObject({ code: 'bad_response', detail: 'invalid_request' });
    for (let i = 0; i < 5; i++) await c.sendSupport(report());
    await expect(c.sendSupport(report())).rejects.toMatchObject({ code: 'unavailable', detail: 'rate_limited' });
    await mock({ down: true });
    await expect(c.sendSupport(report())).rejects.toBeInstanceOf(CloudError);
  });
});

describe('CloudClient.family: this browser\'s sign-in, from its own access token', () => {
  const jwt = (claims: unknown) => ['{"alg":"HS256"}', JSON.stringify(claims)].map((p) => Buffer.from(p).toString('base64url')).concat('sig').join('.');
  const client = (accessToken?: string) => new CloudClient({ serviceUrl: 'https://pro.example', store: memoryStore(accessToken ? { accessToken, refreshToken: 'r', expiresAt: Date.now() + 60_000 } : undefined) });
  it('reads the fam claim of a JWT access token', async () => {
    expect(await client(jwt({ fam: '0f8fad5b-d9cb-469f-a165-70867728950e', scp: 'full' })).family()).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
  });
  it('is undefined signed out, for a token that is no JWT, or a claim that is no sign-in id', async () => {
    expect(await client().family()).toBeUndefined();
    expect(await client('opaque-token').family()).toBeUndefined();
    expect(await client(jwt({ fam: '<script>' })).family()).toBeUndefined();
    expect(await client(jwt({ scp: 'full' })).family()).toBeUndefined();
  });
});
