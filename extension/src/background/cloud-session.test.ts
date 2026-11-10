import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { cloudRouter } from '../../../fixtures/cloud/mock.ts';

// The Pro session against the mock service: sign-in in a tab (the sign-in page's redirect followed by hand, to the
// done page whose code the content script hands over), the account shown in the UI (cached five minutes, refetched on demand or after a server-side change), sign-out.
const h = vi.hoisted(() => ({ S: { policy: { judge: { provider: 'cloud' }, cloud: { serviceUrl: '' } } }, system: vi.fn(), secrets: { keys: {} as Record<string, string> }, uninstall: [] as string[] }));
// The own-key judge's keys, which a Pro sign-in removes.
vi.mock('./state', () => ({ S: h.S, system: h.system, getSecrets: async () => h.secrets }));

let server: http.Server;
let base = '';
const store: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
const EXT_ID = 'a'.repeat(32);

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/cloud', cloudRouter());
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}/cloud`;
  h.S.policy.cloud.serviceUrl = base;
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
      remove: async (k: string) => { delete store[k]; },
    } },
    runtime: { id: EXT_ID, setUninstallURL: async (u: string) => { h.uninstall.push(u); } },
  });
  (globalThis.chrome as unknown as { storage: Record<string, unknown> }).storage.session = {
    get: async (k: string) => (k in session ? { [k]: session[k] } : {}),
    set: async (o: Record<string, unknown>) => { Object.assign(session, o); },
    remove: async (k: string) => { delete session[k]; },
  };
});
afterAll(() => { vi.unstubAllGlobals(); return new Promise<void>((r) => server.close(() => r())); });

const meCalls = async () => ((await (await fetch(`${base}/__mock`)).json()) as { log: { path: string }[] }).log.filter((e) => e.path === 'GET /v1/me').length;
const mock = (patch: Record<string, unknown>) => fetch(`${base}/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });

describe('the Pro session', () => {
  it('signs in in a tab: the sign-in page sends it to the done page with a code, which the tab that started it can use once', async () => {
    const { cloudStatus, finishSignIn, signInRedirect, startSignIn, takeSignIn } = await import('./cloud-session');
    expect(await cloudStatus()).toMatchObject({ provider: 'cloud', serviceUrl: base, signedIn: false, account: undefined });
    expect(signInRedirect()).toBe(`https://${EXT_ID}.chromiumapp.org/cloud`);
    const url = await startSignIn(7, 'chrome-extension://x/setup.html');
    expect(new URL(url).searchParams.get('handoff')).toBe('page');
    const done = (await fetch(url, { redirect: 'manual' })).headers.get('location')!;
    expect(new URL(done).pathname).toBe('/cloud/signin/done');
    const { state } = (session.cloudSignInPending as { state: string });
    const code = new URLSearchParams(new URL(done).hash.slice(1)).get('code')!;
    expect(await takeSignIn(state, 8)).toBeUndefined(); // another tab
    expect(await takeSignIn('other', 7)).toBeUndefined(); // another state
    const pending = await takeSignIn(state, 7);
    expect(pending).toMatchObject({ tabId: 7, back: 'chrome-extension://x/setup.html', redirect: signInRedirect() });
    expect(await takeSignIn(state, 7)).toBeUndefined(); // good once
    h.secrets.keys = { openrouter: 'sk-or-kept' };
    const st = await finishSignIn(code, pending!);
    // The session only signs in: making Pro the judge and deleting the key is messages.ts enterPro's, through the lock.
    expect(store.secrets).toBeUndefined();
    expect(st.signedIn).toBe(true);
    expect(st.account).toMatchObject({ email: 'test.user@example.com', plan: 'cloud', status: 'active' });
    expect(store.cloudTokens).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), uninstallToken: expect.any(String) });
    expect(h.system).toHaveBeenCalledWith('cloud:signed-in');
    // Removing OnlyRead now opens the service's goodbye page, which signs this browser out with the sign-in's token.
    expect(h.uninstall.at(-1)).toBe(`${base}/goodbye#t=${(store.cloudTokens as { uninstallToken: string }).uninstallToken}`);
  });
  // A dev build defaults to the local mock; a sign-in with the mock not running goes to the real service.
  it('falls back to the real service for a sign-in only on a dev build\'s own mock address, and only when nothing answers there', async () => {
    const { serviceAnswers, signInFallback } = await import('./cloud-session');
    const { RELEASE_SERVICE_URL, defaultPolicy } = await import('./policy');
    const dev = defaultPolicy();
    expect(dev.cloud.serviceUrl).toBe('http://localhost:4173/cloud');
    const down = async () => false;
    const up = async () => true;
    expect(await signInFallback(dev, down)).toBe(RELEASE_SERVICE_URL);
    expect(RELEASE_SERVICE_URL).toBe('https://pro.onlyread.ai');
    expect(await signInFallback(dev, up)).toBeUndefined(); // the mock is running (the e2e suites)
    expect(await signInFallback({ ...dev, cloud: { ...dev.cloud, serviceUrl: 'http://localhost:9999/cloud' } }, down)).toBeUndefined(); // set by hand
    expect(await signInFallback({ ...dev, devSink: null, cloud: { ...dev.cloud, serviceUrl: RELEASE_SERVICE_URL } }, down)).toBeUndefined();
    // Only a build for the local mock falls back (no ONLYREAD_SERVICE_URL): one made for another service that finds the
    // mock's address saved keeps it, until its start moves it (messages.ts applyBuildService).
    const g = globalThis as { __ONLYREAD_SERVICE_URL__?: string };
    try {
      for (const other of ['http://localhost:8080', RELEASE_SERVICE_URL, 'https://foo.example']) {
        g.__ONLYREAD_SERVICE_URL__ = other;
        expect(await signInFallback(dev, down)).toBeUndefined();
      }
    } finally { delete g.__ONLYREAD_SERVICE_URL__; }
    // Any HTTP answer counts as the mock being there; a refused connection does not.
    expect(await serviceAnswers(`${base}/no-such-page`)).toBe(true);
    expect(await serviceAnswers('http://127.0.0.1:1/cloud')).toBe(false);
  });
  it('drops a sign-in left waiting longer than SIGN_IN_TTL_MS', async () => {
    const { SIGN_IN_TTL_MS, startSignIn, takeSignIn } = await import('./cloud-session');
    await startSignIn(7, 'chrome-extension://x/options.html');
    const p = session.cloudSignInPending as { state: string; at: number };
    p.at -= SIGN_IN_TTL_MS + 1;
    expect(await takeSignIn(p.state, 7)).toBeUndefined();
    expect(session.cloudSignInPending).toBeUndefined();
  });
  it('keeps the account for a while, refetches when asked, and after the judge reports a subscription change', async () => {
    const { cloudStatus, onCloudResult } = await import('./cloud-session');
    const { CloudError } = await import('./judge/cloud');
    const before = await meCalls();
    await cloudStatus();
    expect(await meCalls()).toBe(before);
    await cloudStatus(true);
    expect(await meCalls()).toBe(before + 1);
    onCloudResult(new CloudError('limit_reached'));
    expect((await cloudStatus()).lastError?.code).toBe('limit_reached');
    expect(await meCalls()).toBe(before + 2);
    onCloudResult(null);
    expect((await cloudStatus()).lastError).toBeUndefined();
  });
  it('keeps the last account and records the error when the service cannot be reached', async () => {
    const { cloudStatus } = await import('./cloud-session');
    await mock({ down: true });
    const st = await cloudStatus(true);
    expect(st.account?.email).toBe('test.user@example.com');
    expect(st.lastError?.code).toBe('unavailable');
    await mock({ down: false });
  });
  it('signs out: tokens gone, account gone, and nothing to open when OnlyRead is removed', async () => {
    const { cloudSignOut, cloudStatus } = await import('./cloud-session');
    const st = await cloudSignOut();
    expect(st).toMatchObject({ signedIn: false, account: undefined, lastError: undefined });
    expect(store.cloudTokens).toBeUndefined();
    expect(h.uninstall.at(-1)).toBe('');
    expect(h.system).toHaveBeenCalledWith('cloud:signed-out');
    expect((await cloudStatus()).signedIn).toBe(false);
  });
  it('makes a new client, with no account carried over, when the service address changes', async () => {
    const { cloudClient } = await import('./cloud-session');
    const a = cloudClient();
    expect(cloudClient()).toBe(a);
    const other = { ...h.S.policy, cloud: { serviceUrl: 'https://elsewhere.example/' } } as never;
    const b = cloudClient(other);
    expect(b).not.toBe(a);
    expect(b.serviceUrl).toBe('https://elsewhere.example');
  });
});
