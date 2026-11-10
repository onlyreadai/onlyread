import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { RELEASE_SERVICE_URL, buildServiceUrl, defaultPolicy, devRelease, devServiceLocal, devServiceSwitch, devServiceUrl, normalizeManaged, normalizePolicy } from './policy';

// The distribution flag is an esbuild define at build time; under vitest we simulate it as a global.
declare global { var __ONLYREAD_DIST__: boolean | undefined; var __ONLYREAD_SERVICE_URL__: string | undefined; }
afterEach(() => {
  delete (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__;
  delete (globalThis as { __ONLYREAD_SERVICE_URL__?: string }).__ONLYREAD_SERVICE_URL__;
});

describe('defaultPolicy distribution override', () => {
  it('is enforce + agent-session with the dev sink in a normal build', () => {
    const d = defaultPolicy();
    expect(d.devSink).toBe('http://localhost:4173/__audit');
    expect(d.mode).toBe('enforce');
    expect(d.attachWhen).toBe('agent-session');
    expect(d.enabled).toBe(false); // a fresh install: setup turns it on once an AI judge works
  });
  it('is enforce + agent-session with no dev sink in a distribution build (sessions are detected)', () => {
    (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__ = true;
    const d = defaultPolicy();
    expect(d.devSink).toBeNull();
    expect(d.attachWhen).toBe('agent-session');
    expect(d.mode).toBe('enforce');
  });
  it('never runs a distribution build in Monitor mode, whatever the stored policy says', () => {
    (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__ = true;
    expect(normalizePolicy({ ...defaultPolicy(), mode: 'monitor' }).mode).toBe('enforce');
    (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__ = false;
    expect(normalizePolicy({ ...defaultPolicy(), mode: 'monitor' }).mode).toBe('monitor');
  });
  it('uses the shipped OnlyRead Pro address in a distribution build, whatever the stored policy says', () => {
    const stored = (serviceUrl: string) => ({ ...defaultPolicy(), cloud: { ...defaultPolicy().cloud, serviceUrl } });
    // A development build keeps the stored address: the local mock, or the real service chosen at sign-in.
    expect(normalizePolicy(stored('http://localhost:4173/cloud')).cloud.serviceUrl).toBe('http://localhost:4173/cloud');
    (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__ = true;
    const shipped = defaultPolicy().cloud.serviceUrl;
    expect(shipped).toMatch(/^https:\/\//);
    // An address an earlier release stored, and one that was never allowed, both give way to the shipped one.
    expect(normalizePolicy(stored('https://old.pro.example')).cloud.serviceUrl).toBe(shipped);
    expect(normalizePolicy(stored('http://localhost:4173/cloud')).cloud.serviceUrl).toBe(shipped);
  });
  it('a release takes the judge\'s time limits it ships with, over a stored copy (an old default); a development build keeps stored ones', () => {
    const stored = { ...defaultPolicy(), judge: { ...defaultPolicy().judge, timeoutMs: 3000, llmTimeoutMs: 4000 } };
    expect(normalizePolicy(stored).judge).toMatchObject({ timeoutMs: 3000, llmTimeoutMs: 4000 });
    (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__ = true;
    expect(normalizePolicy(stored).judge).toMatchObject({ timeoutMs: 5000, llmTimeoutMs: 6000 });
    // The rest of the judge stays the person's: their provider and model.
    expect(normalizePolicy({ ...stored, judge: { ...stored.judge, provider: 'byok', byok: { id: 'vercel' } } }).judge).toMatchObject({ provider: 'byok', byok: { id: 'vercel' }, timeoutMs: 5000 });
  });
  it('never revives the dev sink (and its localhost control channel) in a distribution build', () => {
    (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__ = true;
    expect(normalizePolicy({ ...defaultPolicy(), devSink: 'http://localhost:4173/__audit' }).devSink).toBeNull();
    (globalThis as { __ONLYREAD_DIST__?: boolean }).__ONLYREAD_DIST__ = false;
    expect(normalizePolicy({ ...defaultPolicy(), devSink: 'http://localhost:4173/__audit' }).devSink).toBe('http://localhost:4173/__audit');
  });
});

describe('a test release (a release made with ONLYREAD_SERVICE_URL, harness/bundle.py --service-url)', () => {
  const g = globalThis as { __ONLYREAD_DIST__?: boolean; __ONLYREAD_SERVICE_URL__?: string };
  const DEV = 'https://foo.example';
  const stored = (serviceUrl: string) => ({ ...defaultPolicy(), cloud: { ...defaultPolicy().cloud, serviceUrl } });

  it('a store release (no override) is locked to the store address, https only', () => {
    g.__ONLYREAD_DIST__ = true;
    g.__ONLYREAD_SERVICE_URL__ = '';
    expect(devRelease()).toBe(false);
    expect(buildServiceUrl()).toBe(RELEASE_SERVICE_URL);
    expect(RELEASE_SERVICE_URL).toBe('https://pro.onlyread.ai');
    expect(defaultPolicy().cloud.serviceUrl).toBe('https://pro.onlyread.ai');
    expect(normalizePolicy(stored(DEV)).cloud.serviceUrl).toBe('https://pro.onlyread.ai');
  });
  it('a release with the define missing or undefined is a store release', () => {
    g.__ONLYREAD_DIST__ = true;
    expect([devRelease(), buildServiceUrl()]).toEqual([false, RELEASE_SERVICE_URL]);
    g.__ONLYREAD_SERVICE_URL__ = undefined;
    expect([devRelease(), buildServiceUrl()]).toEqual([false, RELEASE_SERVICE_URL]);
  });
  it('is locked to the override: the default, and a saved address replaced', () => {
    g.__ONLYREAD_DIST__ = true;
    g.__ONLYREAD_SERVICE_URL__ = DEV;
    expect(devRelease()).toBe(true);
    expect(buildServiceUrl()).toBe(DEV);
    expect(RELEASE_SERVICE_URL).toBe('https://pro.onlyread.ai');
    const d = defaultPolicy();
    expect(d.cloud.serviceUrl).toBe(DEV);
    expect(d.mode).toBe('enforce');
    expect(d.devSink).toBeNull();
    expect(normalizePolicy(stored('https://pro.onlyread.ai')).cloud.serviceUrl).toBe(DEV);
    expect(normalizePolicy(stored('http://localhost:4173/cloud')).cloud.serviceUrl).toBe(DEV);
  });
  it('accepts an http://localhost override, and only that address', () => {
    g.__ONLYREAD_DIST__ = true;
    g.__ONLYREAD_SERVICE_URL__ = 'http://localhost:8080';
    expect(normalizePolicy(stored('https://pro.onlyread.ai')).cloud.serviceUrl).toBe('http://localhost:8080');
    // Another localhost address is a stored copy like any other: replaced by the build's.
    expect(normalizePolicy(stored('http://localhost:4173/cloud')).cloud.serviceUrl).toBe('http://localhost:8080');
  });
});

describe('a development build\'s Pro service (ONLYREAD_SERVICE_URL)', () => {
  const g = globalThis as { __ONLYREAD_DIST__?: boolean; __ONLYREAD_SERVICE_URL__?: string };
  const SINK = 'http://localhost:4173/__audit';
  const MOCK = 'http://localhost:4173/cloud';
  const saved = (serviceUrl: string) => ({ cloud: { serviceUrl, timeoutMs: 8000 } });

  it('without it: starts on the mock, falls back from it, never moves a saved service, and is no test release', () => {
    expect([devServiceUrl(SINK), devServiceLocal(), defaultPolicy().cloud.serviceUrl, devRelease()]).toEqual([MOCK, true, MOCK, false]);
    for (const url of ['https://foo.example', RELEASE_SERVICE_URL, 'http://localhost:8080']) expect(devServiceSwitch(saved(url))).toBeUndefined();
    g.__ONLYREAD_SERVICE_URL__ = '';
    expect([devServiceUrl(SINK), devServiceSwitch(saved('https://foo.example'))]).toEqual([MOCK, undefined]);
  });
  it.each(['https://foo.example', 'http://localhost:8080', 'https://pro.onlyread.ai'])('%s: starts there, moves any other saved service there', (url) => {
    g.__ONLYREAD_SERVICE_URL__ = url;
    expect([devServiceUrl(SINK), devServiceLocal(), defaultPolicy().cloud.serviceUrl, devRelease()]).toEqual([url, false, url, false]);
    expect(devServiceSwitch(saved(MOCK))).toBe(url);
    expect(devServiceSwitch(saved(url))).toBeUndefined();
    expect(devServiceSwitch(saved(`${url}/`))).toBeUndefined();
    // A development build keeps a saved service it is given (a test's): only the start moves it (messages.ts).
    expect(normalizePolicy({ ...defaultPolicy(), cloud: { ...defaultPolicy().cloud, serviceUrl: MOCK } }).cloud.serviceUrl).toBe(MOCK);
  });
  it('a release uses it as its own lock, never as a development build\'s', () => {
    g.__ONLYREAD_DIST__ = true;
    g.__ONLYREAD_SERVICE_URL__ = 'https://foo.example';
    expect([devServiceUrl(SINK), devServiceLocal(), devServiceSwitch(saved(MOCK))]).toEqual([undefined, false, undefined]);
  });
});

describe('scripts/build.mjs checks ONLYREAD_SERVICE_URL', () => {
  // --validate-only stops after the checks: a loosened check can never start a real build into extension/dist.
  const script = fileURLToPath(new URL('../../../scripts/build.mjs', import.meta.url));
  const root = dirname(dirname(script));
  const validate = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script, '--validate-only'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
  const bad = [
    'http://evil.example', 'http://127.0.0.1:3001', 'https://foo.example/', 'https://foo.example/path', 'https://Foo.example',
    'https://foo.example.', 'https://user@foo.example', 'https://foo.example:443', 'ftp://foo.example', 'https://[::1]',
    'https://[::1]:8443', 'https://[::1', 'foo.example', 'production',
  ];
  it.each(bad.flatMap((url) => [[url, ''], [url, '1']]))('refuses %j (ONLYREAD_DIST=%j)', (url, dist) => {
    const r = validate({ ONLYREAD_SERVICE_URL: url, ONLYREAD_DIST: dist });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('build refused: ONLYREAD_SERVICE_URL');
  });
  it.each(['', 'https://foo.example', 'https://foo.example:8443', 'http://localhost:8080'].flatMap((url) => [[url, ''], [url, '1']]))('accepts %j (ONLYREAD_DIST=%j)', (url, dist) => {
    expect(validate({ ONLYREAD_SERVICE_URL: url, ONLYREAD_DIST: dist }).status).toBe(0);
  });
  it('refuses the fixture\'s port for a development build: the mock is the build without the variable', () => {
    const r = validate({ ONLYREAD_SERVICE_URL: 'http://localhost:4173', ONLYREAD_DIST: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('leave ONLYREAD_SERVICE_URL unset for the mock');
  });
  it('takes the store\'s own service for a development build, never for a test release', () => {
    expect(validate({ ONLYREAD_SERVICE_URL: RELEASE_SERVICE_URL, ONLYREAD_DIST: '' }).status).toBe(0);
    for (const url of [RELEASE_SERVICE_URL, `${RELEASE_SERVICE_URL}:8443`]) {
      const r = validate({ ONLYREAD_SERVICE_URL: url, ONLYREAD_DIST: '1' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the store release\'s own service');
    }
  });
});


describe('normalizePolicy fills new fields from defaults', () => {
  it('supplies enabled, attachWhen, onRefusedMutation, allowReadTracking when a stored policy omits them', () => {
    const p = normalizePolicy({ mode: 'monitor' });
    expect(p.enabled).toBe(false);
    expect(p.attachWhen).toBe('agent-session');
    expect(p.onRefusedMutation).toBe('notice');
    expect(p.allowReadTracking).toBe(true);
    expect(p.mode).toBe('monitor');
  });
});

describe('normalizePolicy validates blockResponse', () => {
  it('accepts fail and reject, defaults to fail, rejects anything else', () => {
    expect(normalizePolicy({}).blockResponse).toBe('fail');
    expect(normalizePolicy({ blockResponse: 'reject' }).blockResponse).toBe('reject');
    expect(() => normalizePolicy({ blockResponse: 'nope' })).toThrow(/blockResponse/);
  });
});

describe('normalizePolicy and re: telemetry patterns', () => {
  it('a stored telemetry list, even one with a broken regex, is replaced by the shipped list', () => {
    const d = defaultPolicy();
    expect(normalizePolicy({ ...d, telemetryAllow: ['re:['] }).telemetryAllow).toEqual(d.telemetryAllow);
    expect(normalizePolicy({ ...d, telemetryAllow: ['re:'] }).telemetryAllow).toEqual(d.telemetryAllow);
  });
});


describe('judge settings in a stored policy', () => {
  it('keeps only the fields this version knows (old gateway and endpoint settings are dropped)', () => {
    const stored = { ...defaultPolicy(), judge: { ...defaultPolicy().judge, primary: 'jev', gatewayBaseUrl: 'https://old.example', jevEndpoint: 'https://old.example/j', byok: { id: 'vercel', model: 'anthropic/claude-haiku-4.5', baseUrl: 'https://x' } } };
    const j = normalizePolicy(stored).judge as unknown as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(['byok', 'llmTimeoutMs', 'provider', 'timeoutMs']);
    expect(j.byok).toEqual({ id: 'vercel', model: 'anthropic/claude-haiku-4.5' });
  });
  it('fills a missing own-key choice with the default gateway', () => {
    const stored = { ...defaultPolicy(), judge: { provider: 'byok', timeoutMs: 3000, llmTimeoutMs: 6000 } };
    expect(normalizePolicy(stored).judge.byok).toEqual({ id: 'openrouter' });
  });
  it('rejects an unknown provider, gateway or a non-positive time limit', () => {
    const base = defaultPolicy();
    expect(() => normalizePolicy({ ...base, judge: { ...base.judge, provider: 'other' } })).toThrow(/judge.provider/);
    expect(() => normalizePolicy({ ...base, judge: { ...base.judge, byok: { id: 'anthropic' } } })).toThrow(/judge.byok.id/);
    expect(() => normalizePolicy({ ...base, judge: { ...base.judge, timeoutMs: 0 } })).toThrow(/judge.timeoutMs/);
    expect(() => normalizePolicy({ ...base, judge: { ...base.judge, llmTimeoutMs: -1 } })).toThrow(/judge.llmTimeoutMs/);
  });
  it('defaults to OnlyRead Pro, with OpenRouter for an own key and the shipped time limits', () => {
    expect(defaultPolicy().judge).toEqual({ provider: 'cloud', byok: { id: 'openrouter' }, timeoutMs: 5000, llmTimeoutMs: 6000 });
  });
});

describe('judge thresholds always come from the shipped defaults', () => {
  it('a stored policy saved under older defaults gets the current thresholds', () => {
    const stored = { ...defaultPolicy(), thresholds: { allow: 0.3, block: 0.85 } };
    expect(normalizePolicy(stored).thresholds).toEqual(defaultPolicy().thresholds);
    expect(defaultPolicy().thresholds.block).toBe(0.75);
  });
});

describe('global rule lists: shipped allowances always apply; stored entries can only add blocking', () => {
  it('a stored policy from an older version gets the current telemetry patterns and loses removed ones', () => {
    const stored = { ...defaultPolicy(), telemetryAllow: ['/collect', '/an-old-removed-pattern'] };
    const out = normalizePolicy(stored);
    expect(out.telemetryAllow).toEqual(defaultPolicy().telemetryAllow);
    expect(out.telemetryAllow).toContain('/b/ss/');
    expect(out.telemetryAllow).not.toContain('/an-old-removed-pattern');
  });
  it('stored blocked paths are kept on top of the shipped ones', () => {
    const out = normalizePolicy({ ...defaultPolicy(), blockedGetPaths: ['/logout', '/mark-read'] });
    expect(out.blockedGetPaths).toEqual(expect.arrayContaining([...defaultPolicy().blockedGetPaths, '/mark-read']));
  });
});

describe('normalizePolicy: every broken field is rejected with a message that names it', () => {
  const base = () => JSON.parse(JSON.stringify(defaultPolicy())) as Record<string, any>;
  const cases: [string, (p: Record<string, any>) => void, RegExp][] = [
    ['not an object', () => {}, /policy must be an object/],
    ['enabled', (p) => { p.enabled = 'yes'; }, /enabled must be a boolean/],
    ['mode', (p) => { p.mode = 'audit'; }, /mode must be monitor\|enforce, got audit/],
    ['customSites', (p) => { p.customSites = [{ id: 'x.com', domains: [] }]; }, /customSites entries need an id, string domains and a boolean enabled/],
    ['websockets', (p) => { p.websockets = 'maybe'; }, /websockets must be block\|allow/],
    ['onRefusedMutation', (p) => { p.onRefusedMutation = 'retry'; }, /onRefusedMutation must be/],
    ['blockResponse', (p) => { p.blockResponse = 'drop'; }, /blockResponse must be fail\|reject/],
    ['allowReadTracking', (p) => { p.allowReadTracking = 1; }, /allowReadTracking must be a boolean/],
    ['judge.provider', (p) => { p.judge.provider = 'other'; }, /judge.provider must be byok\|cloud/],
    ['judge.byok.id', (p) => { p.judge.byok = { id: 'nope' }; }, /judge.byok.id must be one of/],
    ['judge.timeoutMs', (p) => { p.judge.timeoutMs = 0; }, /judge.timeoutMs must be positive/],
    ['judge.llmTimeoutMs', (p) => { p.judge.llmTimeoutMs = -1; }, /judge.llmTimeoutMs must be positive/],
    ['cloud.serviceUrl', (p) => { p.cloud.serviceUrl = 'http://evil.example'; }, /cloud.serviceUrl must be https/],
    ['cloud.timeoutMs', (p) => { p.cloud.timeoutMs = 0; }, /cloud.timeoutMs must be positive/],
    ['attachWhen', (p) => { p.attachWhen = 'sometimes'; }, /attachWhen must be always\|agent-session/],
    // decision.ts tests `!policy.uploads`, so an unchecked stored "no" would allow uploads.
    ['attachScope', (p) => { p.attachScope = 'some-tabs'; }, /attachScope must be all-tabs\|target-tabs, got some-tabs/],
    ['reviewBand', (p) => { p.reviewBand = 'maybe'; }, /reviewBand must be block\|llm\|human, got maybe/],
    ['uploads', (p) => { p.uploads = 'no'; }, /uploads must be a boolean/],
    ['downloads', (p) => { p.downloads = 1; }, /downloads must be a boolean/],
    ['opaqueToReview', (p) => { p.opaqueToReview = 'yes'; }, /opaqueToReview must be a boolean/],
  ];
  for (const [name, breakIt, message] of cases) {
    it(name, () => {
      if (name === 'not an object') { expect(() => normalizePolicy(null)).toThrow(message); return; }
      const p = base(); breakIt(p);
      expect(() => normalizePolicy(p)).toThrow(message);
    });
  }
  it('repairs fields the merge owns instead of rejecting them: sites and the shipped path lists', () => {
    const p = base(); p.sites = null; p.blockedGetPaths = 'x'; p.telemetryAllow = 'y';
    const out = normalizePolicy(p);
    expect(typeof out.sites).toBe('object');
    expect(Array.isArray(out.blockedGetPaths) && Array.isArray(out.telemetryAllow)).toBe(true);
  });
  it('accepts http://localhost for a development service URL', () => {
    const p = base(); p.cloud.serviceUrl = 'http://localhost:4173';
    expect(normalizePolicy(p).cloud.serviceUrl).toBe('http://localhost:4173');
  });
});

// The defaults have every site off, so a stored policy with one bad value (an older version's
// `uploads: "no"`) must not make the person's sites vanish: that value is reset, the rest kept, the copy backed up.
describe('getPolicy with an invalid stored policy', () => {
  const stored = (policy: unknown) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store: Record<string, unknown> = { policy };
    vi.stubGlobal('chrome', { storage: { local: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: Record<string, unknown>) => { Object.assign(store, o); } } } });
    return store;
  };
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('resets the one bad value to its default and keeps the rest, saying which, and clears the report once a valid policy is saved', async () => {
    const store = stored({ ...defaultPolicy(), uploads: 'no', sites: { gmail: { enabled: true } }, customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }] });
    const { getPolicy, setPolicy, BACKUP_KEY } = await import('./policy');
    const { health } = await import('./storage-health');
    const p = await getPolicy();
    expect(p.uploads).toBe(defaultPolicy().uploads);
    expect(p.sites.gmail?.enabled).toBe(true);
    expect(p.customSites.map((c) => c.id)).toEqual(['app.example.com']);
    expect(store[BACKUP_KEY]).toMatchObject({ policy: { uploads: 'no' }, error: 'uploads must be a boolean' });
    expect(health.policy).toBe(`The stored settings had an invalid value (uploads must be a boolean); uploads was reset to its default and the old copy is kept under ${BACKUP_KEY}`);
    expect(health.policyRepaired).toBe('uploads');
    await setPolicy(defaultPolicy());
    expect(health.policy).toBeUndefined();
    expect(health.policyRepaired).toBeUndefined();
  });

  it('resets a nested value (judge.provider) on its own, keeping the rest of the judge settings', async () => {
    stored({ ...defaultPolicy(), judge: { ...defaultPolicy().judge, provider: 'other', byok: { id: 'vercel' } } });
    const { getPolicy } = await import('./policy');
    const { health } = await import('./storage-health');
    const p = await getPolicy();
    expect(p.judge).toMatchObject({ provider: defaultPolicy().judge.provider, byok: { id: 'vercel' } });
    expect(health.policyRepaired).toBe('judge.provider');
  });

  // A custom site with a domain that is not a string, if accepted, would make every guard check throw.
  it('does not take a custom site whose domains are not strings: the field is repaired and every check still runs', async () => {
    const store = stored({ ...defaultPolicy(), sites: { gmail: { enabled: true } }, customSites: [{ id: 'app.example.com', name: 'App', domains: [123], enabled: true }] });
    const { getPolicy, BACKUP_KEY } = await import('./policy');
    const { health } = await import('./storage-health');
    const { guardsHost } = await import('./decision');
    const p = await getPolicy();
    expect(health.policyRepaired).toBe('customSites');
    expect(p.sites.gmail?.enabled).toBe(true);
    expect(store[BACKUP_KEY]).toMatchObject({ error: expect.stringMatching(/^customSites entries need/) });
    expect(() => guardsHost(p.effective, 'mail.google.com')).not.toThrow();
  });
  it('rejects a custom site with an empty domain, a missing enabled or a name that is not a string', async () => {
    const { normalizePolicy } = await import('./policy');
    for (const c of [{ id: 'a.com', domains: [''], enabled: true }, { id: 'a.com', domains: ['a.com'] }, { id: 'a.com', name: 7, domains: ['a.com'], enabled: true }]) {
      expect(() => normalizePolicy({ ...defaultPolicy(), customSites: [c] })).toThrow(/^customSites entries need/);
    }
  });

  it('falls back to the defaults, with the backup and the report, when the policy is broken in more than one way', async () => {
    const store = stored({ ...defaultPolicy(), mode: 'audit', uploads: 'no', sites: { gmail: { enabled: true } } });
    const { getPolicy, BACKUP_KEY } = await import('./policy');
    const { health } = await import('./storage-health');
    const p = await getPolicy();
    expect(p.sites.gmail?.enabled).toBe(false);
    expect(store[BACKUP_KEY]).toMatchObject({ policy: { mode: 'audit' }, error: expect.stringMatching(/mode must be monitor\|enforce/) });
    expect(health.policy).toMatch(/^The stored settings were invalid \(mode must be monitor\|enforce, got audit\); the defaults are in use/);
    expect(health.policyRepaired).toBeUndefined();
  });
});

// An invalid policy written around the background (never the background's own: it writes valid ones) is reported,
// and the caller puts the current policy back, so an invalid and weakening copy never waits in storage for the next
// start to repair it. Own writes are told apart by a nonce written with the policy, never by content.
describe('onPolicyChange', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  /** chrome.storage as the background sees it: keys come back sorted at every depth, and a write of a value equal
   *  to the stored one fires no change for that key (so an unchanged policy written with a new nonce reports the
   *  nonce alone). The listener registered by onPolicyChange is fed by `set` the way Chrome feeds it. */
  const browser = () => {
    const store: Record<string, unknown> = {};
    const listeners: ((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void)[] = [];
    const sorted = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x)));
    const set = async (o: Record<string, unknown>) => {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(sorted(o) as Record<string, unknown>)) {
        if (JSON.stringify(store[k]) === JSON.stringify(v)) continue;
        changes[k] = { oldValue: store[k], newValue: v }; store[k] = v;
      }
      if (Object.keys(changes).length) for (const l of listeners) l(changes, 'local');
    };
    vi.stubGlobal('chrome', { storage: {
      local: { get: async (k: string) => ({ [k]: store[k] }), set },
      onChanged: { addListener: (l: (typeof listeners)[number]) => { listeners.push(l); } },
    } });
    /** A write from around the background (an agent with storage access). */
    const outside = (policy: unknown, extra: Record<string, unknown> = {}) => set({ policy, ...extra });
    return { store, outside };
  };

  it('reports an invalid change instead of passing or ignoring it, and passes a valid one with whether it was its own', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, outside } = browser();
    const { onPolicyChange, setPolicy } = await import('./policy');
    const valid: unknown[] = []; const invalid: string[] = [];
    onPolicyChange((p, own) => valid.push([p.enabled, own]), (m) => invalid.push(m));
    await outside({ ...defaultPolicy(), enabled: false, sites: { gmail: { enabled: false } }, uploads: 'no' });
    expect(valid).toEqual([]);
    expect(invalid).toEqual(['uploads must be a boolean']);
    await outside({ ...defaultPolicy(), enabled: false });
    expect(valid).toEqual([[false, false]]); // valid, and not the background's own write
    // An own write, with a custom site (an object the stored copy returns with its keys reordered): still its own.
    await setPolicy({ ...defaultPolicy(), enabled: true, customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }] });
    expect(valid.at(-1)).toEqual([true, true]);
    expect(typeof store.policyNonce).toBe('string');
    await set_other_keys();
    expect(valid).toHaveLength(2);
    async function set_other_keys() { await (chrome.storage.local.set as (o: Record<string, unknown>) => Promise<void>)({ secrets: { keys: {} } }); }
  });

  // A worker woken by an outside write reads it at startup; only the old value shows what the write lowers.
  it('passes the policy stored before the change, or undefined when there was none', async () => {
    const { outside } = browser();
    const { onPolicyChange, setPolicy } = await import('./policy');
    const olds: unknown[] = [];
    onPolicyChange((_p, _own, old) => olds.push(old?.sites.gmail?.enabled), () => {});
    await setPolicy({ ...defaultPolicy(), sites: { gmail: { enabled: true } } });
    await outside({ ...defaultPolicy(), sites: { gmail: { enabled: false } } });
    expect(olds).toEqual([undefined, true]);
  });

  it('never takes an outside write for its own: not a replay of an unchanged own policy, not one carrying a copied or fresh nonce', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, outside } = browser();
    const { onPolicyChange, setPolicy } = await import('./policy');
    const seen: unknown[] = [];
    onPolicyChange((p, own) => seen.push([p.enabled, own]), () => {});
    const off = { ...defaultPolicy(), enabled: false };
    await setPolicy(off);                      // own
    await setPolicy(off);                      // own, unchanged: Chrome reports the nonce alone, nothing to apply
    await setPolicy({ ...defaultPolicy(), enabled: true });
    expect(seen).toEqual([[false, true], [true, true]]);
    await outside(off);                        // a replay: the same content as an earlier own write
    expect(seen.at(-1)).toEqual([false, false]);
    await setPolicy({ ...defaultPolicy(), enabled: true });
    await outside(off, { policyNonce: store.policyNonce }); // the stored nonce, copied
    expect(seen.at(-1)).toEqual([false, false]);
    await setPolicy({ ...defaultPolicy(), enabled: true });
    await outside(off, { policyNonce: 'made-up' });
    expect(seen.at(-1)).toEqual([false, false]);
  });
  it('setPolicy keeps the report about a repair when asked (the repaired policy being written back)', async () => {
    const store: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { local: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: Record<string, unknown>) => { Object.assign(store, o); } } } });
    const { setPolicy } = await import('./policy');
    const { health } = await import('./storage-health');
    health.policy = 'had an invalid value'; health.policyRepaired = 'uploads';
    await setPolicy(defaultPolicy(), { keepReport: true });
    expect(health.policyRepaired).toBe('uploads');
    await setPolicy(defaultPolicy());
    expect(health.policyRepaired).toBeUndefined();
  });
});

describe('the Pro account\'s site list in a stored policy (normalizeManaged)', () => {
  const good = { version: 3, fetchedAt: 5, sites: { gmail: { enabled: true }, notyet: { enabled: true }, linear: { enabled: 'yes' } }, customSites: [{ id: 'tools.example.net', name: 'Tools', domains: ['tools.example.net'], enabled: true, extra: 1 }] };
  it('keeps a well-formed list, with only the built-in ids this version knows', () => {
    expect(normalizeManaged(good)).toEqual({ version: 3, fetchedAt: 5, sites: { gmail: { enabled: true }, linear: { enabled: false } }, customSites: [{ id: 'tools.example.net', name: 'Tools', domains: ['tools.example.net'], enabled: true }] });
    expect(normalizePolicy({ ...defaultPolicy(), managed: good }).managed?.version).toBe(3);
  });
  it('drops a malformed list rather than reject the policy', () => {
    for (const bad of [null, 'x', { ...good, version: 0 }, { ...good, version: 1.5 }, { ...good, sites: null }, { ...good, customSites: {} },
      { ...good, customSites: [{ id: 'x.example.com', domains: [], enabled: true }] }, { ...good, customSites: [{ id: 'x.example.com', domains: ['x.example.com'] }] },
      { ...good, customSites: [{ id: 'x.example.com', domains: [7], enabled: true }] }]) {
      expect(normalizeManaged(bad)).toBeUndefined();
      expect('managed' in normalizePolicy({ ...defaultPolicy(), managed: bad })).toBe(false);
    }
  });
  // Without these checks a crafted answer could carry 5,000 sites, a custom `mail.google.com` or an id `gmail` beside
  // the built-in, or `com` and `co.uk`, which guard every host under them.
  it('leaves out a custom site that is not a site of its own, each id once, and refuses a list past 100', () => {
    const site = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, domains: [id], enabled: true, ...extra });
    const m = normalizeManaged({ ...good, customSites: [
      site('tools.example.net'), site('tools.example.net', { name: 'again' }),
      site('mail.google.com'),                                                   // a built-in site's host
      site('gmail', { domains: ['evil.example'] }),                              // a built-in site's id
      site('ok.example.org', { domains: ['ok.example.org', 'calendar.google.com'] }), // one domain a built-in covers
      site('com'), site('co.uk'), site('github.io'),                             // a registry's or a platform's name
      site('localhost'), site('not a host'), site('a..b'),
      site('long.example.org', { name: `  ${'x'.repeat(80)}` }),
    ] });
    expect(m?.customSites.map((c) => c.id)).toEqual(['tools.example.net', 'long.example.org']);
    expect(m?.customSites[0]?.name).toBe('tools.example.net');
    expect(m?.customSites[1]?.name).toBe('x'.repeat(60));
    const many = (n: number) => Array.from({ length: n }, (_, i) => site(`s${i}.example.com`));
    expect(normalizeManaged({ ...good, customSites: many(100) })?.customSites).toHaveLength(100);
    expect(normalizeManaged({ ...good, customSites: many(101) })).toBeUndefined();
    expect(normalizeManaged({ ...good, customSites: [...many(100), site('mail.google.com')] })?.customSites).toHaveLength(100); // left out before the count
  });
});
