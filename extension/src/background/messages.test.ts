import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Policy, Status } from '../shared/types';

// The message handlers with storage, Chrome and the judges replaced: setPolicy returns what it was given
// and records it, the cache records imports, and everything else answers a fixed value.
const h = vi.hoisted(() => ({
  saved: [] as Policy[],
  /** Whether the browser was marked as an agent's when a setup link signed it in, and at that sign-in's first sync. */
  linkSignedInAgentBrowser: undefined as boolean | undefined,
  agentBrowserAtSync: undefined as boolean | undefined,
  /** judges.ts tryByokJudge: the candidate own-key judge's test, passing unless a test says otherwise. */
  tryJudge: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ ok: true, judge: 'jev', latencyMs: 1 })),
  notify: vi.fn(async (_type?: string) => {}),
  cachePut: vi.fn(async () => {}),
  uiPush: vi.fn(),
  editorGuardFor: vi.fn((host: string) => host === 'docs.example.com'),
  closingAdd: vi.fn(async (_tabId: number) => {}),
  discover: vi.fn(async () => ({})),
  sync: vi.fn(async (_reason: string) => {}),
  applyPending: vi.fn(async (_reason: string) => {}),
  edit: vi.fn(async (_edit: unknown, _why: string) => {}),
  pending: undefined as string | undefined,
  tabUpdates: [] as [number, string][],
  signIn: undefined as { state: string; tabId: number; back: string; closeWhenDone?: boolean } | undefined,
  tabRemoves: [] as number[],
  fallback: undefined as string | undefined,
  finish: vi.fn(async (_code: string) => ({ signedIn: true })),
  /** The Pro client of the service in use: signed in or not, and its sign-outs. */
  client: { signedIn: vi.fn(async () => false), signOut: vi.fn(async () => {}) },
  signedOutHooks: [] as (() => void)[],
  lockOpenHooks: [] as (() => void)[],
}));
// Like the real setPolicy, a write becomes the policy last written (policy.ts lastWrittenPolicy) at once, while S.policy
// takes it only when storage reports it (here: never, unless a test sets it).
vi.mock('./policy', async (orig) => {
  const o = await orig<typeof import('./policy')>();
  return { ...o, setPolicy: vi.fn(async (p: Policy) => { h.saved.push(p); o.policyAccepted(p); return p; }) };
});
vi.mock('./cache', () => ({ put: h.cachePut, list: async () => [], clear: async () => {}, size: async () => 0 }));
vi.mock('./uiactions', () => ({ push: h.uiPush }));
vi.mock('./guard', () => ({
  guardConfig: (host: string) => ({ editorGuard: h.editorGuardFor(host), holdClose: false }),
  closing: { add: h.closingAdd },
}));
vi.mock('./site-discover', () => ({ discoverSite: h.discover }));
vi.mock('./judges', () => ({ selectJudges: vi.fn(async () => {}), tryByokJudge: h.tryJudge, testRecord: () => ({}), testAnthropic: async () => undefined }));
vi.mock('./cloud-session', () => ({
  cloudClient: () => h.client,
  whenSignedOut: (fn: () => void) => { h.signedOutHooks.push(fn); },
  cloudStatus: vi.fn(async () => ({ provider: 'cloud', signedIn: false })),
  cloudSignOut: vi.fn(async () => ({ signedIn: false })),
  startSignIn: vi.fn(async (tabId: number, back: string, service = 'https://pro.example', closeWhenDone = false) => { h.signIn = { state: 's1', tabId, back, closeWhenDone }; return `${service}/signin?state=s1`; }),
  signInFallback: vi.fn(async () => h.fallback),
  takeSignIn: vi.fn(async (state: string, tabId: number) => {
    const p = h.signIn;
    if (!p || p.state !== state || p.tabId !== tabId) return undefined;
    h.signIn = undefined;
    return { ...p, verifier: 'v', redirect: 'r', at: 0 };
  }),
  finishSignIn: (code: string) => h.finish(code),
  signInWithSetupLink: vi.fn(async () => { h.linkSignedInAgentBrowser = S.agentBrowser; return { provider: 'cloud', signedIn: true, account: { email: 'p@example.com' } }; }),
  pendingSignIn: vi.fn(async () => (h.signIn ? { ...h.signIn, verifier: 'v', redirect: 'r', at: 0 } : undefined)),
}));
vi.mock('./cloud-sync', () => ({ syncManagedSites: h.sync, applyPendingManaged: h.applyPending, flushAccountEdits: h.edit, accountRefusal: () => undefined, accountBrowsers: (p: Policy) => p.managed?.browsers ?? 1, notifyAccountPages: h.notify, pendingManaged: () => h.pending, whenLockOpens: (fn: () => void) => { h.lockOpenHooks.push(fn); } }));
vi.mock('./audit', () => ({ list: async () => [], clear: async () => {}, record: async () => {} }));
vi.mock('./sink', () => ({ send: () => {} }));

// Each test gets fresh modules, so no state (the lock's PIN copy, the storage reports, queued work) carries over.
let handle: typeof import('./messages').handle;
let PIN_TRY_LIMIT_MS: number;
let S: typeof import('./state').S;
let defaultPolicy: typeof import('./policy').defaultPolicy;
let normalizePolicy: typeof import('./policy').normalizePolicy;
let policyAccepted: typeof import('./policy').policyAccepted;
let guardedSiteIds: typeof import('./sites').guardedSiteIds;
let listSites: typeof import('./sites').listSites;
let PIN_ITERATIONS: number;
let health: typeof import('./storage-health').health;
let storageFailed: typeof import('./storage-health').storageFailed;
async function freshModules(): Promise<void> {
  vi.resetModules();
  h.signedOutHooks.length = 0; h.lockOpenHooks.length = 0; // the hooks the previous modules registered
  ({ handle, PIN_TRY_LIMIT_MS } = await import('./messages'));
  ({ S } = await import('./state'));
  ({ defaultPolicy, normalizePolicy, policyAccepted } = await import('./policy'));
  ({ guardedSiteIds, listSites } = await import('./sites'));
  ({ PIN_ITERATIONS } = await import('./protection'));
  ({ health, storageFailed } = await import('./storage-health'));
  // In the extension S.policy only ever takes a policy that was just written (index.ts, as storage reports it), so a
  // test that sets it has written it: the background's changes build on the policy last written (messages.ts latest).
  let current = S.policy;
  const accept = policyAccepted;
  Object.defineProperty(S, 'policy', { configurable: true, get: () => current, set: (p: Policy) => { current = p; accept(p); } });
}

const tab = (url: string, id = 3) => ({ tab: { id, url } as chrome.tabs.Tab, url } as chrome.runtime.MessageSender);
const send = (msg: Message, sender: chrome.runtime.MessageSender = {}) => handle(msg, sender);

const store: Record<string, unknown> = {};

beforeEach(async () => {
  await freshModules();
  for (const k of Object.keys(store)) delete store[k];
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: async (k: string | string[]) => (Array.isArray(k) ? Object.fromEntries(k.filter((x) => x in store).map((x) => [x, store[x]])) : { [k]: store[k] }),
      set: async (o: Record<string, unknown>) => { Object.assign(store, o); },
      remove: async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) delete store[x]; },
    } },
    declarativeNetRequest: { getDynamicRules: async () => [] },
    runtime: { id: 'onlyread', getManifest: () => ({ version: '1.0.0' }), getURL: (p: string) => `chrome-extension://onlyread/${p}` },
    tabs: {
      update: async (id: number, p: { url: string }) => { h.tabUpdates.push([id, p.url]); return {}; },
      remove: async (id: number) => { h.tabRemoves.push(id); },
    },
  });
  S.agentSession = false; S.pinUnlockedUntil = 0;
  h.tryJudge.mockReset(); h.tryJudge.mockResolvedValue({ ok: true, judge: 'jev', latencyMs: 1 });
  h.saved.length = 0; h.closingAdd.mockClear(); h.cachePut.mockClear(); h.uiPush.mockClear(); h.discover.mockClear();
  h.sync.mockClear(); h.notify.mockClear(); h.applyPending.mockClear(); h.edit.mockReset(); h.pending = undefined;
  h.tabUpdates.length = 0; h.tabRemoves.length = 0; h.signIn = undefined; h.finish.mockReset(); h.finish.mockImplementation(async () => ({ signedIn: true }));
  S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }] });
  policyAccepted(S.policy); // what storage holds, as far as the background knows: the policy in force (policy.ts)
});

describe('handle', () => {
  it('records the agent\'s clicks only on guarded sites', async () => {
    const action = { ts: 1, type: 'click', tag: 'button', name: 'Send', url: 'https://app.example.com/' } as const;
    expect(await send({ type: 'ui:action', action }, tab('https://app.example.com/inbox'))).toEqual({ ok: true });
    expect(await send({ type: 'ui:action', action }, tab('https://news.example.org/'))).toEqual({ ok: true });
    expect(h.uiPush).toHaveBeenCalledTimes(1);
    expect(h.uiPush).toHaveBeenCalledWith(3, action);
  });

  it('imports only allow and block verdicts, defaulting their probability', async () => {
    const r = await send({ type: 'cache:import', entries: {
      'POST a/x json:a': { verdict: 'allow' }, 'POST a/y json:b': { verdict: 'block', pWrite: 0.9 }, 'POST a/z json:c': { verdict: 'maybe' as never },
    } });
    expect(r).toEqual({ ok: true, imported: 2 });
    expect(h.cachePut).toHaveBeenCalledWith('POST a/x json:a', 'allow', 0, 'label');
    expect(h.cachePut).toHaveBeenCalledWith('POST a/y json:b', 'block', 0.9, 'label');
  });

  it('adding a host a verified site covers switches that site on instead of adding a copy', async () => {
    await send({ type: 'site:add', host: 'https://mail.google.com/mail/u/0/' });
    const saved = h.saved.at(-1)!;
    expect(saved.sites.gmail?.enabled).toBe(true);
    expect(saved.customSites.map((c) => c.id)).toEqual(['app.example.com']);
  });

  it('adds an unknown host as a custom site and looks up its icon afterwards', async () => {
    await send({ type: 'site:add', host: 'tools.example.net' });
    expect(h.saved.at(-1)!.customSites.map((c) => c.id)).toContain('tools.example.net');
    expect(h.discover).toHaveBeenCalledWith('tools.example.net');
  });

  it('rejects something that is not a host', async () => {
    await expect(send({ type: 'site:add', host: 'localhost' })).rejects.toThrow(/not a host/);
    await expect(send({ type: 'site:add', host: 'a..b' })).rejects.toThrow(/not a host/);
  });

  it('rejects a public suffix as a site of its own: guarding co.uk would judge every .co.uk host', async () => {
    await expect(send({ type: 'site:add', host: 'https://www.co.uk/' })).rejects.toThrow(/not a site of its own: co.uk is a public suffix/);
    await expect(send({ type: 'site:add', host: 'github.io' })).rejects.toThrow(/public suffix/);
    expect(h.saved).toEqual([]);
    await send({ type: 'site:add', host: 'shop.example.co.uk' });
    expect(h.saved.at(-1)!.customSites.map((c) => c.id)).toContain('shop.example.co.uk');
  });

  it('refuses an unknown provider without saving', async () => {
    expect(await send({ type: 'judge:byok', choice: { id: 'nope' as never } })).toEqual({ ok: false, error: 'unknown provider' });
    expect(h.saved).toEqual([]);
  });

  it('saves an own-key choice with a trimmed model', async () => {
    await send({ type: 'judge:byok', choice: { id: 'openrouter', model: '  anthropic/claude-sonnet-5 ' } });
    expect(h.saved.at(-1)!.judge).toMatchObject({ provider: 'byok', byok: { id: 'openrouter', model: 'anthropic/claude-sonnet-5' } });
  });

  it('tests an own key before anything changes: a failed test or a missing key stores nothing and keeps the judge in force', async () => {
    h.tryJudge.mockResolvedValueOnce({ ok: false, judge: 'jev', error: 'HTTP 401', latencyMs: 1 });
    expect(await send({ type: 'judge:byok', choice: { id: 'openrouter' }, key: 'sk-bad' })).toMatchObject({ ok: false, error: 'HTTP 401', tested: true });
    h.tryJudge.mockResolvedValueOnce({ ok: false, problem: 'no key' });
    expect(await send({ type: 'judge:byok', choice: { id: 'openrouter' } })).toEqual({ ok: false, problem: 'no key' });
    expect(h.saved).toEqual([]);
    expect(store.secrets).toBeUndefined();
    // Passed: the key typed is what was tested, and only now is it stored and the provider put into force.
    expect(await send({ type: 'judge:byok', choice: { id: 'openrouter' }, key: ' sk-good ' })).toMatchObject({ ok: true });
    expect(h.tryJudge).toHaveBeenLastCalledWith({ id: 'openrouter' }, { keys: { openrouter: 'sk-good' } }, expect.anything());
    expect(store.secrets).toEqual({ keys: { openrouter: 'sk-good' } });
    expect(h.saved.at(-1)!.judge).toMatchObject({ provider: 'byok', byok: { id: 'openrouter' } });
  });

  it('answers the editor guard for the asking frame\'s host', async () => {
    expect(await send({ type: 'guard:config' }, { url: 'https://docs.example.com/d/1', tab: { url: 'https://other.example.com/' } as chrome.tabs.Tab })).toEqual({ editorGuard: true, holdClose: false });
    expect(h.editorGuardFor).toHaveBeenLastCalledWith('docs.example.com');
  });

  it('patches only the guard fields it is given', async () => {
    await send({ type: 'guard:set', enabled: false });
    const saved = h.saved.at(-1)!;
    expect(saved.enabled).toBe(false);
    expect(saved.mode).toBe(S.policy.mode);
  });

  it('builds a guard or exclude change on the policy last written: a change storage has not reported yet stays', async () => {
    // S.policy takes neither write here (storage has not reported them).
    await send({ type: 'site:set', id: 'gmail', enabled: true });
    await send({ type: 'guard:set', attachWhen: 'always' });
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'always', sites: { gmail: { enabled: true } } });
    await send({ type: 'exclude:add', host: 'a.example.com' });
    await send({ type: 'exclude:add', host: 'b.example.com' });
    expect(h.saved.at(-1)!.excludeSites).toEqual(['a.example.com', 'b.example.com']);
    await send({ type: 'judge:byok', choice: { id: 'openrouter' } });
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'always', sites: { gmail: { enabled: true } }, excludeSites: ['a.example.com', 'b.example.com'] });
  });

  it('while every site is guarded, a site\'s switch allows it (its own setting off) and guards it again (its own setting back on)', async () => {
    S.policy = normalizePolicy({ ...S.policy, guardAll: true, excludeSites: ['news.example.org'], sites: { ...S.policy.sites, linkedin: { enabled: true } } });
    await send({ type: 'site:guard-all', id: 'linkedin', on: false, host: 'www.linkedin.com' });
    expect(h.saved.at(-1)).toMatchObject({ excludeSites: ['news.example.org', 'linkedin.com'], sites: { linkedin: { enabled: false } }, guardAllOff: ['linkedin'] });
    // On takes back the hosts at or under the site's domains (and only those), and puts its own setting back on.
    await send({ type: 'exclude:add', host: 'jobs.linkedin.com' });
    await send({ type: 'site:guard-all', id: 'linkedin', on: true, host: 'www.linkedin.com' });
    expect(h.saved.at(-1)).toMatchObject({ excludeSites: ['news.example.org'], sites: { linkedin: { enabled: true } }, guardAllOff: [] });
    // Its allowed host taken back in settings instead: switched back on there too.
    await send({ type: 'site:guard-all', id: 'linkedin', on: false, host: 'www.linkedin.com' });
    expect(h.saved.at(-1)).toMatchObject({ sites: { linkedin: { enabled: false } }, guardAllOff: ['linkedin'] });
    await send({ type: 'exclude:remove', host: 'linkedin.com' });
    expect(h.saved.at(-1)).toMatchObject({ excludeSites: ['news.example.org'], sites: { linkedin: { enabled: true } }, guardAllOff: [] });
    // A site that was not on stays as it was: off then on leaves its own setting off.
    await send({ type: 'site:guard-all', id: 'x', on: false, host: 'x.com' });
    expect(h.saved.at(-1)!.guardAllOff).toEqual([]);
    await send({ type: 'site:guard-all', id: 'x', on: true, host: 'x.com' });
    expect(h.saved.at(-1)).toMatchObject({ excludeSites: ['news.example.org'], sites: { x: { enabled: false } } });
    // Gmail, switched on, keeps calendar.google.com guarded: Calendar is not allowed there, and nothing is saved.
    S.policy = normalizePolicy({ ...S.policy, guardAll: true, excludeSites: [], sites: { ...S.policy.sites, gmail: { enabled: true } } });
    const before = h.saved.length;
    expect(await send({ type: 'site:guard-all', id: 'calendar', on: false, host: 'calendar.google.com' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Gmail keeps/) });
    expect(h.saved).toHaveLength(before);
  });

  it('while every site is guarded, a custom parent of a built-in site is not allowed, and on keeps the user\'s own allowed hosts', async () => {
    const google = { id: 'google.com', name: 'Google', domains: ['google.com'], enabled: false };
    S.policy = normalizePolicy({ ...S.policy, guardAll: true, excludeSites: [], customSites: [...S.policy.customSites, google] });
    const before = h.saved.length;
    expect(await send({ type: 'site:guard-all', id: 'google.com', on: false, host: 'www.google.com' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Allowing this site would also allow /) });
    expect(h.saved).toHaveLength(before);
    // Calendar on under an allowed google.com: the user's entries stay, and Calendar is switched on (guarded under it).
    S.policy = normalizePolicy({ ...S.policy, guardAll: true, excludeSites: ['google.com', 'people-pa.clients6.google.com'], customSites: S.policy.customSites.filter((c) => c.id !== 'google.com') });
    await send({ type: 'site:guard-all', id: 'calendar', on: true, host: 'calendar.google.com' });
    expect(h.saved.at(-1)).toMatchObject({ excludeSites: ['google.com', 'people-pa.clients6.google.com'], sites: { calendar: { enabled: true } } });
  });

  it('a site looked up after it was added keeps the changes made during the lookup', async () => {
    let found!: (v: { iconUrl?: string; name?: string }) => void;
    h.discover.mockImplementationOnce(() => new Promise((r) => { found = r; }));
    await send({ type: 'site:add', host: 'a.example.net' });
    await vi.waitFor(() => expect(h.discover).toHaveBeenCalledWith('a.example.net'));
    // Meanwhile another site is added and one switched on; S.policy has neither yet.
    await send({ type: 'site:add', host: 'b.example.net' });
    await send({ type: 'site:set', id: 'gmail', enabled: true });
    const before = h.saved.length;
    found({ iconUrl: 'https://a.example.net/favicon.ico' });
    await vi.waitFor(() => expect(h.saved).toHaveLength(before + 1));
    const last = h.saved.at(-1)!;
    expect(last.customSites.map((c) => c.id)).toEqual(['app.example.com', 'a.example.net', 'b.example.net']);
    expect(last.customSites.find((c) => c.id === 'a.example.net')!.iconUrl).toBe('https://a.example.net/favicon.ico');
    expect(last.sites.gmail?.enabled).toBe(true);
  });

  it('a site removed during its lookup is not written back', async () => {
    let found!: (v: { iconUrl?: string; name?: string }) => void;
    h.discover.mockImplementationOnce(() => new Promise((r) => { found = r; }));
    await send({ type: 'site:add', host: 'a.example.net' });
    await vi.waitFor(() => expect(h.discover).toHaveBeenCalledWith('a.example.net'));
    await send({ type: 'site:remove', id: 'a.example.net' });
    const before = h.saved.length;
    found({ iconUrl: 'https://a.example.net/favicon.ico' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.saved).toHaveLength(before);
    expect(h.saved.at(-1)!.customSites.map((c) => c.id)).toEqual(['app.example.com']);
  });

  it('holds a typed secret only from a guarded site', async () => {
    const { known } = await import('./typed-secrets');
    await send({ type: 'secret:typed', field: 'https://app.example.com#0', value: 'hunter22' }, tab('https://app.example.com/login', 7));
    await send({ type: 'secret:typed', field: 'https://news.example.org#0', value: 'other-pw' }, tab('https://news.example.org/', 8));
    expect(known()).toContain('hunter22');
    expect(known()).not.toContain('other-pw');
  });

  it('holds no typed secret while protection is off', async () => {
    const { known } = await import('./typed-secrets');
    S.policy = normalizePolicy({ ...S.policy, enabled: false });
    await send({ type: 'secret:typed', field: 'https://app.example.com#1', value: 'off-pw-1' }, tab('https://app.example.com/login', 9));
    expect(known()).not.toContain('off-pw-1');
  });

  it('refuses a closing guarded page\'s writes, only for its top frame and only while writes are refused', async () => {
    const closing = (url: string, frameId: number) => send({ type: 'page:closing' }, { ...tab(url, 5), frameId });
    await closing('https://app.example.com/inbox', 0);
    expect(h.closingAdd).not.toHaveBeenCalled(); // dormant: between agent sessions nothing is refused
    S.policy = normalizePolicy({ ...S.policy, attachWhen: 'always', mode: 'enforce' });
    await closing('https://app.example.com/inbox', 2);
    await closing('https://news.example.org/', 0);
    expect(h.closingAdd).not.toHaveBeenCalled();
    await closing('https://app.example.com/inbox', 0);
    expect(h.closingAdd).toHaveBeenCalledWith(5);
  });

  it('puts a switched-on site\'s shipped labels straight back after the cache is cleared', async () => {
    S.policy = normalizePolicy({ ...S.policy, sites: { ...S.policy.sites, gmail: { enabled: true } } });
    await send({ type: 'cache:clear' });
    expect(h.cachePut).toHaveBeenCalledWith('POST mail.google.com/sync/u/{id}/i/s gmail:s:r', 'allow', 0, 'label');
  });

  it('answers undefined to a message type it does not handle', async () => {
    expect(await send({ type: 'onlyread:config', editorGuard: false })).toBeUndefined();
  });

  it('answers policy:get with the policy it holds, and has no policy:set (the dev channel has its own)', async () => {
    expect(await send({ type: 'policy:get' })).toBe(S.policy);
    expect(await send({ type: 'policy:set', policy: { ...S.policy, enabled: false } })).toBeUndefined();
    expect(h.saved).toEqual([]);
  });

  it('reports storage, startup and policy problems in status, and what the store holds when the browser can say', async () => {
    const before = (await send({ type: 'status:get' })) as Status;
    expect(before).toMatchObject({ storageProblem: undefined, startupProblem: undefined, policyProblem: undefined, storageBytes: undefined });
    storageFailed('audit', new Error('QUOTA_BYTES quota exceeded'));
    health.startup = 'site verdicts not restored: quota';
    expect(await send({ type: 'status:get' })).toMatchObject({ storageProblem: expect.stringMatching(/activity log could not be saved \(QUOTA_BYTES/), startupProblem: 'site verdicts not restored: quota' });
    (globalThis as { chrome: { storage: { local: { getBytesInUse?: () => Promise<number> } } } }).chrome.storage.local.getBytesInUse = async () => 4321;
    expect(((await send({ type: 'status:get' })) as Status).storageBytes).toBe(4321);
  });

  it('names the own-key provider in status, for the settings page\'s status card', async () => {
    expect(((await send({ type: 'status:get' })) as Status).byokLabel).toBe('OpenRouter');
  });

  it('answers activity:get with today\'s counts and the recent refusals, not the whole log', async () => {
    expect(await send({ type: 'activity:get' })).toEqual({ today: { refused: 0, judged: 0, seen: 0 }, recent: [], more: false, total: 0, offset: 0 });
  });

  it('opens the settings page at its AI judge section for the notice\'s "Sign in to Pro"', async () => {
    const create = vi.fn(async () => ({}));
    const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    c.tabs = { create };
    const focus = vi.fn(async () => ({}));
    c.windows = { ...(c.windows as object), getLastFocused: async () => ({ id: 7 }), update: focus }; // the person's last browser window, brought forward
    (c.runtime as Record<string, unknown>).getURL = (p: string) => `chrome-extension://onlyread/${p}`;
    const top = (url: string, frameId = 0) => ({ ...tab(url), frameId });
    expect(await send({ type: 'settings:open', section: 'ai-judge' }, top('https://linear.app/'))).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://onlyread/options.html#ai-judge', windowId: 7, active: true });
    // Only where those buttons show: a top frame on a guarded or demo site, never an iframe or any other page.
    create.mockClear();
    expect(await send({ type: 'settings:open', section: 'ai-judge' }, top('https://linear.app/', 2))).toEqual({ ok: false });
    expect(await send({ type: 'settings:open', section: 'ai-judge' }, top('https://example.com/'))).toEqual({ ok: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('opens the settings page at its top for the setup window\'s "Skip demo", from OnlyRead\'s own pages', async () => {
    const create = vi.fn(async () => ({}));
    const activate = vi.fn(async () => ({}));
    const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    c.tabs = { create, update: activate };
    const focus = vi.fn(async () => ({}));
    c.windows = { ...(c.windows as object), getLastFocused: async () => ({ id: 7 }), update: focus }; // the person's last browser window, brought forward
    const rt = c.runtime as Record<string, unknown>;
    rt.getURL = (p: string) => `chrome-extension://onlyread/${p}`;
    rt.ContextType = { TAB: 'TAB' };
    let pages: { tabId: number; windowId: number; documentUrl: string }[] = [];
    rt.getContexts = async () => pages;
    const setupWindow = { url: 'chrome-extension://onlyread/setup.html', tab: { id: 2 } as chrome.tabs.Tab } as chrome.runtime.MessageSender;
    expect(await send({ type: 'settings:open', section: 'overview' }, setupWindow)).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://onlyread/options.html', windowId: 7, active: true });
    // That window comes forward: from full screen on macOS (a Space of its own) the person would otherwise be left on the
    // desktop once the setup window closes.
    expect(focus).toHaveBeenCalledWith(7, { focused: true });
    // No ordinary window left: the page opens in a new one.
    const opened = vi.fn(async () => ({}));
    c.windows = { getLastFocused: async () => { throw new Error('none'); }, create: opened, update: focus };
    await send({ type: 'settings:open', section: 'overview' }, setupWindow);
    expect(opened).toHaveBeenCalledWith({ url: 'chrome-extension://onlyread/options.html', focused: true });
    // The settings page already open (at any section): that tab, in its own window, brought forward; no new tab.
    c.windows = { getLastFocused: async () => ({ id: 7 }), create: opened, update: focus };
    pages = [{ tabId: 2, windowId: 3, documentUrl: 'chrome-extension://onlyread/setup.html' }, { tabId: 12, windowId: 4, documentUrl: 'chrome-extension://onlyread/options.html#security' }];
    create.mockClear(); opened.mockClear(); focus.mockClear();
    await send({ type: 'settings:open', section: 'overview' }, setupWindow);
    expect(create).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(12, { active: true });
    expect(focus).toHaveBeenCalledWith(4, { focused: true });
    delete rt.getContexts;
  });

  // Pro mode (signed in, Pro judging): OnlyRead is managed on the Pro account page, so the settings buttons go there
  // while the service is reachable; the AI judge and the report stay here, and so does everything with an own key.
  it('opens the Pro account page for settings in Pro mode, this browser\'s page with an own key or Pro out of reach', async () => {
    const create = vi.fn(async () => ({}));
    const activate = vi.fn(async () => ({}));
    const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    let tabs: { id: number; windowId: number; url: string }[] = [];
    c.tabs = { create, update: activate, query: async () => tabs };
    (c.runtime as Record<string, unknown>).ContextType = { TAB: 'TAB' };
    (c.runtime as Record<string, unknown>).getContexts = async () => [];
    const focus = vi.fn(async () => ({}));
    c.windows = { ...(c.windows as object), getLastFocused: async () => ({ id: 7 }), update: focus }; // the person's last browser window, brought forward
    (c.runtime as Record<string, unknown>).getURL = (p: string) => `chrome-extension://onlyread/${p}`;
    const own = { url: 'chrome-extension://onlyread/popup.html' } as chrome.runtime.MessageSender;
    const { cloudStatus } = await import('./cloud-session');
    const status = vi.mocked(cloudStatus);
    S.policy = normalizePolicy({ ...S.policy, judge: { ...S.policy.judge, provider: 'cloud' }, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example/' } });
    status.mockResolvedValue({ provider: 'cloud', serviceUrl: 'https://pro.example/', signedIn: true });
    for (const [section, url] of [['overview', 'https://pro.example/account'], ['guarded-sites', 'https://pro.example/account#sites'], ['security', 'https://pro.example/account#protection'], ['ai-judge', 'chrome-extension://onlyread/options.html#ai-judge'], ['support', 'chrome-extension://onlyread/options.html#report']] as const) {
      create.mockClear();
      await send({ type: 'settings:open', section }, own);
      expect(create).toHaveBeenCalledWith({ url, windowId: 7, active: true });
    }
    // The account page already open in a tab: that tab comes forward instead.
    tabs = [{ id: 5, windowId: 8, url: 'https://pro.example/' }, { id: 6, windowId: 8, url: 'https://pro.example/account#sites' }];
    create.mockClear();
    await send({ type: 'settings:open', section: 'overview' }, own);
    expect(create).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(6, { active: true });
    expect(focus).toHaveBeenCalledWith(8, { focused: true });
    tabs = [];
    // Pro out of reach a moment ago: this browser's page.
    status.mockResolvedValue({ provider: 'cloud', serviceUrl: 'https://pro.example/', signedIn: true, lastError: { code: 'unavailable', at: Date.now() } });
    create.mockClear();
    await send({ type: 'settings:open', section: 'overview' }, own);
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://onlyread/options.html', windowId: 7, active: true });
    // An own key: this browser's page.
    S.policy = normalizePolicy({ ...S.policy, judge: { ...S.policy.judge, provider: 'byok' } });
    status.mockResolvedValue({ provider: 'byok', serviceUrl: 'https://pro.example/', signedIn: false });
    create.mockClear();
    await send({ type: 'settings:open', section: 'security' }, own);
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://onlyread/options.html#security', windowId: 7, active: true });
    status.mockResolvedValue({ provider: 'cloud', signedIn: false } as never);
    delete (c.runtime as Record<string, unknown>).getContexts;
  });

  it('opens the Pro account page at its "Install on" for the demo summary\'s button, from the demo\'s site only', async () => {
    const create = vi.fn(async () => ({}));
    const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    c.tabs = { create };
    const focus = vi.fn(async () => ({}));
    c.windows = { ...(c.windows as object), getLastFocused: async () => ({ id: 7 }), update: focus }; // the person's last browser window, brought forward
    (c.runtime as Record<string, unknown>).getURL = (p: string) => `chrome-extension://onlyread/${p}`;
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example/' } };
    const top = (url: string) => ({ ...tab(url), frameId: 0 });
    expect(await send({ type: 'settings:open', section: 'install-agent' }, top('https://x.com/home'))).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ url: 'https://pro.example/account?install=agent', windowId: 7, active: true });
    create.mockClear();
    expect(await send({ type: 'settings:open', section: 'install-agent' }, top('https://example.com/'))).toEqual({ ok: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('opens the setup window at the demo\'s choice of site for "Try another" and "Try the demo", or sends an open one there', async () => {
    const created: string[] = [];
    const updated: string[] = [];
    let contexts: unknown[] = [];
    const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    (c.runtime as Record<string, unknown>).getContexts = async () => contexts;
    (c.runtime as Record<string, unknown>).ContextType = { TAB: 'TAB' };
    c.windows = { create: async (o: { url: string }) => { created.push(o.url); return {}; }, update: async () => ({}), getLastFocused: async () => { throw new Error('none'); } };
    c.tabs = { update: async (_id: number, o: { url: string }) => { updated.push(o.url); return {}; } };
    const top = { ...tab('https://www.linkedin.com/feed/'), frameId: 0 };
    expect(await send({ type: 'settings:open', section: 'demo' }, top)).toEqual({ ok: true });
    expect(created).toEqual(['chrome-extension://onlyread/setup.html#demo']);
    contexts = [{ windowId: 9, tabId: 4, documentUrl: 'chrome-extension://onlyread/setup.html' }];
    expect(await send({ type: 'setup:open', step: 'demo' })).toEqual({ ok: true });
    expect(updated).toEqual(['chrome-extension://onlyread/setup.html#demo']);
    expect(created).toHaveLength(1);
    // Not from a page that is neither guarded nor a demo site.
    expect(await send({ type: 'settings:open', section: 'demo' }, { ...tab('https://example.com/'), frameId: 0 })).toEqual({ ok: false });
  });

  it('opens the setup window in its own size, and puts it back when Chrome opens it in full screen (from a full-screen window)', async () => {
    vi.useFakeTimers();
    try {
      const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
      (c.runtime as Record<string, unknown>).getContexts = async () => [];
      (c.runtime as Record<string, unknown>).ContextType = { TAB: 'TAB' };
      let state = 'normal';
      const opened: Record<string, unknown>[] = [];
      const updates: Record<string, unknown>[] = [];
      c.windows = {
        create: async (o: Record<string, unknown>) => { opened.push(o); return { id: 31 }; },
        get: async () => ({ id: 31, state }),
        update: async (_id: number, o: Record<string, unknown>) => { updates.push(o); if (o.state) state = o.state as string; return {}; },
        getLastFocused: async () => ({ left: 0, top: 0, width: 1512, height: 982, state: 'fullscreen' }),
      };
      await send({ type: 'setup:open' });
      expect(opened[0]).toMatchObject({ type: 'popup', state: 'normal', width: 640, height: 820, left: 436, top: 81 });
      expect(updates).toEqual([]); // opened at its size
      state = 'fullscreen'; // macOS moved it into full screen a moment later
      await vi.advanceTimersByTimeAsync(900);
      expect(updates).toEqual([{ state: 'normal' }, { width: 640, height: 820, left: 436, top: 81, focused: true }]);
    } finally { vi.useRealTimers(); }
  });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('the Pro account\'s site list (cloud-sync.ts)', () => {
  const managed = () => {
    S.policy = normalizePolicy({ ...S.policy, managed: { version: 7, fetchedAt: 1234, sites: { gmail: { enabled: true } }, customSites: [] } });
    policyAccepted(S.policy);
  };

  // A settings change is built from the policy in force, but cloud-sync.ts may have written the
  // list a moment ago with its change event still queued; the change carries the list as last written, either way.
  it('a settings change carries the list as last written, which the policy in force may not hold yet', async () => {
    policyAccepted(normalizePolicy({ ...S.policy, managed: { version: 3, fetchedAt: 1, sites: { gmail: { enabled: true } }, customSites: [] } }));
    expect(S.policy.managed).toBeUndefined();
    await send({ type: 'guard:set', attachWhen: 'always' });
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'always', managed: { version: 3 } });
    // sites:discover's write too (the settings page sends it beside cloud:sync on the same open).
    h.discover.mockResolvedValueOnce({ iconUrl: 'https://app.example.com/icon.png' });
    await send({ type: 'sites:discover' });
    await vi.waitFor(() => expect(h.saved).toHaveLength(2));
    expect(h.saved.at(-1)).toMatchObject({ customSites: [{ id: 'app.example.com', iconUrl: 'https://app.example.com/icon.png' }], managed: { version: 3 } });
    // And the other way round: the list was just written off, and a change built from the policy still holding it drops it.
    managed();
    policyAccepted(normalizePolicy({ ...S.policy, managed: undefined }));
    await send({ type: 'mode:set', mode: 'enforce' });
    expect(h.saved.at(-1)!.managed).toBeUndefined();
  });

  // Pro mode: the sites are the account's, and a change here goes to it, local first: kept in `accountEdits` (guarded
  // at once, through the lock like any change) and sent by cloud-sync.ts.
  const edits = () => (h.saved.at(-1)!.accountEdits ?? []).map(({ at: _, ...e }) => e);
  it('in Pro mode a change of the sites waits for the account: additions, removals made against the version seen', async () => {
    managed();
    await send({ type: 'site:set', id: 'gmail', enabled: false });
    expect(edits()).toEqual([{ op: 'remove', scope: 'account', id: 'gmail', builtin: true, version: 7 }]);
    expect(h.edit).toHaveBeenCalledWith('edit');
    expect(guardedSiteIds(h.saved.at(-1)!)).not.toContain('gmail'); // off here at once
    await send({ type: 'site:set', id: 'linear', enabled: true });
    await send({ type: 'site:add', host: 'tools.example.net' });
    expect(edits().slice(1)).toEqual([
      { op: 'add', scope: 'account', id: 'linear', builtin: true },
      { op: 'add', scope: 'account', id: 'tools.example.net', builtin: false, name: 'Example' },
    ]);
    expect(h.saved.at(-1)!.sites.linear?.enabled).not.toBe(true); // not this browser's own list
    expect(guardedSiteIds(h.saved.at(-1)!)).toEqual(['linear', 'app.example.com', 'tools.example.net']);
    // Removing a site whose addition has not gone yet takes the addition back: nothing to send for it.
    await send({ type: 'site:remove', id: 'tools.example.net' });
    expect(edits().map((e) => `${e.op} ${e.id}`)).toEqual(['remove gmail', 'add linear']);
    // A site this browser's own list still has (from before the move) leaves that list too, with nothing to send.
    await send({ type: 'site:remove', id: 'app.example.com' });
    expect(h.saved.at(-1)!.customSites).toEqual([]);
    expect(edits()).toHaveLength(2);
  });

  it('in Pro mode a site only this browser\'s own list guards (kept from before the move) can be switched off', async () => {
    managed();
    S.policy = normalizePolicy({ ...S.policy, sites: { ...S.policy.sites, linear: { enabled: true } } });
    expect(guardedSiteIds(S.policy)).toContain('linear');
    await send({ type: 'site:set', id: 'linear', enabled: false });
    expect(h.saved.at(-1)!.sites.linear?.enabled).toBe(false);
    expect(guardedSiteIds(h.saved.at(-1)!)).not.toContain('linear');
    expect(edits()).toEqual([]); // not on the account: nothing to send
  });

  it('in Pro mode, while every site is guarded, the switch takes a site off the account and allowed, and back on', async () => {
    managed();
    S.policy = normalizePolicy({ ...S.policy, guardAll: true, excludeSites: [] });
    policyAccepted(S.policy);
    const gmail = (p: Policy) => listSites(p, 'mail.google.com').find((s) => s.id === 'gmail')!;
    expect(gmail(S.policy).guardAll).toEqual({ on: true }); // switchable: Pro mode changes the account's list
    await send({ type: 'site:guard-all', id: 'gmail', on: false, host: 'mail.google.com' });
    expect(edits()).toEqual([{ op: 'remove', scope: 'account', id: 'gmail', builtin: true, version: 7 }]);
    expect(h.saved.at(-1)).toMatchObject({ excludeSites: ['mail.google.com'], guardAllOff: ['gmail'] });
    expect(gmail(h.saved.at(-1)!).guardAll).toEqual({ on: false });
    // On: the allowed host back, and Gmail back on the account (the removal still waiting is taken back).
    await send({ type: 'site:guard-all', id: 'gmail', on: true, host: 'mail.google.com' });
    expect(h.saved.at(-1)).toMatchObject({ excludeSites: [], guardAllOff: [] });
    expect(gmail(h.saved.at(-1)!)).toMatchObject({ account: true, guardAll: { on: true } });
  });

  it('in Pro mode, a custom site the switch takes off the account stays here switched off, and goes back on', async () => {
    const tools = { id: 'tools.example.net', name: 'Tools', domains: ['tools.example.net'], enabled: true };
    S.policy = normalizePolicy({ ...S.policy, guardAll: true, excludeSites: [], customSites: [], managed: { version: 7, fetchedAt: 1, sites: {}, customSites: [tools] } });
    policyAccepted(S.policy);
    const row = (p: Policy) => listSites(p, 'tools.example.net').find((s) => s.id === 'tools.example.net');
    await send({ type: 'site:guard-all', id: 'tools.example.net', on: false, host: 'tools.example.net' });
    expect(edits()).toEqual([{ op: 'remove', scope: 'account', id: 'tools.example.net', builtin: false, version: 7 }]);
    expect(h.saved.at(-1)!.customSites).toEqual([{ ...tools, enabled: false }]);
    expect(row(h.saved.at(-1)!)).toMatchObject({ guardAll: { on: false } }); // the row stays, off
    await send({ type: 'site:guard-all', id: 'tools.example.net', on: true, host: 'tools.example.net' });
    expect(edits().at(-1)).toMatchObject({ op: 'add', id: 'tools.example.net', builtin: false, name: 'Tools' });
    expect(row(h.saved.at(-1)!)).toMatchObject({ account: true, guardAll: { on: true } });
  });

  it('with two or more browsers on the account an addition goes to this browser\'s list, unless one is asked for', async () => {
    S.policy = normalizePolicy({ ...S.policy, managed: { version: 7, fetchedAt: 1, sites: {}, customSites: [], browsers: 2, browserVersion: 3, browserSites: { sites: { x: { enabled: true } }, customSites: [] } } });
    await send({ type: 'site:set', id: 'linear', enabled: true });
    await send({ type: 'site:set', id: 'gmail', enabled: true, scope: 'account' });
    await send({ type: 'site:set', id: 'x', enabled: false });
    expect(edits()).toEqual([
      { op: 'add', scope: 'browser', id: 'linear', builtin: true },
      { op: 'add', scope: 'account', id: 'gmail', builtin: true },
      { op: 'remove', scope: 'browser', id: 'x', builtin: true, version: 3 },
    ]);
  });

  // With an own key there is no account to change.
  it('with an own key, refuses every edit of the account\'s list: adding, switching on, removing', async () => {
    S.policy = normalizePolicy({ ...S.policy, judge: { ...S.policy.judge, provider: 'byok' } });
    for (const msg of [
      { type: 'site:set', id: 'gmail', enabled: true, scope: 'account' },
      { type: 'site:set', id: 'gmail', enabled: false, scope: 'account' },
      { type: 'site:add', host: 'tools.example.net', scope: 'account' },
      { type: 'site:remove', id: 'linear', scope: 'account' },
    ] as Message[]) expect(await send(msg)).toEqual({ ok: false, error: "Your Pro account's sites are changed on your account page." });
    expect(h.edit).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
  });

  it('Sync now fetches the list and answers with the status: the version in force and what waits', async () => {
    managed();
    h.pending = 'Your Pro account asks to switch gmail off; this applies when the agent session ends';
    const st = (await send({ type: 'cloud:sync' })) as Status;
    expect(h.sync).toHaveBeenCalledWith('sync-now');
    expect(st).toMatchObject({ managed: { version: 7, at: 1234 }, managedPending: h.pending, sites: ['gmail', 'app.example.com'] });
  });

  describe('one mode at a time: Pro (signed in, Pro judge) or an own key (no sign-in)', () => {
    const setupTab = () => tab('chrome-extension://onlyread/setup.html', 9);
    // As written by the background: the mode's changes build on the policy last written (messages.ts latest).
    const use = (p: Policy) => { S.policy = p; policyAccepted(p); };
    const byok = () => use({ ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' }, judge: { ...S.policy.judge, provider: 'byok' } });
    afterEach(() => { h.client.signedIn.mockResolvedValue(false); S.agentSession = false; S.agentBrowser = false; delete store.secrets; });

    it('a finished sign-in makes Pro the judge and deletes the own key', async () => {
      byok();
      store.secrets = { keys: { openrouter: 'sk-or-1' } };
      expect(await send({ type: 'cloud:signin' }, setupTab())).toMatchObject({ ok: true });
      await send({ type: 'page:signin-code', code: 'c', state: 's1' }, { ...tab('https://pro.example/signin/done', 9), frameId: 0 });
      expect(h.saved.at(-1)!.judge.provider).toBe('cloud');
      expect(store.secrets).toEqual({ keys: {} });
    });

    it('a sign-in the lock would refuse (an agent at work, a judge set before) does not start', async () => {
      byok();
      store.firstJudgeAt = 1; // a judge was set up before: changing it is a change of judge like any other
      S.agentSession = true;
      const { startSignIn } = await import('./cloud-session');
      vi.mocked(startSignIn).mockClear();
      expect(await send({ type: 'cloud:signin' }, setupTab())).toMatchObject({ ok: false, error: expect.stringMatching(/AI judge/) });
      expect(startSignIn).not.toHaveBeenCalled();
      expect(h.saved).toEqual([]);
    });

    it('the first AI judge: a Pro sign-in starts while an agent works, and the window shuts once a judge works', async () => {
      byok();
      S.agentSession = true;
      const { startSignIn } = await import('./cloud-session');
      vi.mocked(startSignIn).mockClear();
      expect(await send({ type: 'cloud:signin' }, setupTab())).toMatchObject({ ok: true });
      expect(startSignIn).toHaveBeenCalledTimes(1);
      // A judge at work writes the record (a Pro chosen by a setup link writes none of its own): no second first judge.
      S.judgeConsent = true; S.judgeProblem = undefined;
      expect(await send({ type: 'status:get' })).toMatchObject({ judgeMissing: false });
      await vi.waitFor(() => expect(store.firstJudgeAt).toEqual(expect.any(Number)));
      S.judgeProblem = 'no key';
      vi.mocked(startSignIn).mockClear();
      expect(await send({ type: 'cloud:signin' }, setupTab())).toMatchObject({ ok: false, error: expect.stringMatching(/AI judge/) });
      expect(startSignIn).not.toHaveBeenCalled();
    });

    it('an own key chosen while signed in leaves Pro: the judge first, then the sign-out; never in an agent\'s browser', async () => {
      use({ ...S.policy, judge: { ...S.policy.judge, provider: 'cloud' } });
      h.client.signedIn.mockResolvedValue(true);
      const { cloudSignOut } = await import('./cloud-session');
      vi.mocked(cloudSignOut).mockClear();
      expect(await send({ type: 'judge:byok', choice: { id: 'openrouter' } })).toMatchObject({ ok: true });
      expect(h.saved.at(-1)!.judge).toMatchObject({ provider: 'byok', byok: { id: 'openrouter' } });
      expect(cloudSignOut).toHaveBeenCalledTimes(1);
      expect(h.sync).toHaveBeenLastCalledWith('signed-out');
      S.agentBrowser = true;
      await expect(send({ type: 'judge:byok', choice: { id: 'openrouter' } })).rejects.toThrow(/^locked:agent:.*can't leave OnlyRead Pro/);
      expect(cloudSignOut).toHaveBeenCalledTimes(1);
    });

    it('settles a mix left from before: signed in with an own key signs out; a Pro judge with no sign-in becomes the own key; an agent\'s browser stays signed in', async () => {
      const { settleMode } = await import('./messages');
      const { cloudSignOut } = await import('./cloud-session');
      vi.mocked(cloudSignOut).mockClear();
      byok();
      h.client.signedIn.mockResolvedValue(true);
      await settleMode('startup');
      expect(cloudSignOut).toHaveBeenCalledTimes(1);
      expect(h.saved).toEqual([]);
      // An agent's browser is never signed out here; its lock holds the change of judge (a setup link never connects a
      // browser with its own key, so this mix is not made by OnlyRead).
      S.agentBrowser = true;
      await settleMode('startup');
      expect(cloudSignOut).toHaveBeenCalledTimes(1);
      expect(h.saved).toEqual([]);
      S.agentBrowser = false;
      h.client.signedIn.mockResolvedValue(false);
      use({ ...S.policy, judge: { ...S.policy.judge, provider: 'cloud' } });
      await settleMode('startup');
      expect(h.saved.at(-1)!.judge.provider).toBe('byok');
      // Held by the lock (an agent at work): left for when it opens, nothing thrown.
      S.agentSession = true;
      const n = h.saved.length;
      await settleMode('signed-out');
      expect(h.saved).toHaveLength(n);
    });
  });

  it('the account page\'s "the account changed" asks for the lists now: from the service\'s top frame, signed in, at most once in two seconds', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    const page = (url: string, frameId = 0) => ({ ...tab(url, 9), frameId });
    h.client.signedIn.mockResolvedValue(true);
    h.sync.mockClear();
    await send({ type: 'page:account-changed' }, page('https://pro.example.evil/account'));
    await send({ type: 'page:account-changed' }, page('https://evil.example/https://pro.example/account'));
    await send({ type: 'page:account-changed' }, page('https://pro.example/account', 3));
    expect(h.sync).not.toHaveBeenCalled();
    h.client.signedIn.mockResolvedValue(false);
    await send({ type: 'page:account-changed' }, page('https://pro.example/account'));
    expect(h.sync).not.toHaveBeenCalled();
    h.client.signedIn.mockResolvedValue(true);
    await send({ type: 'page:account-changed' }, page('https://pro.example/account'));
    await send({ type: 'page:account-changed' }, page('https://pro.example/account'));
    expect(h.sync.mock.calls).toEqual([['account-page']]);
    h.client.signedIn.mockResolvedValue(false);
  });

  it('takes the list on sign-in and drops it on sign-out (through the lock, in cloud-sync.ts)', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    expect(await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/setup.html', 9))).toMatchObject({ ok: true });
    await send({ type: 'page:signin-code', code: 'c', state: 's1' }, { ...tab('https://pro.example/signin/done', 9), frameId: 0 });
    expect(h.sync).toHaveBeenLastCalledWith('signed-in');
    await send({ type: 'cloud:signout' });
    expect(h.sync).toHaveBeenLastCalledWith('signed-out');
  });

  it('a setup link marks the browser before it is redeemed, unmarks it when it signs nothing in, and reconnects a marked browser that lost its sign-in', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    const setupPage = { ...tab('https://pro.example/agent-setup', 9), frameId: 0 };
    const link = { type: 'page:agent-setup-link', connect: 'a'.repeat(43), clicked: true } as const;
    const redeem = vi.mocked((await import('./cloud-session')).signInWithSetupLink);
    h.sync.mockImplementation(async (why: string) => { if (why === 'signed-in') h.agentBrowserAtSync = S.agentBrowser; });
    try {
      // A code that signs nothing in: the mark set for it goes again.
      redeem.mockRejectedValueOnce(new Error('expired'));
      expect(await send(link, setupPage)).toMatchObject({ ok: true, connectError: expect.stringMatching(/could not be used/) });
      expect(S.agentBrowser).toBe(false);
      // One that does: marked before the code was redeemed, so before any sync could see the sign-in.
      expect(await send(link, setupPage)).toMatchObject({ ok: true, connected: expect.any(String) });
      expect(h.linkSignedInAgentBrowser).toBe(true);
      expect(h.agentBrowserAtSync).toBe(true);
      // A marked browser that lost its sign-in takes a link again, and stays marked if that one fails.
      h.agentBrowserAtSync = undefined;
      redeem.mockRejectedValueOnce(new Error('expired'));
      expect(await send(link, setupPage)).toMatchObject({ connectError: expect.stringMatching(/could not be used/) });
      expect(S.agentBrowser).toBe(true);
      expect(await send(link, setupPage)).toMatchObject({ ok: true, connected: expect.any(String) });
      expect(h.agentBrowserAtSync).toBe(true);
    } finally { S.agentBrowser = false; h.sync.mockImplementation(async () => {}); }
  });

  it('refuses a sign-in while signed in, and in an agent\'s browser, whether asked or finished', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    h.client.signedIn.mockResolvedValue(true);
    expect(await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/options.html', 9))).toMatchObject({ ok: false, error: expect.stringMatching(/already signed in/) });
    h.client.signedIn.mockResolvedValue(false);
    S.agentBrowser = true;
    try {
      expect(await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/options.html', 9))).toMatchObject({ ok: false, error: expect.stringMatching(/belongs to an AI agent/) });
      // A sign-in started before the browser was marked is not finished either.
      S.agentBrowser = false;
      expect(await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/setup.html', 9))).toMatchObject({ ok: true });
      S.agentBrowser = true;
      h.sync.mockClear();
      await send({ type: 'page:signin-code', code: 'c', state: 's1' }, { ...tab('https://pro.example/signin/done', 9), frameId: 0 });
      expect(h.sync).not.toHaveBeenCalledWith('signed-in');
    } finally { S.agentBrowser = false; }
  });

  it('an email link opened in another tab brings the window the sign-in started in forward, and closes the link\'s tab', async () => {
    vi.useFakeTimers();
    try {
      S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
      const c = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
      const focused: number[] = [];
      c.tabs!.get = async (id: number) => ({ id, windowId: 77 });
      c.windows = { update: async (id: number) => { focused.push(id); return {}; } };
      const link = { ...tab('https://pro.example/sign-in/verify?__clerk_status=verified', 12), frameId: 0 };
      await send({ type: 'page:signin-link' }, link);
      expect(focused).toEqual([]); // no sign-in waits
      await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/setup.html', 9));
      h.tabUpdates.length = 0;
      await send({ type: 'page:signin-link' }, { ...tab('https://elsewhere.example/sign-in/verify', 12), frameId: 0 });
      await send({ type: 'page:signin-link' }, { ...link, frameId: 3 });
      expect(focused).toEqual([]); // another site, or a frame
      await send({ type: 'page:signin-link' }, link);
      expect(focused).toEqual([77]);
      expect(h.tabUpdates).toEqual([[9, undefined]]); // the started tab made active
      await vi.advanceTimersByTimeAsync(1600);
      expect(h.tabRemoves).toEqual([12]);
    } finally { vi.useRealTimers(); }
  });

  // The tab sign-in: the asking tab goes to the sign-in page, and the done page's code is taken only from
  // that page of this browser's service, in that tab, top frame, with the state it started with.
  it('signs in in the asking tab, takes the code only from the service\'s done page in that tab, and sends the tab back', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    expect(await send({ type: 'cloud:signin' })).toMatchObject({ ok: false }); // no tab to sign in in
    await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/options.html?signin=failed&reason=x#ai-judge', 9));
    expect(h.tabUpdates).toEqual([[9, 'https://pro.example/signin?state=s1']]);
    expect(h.signIn?.back).toBe('chrome-extension://onlyread/options.html#ai-judge');
    const code = { type: 'page:signin-code', code: 'c', state: 's1' } as const;
    await send(code, { ...tab('https://evil.example/signin/done', 9), frameId: 0 });          // another site
    await send(code, { ...tab('https://pro.example/account', 9), frameId: 0 });               // another page
    await send(code, { ...tab('https://pro.example/signin/done', 9), frameId: 2 });           // a frame
    await send(code, { ...tab('https://pro.example/signin/done', 4), frameId: 0 });           // another tab
    await send({ ...code, state: 's2' }, { ...tab('https://pro.example/signin/done', 9), frameId: 0 }); // another state
    expect(h.finish).not.toHaveBeenCalled();
    await send(code, { ...tab('https://pro.example/signin/done', 9), frameId: 0 });
    expect(h.finish).toHaveBeenCalledWith('c');
    expect(h.tabUpdates.at(-1)).toEqual([9, 'chrome-extension://onlyread/options.html?signin=ok#ai-judge']);
  });

  // A dev build on the local mock's address whose mock is not running signs in through the real service.
  it('signs in through the real service when the local mock does not answer, saving the change through the lock', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'http://localhost:4173/cloud' } };
    h.fallback = 'https://pro.onlyread.ai';
    try {
      expect(await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/setup.html', 9))).toMatchObject({ ok: true });
      expect(h.tabUpdates.at(-1)).toEqual([9, 'https://pro.onlyread.ai/signin?state=s1']);
      expect(h.saved.at(-1)!.cloud.serviceUrl).toBe('https://pro.onlyread.ai');
    } finally {
      h.fallback = undefined;
    }
  });

  // A sign-in goes back to the page that asked, which shows the result: the setup window then goes on to its demo.
  it('sends the setup window and the settings tab back from the done page, signed in', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    const done = { ...tab('https://pro.example/signin/done', 9), frameId: 0 };
    const code = { type: 'page:signin-code', code: 'c', state: 's1' } as const;
    h.finish.mockImplementation(async () => ({ provider: 'cloud', signedIn: true, account: { credits: { left: 1000, total: 1000 } } }) as never);
    await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/setup.html', 9));
    await send(code, done);
    expect(h.sync).toHaveBeenLastCalledWith('signed-in');
    expect(h.tabRemoves).toEqual([]);
    expect(h.tabUpdates).toEqual([[9, 'https://pro.example/signin?state=s1'], [9, 'chrome-extension://onlyread/setup.html?signin=ok']]);

    await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/options.html#ai-judge', 9));
    await send(code, done);
    expect(h.tabRemoves).toEqual([]);
    expect(h.tabUpdates.at(-1)).toEqual([9, 'chrome-extension://onlyread/options.html?signin=ok#ai-judge']);
  });

  it('tells an open account page when this browser signs in or out, so its Browsers list asks again', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    h.notify.mockClear();
    await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/setup.html', 9));
    await send({ type: 'page:signin-code', code: 'c', state: 's1' }, { ...tab('https://pro.example/signin/done', 9), frameId: 0 });
    expect(h.notify).toHaveBeenCalledWith('this-browser-changed');
    h.notify.mockClear();
    for (const fn of h.signedOutHooks) fn();
    expect(h.notify).toHaveBeenCalledWith('this-browser-changed');
  });

  it('sends the tab back with the reason when the code exchange fails', async () => {
    S.policy = { ...S.policy, cloud: { ...S.policy.cloud, serviceUrl: 'https://pro.example' } };
    h.finish.mockRejectedValueOnce(new Error('code expired'));
    await send({ type: 'cloud:signin' }, tab('chrome-extension://onlyread/setup.html', 9));
    await send({ type: 'page:signin-code', code: 'c', state: 's1' }, { ...tab('https://pro.example/signin/done', 9), frameId: 0 });
    expect(h.tabUpdates.at(-1)).toEqual([9, 'chrome-extension://onlyread/setup.html?signin=failed&reason=code+expired']);
    expect(h.notify).not.toHaveBeenCalledWith('this-browser-changed'); // nothing changed for the account page
    expect(h.sync).not.toHaveBeenCalledWith('signed-in');
  });

  it('tries the waiting change once the right PIN is entered or the PIN removed, not after a wrong one', async () => {
    await send({ type: 'pin:set', pin: '4829' });
    await send({ type: 'pin:unlock', pin: '0000' });
    expect(h.applyPending).not.toHaveBeenCalled();
    await send({ type: 'pin:unlock', pin: '4829' });
    expect(h.applyPending).toHaveBeenCalledWith('pin');
    await send({ type: 'pin:clear', pin: '4829' });
    expect(h.applyPending).toHaveBeenLastCalledWith('pin-removed');
  });

  it('restores the labels of the built-in sites it guards when the cache is cleared', async () => {
    managed();
    await send({ type: 'cache:clear' });
    expect(h.cachePut).toHaveBeenCalledWith('POST mail.google.com/sync/u/{id}/i/s gmail:s:r', 'allow', 0, 'label');
  });
});

describe('lowering protection is locked while an agent works, and behind the PIN', () => {
  const on = () => { S.policy = normalizePolicy({ ...S.policy, enabled: true, sites: { ...S.policy.sites, gmail: { enabled: true } } }); };

  it('refuses turning protection off, switching a site off and clearing verdicts while an agent is active', async () => {
    on(); S.agentSession = true;
    await expect(send({ type: 'guard:set', enabled: false })).rejects.toThrow(/^locked:agent:An AI agent is active in this browser, so OnlyRead can't turn protection off/);
    await expect(send({ type: 'site:set', id: 'gmail', enabled: false })).rejects.toThrow(/^locked:agent:.*switch gmail off/);
    await expect(send({ type: 'cache:clear' })).rejects.toThrow(/^locked:agent:.*clear the tested verdicts/);
    expect(h.saved).toEqual([]);
  });

  it('counts a site added a moment ago, not yet reported by storage, as lowered when it is removed', async () => {
    on();
    await send({ type: 'site:add', host: 'tools.example.net' });
    S.agentSession = true;
    await expect(send({ type: 'site:remove', id: 'tools.example.net' })).rejects.toThrow(/^locked:agent:/);
    expect(h.saved.at(-1)!.customSites.map((c) => c.id)).toContain('tools.example.net');
  });

  it('still lets protection be raised while an agent is active', async () => {
    on(); S.agentSession = true;
    await send({ type: 'site:add', host: 'tools.example.net' });
    expect(h.saved.at(-1)!.customSites.map((c) => c.id)).toContain('tools.example.net');
  });

  it('with a PIN set, asks for it before lowering protection, and allows it for a while once entered', async () => {
    on();
    expect(await send({ type: 'pin:set', pin: '4829' })).toEqual({ ok: true });
    await expect(send({ type: 'guard:set', enabled: false })).rejects.toThrow(/^locked:pin:Enter your settings PIN to turn protection off/);
    expect(await send({ type: 'pin:unlock', pin: '0000' })).toEqual({ ok: false, error: 'That PIN is not right.' });
    expect(await send({ type: 'pin:unlock', pin: '4829' })).toMatchObject({ ok: true });
    await send({ type: 'guard:set', enabled: false });
    expect(h.saved.at(-1)!.enabled).toBe(false);
  });

  it('changing or removing the PIN needs the current one; an agent session refuses removing it', async () => {
    expect(await send({ type: 'pin:set', pin: '4829' })).toEqual({ ok: true });
    expect(await send({ type: 'pin:set', pin: '1111' })).toEqual({ ok: false, error: 'The current PIN is not right.' });
    expect(await send({ type: 'pin:set', pin: '1111', current: '4829' })).toEqual({ ok: true });
    S.agentSession = true;
    await expect(send({ type: 'pin:clear', pin: '1111' })).rejects.toThrow(/^locked:agent:/);
    S.agentSession = false;
    expect(await send({ type: 'pin:clear', pin: '1111' })).toEqual({ ok: true });
    expect(store.settingsPin).toBeUndefined();
  });

  it('adds a first key freely, but replacing or removing one is locked while an agent is active', async () => {
    store.firstJudgeAt = 1; // a judge set up before: the first-judge window is shut
    S.agentSession = true;
    expect(await send({ type: 'secrets:key', provider: 'openrouter', key: ' sk-or-first ' })).toEqual({ ok: true });
    expect(store.secrets).toEqual({ keys: { openrouter: 'sk-or-first' } });
    await expect(send({ type: 'secrets:key', provider: 'openrouter', key: 'sk-or-agents' })).rejects.toThrow(/^locked:agent:.*replace the AI judge's key/);
    await expect(send({ type: 'secrets:key', provider: 'openrouter' })).rejects.toThrow(/^locked:agent:.*remove the AI judge's key/);
    expect(store.secrets).toEqual({ keys: { openrouter: 'sk-or-first' } });
    S.agentSession = false;
    expect(await send({ type: 'secrets:key', provider: 'openrouter' })).toEqual({ ok: true });
    expect(store.secrets).toEqual({ keys: {} });
  });

  it('keeps an Anthropic key beside the gateway\'s, under the same lock, and no other kind of key', async () => {
    store.firstJudgeAt = 1;
    expect(await send({ type: 'secrets:key', provider: 'anthropic', key: 'sk-ant-1' })).toEqual({ ok: true });
    expect(store.secrets).toEqual({ keys: { anthropic: 'sk-ant-1' } });
    S.agentSession = true;
    await expect(send({ type: 'secrets:key', provider: 'anthropic', key: 'sk-ant-agents' })).rejects.toThrow(/^locked:agent:.*replace the AI judge's key/);
    await expect(send({ type: 'secrets:key', provider: 'anthropic' })).rejects.toThrow(/^locked:agent:.*remove the AI judge's key/);
    S.agentSession = false;
    expect(await send({ type: 'secrets:key', provider: 'openai' as never, key: 'k' })).toEqual({ ok: false, error: 'unknown provider' });
  });

  it('the first AI judge: a mistyped key can be replaced while an agent works, until a judge has worked', async () => {
    S.agentSession = true;
    S.judgeProblem = 'the key was refused'; // no judge works yet
    expect(await send({ type: 'secrets:key', provider: 'openrouter', key: 'sk-or-typo' })).toEqual({ ok: true });
    expect(await send({ type: 'secrets:key', provider: 'openrouter', key: 'sk-or-right' })).toEqual({ ok: true });
    expect(store.secrets).toEqual({ keys: { openrouter: 'sk-or-right' } });
    // Only the judge's own changes pass: anything else still waits for the agent to finish.
    await expect(send({ type: 'mode:set', mode: 'monitor' } as never)).rejects.toThrow(/^locked:agent:/);
    store.firstJudgeAt = 1; // a judge has worked: shut for good
    await expect(send({ type: 'secrets:key', provider: 'openrouter', key: 'sk-or-agents' })).rejects.toThrow(/^locked:agent:.*replace the AI judge's key/);
  });

  it('puts back a first-judge record removed from outside while an agent works', async () => {
    const { putBackOutsideWrite } = await import('./messages');
    store.firstJudgeAt = 5;
    S.agentSession = true;
    delete store.firstJudgeAt;
    expect(await putBackOutsideWrite({ firstJudgeAt: { oldValue: 5, newValue: undefined } })).toMatchObject({ what: ['set up a first AI judge again'] });
    expect(store.firstJudgeAt).toBe(5);
    // Written by the setup or settings page (no record before): it only shuts the window, so it stands.
    expect(await putBackOutsideWrite({ firstJudgeAt: { oldValue: undefined, newValue: 7 } })).toBeUndefined();
  });

  it('asks for the PIN before replacing a key', async () => {
    store.secrets = { keys: { vercel: 'vk-1' } };
    await send({ type: 'pin:set', pin: '4829' });
    await expect(send({ type: 'secrets:key', provider: 'vercel', key: 'vk-2' })).rejects.toThrow(/^locked:pin:Enter your settings PIN to replace the AI judge's key/);
    await send({ type: 'pin:unlock', pin: '4829' });
    expect(await send({ type: 'secrets:key', provider: 'vercel', key: 'vk-2' })).toEqual({ ok: true });
  });

  it('refuses a first PIN while an agent is active, so an agent cannot set one the person does not know', async () => {
    S.agentSession = true;
    await expect(send({ type: 'pin:set', pin: '4829' })).rejects.toThrow(/^locked:agent:.*set a PIN/);
    expect(store.settingsPin).toBeUndefined();
  });

  it('makes each try wait longer after five wrong PINs, and keeps the count in storage', async () => {
    await send({ type: 'pin:set', pin: '4829' });
    for (let i = 0; i < 5; i++) expect(await send({ type: 'pin:unlock', pin: '0000' })).toEqual({ ok: false, error: 'That PIN is not right.' });
    expect(await send({ type: 'pin:unlock', pin: '4829' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Too many wrong PINs/) });
    expect(store.pinFailures).toMatchObject({ count: 5 });
  });

  // Tries sent all at once (an undetected agent driving the settings page) are taken one at a time: without that, every
  // try passed the wait check before the first was counted, and the racing counts wrote over each other.
  it('takes wrong PINs sent at once one at a time: five are compared, the rest wait, and every one compared is counted', async () => {
    await send({ type: 'pin:set', pin: '4829' });
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    try {
      const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => send({ type: 'pin:unlock', pin: String(1000 + i) }) as Promise<{ ok: boolean; error?: string }>));
      expect(burst.filter((r) => r.error === 'That PIN is not right.')).toHaveLength(5);
      expect(burst.filter((r) => /^Too many wrong PINs/.test(r.error ?? ''))).toHaveLength(15);
      expect(derive).toHaveBeenCalledTimes(5); // only five PINs were ever compared
      expect(store.pinFailures).toMatchObject({ count: 5 });
      // The right PIN in a burst after the limit is refused like the rest, and not compared.
      const again = await Promise.all(['0001', '4829', '0002'].map((pin) => send({ type: 'pin:unlock', pin }) as Promise<{ ok: boolean; error?: string }>));
      for (const r of again) expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^Too many wrong PINs/) });
      expect(derive).toHaveBeenCalledTimes(5);
      expect(S.pinUnlockedUntil).toBeLessThanOrEqual(Date.now());
    } finally { derive.mockRestore(); }
  });

  it('a try that throws is still counted and does not hold up the next; the right PIN then unlocks and clears the count', async () => {
    await send({ type: 'pin:set', pin: '4829' });
    const derive = vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValueOnce(new Error('crypto failed'));
    try {
      const [thrown, right] = await Promise.allSettled([send({ type: 'pin:unlock', pin: '4829' }), send({ type: 'pin:unlock', pin: '4829' })]);
      expect(thrown.status).toBe('rejected');
      expect(right).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      expect(store.pinFailures).toEqual({ count: 0, retryAt: 0 });
    } finally { derive.mockRestore(); }
  });

  describe('a try that hangs', () => {
    const real = crypto.subtle.deriveBits.bind(crypto.subtle);
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('fails at the time limit, and the try behind it runs', async () => {
      await send({ type: 'pin:set', pin: '4829' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.spyOn(crypto.subtle, 'deriveBits').mockReturnValueOnce(new Promise<ArrayBuffer>(() => {})); // never finishes
      const hung = send({ type: 'pin:unlock', pin: '4829' });
      const next = send({ type: 'pin:unlock', pin: '4829' });
      await vi.advanceTimersByTimeAsync(PIN_TRY_LIMIT_MS);
      expect(await hung).toEqual({ ok: false, error: 'That PIN is not right.' });
      expect(await next).toMatchObject({ ok: true });
    });

    it('matching after the limit neither unlocks nor clears the count', async () => {
      await send({ type: 'pin:set', pin: '4829' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let release = () => {};
      let derived: Promise<ArrayBuffer> | undefined;
      vi.spyOn(crypto.subtle, 'deriveBits').mockImplementationOnce((...args: Parameters<SubtleCrypto['deriveBits']>) => new Promise<ArrayBuffer>((resolve) => { release = () => { derived = real(...args); resolve(derived); }; }));
      const slow = send({ type: 'pin:unlock', pin: '4829' });
      await vi.advanceTimersByTimeAsync(PIN_TRY_LIMIT_MS);
      expect(await slow).toEqual({ ok: false, error: 'That PIN is not right.' });
      release();
      await derived; // the right PIN, matched late
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); // and whatever the try does next
      expect(S.pinUnlockedUntil).toBeLessThanOrEqual(Date.now());
      expect(store.pinFailures).toMatchObject({ count: 1 }); // counted, and not cleared by the late match
    });
  });

  it('matches no PIN against a stored record asking for too many rounds, or a malformed number of them', async () => {
    const { pinMatches, hashPin, MAX_PIN_ITERATIONS } = await import('./protection');
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    try {
      const ok = await hashPin('4829', crypto.randomUUID(), 1000);
      expect(await pinMatches('4829', ok)).toBe(true);
      derive.mockClear();
      for (const iterations of [MAX_PIN_ITERATIONS + 1, 1e12, 0, -5, 1.5, Number.NaN, '310000' as unknown as number]) {
        expect(await pinMatches('4829', { ...ok, iterations }), String(iterations)).toBe(false);
      }
      expect(derive).not.toHaveBeenCalled(); // refused before any rounds are run
    } finally { derive.mockRestore(); }
  });

  it('honours a backoff another worker life left in storage: a restart hands out no fresh budget', async () => {
    await send({ type: 'pin:set', pin: '4829' });
    store.pinFailures = { count: 5, retryAt: Date.now() + 30_000 }; // written by the worker before it was reloaded
    expect(await send({ type: 'pin:unlock', pin: '4829' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Too many wrong PINs/) });
    store.pinFailures = { count: 5, retryAt: Date.now() - 1 };
    expect(await send({ type: 'pin:unlock', pin: '4829' })).toMatchObject({ ok: true });
    expect(store.pinFailures).toEqual({ count: 0, retryAt: 0 }); // a right PIN clears it
  });

  it('upgrades a PIN hashed by an older version (one SHA-256 round) on the next right entry', async () => {
    const salt = 'old-salt';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:4829`));
    store.settingsPin = { salt, hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
    expect(await send({ type: 'pin:unlock', pin: '0000' })).toEqual({ ok: false, error: 'That PIN is not right.' });
    expect((store.settingsPin as { iterations?: number }).iterations).toBeUndefined(); // a wrong PIN changes nothing
    expect(await send({ type: 'pin:unlock', pin: '4829' })).toMatchObject({ ok: true });
    expect((store.settingsPin as { iterations?: number }).iterations).toBe(PIN_ITERATIONS);
    expect(await send({ type: 'pin:unlock', pin: '4829' })).toMatchObject({ ok: true }); // and the new hash verifies
  });

  it('puts back a policy written around the background that lowers protection while locked', async () => {
    const { refusedStorageChange } = await import('./messages');
    on(); S.agentSession = true;
    expect(await refusedStorageChange(S.policy, normalizePolicy({ ...S.policy, enabled: false }))).toMatch(/turn protection off/);
    expect(await refusedStorageChange(S.policy, normalizePolicy({ ...S.policy, uploads: false }))).toBeUndefined();
  });

  it('rejects a PIN that is not 4 to 12 digits', async () => {
    expect(await send({ type: 'pin:set', pin: '12' })).toEqual({ ok: false, error: 'A PIN is 4 to 12 digits.' });
  });
});

// The PIN, the judge's keys and the rest, written around the background.
describe('refusedOutsideWrite', () => {
  it('refuses removing the PIN while an agent works, or without the PIN, and judges it with the PIN as it was', async () => {
    const { refusedOutsideWrite } = await import('./messages');
    const pin = { salt: 's', hash: 'h', iterations: 1 };
    S.agentSession = true;
    expect(await refusedOutsideWrite({ settingsPin: { oldValue: pin } })).toMatchObject({ what: ['remove the settings PIN'], keys: ['settingsPin'] });
    S.agentSession = false;
    // Storage already holds no PIN, but the removal is still the PIN's to allow.
    expect((await refusedOutsideWrite({ settingsPin: { oldValue: pin } }))?.message).toMatch(/Enter your settings PIN/);
    S.pinUnlockedUntil = Date.now() + 60_000;
    expect(await refusedOutsideWrite({ settingsPin: { oldValue: pin } })).toBeUndefined();
  });
  it('accepts a first judge key, refuses replacing one while an agent works', async () => {
    const { refusedOutsideWrite } = await import('./messages');
    S.agentSession = true;
    expect(await refusedOutsideWrite({ secrets: { newValue: { keys: { openrouter: 'k1' } } } })).toBeUndefined();
    expect(await refusedOutsideWrite({ secrets: { oldValue: { keys: { openrouter: 'k1' } }, newValue: { keys: { openrouter: 'evil' } } } }))
      .toMatchObject({ what: ["replace the AI judge's key"], keys: ['secrets'] });
    expect(await refusedOutsideWrite({ policyNonce: { newValue: 'n' }, theme: { newValue: 'dark' } })).toBeUndefined();
  });
});

describe('putBackOutsideWrite', () => {
  const mark = { at: 1, account: 'me@example.com' };
  const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 9 };
  // A worker woken by the mark's removal reads it already gone, so S.agentBrowser is false.
  it("puts back the agent-browser mark and the tokens removed with it, judged by the mark as it was", async () => {
    const { putBackOutsideWrite } = await import('./messages');
    S.agentBrowser = false; S.agentSession = false;
    const r = await putBackOutsideWrite({ agentBrowser: { oldValue: mark }, cloudTokens: { oldValue: tokens } });
    expect(r?.what).toEqual(['release this browser from its AI agent', 'sign out of OnlyRead Pro']);
    expect(store.agentBrowser).toEqual(mark);
    expect(store.cloudTokens).toEqual(tokens);
    expect(S.agentBrowser).toBe(true);
    S.agentBrowser = false;
  });
  // A key the background wrote since the outside write is left as it now is.
  it('leaves a key the background has written since', async () => {
    const { putBackOutsideWrite } = await import('./messages');
    S.agentSession = true;
    store.secrets = { keys: { openrouter: 'newer-own-key' } };
    const r = await putBackOutsideWrite({ secrets: { oldValue: { keys: { openrouter: 'k1' } }, newValue: { keys: { openrouter: 'evil' } } } });
    expect(r?.what).toEqual(["replace the AI judge's key"]);
    expect(store.secrets).toEqual({ keys: { openrouter: 'newer-own-key' } });
    store.secrets = { keys: { openrouter: 'evil' } };
    await putBackOutsideWrite({ secrets: { oldValue: { keys: { openrouter: 'k1' } }, newValue: { keys: { openrouter: 'evil' } } } });
    expect(store.secrets).toEqual({ keys: { openrouter: 'k1' } });
  });
  // A forged undo record is put back; erasing one is not a lowering.
  it("removes an undo record written from outside, and lets one be erased", async () => {
    const { putBackOutsideWrite } = await import('./messages');
    S.agentSession = true;
    store.agentSetup = { at: 1, sites: ['gmail'] };
    expect((await putBackOutsideWrite({ agentSetup: { newValue: { at: 1, sites: ['gmail'] } } }))?.what).toEqual(["change the AI agent setup's undo record"]);
    expect('agentSetup' in store).toBe(false);
    expect(await putBackOutsideWrite({ agentSetup: { oldValue: { at: 1, sites: [] } } })).toBeUndefined();
  });
});

// A settings message sent right after an outside write waits for the write to be checked.
describe('settings messages wait for an outside write to be checked', () => {
  it('a PIN removed around the background, then protection switched off at once, still asks for the PIN', async () => {
    const { beginOutsideCheck } = await import('./owned-storage');
    store.settingsPin = { salt: 's', hash: 'h', iterations: 1 };
    S.agentSession = false; S.agentBrowser = false;
    const pin = store.settingsPin;
    delete store.settingsPin; // the outside removal has landed; its put-back is still queued
    const done = beginOutsideCheck();
    setTimeout(() => { store.settingsPin = pin; done(); }, 30);
    await expect(send({ type: 'guard:set', enabled: false })).rejects.toThrow(/^locked:pin:/);
  });
  it('a wrong-PIN count reset around the background, then a PIN try at once, still waits out the backoff', async () => {
    const { beginOutsideCheck } = await import('./owned-storage');
    const failures = { count: 6, retryAt: Date.now() + 60_000 };
    store.settingsPin = { salt: 's', hash: 'h', iterations: 1 };
    store.pinFailures = { count: 0, retryAt: 0 };
    const done = beginOutsideCheck();
    setTimeout(() => { store.pinFailures = failures; done(); }, 30);
    expect(await send({ type: 'pin:unlock', pin: '1234' })).toMatchObject({ ok: false, error: expect.stringMatching(/Too many wrong PINs/) });
  });
});

// The outside write is in storage, but its change event has not reached the worker, so no
// check is open to wait for. The lock reads its own copy, the stricter of it and storage.
describe('the lock does not trust storage for the PIN and the wrong-PIN count', () => {
  it('a wrong-PIN count reset in storage, with no change event yet, does not skip the backoff', async () => {
    const { loadLockState } = await import('./lock-state');
    store.settingsPin = { salt: 's', hash: 'h', iterations: 1 };
    store.pinFailures = { count: 10, retryAt: Date.now() + 3_600_000 };
    await loadLockState();
    store.pinFailures = { count: 0, retryAt: 0 };
    expect(await send({ type: 'pin:unlock', pin: '1234' })).toMatchObject({ ok: false, error: expect.stringMatching(/Too many wrong PINs/) });
  });
  it('a PIN removed in storage, with no change event yet, is still asked for', async () => {
    const { loadLockState } = await import('./lock-state');
    store.settingsPin = { salt: 's', hash: 'h', iterations: 1 };
    await loadLockState();
    delete store.settingsPin;
    S.agentSession = false; S.agentBrowser = false;
    await expect(send({ type: 'guard:set', enabled: false })).rejects.toThrow(/^locked:pin:/);
  });
  it('a PIN replaced in storage by one the writer knows does not unlock: the copy is checked', async () => {
    const { loadLockState } = await import('./lock-state');
    const { hashPin } = await import('./protection');
    store.settingsPin = await hashPin('482913', 'a-b-c-d-e', 1000);
    await loadLockState();
    store.settingsPin = await hashPin('1111', 'a-b-c-d-e', 1000);
    expect(await send({ type: 'pin:unlock', pin: '1111' })).toMatchObject({ ok: false });
    expect(await send({ type: 'pin:unlock', pin: '482913' })).toMatchObject({ ok: true });
  });
  it('takes an outside write once it stands: a first PIN set with no agent at work, and a count raised', async () => {
    const { putBackOutsideWrite } = await import('./messages');
    const { lockFailures, lockPin, loadLockState } = await import('./lock-state');
    await loadLockState();
    S.agentSession = false;
    const pin = { salt: 's', hash: 'h', iterations: 1 };
    store.settingsPin = pin;
    expect(await putBackOutsideWrite({ settingsPin: { newValue: pin } })).toBeUndefined();
    delete store.settingsPin; // storage lost it afterwards: the copy still has it
    expect(await lockPin()).toEqual(pin);
    expect(await putBackOutsideWrite({ pinFailures: { oldValue: { count: 1, retryAt: 0 }, newValue: { count: 2, retryAt: 0 } } })).toBeUndefined();
    expect((await lockFailures()).count).toBe(2);
  });
  it('caps a wrong-PIN wait written from outside at the longest the background sets', async () => {
    const { lockFailures, loadLockState, MAX_PIN_WAIT_MS } = await import('./lock-state');
    await loadLockState();
    store.pinFailures = { count: 9, retryAt: 1e15 };
    const now = Date.now();
    expect((await lockFailures(now)).retryAt).toBe(now + MAX_PIN_WAIT_MS);
  });
});

// Only what reads the lock waits for a pending check; the content script's messages
// (the closing-tab fence among them) are answered at once.
describe('messages that do not read the lock do not wait for outside-write checks', () => {
  it('answers guard:config, ui:action and page:closing while a check is open, and a lowering only after it closes', async () => {
    const { beginOutsideCheck } = await import('./owned-storage');
    const done = beginOutsideCheck();
    const quick = <T>(p: Promise<T>) => Promise.race([p, new Promise<'waited'>((r) => setTimeout(() => r('waited'), 50))]);
    const sender = tab('https://news.example.org/');
    expect(await quick(send({ type: 'guard:config' }, sender))).not.toBe('waited');
    expect(await quick(send({ type: 'ui:action', action: { ts: 1, type: 'click', tag: 'button', url: 'https://news.example.org/' } }, sender))).not.toBe('waited');
    expect(await quick(send({ type: 'page:closing' }, sender))).not.toBe('waited');
    const lowering = send({ type: 'guard:set', enabled: false });
    expect(await quick(lowering)).toBe('waited');
    done();
    await lowering;
  });
});

// Development builds choose the Pro service: the local mock on the dev sink's host, or production. A sign-in belongs to
// the service it was made on, so switching signs the browser out of the one it leaves.
describe('choosing the Pro service (development builds)', () => {
  beforeEach(() => { h.client.signedIn.mockReset(); h.client.signOut.mockReset(); });

  it('switches to production and back to the local mock, signing out of the service it leaves', async () => {
    const { RELEASE_SERVICE_URL, devMockServiceUrl } = await import('./policy');
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, devSink: 'http://localhost:4173/__audit', cloud: { ...defaultPolicy().cloud, serviceUrl: 'http://localhost:4173/cloud' } });
    h.client.signedIn.mockResolvedValue(true);
    await send({ type: 'cloud:service-set', service: 'production' });
    expect(h.saved.at(-1)?.cloud.serviceUrl).toBe(RELEASE_SERVICE_URL);
    expect(h.client.signOut).toHaveBeenCalledTimes(1);
    S.policy = h.saved.at(-1)!;
    await send({ type: 'cloud:service-set', service: 'local' });
    expect(h.saved.at(-1)?.cloud.serviceUrl).toBe(devMockServiceUrl('http://localhost:4173/__audit'));
    // The service already in use: nothing saved, nobody signed out.
    S.policy = h.saved.at(-1)!; const n = h.saved.length;
    await send({ type: 'cloud:service-set', service: 'local' });
    expect(h.saved).toHaveLength(n);
    expect(h.client.signOut).toHaveBeenCalledTimes(2);
  });

  it('is refused while an agent works, and the browser stays signed in', async () => {
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, devSink: 'http://localhost:4173/__audit', cloud: { ...defaultPolicy().cloud, serviceUrl: 'http://localhost:4173/cloud' } });
    S.agentSession = true; h.client.signedIn.mockResolvedValue(true);
    await expect(send({ type: 'cloud:service-set', service: 'production' })).rejects.toThrow();
    expect(h.saved).toEqual([]);
    expect(h.client.signOut).not.toHaveBeenCalled();
  });
});

describe('no AI judge, no protection', () => {
  it('cannot turn protection on without a judge, and signing out of Pro with no key turns it off', async () => {
    S.judgeConsent = true;
    try {
      h.client.signedIn.mockImplementation(async () => false);
      S.policy = normalizePolicy({ ...defaultPolicy(), enabled: false, judge: { ...defaultPolicy().judge, provider: 'cloud' } });
      expect((await send({ type: 'status:get' }) as { judgeMissing?: boolean }).judgeMissing).toBe(true);
      await expect(send({ type: 'guard:set', enabled: true })).rejects.toThrow(/AI judge/);
      // The mode changes, protection stays off.
      await send({ type: 'mode:set', mode: 'enforce' });
      expect(h.saved.at(-1)).toMatchObject({ enabled: false });
      // Signed in: on again.
      h.client.signedIn.mockImplementation(async () => true);
      await send({ type: 'guard:set', enabled: true });
      expect(h.saved.at(-1)).toMatchObject({ enabled: true });
      // Signing out with no key of its own: off.
      S.policy = h.saved.at(-1)!;
      h.client.signedIn.mockImplementation(async () => false);
      await send({ type: 'cloud:signout' });
      expect(h.saved.at(-1)).toMatchObject({ enabled: false });
    } finally { h.client.signedIn.mockImplementation(async () => false); }
  });

  it('turns protection off when OnlyRead Pro ends the sign-in (the account page signed this browser out), as signing out here does', async () => {
    S.judgeConsent = true;
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, judge: { ...defaultPolicy().judge, provider: 'cloud' } });
    policyAccepted(S.policy);
    h.saved.length = 0;
    h.client.signedIn.mockImplementation(async () => false); // the refresh was refused: the tokens are gone
    for (const fn of h.signedOutHooks) fn();
    await vi.waitFor(() => expect(h.saved.at(-1)).toMatchObject({ enabled: false }));
    // The settle's change of judge stands: protection goes off on top of it, not over it with the copy before it (the
    // two writes come one after the other, before storage reports the first).
    expect(h.saved.at(-1)!.judge.provider).toBe('byok');
    // With a key of its own (the judge is not Pro), the sign-in ending changes nothing.
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, judge: { ...defaultPolicy().judge, provider: 'byok' } });
    policyAccepted(S.policy);
    S.judgeProblem = undefined;
    h.saved.length = 0;
    for (const fn of h.signedOutHooks) fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.saved).toEqual([]);
  });

  it('a sign-out the lock kept from turning protection off turns it off once the lock opens', async () => {
    S.judgeConsent = true;
    store.firstJudgeAt = 1; // Pro worked here before: its judge changes go through the lock
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, judge: { ...defaultPolicy().judge, provider: 'cloud' } });
    h.saved.length = 0;
    h.client.signedIn.mockImplementation(async () => false);
    S.agentSession = true; // the lock refuses turning protection off
    for (const fn of h.signedOutHooks) fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.saved).toEqual([]);
    expect((await send({ type: 'status:get' }) as Status)).toMatchObject({ enabled: true, judgeMissing: true });
    S.agentSession = false; // the session ended: cloud-sync.ts applyPendingManaged tells the hooks
    for (const fn of h.lockOpenHooks) fn();
    await vi.waitFor(() => expect(h.saved.at(-1)).toMatchObject({ enabled: false }));
  });
});

describe('the read-tracking switch', () => {
  it('saves the choice; turning it on is refused while an agent works, turning it off is not', async () => {
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, allowReadTracking: false });
    expect(await send({ type: 'read-tracking:set', on: true })).toEqual({ allowReadTracking: true });
    // Switched on already, as last written: on again changes nothing. From off, it is refused.
    S.agentSession = true;
    expect(await send({ type: 'read-tracking:set', on: true })).toEqual({ allowReadTracking: true });
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, allowReadTracking: false });
    await expect(send({ type: 'read-tracking:set', on: true })).rejects.toThrow();
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, allowReadTracking: true });
    expect(await send({ type: 'read-tracking:set', on: false })).toEqual({ allowReadTracking: false });
  });
});

// The first-run demo (demo.ts): started from the setup window, seen by the coach card on its own site only, ended by
// the refused write a moment later or by a skip, its settings put back through the lock.
describe('the first-run demo', () => {
  const sent: unknown[] = [];
  const opened: string[] = [];
  const session: Record<string, unknown> = {};
  beforeEach(async () => {
    sent.length = 0; opened.length = 0;
    const c = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
    vi.stubGlobal('chrome', {
      ...c,
      storage: { ...c.storage, session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: Record<string, unknown>) => { Object.assign(session, o); }, remove: async (k: string) => { delete session[k]; } } },
      runtime: { ...c.runtime, sendMessage: async (m: unknown) => { sent.push(m); }, getContexts: async () => [], ContextType: { TAB: 'TAB' } },
      tabs: { ...c.tabs, create: async (p: { url: string; windowId?: number }) => { opened.push(`${p.url} in ${p.windowId}`); return { windowId: p.windowId }; }, query: async () => [{ id: 5, url: 'https://www.linkedin.com/feed/' }, { id: 6, url: 'https://example.com/' }], sendMessage: async (id: number, m: unknown) => { sent.push({ to: id, ...(m as object) }); } },
      windows: { update: async () => ({}), getLastFocused: async () => ({ id: 1 }) },
    });
    // An AI judge to ask (an own key): the demo does not start without one.
    S.judgeConsent = true; S.judgeProblem = undefined;
    S.policy = normalizePolicy({ ...defaultPolicy(), enabled: true, attachWhen: 'agent-session', judge: { ...defaultPolicy().judge, provider: 'byok' } });
    const { endDemo } = await import('./demo');
    await endDemo();
  });
  const setup = { url: 'chrome-extension://onlyread/setup.html', tab: { id: 2 } as chrome.tabs.Tab } as chrome.runtime.MessageSender;

  it('does not start without an AI judge: it would turn protection on with none to ask', async () => {
    S.judgeConsent = false;
    try {
      h.saved.length = 0;
      expect(await send({ type: 'demo:start', site: 'linkedin' }, setup)).toMatchObject({ ok: false, error: expect.stringMatching(/AI judge/) });
      expect(h.saved).toEqual([]);
      expect(opened).toEqual([]);
    } finally { S.judgeConsent = true; }
  });

  it('starts on a verified site only: protection on all the time, the site guarded, the site opened', async () => {
    expect(await send({ type: 'demo:start', site: 'app.example.com' }, setup)).toEqual({ ok: false, error: 'That site has no demo.' });
    expect(await send({ type: 'demo:start', site: 'linkedin' }, setup)).toEqual({ ok: true });
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'always', mode: 'enforce', enabled: true, sites: { linkedin: { enabled: true } } });
    expect(opened).toEqual(['https://www.linkedin.com/feed/ in 1']); // in the person's own window, not the setup window's
  });

  it('tells a content script about the demo on its own site only', async () => {
    await send({ type: 'demo:start', site: 'linkedin' }, setup);
    expect(await send({ type: 'demo:state' }, tab('https://www.linkedin.com/feed/'))).toMatchObject({ active: true, site: 'linkedin', action: 'React to a post', change: 'your reaction' });
    expect(await send({ type: 'demo:state' }, tab('https://example.com/'))).toEqual({ active: false });
    expect(await send({ type: 'demo:state' }, setup)).toMatchObject({ active: true, site: 'linkedin' });
  });

  it('ends when the coach card says the notice closed: the site\'s tabs hear, the settings go back', async () => {
    vi.useFakeTimers();
    try {
      await send({ type: 'demo:start', site: 'linkedin' }, setup);
      S.policy = h.saved.at(-1)!;
      const { demoRefusal } = await import('./demo');
      await demoRefusal(5, 'www.linkedin.com', { url: 'https://www.linkedin.com/flagship-web/rsc-action/actions/server-request', shape: 'li:rsc:w[reactions.create]' }, 'decoded-write');
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toContainEqual({ to: 5, type: 'demo:stopped', site: 'linkedin', name: 'Create' });
      expect(sent).not.toContainEqual(expect.objectContaining({ to: 6 }));
      // Step 2 lasts as long as OnlyRead's notice: the coach card's word ends it, from the demo's site only.
      expect(await send({ type: 'demo:done' }, tab('https://example.com/'))).toEqual({ ok: false });
      expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'always' });
      expect(await send({ type: 'demo:done' }, tab('https://www.linkedin.com/feed/'))).toEqual({ ok: true, restored: true });
      expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'agent-session', sites: { linkedin: { enabled: true } } });
      expect(sent).toContainEqual({ type: 'demo:ended', site: 'linkedin', stopped: 'Create', restored: true, skipped: false });
    } finally { vi.useRealTimers(); }
  });

  it('is not ended by the coach card before its write is refused, and ends on its own if no word comes', async () => {
    vi.useFakeTimers();
    try {
      await send({ type: 'demo:start', site: 'x' }, setup);
      S.policy = h.saved.at(-1)!;
      expect(await send({ type: 'demo:done' }, tab('https://x.com/home'))).toEqual({ ok: false });
      const { demoRefusal } = await import('./demo');
      await demoRefusal(5, 'x.com', { url: 'https://x.com/i/api/graphql/abc/FavoriteTweet', shape: 'json:queryId,variables' }, 'cached:label');
      await vi.advanceTimersByTimeAsync(19_000);
      expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'always' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'agent-session' });
    } finally { vi.useRealTimers(); }
  });

  it('leaves the next demo alone: the last one\'s fallback timer ends only the demo that set it', async () => {
    vi.useFakeTimers();
    try {
      await send({ type: 'demo:start', site: 'x' }, setup);
      S.policy = h.saved.at(-1)!;
      const { demoRefusal, demoState } = await import('./demo');
      await demoRefusal(5, 'x.com', { url: 'https://x.com/i/api/graphql/abc/FavoriteTweet', shape: 'json:queryId,variables' }, 'cached:label');
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await send({ type: 'demo:done' }, tab('https://x.com/home'))).toMatchObject({ ok: true });
      // "Try another site": LinkedIn's demo, a few seconds later.
      await vi.advanceTimersByTimeAsync(4_000);
      await send({ type: 'demo:start', site: 'linkedin' }, setup);
      S.policy = h.saved.at(-1)!;
      await vi.advanceTimersByTimeAsync(15_000); // past the X demo's timer
      expect(demoState()).toMatchObject({ site: 'linkedin' });
      expect(demoState()?.stopped).toBeUndefined();
      expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'always' });
    } finally { vi.useRealTimers(); }
  });

  it('without a tab of its own, ends as a skip once the last tab of its site closes, and not while one is still open', async () => {
    await send({ type: 'demo:start', site: 'linkedin' }, setup);
    S.policy = h.saved.at(-1)!;
    const c = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
    const { demoTabClosed } = await import('./messages');
    const { demoState } = await import('./demo');
    c.tabs!.query = async () => [{ id: 5, url: 'https://www.linkedin.com/feed/' }, { id: 6, url: 'https://example.com/' }];
    await demoTabClosed(4);
    expect(demoState()).toMatchObject({ site: 'linkedin' }); // another tab of the site is still open
    c.tabs!.query = async () => [{ id: 7, url: '', pendingUrl: 'https://www.linkedin.com/feed/' }];
    await demoTabClosed(4);
    expect(demoState()).toMatchObject({ site: 'linkedin' }); // one still loading the site counts
    c.tabs!.query = async () => [{ id: 4, url: 'https://www.linkedin.com/feed/' }, { id: 6, url: 'https://example.com/' }];
    await demoTabClosed(4); // the closed tab itself, still listed while it closes, does not count
    expect(demoState()).toBeUndefined();
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'agent-session' });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'demo:ended', site: 'linkedin', skipped: true }));
  });

  it('closing the tab the demo opened skips it, even with another tab of the site open; closing another tab does not', async () => {
    const c = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
    c.tabs!.create = async (p: { windowId?: number }) => ({ id: 9, windowId: p.windowId });
    c.tabs!.query = async () => [{ id: 5, url: 'https://www.linkedin.com/feed/' }, { id: 9, url: 'https://www.linkedin.com/feed/' }];
    await send({ type: 'demo:start', site: 'linkedin' }, setup);
    S.policy = h.saved.at(-1)!;
    const { demoTabClosed } = await import('./messages');
    const { demoState } = await import('./demo');
    expect(demoState()).toMatchObject({ site: 'linkedin', tabId: 9 });
    await demoTabClosed(5);
    expect(demoState()).toMatchObject({ site: 'linkedin' }); // an earlier tab of the site, not the demo's
    await demoTabClosed(9);
    expect(demoState()).toBeUndefined();
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'agent-session' });
    expect(sent).toContainEqual(expect.objectContaining({ type: 'demo:ended', site: 'linkedin', skipped: true }));
  });

  it('hands the coach card its font on the demo\'s own site only', async () => {
    const c = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    vi.stubGlobal('chrome', { ...c, runtime: { ...(c.runtime as object), getURL: (p: string) => `chrome-extension://onlyread/${p}` } });
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
    expect(await send({ type: 'demo:font' }, tab('https://x.com/home'))).toEqual({ ok: false }); // no demo
    await send({ type: 'demo:start', site: 'x' }, setup);
    expect(await send({ type: 'demo:font' }, tab('https://example.com/'))).toEqual({ ok: false });
    expect(await send({ type: 'demo:font' }, tab('https://x.com/home'))).toEqual({ ok: true, font: btoa('\x01\x02\x03') });
    vi.unstubAllGlobals();
  });

  it('a skip on the site opens the settings page next, in the person\'s window; one from the setup window leaves that to it', async () => {
    const c = (globalThis as unknown as { chrome: { runtime: Record<string, unknown> } }).chrome;
    c.runtime.getURL = (p: string) => `chrome-extension://onlyread/${p}`;
    await send({ type: 'demo:start', site: 'x' }, setup);
    opened.length = 0;
    const onSite = { ...tab('https://x.com/home'), tab: { id: 3, url: 'https://x.com/home', windowId: 9 } as chrome.tabs.Tab };
    expect(await send({ type: 'demo:skip' }, onSite)).toMatchObject({ ok: true });
    expect(opened).toEqual(['chrome-extension://onlyread/options.html in 1']); // the window last in front: the site's
    await send({ type: 'demo:start', site: 'x' }, setup);
    opened.length = 0;
    expect(await send({ type: 'demo:skip' }, setup)).toMatchObject({ ok: true });
    expect(opened).toEqual([]);
  });

  it('a skip while an agent works still puts back guarding during agent sessions only, and the setup window hears', async () => {
    S.policy = normalizePolicy({ ...S.policy, mode: 'enforce', attachWhen: 'agent-session' });
    await send({ type: 'demo:start', site: 'x' }, setup);
    expect(await send({ type: 'demo:skip' }, tab('https://example.com/'))).toEqual({ ok: false }); // not the demo's site
    S.policy = h.saved.at(-1)!;
    expect(S.policy.attachWhen).toBe('always');
    S.agentSession = true; // with an agent at work, "during agent sessions" guards as "always" does
    expect(await send({ type: 'demo:skip' }, tab('https://x.com/home'))).toEqual({ ok: true, restored: true });
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'agent-session', mode: 'enforce' });
    expect(sent).toContainEqual({ type: 'demo:ended', site: 'x', stopped: undefined, restored: true, skipped: true });
    S.agentSession = false;
  });

  it('a mode the demo changed waits for the lock: while an agent works it stays enforcing, and the setup window says so', async () => {
    S.policy = normalizePolicy({ ...S.policy, mode: 'monitor', attachWhen: 'agent-session' });
    await send({ type: 'demo:start', site: 'x' }, setup);
    S.policy = h.saved.at(-1)!;
    S.agentSession = true;
    expect(await send({ type: 'demo:skip' }, tab('https://x.com/home'))).toEqual({ ok: true, restored: false });
    expect(h.saved.at(-1)).toMatchObject({ attachWhen: 'agent-session', mode: 'enforce' });
    expect(sent).toContainEqual({ type: 'demo:ended', site: 'x', stopped: undefined, restored: false, skipped: true });
    S.agentSession = false;
  });
});
