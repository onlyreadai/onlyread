import { describe, expect, it } from 'vitest';
import type { Policy } from '../shared/types';
import { defaultPolicy, normalizePolicy } from './policy';
import { PIN_ITERATIONS, hashPin, lockFor, messageAllowed, needsRehash, pinMatches, storageLowering, validPin, weakeningChanges } from './protection';

const base = (): Policy => normalizePolicy({
  ...defaultPolicy(), enabled: true, mode: 'enforce', attachWhen: 'always', uploads: false, websockets: 'block',
  sites: { gmail: { enabled: true } },
  customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com', 'api.example.com'], enabled: true }],
});
const change = (patch: (p: Policy) => void): string[] => { const next = structuredClone(base()); patch(next); return weakeningChanges(base(), next); };

describe('weakeningChanges', () => {
  it('finds nothing in an unchanged policy', () => {
    expect(weakeningChanges(base(), base())).toEqual([]);
  });
  it('names each way protection is lowered', () => {
    expect(change((p) => { p.enabled = false; })).toEqual(['turn protection off']);
    expect(change((p) => { p.mode = 'monitor'; })).toEqual(['switch to monitor mode']);
    expect(change((p) => { p.attachWhen = 'agent-session'; })).toEqual(['guard only during agent sessions']);
    expect(change((p) => { p.attachScope = 'target-tabs'; })).toEqual(["hold only the guarded sites' own tabs"]);
    expect(change((p) => { p.sites.gmail = { enabled: false }; })).toEqual(['switch gmail off']);
    expect(change((p) => { p.customSites = []; })).toEqual(['remove app.example.com']);
    expect(change((p) => { p.customSites[0]!.enabled = false; })).toEqual(['switch app.example.com off']);
    expect(change((p) => { p.customSites[0]!.domains = ['app.example.com']; })).toEqual(["guard fewer of app.example.com's domains"]);
    expect(change((p) => { p.uploads = true; })).toEqual(['allow file uploads']);
    expect(change((p) => { p.websockets = 'allow'; })).toEqual(['allow WebSockets']);
    expect(weakeningChanges({ ...base(), allowReadTracking: false }, { ...base(), allowReadTracking: true })).toEqual(['allow read-tracking writes']);
    expect(change((p) => { p.allowReadTracking = false; })).toEqual([]); // refusing them raises protection
    expect(change((p) => { p.opaqueToReview = false; })).toEqual(['stop reviewing unreadable request bodies']);
    expect(change((p) => { p.judge = { ...p.judge, byok: { id: 'vercel' } }; })).toEqual(['change the AI judge']);
    expect(change((p) => { p.cloud = { ...p.cloud, serviceUrl: 'https://elsewhere.example' }; })).toEqual(['change the OnlyRead Pro service']);
  });
  it('lets protection be raised', () => {
    const off = structuredClone(base()); off.enabled = false; off.sites.gmail = { enabled: false }; off.attachWhen = 'agent-session';
    expect(weakeningChanges(off, base())).toEqual([]);
    expect(change((p) => { p.reviewBand = 'block'; })).toEqual([]);
    expect(change((p) => { p.customSites.push({ id: 'new.example.com', name: 'New', domains: ['new.example.com'], enabled: true }); })).toEqual([]);
  });
});

// The account's list is guarded together with this browser's own (sites.ts sitesInForce), so
// only a site no list guards any more is a lowering.
describe('weakeningChanges with the Pro account\'s site list (cloud-sync.ts)', () => {
  const managedList = (sites: Record<string, boolean>, customSites: Policy['customSites'] = []) =>
    ({ version: 2, fetchedAt: 1, sites: Object.fromEntries(Object.entries(sites).map(([id, on]) => [id, { enabled: on }])), customSites });
  const withList = (p: Policy, m: ReturnType<typeof managedList> | undefined): Policy => normalizePolicy({ ...p, managed: m });
  const TOOLS = { id: 'tools.example.net', name: 'T', domains: ['tools.example.net'], enabled: true };

  it('a list that leaves out a local site lowers nothing when management is switched on: the local site stays guarded', () => {
    expect(weakeningChanges(base(), withList(base(), managedList({ linear: true })))).toEqual([]);
    expect(weakeningChanges(base(), withList(base(), managedList({ gmail: false })))).toEqual([]);
  });
  it('names a site only the account guards when the account switches it off or removes it', () => {
    const on = withList(base(), managedList({ gmail: true, linear: true }, [TOOLS]));
    expect(weakeningChanges(on, withList(base(), managedList({ gmail: true, linear: false }, [TOOLS])))).toEqual(['switch linear off']);
    expect(weakeningChanges(on, withList(base(), managedList({ gmail: true, linear: true })))).toEqual(['remove tools.example.net']);
    expect(weakeningChanges(on, withList(base(), managedList({ gmail: true, linear: true }, [{ ...TOOLS, enabled: false }])))).toEqual(['switch tools.example.net off']);
  });
  it('names nothing when the account drops a site this browser guards too', () => {
    const on = withList(base(), managedList({ gmail: true }, [{ ...base().customSites[0]!, name: 'App' }]));
    expect(weakeningChanges(on, withList(base(), managedList({ gmail: false })))).toEqual([]);
  });
  it('names the sites only the account guarded when the list goes (switched off, signed out, lapsed)', () => {
    const on = withList(base(), managedList({ gmail: true, linear: true }, [TOOLS]));
    expect(weakeningChanges(on, withList(on, undefined))).toEqual(['switch linear off', 'remove tools.example.net']);
  });
  it('names a local site switched off or removed only when the account does not guard it', () => {
    const on = withList(base(), managedList({ gmail: true }, [{ ...base().customSites[0]! }]));
    expect(weakeningChanges(on, normalizePolicy({ ...on, sites: { gmail: { enabled: false } }, customSites: [] }))).toEqual([]);
    const linear = withList(normalizePolicy({ ...base(), sites: { gmail: { enabled: true }, linear: { enabled: true } } }), managedList({ gmail: true }));
    expect(weakeningChanges(linear, normalizePolicy({ ...linear, sites: { gmail: { enabled: false }, linear: { enabled: false } } }))).toEqual(['switch linear off']);
  });
  it('lets a list raise protection', () => {
    expect(weakeningChanges(base(), withList(base(), managedList({ gmail: true, linear: true }, [TOOLS])))).toEqual([]);
  });
  // The union sees gmail still guarded here; every other browser on the account loses it once the edit is sent.
  it('names a new removal from the account\'s list even while this browser\'s own list still guards the site', () => {
    const on = withList(base(), managedList({ gmail: true }));
    const remove = { op: 'remove' as const, scope: 'account' as const, id: 'gmail', builtin: true, at: 5 };
    const queued = normalizePolicy({ ...on, accountEdits: [remove] });
    expect(weakeningChanges(on, queued)).toEqual(['remove gmail from your Pro account']);
    expect(weakeningChanges(queued, queued)).toEqual([]); // already waiting: not new
    expect(weakeningChanges(on, normalizePolicy({ ...on, accountEdits: [{ ...remove, scope: 'browser' }] }))).toEqual([]);
  });
});

describe('lockFor', () => {
  const free = { agentActive: false, pinSet: false, pinUnlocked: false };
  it('allows anything that does not weaken protection, even with an agent active', () => {
    expect(lockFor([], { ...free, agentActive: true, pinSet: true })).toBeUndefined();
  });
  it('refuses a weakening change while an agent is active, PIN or not', () => {
    expect(lockFor(['turn protection off'], { ...free, agentActive: true, pinSet: true, pinUnlocked: true })?.reason).toBe('agent');
    expect(lockFor(['turn protection off'], { ...free, agentActive: true })?.message).toMatch(/AI agent is active.*turn protection off/);
  });
  it('refuses a weakening change in a browser that belongs to an agent, PIN entered or not, and says how to release it', () => {
    const r = lockFor(['switch gmail off'], { ...free, agentActive: true, agentBrowser: true, pinSet: true, pinUnlocked: true });
    expect(r?.reason).toBe('agent');
    expect(r?.message).toMatch(/belongs to an AI agent.*switch gmail off.*account page in your own browser/);
  });
  it('asks for the PIN when one is set and not entered', () => {
    expect(lockFor(['switch gmail off'], { ...free, pinSet: true })).toEqual({ reason: 'pin', message: 'Enter your settings PIN to switch gmail off.' });
    expect(lockFor(['switch gmail off'], { ...free, pinSet: true, pinUnlocked: true })).toBeUndefined();
  });
  it('allows a weakening change with no agent and no PIN', () => {
    expect(lockFor(['switch gmail off'], free)).toBeUndefined();
  });
});

describe('settings PIN', () => {
  it('accepts 4 to 12 digits only', () => {
    expect(validPin('1234')).toBe(true);
    expect(validPin('123456789012')).toBe(true);
    expect(validPin('123')).toBe(false);
    expect(validPin('12a4')).toBe(false);
    expect(validPin(1234)).toBe(false);
  });
  it('stores a salted hash, not the PIN, and checks it', async () => {
    const stored = await hashPin('482913');
    expect(JSON.stringify(stored)).not.toContain('482913');
    expect(await pinMatches('482913', stored)).toBe(true);
    expect(await pinMatches('482914', stored)).toBe(false);
    expect(await pinMatches('482913', undefined)).toBe(false);
    expect((await hashPin('482913')).hash).not.toBe(stored.hash); // a new salt each time
  });
  it('stretches the hash with PBKDF2, and still accepts the single-round hash of older versions, marked for a re-hash', async () => {
    const stored = await hashPin('4829');
    expect(stored.iterations).toBe(PIN_ITERATIONS);
    expect(needsRehash(stored)).toBe(false);
    const salt = 'legacy-salt';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:4829`));
    const legacy = { salt, hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
    expect(await pinMatches('4829', legacy)).toBe(true);
    expect(await pinMatches('4828', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });
});

describe('messageAllowed', () => {
  const own = { id: 'onlyread', origin: 'chrome-extension://onlyread/' };
  it('lets OnlyRead\'s own pages send anything', () => {
    for (const url of ['chrome-extension://onlyread/popup.html', 'chrome-extension://onlyread/options.html']) {
      expect(messageAllowed('guard:set', { id: 'onlyread', url }, own)).toBe(true);
      expect(messageAllowed('policy:set', { id: 'onlyread', url }, own)).toBe(true);
    }
  });
  it('lets the content script (inside web pages) send only its own few messages', () => {
    const page = { id: 'onlyread', url: 'https://mail.google.com/mail/u/0/' };
    for (const t of ['ui:action', 'secret:typed', 'guard:config', 'page:closing', 'settings:open']) expect(messageAllowed(t, page, own)).toBe(true);
    for (const t of ['guard:set', 'policy:set', 'policy:get', 'site:set', 'site:remove', 'mode:set', 'cache:clear', 'pin:clear', 'judge:byok', 'activity:get', 'audit:list']) {
      expect(messageAllowed(t, page, own)).toBe(false);
    }
  });
  it('refuses another extension, even for the content script\'s messages', () => {
    expect(messageAllowed('ui:action', { id: 'other', url: 'chrome-extension://other/x.html' }, own)).toBe(false);
  });
});

// Storage keys besides the policy that hold up protection, written around the background.
describe('storageLowering', () => {
  const none = { agentBrowser: false };
  const pin = { salt: 's', hash: 'h', iterations: 1 };
  it('names removing, changing and (by an agent) setting the settings PIN; leaves an unchanged one', () => {
    expect(storageLowering('settingsPin', pin, undefined, none)).toBe('remove the settings PIN');
    expect(storageLowering('settingsPin', pin, null, none)).toBe('remove the settings PIN');
    expect(storageLowering('settingsPin', pin, { ...pin, hash: 'x' }, none)).toBe('change the settings PIN');
    expect(storageLowering('settingsPin', undefined, pin, none)).toBe('set a settings PIN');
    expect(storageLowering('settingsPin', pin, { ...pin }, none)).toBeUndefined();
  });
  it("names replacing or removing a judge key, never adding a first one", () => {
    expect(storageLowering('secrets', undefined, { keys: { openrouter: 'k1' } }, none)).toBeUndefined();
    expect(storageLowering('secrets', { keys: { openrouter: 'k1' } }, { keys: { openrouter: 'k1', vercel: 'v' } }, none)).toBeUndefined();
    expect(storageLowering('secrets', { keys: { openrouter: 'k1' } }, { keys: { openrouter: 'k2' } }, none)).toBe("replace the AI judge's key");
    expect(storageLowering('secrets', { keys: { openrouter: 'k1' } }, { keys: {} }, none)).toBe("remove the AI judge's key");
    expect(storageLowering('secrets', { keys: { openrouter: 'k1' } }, undefined, none)).toBe("remove the AI judge's key");
  });
  it('names a lowered wrong-PIN count, not a raised one', () => {
    expect(storageLowering('pinFailures', { count: 6, retryAt: 9 }, { count: 0, retryAt: 0 }, none)).toBe('reset the wrong-PIN count');
    expect(storageLowering('pinFailures', { count: 6, retryAt: 9 }, undefined, none)).toBe('reset the wrong-PIN count');
    expect(storageLowering('pinFailures', { count: 1, retryAt: 0 }, { count: 2, retryAt: 0 }, none)).toBeUndefined();
  });
  it("names clearing the agent-browser mark, and any change to the Pro tokens only in an agent's browser", () => {
    expect(storageLowering('agentBrowser', { at: 1, account: 'a' }, undefined, none)).toBe('release this browser from its AI agent');
    expect(storageLowering('agentBrowser', undefined, { at: 1, account: 'a' }, none)).toBeUndefined();
    const t = { accessToken: 'a', refreshToken: 'r', expiresAt: 1 };
    expect(storageLowering('cloudTokens', t, undefined, none)).toBeUndefined();
    expect(storageLowering('cloudTokens', t, undefined, { agentBrowser: true })).toBe('sign out of OnlyRead Pro');
    // In an agent's browser the sign-in is the setup link's: one written from outside (another account's) is refused.
    expect(storageLowering('cloudTokens', undefined, t, { agentBrowser: true })).toBe('change the OnlyRead Pro sign-in');
    expect(storageLowering('cloudTokens', t, { ...t, accessToken: 'b' }, { agentBrowser: true })).toBe('change the OnlyRead Pro sign-in');
    expect(storageLowering('cloudTokens', t, { ...t }, { agentBrowser: true })).toBeUndefined();
    expect(storageLowering('cloudTokens', undefined, t, none)).toBeUndefined(); // elsewhere a sign-in raises
    expect(storageLowering('cloudTokens', t, { ...t, accessToken: 'b' }, none)).toBeUndefined();
  });
  it('names writing the setup\'s undo record, not erasing it', () => {
    expect(storageLowering('agentSetup', undefined, { at: 1, sites: ['gmail'] }, none)).toBe("change the AI agent setup's undo record");
    expect(storageLowering('agentSetup', { at: 1, sites: [] }, { at: 1, sites: ['gmail'] }, none)).toBe("change the AI agent setup's undo record");
    expect(storageLowering('agentSetup', { at: 1, sites: [] }, undefined, none)).toBeUndefined();
  });
});
