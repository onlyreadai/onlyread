import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { cloudRouter } from '../../../fixtures/cloud/mock.ts';
import type { Policy } from '../shared/types';

// The Pro account's site list against the mock service: fetched with its ETag, applied at once when it raises
// protection, kept pending while the lock holds when it lowers it, and applied once the lock opens. The real policy.ts
// (setPolicy with its nonce, onPolicyChange) runs against a storage stand-in that behaves like chrome.storage: keys come
// back sorted at every depth, a write equal to what is stored fires no change, and change events arrive in a later
// task. index.ts's queued change handler is reduced to what matters here. setPolicy is not replaced by a synchronous
// apply, so the lag between a write and its taking effect is exercised.
vi.mock('./audit', () => ({ record: async () => {}, clearBadge: () => {} }));
vi.mock('./sink', () => ({ send: () => {} }));

// ---- chrome.storage as the background sees it ----
const store: Record<string, unknown> = {};
type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;
const listeners: Listener[] = [];
const sorted = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x)));
let events = 0; // change events scheduled and not yet delivered
let failNextSet = false;
let policyWrites = 0; // `set` calls that changed the stored policy
const deliver = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
  events++;
  setTimeout(() => { events--; for (const l of listeners) l(changes, 'local'); }, 0);
};
const local = {
  get: async (k: string | string[]) => { const ks = Array.isArray(k) ? k : [k]; return Object.fromEntries(ks.filter((x) => x in store).map((x) => [x, store[x]])); },
  set: async (o: Record<string, unknown>) => {
    if (failNextSet) { failNextSet = false; throw new Error('QUOTA_BYTES exceeded (test)'); }
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(o)) {
      const nv = sorted(v);
      if (JSON.stringify(store[k]) === JSON.stringify(nv)) continue;
      changes[k] = { oldValue: store[k], newValue: nv };
      store[k] = nv;
    }
    if (changes.policy) policyWrites++;
    if (Object.keys(changes).length) deliver(changes);
  },
  remove: async (k: string) => { const had = k in store; const old = store[k]; delete store[k]; if (had) deliver({ [k]: { oldValue: old } }); },
};
/** A write from around the background (another extension context, a debugger): no nonce. */
const outside = (policy: unknown) => local.set({ policy });
const sessionStore: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: { local, onChanged: { addListener: (l: Listener) => { listeners.push(l); } }, session: {
    get: async (k: string) => (k in sessionStore ? { [k]: sessionStore[k] } : {}),
    set: async (o: Record<string, unknown>) => { Object.assign(sessionStore, o); },
    remove: async (k: string) => { delete sessionStore[k]; },
  } },
  runtime: { id: 'a'.repeat(32) },
});

// Each test gets fresh modules (see freshModules), so no state (the pending change, the ETag, the lock's PIN copy, queued
// work) carries over.
let S: typeof import('./state').S;
let enabledSiteIds: typeof import('./state').enabledSiteIds;
let settingsLock: typeof import('./state').settingsLock;
let carryManaged: typeof import('./policy').carryManaged;
let defaultPolicy: typeof import('./policy').defaultPolicy;
let getPolicy: typeof import('./policy').getPolicy;
let lastWrittenPolicy: typeof import('./policy').lastWrittenPolicy;
let normalizePolicy: typeof import('./policy').normalizePolicy;
let onPolicyChange: typeof import('./policy').onPolicyChange;
let policyAccepted: typeof import('./policy').policyAccepted;
let setPolicy: typeof import('./policy').setPolicy;
let lockFor: typeof import('./protection').lockFor;
let weakeningChanges: typeof import('./protection').weakeningChanges;
let accountRefusal: typeof import('./cloud-sync').accountRefusal;
let applyPendingManaged: typeof import('./cloud-sync').applyPendingManaged;
let flushAccountEdits: typeof import('./cloud-sync').flushAccountEdits;
let initManagedSync: typeof import('./cloud-sync').initManagedSync;
let managedPollDue: typeof import('./cloud-sync').managedPollDue;
let pendingManaged: typeof import('./cloud-sync').pendingManaged;
let syncManagedSites: typeof import('./cloud-sync').syncManagedSites;
let cloudClient: typeof import('./cloud-session').cloudClient;
let finishSignIn: typeof import('./cloud-session').finishSignIn;
let signInWithSetupLink: typeof import('./cloud-session').signInWithSetupLink;
let startSignIn: typeof import('./cloud-session').startSignIn;
let takeSignIn: typeof import('./cloud-session').takeSignIn;
let pkceChallenge: typeof import('./judge/cloud').pkceChallenge;
let randomToken: typeof import('./judge/cloud').randomToken;
let signInUrl: typeof import('./judge/cloud').signInUrl;
let records: MockInstance<typeof import('./audit').record>;

// index.ts's queued change handler, reduced to what matters here and kept in step with it: one change at a time, an
// outside write that lowers protection while locked put back as the policy last written, an accepted one noted
// (policy.ts policyAccepted), S.policy set. `hold` keeps the queue busy, as applyPolicy is while it awaits the rules.
const log: string[] = [];
let hold: Promise<void> | undefined;
let applying: Promise<void> = Promise.resolve();
async function freshModules(): Promise<void> {
  vi.resetModules();
  listeners.length = 0; // the previous modules' storage listener
  applying = Promise.resolve();
  ({ S, enabledSiteIds, settingsLock } = await import('./state'));
  ({ carryManaged, defaultPolicy, getPolicy, lastWrittenPolicy, normalizePolicy, onPolicyChange, policyAccepted, setPolicy } = await import('./policy'));
  ({ lockFor, weakeningChanges } = await import('./protection'));
  ({ accountRefusal, applyPendingManaged, flushAccountEdits, initManagedSync, managedPollDue, pendingManaged, syncManagedSites } = await import('./cloud-sync'));
  ({ cloudClient, finishSignIn, signInWithSetupLink, startSignIn, takeSignIn } = await import('./cloud-session'));
  ({ pkceChallenge, randomToken, signInUrl } = await import('./judge/cloud'));
  records = vi.spyOn(await import('./audit'), 'record');
  onPolicyChange((p, own) => {
    applying = applying.then(async () => {
      if (hold) await hold;
      const prev = S.policy;
      if (!own) {
        const l = await settingsLock();
        const refused = lockFor(weakeningChanges(prev, p), { agentActive: l.agent, pinSet: l.pinSet, pinUnlocked: l.pinUnlocked })?.message;
        if (refused) { log.push(`settings-locked:storage ${refused}`); await setPolicy(lastWrittenPolicy() ?? prev); return; }
        policyAccepted(p);
      }
      S.policy = p;
      log.push(`policy-updated own=${own}`);
    }).catch((err: unknown) => { log.push(`policy change failed: ${String(err)}`); });
  }, (m) => log.push(`invalid ${m}`));
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** Every change event delivered and applied, including the ones the applies themselves write. */
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await tick();
    await applying;
    if (!events) { await tick(); if (!events) { await applying; return; } }
  }
  throw new Error('storage events did not settle');
}

let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/cloud', cloudRouter());
  server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://localhost:${(server.address() as AddressInfo).port}/cloud`;
});
afterAll(() => { vi.unstubAllGlobals(); return new Promise<void>((r) => server.close(() => r())); });

const mock = (patch: Record<string, unknown>) => fetch(`${base}/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
const configCalls = async () => ((await (await fetch(`${base}/__mock`)).json()) as { log: { path: string; status: number }[] }).log.filter((e) => e.path === 'GET /v1/config').map((c) => c.status);
const site = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, domains: [id], enabled: true, ...extra });
const APP = site('app.example.com', { name: 'App' });
const list = (sites: Record<string, boolean>, customSites: unknown[] = []) =>
  mock({ managed: { enabled: true, sites: Object.fromEntries(Object.entries(sites).map(([id, on]) => [id, { enabled: on }])), customSites } });
const logged = () => records.mock.calls.map(([e]) => (e as { reason: string }).reason).filter((r) => r.startsWith('managed-sites:'));

/** The extension's own sign-in, as the tab and the done page run it (cloud-session.ts). */
async function signInAsExtension(): Promise<void> {
  const done = (await fetch(await startSignIn(1, 'chrome-extension://x/options.html'), { redirect: 'manual' })).headers.get('location')!;
  const p = new URLSearchParams(new URL(done).hash.slice(1));
  await finishSignIn(p.get('code')!, (await takeSignIn(p.get('state')!, 1))!);
}

/** This browser signed in by a setup link instead (agent scope), as an agent's browser is. */
async function linkSignIn(): Promise<void> {
  delete store.cloudTokens;
  const { code } = (await (await fetch(`${base}/__setup-link`, { method: 'POST' })).json()) as { code: string };
  await signInWithSetupLink(code);
}

/** The worker restarted: fresh modules over the same storage, read as startup reads it. */
async function restart(): Promise<void> {
  await settled();
  await freshModules();
  S.policy = await getPolicy();
}

/** This browser's tokens lost (dropped around the background: no sign-out hook runs), then a sign-in to another
 *  account, whose list is `sites`. */
async function otherSignIn(sites: Record<string, boolean>): Promise<void> {
  delete store.cloudTokens;
  await mock({ reset: true });
  await list(sites);
  await signInAsExtension();
}

async function signIn(): Promise<void> {
  const client = cloudClient();
  const verifier = randomToken(32), state = randomToken(16), redirect = 'http://localhost/cb';
  const res = await fetch(signInUrl(client.serviceUrl, redirect, state, await pkceChallenge(verifier)), { redirect: 'manual' });
  await client.exchangeCode(new URLSearchParams(new URL(res.headers.get('location')!).hash.slice(1)).get('code')!, verifier, redirect);
}

beforeEach(async () => {
  await settled();
  await freshModules();
  for (const k of Object.keys(store)) delete store[k];
  log.length = 0; hold = undefined; failNextSet = false; policyWrites = 0;
  await mock({ reset: true });
  // The browser's own settings: one custom site, every built-in off. Read the way startup reads them. An own-key judge:
  // these tests are the account list's way through the lock, with a list of this browser's own beside it; in Pro mode
  // that list moves to the account (the "Pro mode" suite below).
  const d = defaultPolicy();
  store.policy = sorted(normalizePolicy({ ...d, enabled: true, judge: { ...d.judge, provider: 'byok' }, cloud: { ...d.cloud, serviceUrl: base }, customSites: [APP] }));
  S.policy = await getPolicy();
  S.agentSession = false; S.pinUnlockedUntil = 0;
  await signIn();
});

/** A sync, then every change it caused in force. */
const sync = async (reason = 'test') => { await syncManagedSites(reason); await settled(); };
const applyPending = async (reason: string) => { await applyPendingManaged(reason); await settled(); };

describe('the Pro account\'s site list', () => {
  it('is polled every half hour while Web Push reaches this browser and every five minutes when not, counted from the last fetch', async () => {
    await syncManagedSites('popup-opened'); // any fetch restarts the count
    const at = Date.now();
    expect(managedPollDue(false, at + 4 * 60_000)).toBe(false);
    expect(managedPollDue(false, at + 5 * 60_000)).toBe(true);
    expect(managedPollDue(true, at + 29 * 60_000)).toBe(false);
    expect(managedPollDue(true, at + 30 * 60_000)).toBe(true);
  });

  it('an active account\'s lists are in force from the first sync, empty ones too; a site on them is guarded at once, with the local sites', async () => {
    await sync();
    expect(S.policy.managed).toMatchObject({ version: 1, sites: {}, customSites: [] });
    expect(enabledSiteIds()).toEqual(['app.example.com']);
    expect(policyWrites).toBe(1);
    records.mockClear(); log.length = 0;
    await list({ gmail: true, linear: false });
    await sync();
    // The account's list adds to the browser's own, so switching management on raises
    // protection and applies at once, during an agent session too.
    expect(S.policy.managed).toMatchObject({ version: 1, sites: { gmail: { enabled: true }, linear: { enabled: false } } });
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(S.policy.customSites.map((c) => c.id)).toEqual(['app.example.com']); // the local list, unchanged
    expect(S.policy.effective.targetDomains).toContain('mail.google.com');
    expect(S.policy.effective.targetDomains).toContain('app.example.com');
    expect(logged()).toContain('managed-sites:applied(test) v1');
    expect(log).toEqual(['policy-updated own=true']);
  });

  it('asks again with the ETag it holds: an unchanged list is a 304 and writes nothing', async () => {
    await list({ gmail: true });
    await sync();
    await sync();
    expect(policyWrites).toBe(1);
    expect(await configCalls()).toEqual([200, 304]);
    expect(logged().filter((r) => r.startsWith('managed-sites:applied'))).toHaveLength(1);
  });

  it('applies a list that raises protection at once, during an agent session too', async () => {
    S.agentSession = true;
    await list({ gmail: true }, [APP]);
    await sync();
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(pendingManaged()).toBeUndefined();
  });

  it('defers a list that switches a site off while an agent works, its sign-in the one kept too, and applies it when the session ends', async () => {
    await list({ gmail: true, linear: true });
    await sync();
    expect(store.managedFrom).toEqual({ family: await cloudClient().family() }); // the first list's sign-in, kept
    S.agentSession = true;
    await list({ gmail: true, linear: false });
    await sync('agent-session-start');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(pendingManaged()).toBe('Your Pro account asks to switch linear off; this applies when the agent session ends');
    expect(logged()).toContain('managed-sites:deferred(agent-session-start) Your Pro account asks to switch linear off; this applies when the agent session ends');
    // A poll during the session (a 304 now) changes nothing.
    await sync('poll');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    S.agentSession = false;
    await applyPending('agent-session-end');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(S.policy.managed?.version).toBe(2);
    expect(pendingManaged()).toBeUndefined();
  });

  it('a list from another sign-in that lowers waits for the whole lock, its additions guarded meanwhile; its sign-in is kept only once the lock opens', async () => {
    await list({ gmail: true, linear: true }); // account A
    await sync();
    const a = store.managedFrom;
    S.agentSession = true;
    await otherSignIn({ linear: true, x: true }); // account B, signed in while the agent works
    await sync('signed-in');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'x', 'app.example.com']);
    expect(pendingManaged()).toBe('Your Pro account asks to switch gmail off; this applies when the agent session ends');
    expect(store.managedFrom).toEqual(a);
    await sync('poll'); // a 304: the pending list offered again, with the sign-in the service named for it, still held
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'x', 'app.example.com']);
    await list({ x: true }); // a newer list replaces the pending one
    await sync('push');
    expect(pendingManaged()).toMatch(/linear/);
    S.agentSession = false;
    await applyPending('agent-session-end');
    expect(enabledSiteIds()).toEqual(['x', 'app.example.com']);
    expect(store.managedFrom).toEqual({ family: await cloudClient().family() }); // B's, kept once the lock opened
  });

  it('a list from another sign-in that only adds is applied, but its sign-in is not kept while the lock holds', async () => {
    await list({ gmail: true });
    await sync();
    const a = store.managedFrom;
    S.agentSession = true;
    await otherSignIn({ gmail: true, linear: true }); // an agent's own account, whose list adds to A's
    await sync('signed-in');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(store.managedFrom).toEqual(a);
    await list({}); // then it lowers: still another sign-in's list
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(pendingManaged()).toMatch(/this applies when the agent session ends/);
  });

  it('drops an answer fetched across a sign-in: it could be either account\'s', async () => {
    await list({ gmail: true });
    await sync();
    const real = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const res = await real(input, init);
      if (String(input).includes('/v1/config')) await gate;
      return res;
    });
    try {
      await list({});
      const p = syncManagedSites('poll');
      await vi.waitFor(() => expect(spy.mock.calls.some(([u]) => String(u).includes('/v1/config'))).toBe(true));
      await signInAsExtension(); // another sign-in lands while the answer is on its way
      release();
      await p; await settled();
    } finally { spy.mockRestore(); }
    expect(logged()).toContain('managed-sites:dropped(poll) fetched across a sign-in');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
  });

  it('a list kept from before this version (no sign-in kept) meets the lock as then, and the first list applied names its sign-in', async () => {
    await list({ gmail: true, linear: true });
    await sync();
    delete store.managedFrom;
    await restart();
    S.agentSession = true;
    await list({ gmail: true, linear: false });
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']); // an agent session holds it, as then
    expect(store.managedFrom).toBeUndefined();
    S.agentSession = false;
    await applyPending('agent-session-end');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(store.managedFrom).toEqual({ family: await cloudClient().family() });
  });

  it('a sign-in that ends takes the account\'s lists with it, and the sign-in kept', async () => {
    await list({ gmail: true });
    await sync();
    expect(store.managedFrom).toBeDefined();
    await cloudClient().signOut(); // no sign-out handler runs here: the tokens' own hook does (cloud-session.ts whenSignedOut)
    await vi.waitFor(async () => { await settled(); expect(S.policy.managed).toBeUndefined(); });
    expect(store.managedFrom).toBeUndefined();
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']); // copied into this browser's own (D14)
  });

  it('with a settings PIN, waits for it, whether or not an agent is active', async () => {
    await list({ gmail: true });
    await sync();
    store.settingsPin = { salt: 's', hash: 'h', iterations: 1 };
    await list({ gmail: false });
    await sync();
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(pendingManaged()).toBe('Your Pro account asks to switch gmail off; enter your settings PIN to apply it');
    // The session ending does not open a PIN.
    await applyPending('agent-session-end');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    S.pinUnlockedUntil = Date.now() + 60_000;
    await applyPending('pin');
    expect(enabledSiteIds()).toEqual(['app.example.com']);
  });

  it('a newer list replaces the pending one', async () => {
    await list({ gmail: true, linear: true });
    await sync();
    store.settingsPin = { salt: 's', hash: 'h', iterations: 1 };
    await list({ gmail: false, linear: true });
    await sync();
    expect(pendingManaged()).toMatch(/switch gmail off/);
    await list({ gmail: true, linear: false });
    await sync();
    expect(pendingManaged()).toMatch(/switch linear off/);
    expect(pendingManaged()).not.toMatch(/gmail/);
    // And one that lowers nothing clears it, applied at once.
    await list({ gmail: true, linear: true, x: true });
    await sync();
    expect(pendingManaged()).toBeUndefined();
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'x', 'app.example.com']);
  });

  it('a lapse, a sign-out and an older server each leave the list at once, its sites copied into this browser\'s own (D14)', async () => {
    const managedThenAgent = async () => {
      await list({ gmail: true });
      await sync();
      expect(S.policy.managed).toBeDefined();
      S.agentSession = true; // leaving the account lowers nothing, so an agent at work holds nothing back
    };
    const endsInLocal = async () => {
      expect(pendingManaged()).toBeUndefined();
      expect(S.policy.managed).toBeUndefined();
      expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']); // what the account guarded, now this browser's own
      expect(S.policy.sites.gmail?.enabled).toBe(true);
      S.agentSession = false;
    };
    await managedThenAgent();
    await mock({ status: 'canceled' });
    await sync();
    await endsInLocal();
    await mock({ status: 'active' });

    await managedThenAgent();
    await mock({ noConfig: true });
    await sync();
    await endsInLocal();
    await mock({ noConfig: false });

    await managedThenAgent();
    await cloudClient().signOut();
    await sync('signed-out');
    await endsInLocal();
  });

  it('keeps the list in force while the service cannot be reached', async () => {
    await list({ gmail: true });
    await sync();
    await mock({ down: true });
    await sync('poll');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(logged().some((r) => r.startsWith('managed-sites:unreachable'))).toBe(true);
    expect(policyWrites).toBe(1);
    await mock({ down: false });
  });

  it('lays the list over the policy last written, so a settings change whose change event is still queued is kept', async () => {
    await list({ gmail: true });
    void setPolicy({ ...S.policy, uploads: true }); // the person's change: written, not yet in force
    await syncManagedSites('popup-opened');
    await settled();
    expect(S.policy.uploads).toBe(true);
    expect(S.policy.managed?.version).toBe(1);
  });
});

// Sites are added to the account's list, and removed from it, from this browser too
// (messages.ts site:add/site:set/site:remove with scope 'account'); the answer is applied the way a sync's is.
describe('a list lost locally comes back at the next sync', () => {
  it('(a) an own settings write built from the policy in force, while the sync\'s change event is still queued', async () => {
    await list({ gmail: true });
    await syncManagedSites('popup-opened');
    // The sync has resolved: storage holds the list, its change event is a task away, S.policy does not have it yet.
    expect((store.policy as Policy).managed).toBeDefined();
    expect(S.policy.managed).toBeUndefined();
    await setPolicy({ ...S.policy, uploads: true }); // a writer that forgets the list (as sites:discover did)
    await settled();
    expect(S.policy.managed).toBeUndefined(); // lost, as before the fix
    await sync('poll');
    expect(S.policy.managed?.version).toBe(1);
    expect(S.policy.uploads).toBe(true);
    expect(await configCalls()).toEqual([200, 304]);
    expect(logged()).toEqual(['managed-sites:applied(popup-opened) v1', 'managed-sites:applied(poll) v1']);
  });

  it('(a\') a settings write that carries the list as last written (messages.ts save) never loses it', async () => {
    await list({ gmail: true });
    await syncManagedSites('popup-opened');
    await setPolicy(carryManaged({ ...S.policy, uploads: true }));
    await settled();
    expect(S.policy.managed?.version).toBe(1);
    expect(S.policy.uploads).toBe(true);
    await sync('poll');
    expect(logged()).toEqual(['managed-sites:applied(popup-opened) v1']); // the 304 found it in force: nothing to do
    expect(policyWrites).toBe(2);
  });

  it('(b) the storage write of a raising list fails: the answer is fetched again, not answered 304', async () => {
    await list({ gmail: true, linear: true });
    failNextSet = true;
    await sync();
    expect(S.policy.managed).toBeUndefined();
    expect(logged().some((r) => r.startsWith('managed-sites:error QUOTA_BYTES'))).toBe(true);
    expect(lastWrittenPolicy()?.managed).toBeUndefined(); // the failed write is not what storage holds
    await sync('poll');
    expect(await configCalls()).toEqual([200, 200]);
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(policyWrites).toBe(1);
  });

  it('(c) an outside write between sessions, with no PIN, strips the list: the next poll puts it back, and says so', async () => {
    await list({ gmail: true });
    await sync();
    const { managed: _m, ...stripped } = S.policy;
    await outside(stripped);
    await settled();
    expect(S.policy.managed).toBeUndefined(); // no lock held: accepted, by design
    expect(log.some((l) => l.startsWith('settings-locked'))).toBe(false);
    expect(enabledSiteIds()).toEqual(['app.example.com']);
    await sync('poll');
    expect(await configCalls()).toEqual([200, 304]);
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(logged()).toContain('managed-sites:applied(poll) v1');
    // While it was lost nothing was fetched afresh: the service answered 304, and the list came from the last answer.
  });

  it('(c\') the same outside write during an agent session is put back by the lock, list included', async () => {
    await list({ gmail: true });
    await sync();
    S.agentSession = true;
    const { managed: _m, ...stripped } = S.policy;
    await outside(stripped);
    await settled();
    expect(log.some((l) => l.startsWith('settings-locked:storage'))).toBe(true);
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
  });
});

describe('the ETag belongs to one sign-in', () => {
  it('tokens lost outside a sync, then a sign-in to another account at the same version: that account\'s list, not a 304', async () => {
    await list({ gmail: true }); // account A: v1 = gmail
    await sync();
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    delete store.cloudTokens;    // revoked server-side, noticed by a classify or /v1/me call; no sync ran
    await mock({ reset: true }); // account B, whose list is also at v1
    await list({ linear: true });
    await signInAsExtension();
    await sync('signed-in');
    expect(await configCalls()).toEqual([200]); // B's log: a full answer, with no If-None-Match from A's list
    expect(enabledSiteIds()).toEqual(['linear', 'app.example.com']);
    expect(S.policy.managed).toMatchObject({ version: 1, sites: { linear: { enabled: true } } });
    expect(S.policy.managed?.sites.gmail).toBeUndefined(); // nothing of A's list is left
  });
});

describe('what the server may send', () => {
  it('refuses a list past 100 custom sites and keeps the one in force; takes exactly 100', async () => {
    await list({ gmail: true });
    await sync();
    const many = (n: number) => Array.from({ length: n }, (_, i) => site(`s${i}.example.com`, { name: 'x'.repeat(60) }));
    await list({ gmail: true }, many(101));
    await sync('poll');
    expect(S.policy.managed?.version).toBe(1);
    expect(logged()).toContain('managed-sites:error managed list v2 is not valid');
    await list({ gmail: true }, many(100));
    await sync('poll');
    expect(S.policy.managed?.version).toBe(3);
    expect(S.policy.managed?.customSites).toHaveLength(100);
  });

  it('leaves out a custom site that is a built-in site\'s host or id, a public suffix or not a host, and keeps the rest', async () => {
    await list({ gmail: false }, [
      APP,
      site('mail.google.com'),                           // gmail's host: tick gmail instead
      site('gmail', { domains: ['evil.example'] }),      // a built-in site's id
      site('com'), site('co.uk'), site('github.io'),     // every .com, .co.uk, .github.io host
      site('localhost'),
    ]);
    await sync();
    expect(S.policy.managed?.version).toBe(1);
    expect(enabledSiteIds()).toEqual(['app.example.com']);
    expect(S.policy.effective.targetDomains).toEqual(['app.example.com']);
  });
});

describe('the pending sentence names only the list\'s own effect', () => {
  it('an outside write that lowers protection, still queued when a raising list arrives, is neither named nor adopted', async () => {
    S.agentSession = true;
    let release = (): void => {};
    hold = new Promise<void>((r) => { release = r; });
    await outside({ ...S.policy, enabled: false }); // its change event is queued behind the held apply
    await list({ gmail: true }, [APP]);
    await syncManagedSites('popup-opened');
    expect(pendingManaged()).toBeUndefined();
    expect(logged()).toEqual(['managed-sites:applied(popup-opened) v1']);
    release();
    await settled();
    // The outside write was refused and put back; the list, written after it, survived the put-back.
    expect(log.some((l) => l.startsWith("settings-locked:storage An AI agent is active in this browser, so OnlyRead can't turn protection off"))).toBe(true);
    expect(S.policy.enabled).toBe(true);
    expect(S.policy.managed?.version).toBe(1);
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
  });
});

describe('nothing before startup', () => {
  it('a sync waits for a finished startup, fetching nothing meanwhile', async () => {
    let started = (): void => {};
    initManagedSync({ whenReady: () => new Promise<void>((r) => { started = r; }) });
    await list({ gmail: true });
    const p = syncManagedSites('poll');
    for (let i = 0; i < 5; i++) await tick();
    expect(await configCalls()).toEqual([]);
    expect(policyWrites).toBe(0);
    started();
    await p;
    await settled();
    expect(await configCalls()).toEqual([200]);
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
  });
});

describe("an agent's browser and the levels", () => {
  afterEach(() => { S.agentBrowser = false; S.agentSession = false; });

  it("applies a lowering from the account in an agent's browser: it is the person's, made on the account page", async () => {
    await linkSignIn(); // the browser's sign-in is a setup link's: the service says its scope is agent
    await list({ gmail: true, linear: true });
    await sync();
    S.agentBrowser = true;
    await list({ gmail: true, linear: false });
    await sync('poll');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(pendingManaged()).toBeUndefined();
    // During a detected session too: the list comes from the sign-in kept, a setup link's.
    S.agentSession = true;
    await list({ linear: false });
    await sync('poll');
    expect(enabledSiteIds()).toEqual(['app.example.com']);
    expect(pendingManaged()).toBeUndefined();
  });

  it("the mark alone does not lift the session hold: over the person's full sign-in a lowering waits, as anywhere", async () => {
    await list({ gmail: true, linear: true }); // the person's full sign-in (beforeEach)
    await sync();
    S.agentBrowser = true; // say an outside write added the mark
    S.agentSession = true;
    await list({ gmail: true });
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(pendingManaged()).toBe('Your Pro account asks to switch linear off; this applies when the agent session ends');
  });

  it("in an agent's browser a list from another sign-in never lowers anything, and its sign-in is never kept", async () => {
    await list({ gmail: true });
    await sync();
    const a = store.managedFrom;
    S.agentBrowser = true;
    await otherSignIn({ gmail: true, linear: true }); // another account an agent signed this browser in to, adding first
    await sync('signed-in');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(store.managedFrom).toEqual(a);
    await list({});
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(pendingManaged()).toBe("Your Pro account asks to switch gmail off, switch linear off; this browser belongs to an AI agent, and a list from another sign-in can't lower what it guards");
    await applyPending('agent-session-end');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
  });

  it("in an agent's browser the sign-in kept is the background's: one written to its key from outside is not trusted", async () => {
    await list({ gmail: true });
    await sync();
    S.agentBrowser = true;
    await otherSignIn({ gmail: true });
    await sync('signed-in');
    store.managedFrom = { family: await cloudClient().family() }; // say an outside write was not put back
    await list({});
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(pendingManaged()).toMatch(/a list from another sign-in can't lower/);
  });

  it("a worker an outside write woke, which read the written sign-in at startup, still keeps the one before it", async () => {
    await list({ gmail: true, linear: true }); // account A, its sign-in kept
    await sync();
    const a = store.managedFrom;
    await otherSignIn({ gmail: true, linear: true }); // the tokens now an agent's own account's (G), no sync yet
    const g = await cloudClient().family();
    await restart(); // the worker stopped
    S.agentBrowser = true;
    // The outside write that wakes it: the sign-in kept named as G's. Startup reads storage before the change event
    // that says the write was not the background's.
    await local.set({ managedFrom: { family: g } });
    initManagedSync({ whenReady: () => Promise.resolve() });
    await settled();
    expect(records.mock.calls.map(([e]) => (e as { reason: string }).reason)).toContain('managed-sites:kept-sign-in outside write put back');
    expect(store.managedFrom).toEqual(a); // storage says A's again
    await list({}); // G lowers
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'app.example.com']);
    expect(pendingManaged()).toMatch(/a list from another sign-in can't lower/);
  });

  it('two outside writes in a row to the sign-in kept: memory and storage keep the one before the first', async () => {
    await linkSignIn();
    await list({ gmail: true, linear: true });
    await sync();
    const a = store.managedFrom;
    // The second change's old value is the first write's: neither is taken.
    void local.set({ managedFrom: { family: '7c9e6679-7425-40de-944b-e07fc1f90ae7' } });
    void local.set({ managedFrom: { family: '16fd2706-8baf-433b-82eb-8c7fada847da' } });
    await settled();
    await vi.waitFor(() => expect(store.managedFrom).toEqual(a));
    // Memory still names A's sign-in: in an agent's browser, A's lowering applies past a session.
    S.agentBrowser = true; S.agentSession = true;
    await list({ gmail: true });
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
  });

  it("in an agent's browser another sign-in whose list is the one in force, unchanged, is not kept either", async () => {
    await list({ gmail: true });
    await sync();
    const a = store.managedFrom;
    S.agentBrowser = true;
    await otherSignIn({ gmail: true }); // the same list, so nothing is written
    await sync('signed-in');
    expect(store.managedFrom).toEqual(a);
    await list({});
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
  });

  it("in an agent's browser, a list kept from before this version (no sign-in kept) lowers as then, with no session", async () => {
    await list({ gmail: true, linear: true });
    await sync();
    delete store.managedFrom;
    await restart();
    S.agentBrowser = true;
    await list({ gmail: true });
    await sync('push');
    expect(enabledSiteIds()).toEqual(['gmail', 'app.example.com']);
    expect(store.managedFrom).toEqual({ family: await cloudClient().family() });
  });

  it('a mixed update from another sign-in during an agent session guards what it adds at once, at every level, and lowers nothing', async () => {
    await mock({ managed: { enabled: true, sites: {}, customSites: [], browserSites: { sites: { gmail: { enabled: true } }, customSites: [] }, guardAll: { on: true, excludeSites: [] } } });
    await sync();
    expect(S.policy.effective.targetDomains).toContain('mail.google.com');
    expect(S.policy.effective.guardAll).toBe(true);
    S.agentSession = true;
    delete store.cloudTokens;
    await mock({ reset: true });
    await mock({ managed: { enabled: true, sites: {}, customSites: [], browserSites: { sites: {}, customSites: [site('crm.example.com')] }, guardAll: { on: true, excludeSites: ['shop.example.com'] } } });
    await signInAsExtension();
    await sync('signed-in');
    // Meanwhile: the CRM guarded, Gmail kept, no allowance.
    expect(S.policy.effective.targetDomains).toEqual(expect.arrayContaining(['mail.google.com', 'crm.example.com']));
    expect(S.policy.effective.excludeDomains).toEqual([]);
    expect(pendingManaged()).toMatch(/switch gmail off/);
    S.agentSession = false;
    await applyPending('agent-session-end');
    expect(S.policy.effective.targetDomains).not.toContain('mail.google.com');
    expect(S.policy.effective.targetDomains).toContain('crm.example.com');
    expect(S.policy.effective.excludeDomains).toEqual(['shop.example.com']);
  });
});

// Pro mode (a Pro judge): the sites are the account's. This browser's own go there once it knows the account (D16), and
// a change made here waits in `accountEdits`, guarded at once, until the account takes it (D10).
describe('Pro mode: this browser\'s site changes go to the account', () => {
  const pro = async (extra: Partial<Policy> = {}) => {
    const d = defaultPolicy();
    await setPolicy(normalizePolicy({ ...S.policy, judge: { ...d.judge, provider: 'cloud' }, ...extra }));
    await settled();
  };
  const sent = () => records.mock.calls.map(([e]) => (e as { reason: string }).reason).filter((r) => /^(account-edit|local-sites):/.test(r));
  const edit = (e: Partial<NonNullable<Policy['accountEdits']>[number]>) => ({ op: 'add' as const, scope: 'account' as const, builtin: false, at: Date.now(), id: '', ...e });

  it('moves this browser\'s own sites to the account at the first sync, guarded throughout (its only browser: the account\'s list)', async () => {
    await pro();
    await sync('signed-in');
    expect(S.policy.customSites).toEqual([]);
    expect(S.policy.accountEdits).toBeUndefined();
    expect(S.policy.managed?.customSites).toEqual([expect.objectContaining({ id: 'app.example.com', name: 'App' })]);
    expect(enabledSiteIds()).toEqual(['app.example.com']);
    expect(sent()).toEqual(['local-sites:moved (signed-in) 1 to the account list', 'account-edit:sent add account app.example.com']);
    // Never weaker on the way: every policy written guarded the site.
    expect(log.filter((l) => l.includes('settings-locked'))).toEqual([]);
  });

  it('keeps a custom site the guard-every-site switch took off the account here, switched off, moving nothing', async () => {
    const tools = { id: 'tools.example.net', name: 'Tools', domains: ['tools.example.net'], enabled: false };
    await pro({ customSites: [tools], guardAllOff: ['tools.example.net'] });
    await sync('signed-in');
    expect(S.policy.customSites).toEqual([tools]);
    expect(sent()).toEqual([]);
  });

  it("in an agent's browser its own sites stay its own: none move to the account", async () => {
    S.agentBrowser = true;
    try {
      await pro();
      await sync('signed-in');
      expect(S.policy.customSites.map((c) => c.id)).toEqual(['app.example.com']);
      expect(S.policy.accountEdits).toBeUndefined();
      expect(S.policy.managed?.customSites).toEqual([]);
      expect(enabledSiteIds()).toEqual(['app.example.com']);
      expect(sent()).toEqual([]);
    } finally { S.agentBrowser = false; }
  });

  it('a change the account takes leaves the queue while an agent works, though the policy in force lags the answer', async () => {
    await pro({ customSites: [] });
    await sync();
    S.agentSession = true;
    await setPolicy(normalizePolicy({ ...S.policy, accountEdits: [edit({ id: 'crm.example.com', name: 'CRM' })] })); await settled();
    hold = new Promise<void>((r) => setTimeout(r, 30)); // the answer's change event waits behind another
    await flushAccountEdits('edit'); await settled();
    expect(S.policy.accountEdits).toBeUndefined();
    expect(sent()).toContain('account-edit:sent add account crm.example.com');
    expect(enabledSiteIds()).toContain('crm.example.com');
  });

  it('a change waits while the service is out of reach, guarded meanwhile, and goes at the next sync', async () => {
    await sync();
    await pro({ customSites: [], accountEdits: [edit({ id: 'crm.example.com', name: 'CRM' })] });
    await mock({ noConfig: true });
    await flushAccountEdits('edit'); await settled();
    expect(S.policy.accountEdits).toHaveLength(1);
    expect(enabledSiteIds()).toContain('crm.example.com');
    await mock({ noConfig: false });
    await sync('poll');
    expect(S.policy.accountEdits).toBeUndefined();
    expect(S.policy.managed?.customSites.map((c) => c.id)).toEqual(['crm.example.com']);
    expect(enabledSiteIds()).toContain('crm.example.com');
  });

  it('a removal made against a list that changed since is refused, and undone here: the site is guarded again', async () => {
    await list({ gmail: true });
    await pro({ customSites: [] });
    await sync();
    const v = S.policy.managed!.version;
    await setPolicy(normalizePolicy({ ...S.policy, accountEdits: [edit({ op: 'remove', id: 'gmail', builtin: true, version: v })] })); await settled();
    expect(enabledSiteIds()).not.toContain('gmail');
    await mock({ refuseEdit: 'conflict' });
    await flushAccountEdits('edit'); await settled();
    expect(S.policy.accountEdits).toBeUndefined();
    expect(enabledSiteIds()).toContain('gmail');
    expect(sent()).toContain('account-edit:refused remove account gmail cloud:bad_response (conflict)');
    expect(accountRefusal()).toMatch(/^Removing Gmail was not kept: your account's sites changed elsewhere/);
  });

  it('an addition the account refuses is dropped through the lock: it waits while an agent works', async () => {
    await pro({ customSites: [] });
    await sync();
    await setPolicy(normalizePolicy({ ...S.policy, accountEdits: [edit({ id: 'tools.example.net', name: 'Tools' })] })); await settled();
    S.agentSession = true;
    await mock({ refuseEdit: 'public-suffix' });
    await flushAccountEdits('edit'); await settled();
    expect(S.policy.accountEdits).toHaveLength(1); // kept: dropping it would stop guarding the site
    expect(enabledSiteIds()).toContain('tools.example.net');
    expect(sent()).toContain('account-edit:held add tools.example.net (agent)');
    expect(accountRefusal()).toBeUndefined(); // nothing undone yet: nothing to say
    S.agentSession = false;
    await mock({ refuseEdit: 'public-suffix' });
    await flushAccountEdits('edit'); await settled();
    expect(enabledSiteIds()).not.toContain('tools.example.net');
    expect(accountRefusal()).toBe('Your Pro account did not take Tools: that address belongs to many sites, not one. It is not guarded.');
  });

  it('a sign-out copies what the account guarded, with the additions not yet sent, into this browser\'s own lists (D14); a removal not yet sent is dropped', async () => {
    await list({ gmail: true, linear: true });
    await pro({ customSites: [] });
    await sync();
    await mock({ noConfig: true });
    await setPolicy(normalizePolicy({ ...S.policy, accountEdits: [edit({ id: 'crm.example.com', name: 'CRM' }), edit({ op: 'remove', id: 'linear', builtin: true, version: 1 })] })); await settled();
    await flushAccountEdits('edit'); await settled();
    expect(enabledSiteIds()).toEqual(['gmail', 'crm.example.com']);
    await mock({ noConfig: false });
    S.agentSession = true; // leaving lowers nothing, so nothing waits
    await cloudClient().signOut();
    await sync('signed-out');
    expect(S.policy.managed).toBeUndefined();
    expect(S.policy.accountEdits).toBeUndefined();
    expect(S.policy.sites.gmail?.enabled).toBe(true);
    expect(S.policy.customSites.map((c) => c.id)).toEqual(['crm.example.com']);
    expect(enabledSiteIds()).toEqual(['gmail', 'linear', 'crm.example.com']); // linear's removal never reached the account
  });
});
