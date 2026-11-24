// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsLock } from './types';

// A lock that activates while a freshly typed key is shown: the shared key form (the one the settings page and the
// setup window both mount) with the storage change listener the two pages install through watchLock. The background and
// the stored secrets are local mocks (dummy values only).
const open: SettingsLock = { agent: false, pinSet: false, pinUnlocked: false };
let lockNow: SettingsLock;
let listeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>;

vi.mock('./messaging', () => ({
  send: vi.fn(async (msg: { type: string }) => (msg.type === 'policy:get' ? { judge: { byok: { id: 'openrouter' } } } : undefined)),
}));

async function mountPage() {
  document.body.innerHTML = `
    <div id="byok-tiles"></div><select id="byok-provider"></select>
    <span id="byok-saved" hidden></span><a id="byok-keylink"></a><button id="clear-key" hidden></button>
    <input id="api-key" type="password"><button id="key-reveal" type="button" disabled></button>`;
  vi.stubGlobal('chrome', { storage: {
    local: { get: async () => ({ secrets: {} }) },
    onChanged: { addListener: (fn: (typeof listeners)[number]) => listeners.push(fn) },
  } });
  const { mountByokForm } = await import('./byok-form');
  const { watchLock } = await import('./key-reveal');
  const form = await mountByokForm();
  const read = async () => lockNow; // what the page's status:get returns
  watchLock(form, read);
  form.setLock(open);
  return form;
}
const key = () => document.getElementById('api-key') as HTMLInputElement;
const eye = () => document.getElementById('key-reveal') as HTMLButtonElement;
const flush = () => new Promise((r) => setTimeout(r, 0));
const emit = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area = 'local') => { for (const fn of listeners) fn(changes, area); };

beforeEach(() => { listeners = []; lockNow = open; });

describe('a lock activating while the freshly typed key is shown', () => {
  it.each([
    ['an agent', { ...open, agent: true }, { agentTabs: { oldValue: [], newValue: [7] } }, 'session'],
    ['an agent browser', { ...open, agentBrowser: true }, { agentBrowser: { newValue: { at: 1, account: 'a' } } }, 'local'],
    ['a PIN', { ...open, pinSet: true }, { settingsPin: { newValue: { hash: 'h' } } }, 'local'],
  ])('%s: the key is hidden and reveal disabled before any poll', async (_n, lock, change, area) => {
    await mountPage();
    key().value = 'dummy-key-123';
    key().dispatchEvent(new Event('input'));
    eye().click();
    expect(key().type).toBe('text');
    lockNow = lock as SettingsLock;
    emit(change, area); // the storage change, with no 3-second poll in between
    expect(key().type).toBe('password');
    expect(eye().disabled).toBe(true);
    await flush(); // the status read lands: the lock is known and still holds
    expect(key().type).toBe('password');
    expect(eye().disabled).toBe(true);
    eye().click();
    expect(key().type).toBe('password');
    expect(key().value).toBe('dummy-key-123'); // what was typed is kept
  });

  it('a write that changes nothing leaves a shown key alone', async () => {
    await mountPage();
    key().value = 'dummy-key-123';
    key().dispatchEvent(new Event('input'));
    eye().click();
    emit({ agentTabs: { oldValue: [], newValue: [] } }, 'session');
    expect(key().type).toBe('text');
  });

  it('the button works again once the lock ends', async () => {
    await mountPage();
    key().value = 'dummy-key-123';
    key().dispatchEvent(new Event('input'));
    lockNow = { ...open, agent: true };
    emit({ agentTabs: { oldValue: [], newValue: [7] } }, 'session');
    await flush();
    expect(eye().disabled).toBe(true);
    lockNow = open;
    emit({ agentTabs: { oldValue: [7], newValue: [] } }, 'session');
    await flush();
    expect(eye().disabled).toBe(false);
  });
});

describe('lock reads that settle out of order', () => {
  const later = <T,>() => { let go!: (v: T) => void; const p = new Promise<T>((r) => { go = r; }); return { p, go }; };

  it('an older unlocked read settling after a lock activation does not re-enable reveal', async () => {
    const form = await mountPage();
    key().value = 'dummy-key-123';
    key().dispatchEvent(new Event('input'));
    const poll = later<SettingsLock>();
    const applyPoll = form.beginLockRead(); // a poll starts while unlocked and stalls
    void poll.p.then((l) => applyPoll(l));
    eye().click();
    expect(key().type).toBe('text');
    lockNow = { ...open, agent: true };
    emit({ agentTabs: { oldValue: [], newValue: [7] } }, 'session');
    await flush(); // the newer read lands: locked
    expect(eye().disabled).toBe(true);
    poll.go(open); // the stale unlocked answer arrives last
    await flush();
    expect(eye().disabled).toBe(true);
    expect(key().type).toBe('password');
  });

  it('an older locked read settling after a newer unlocked read is dropped too, and a failed newest read is unknown', async () => {
    const form = await mountPage();
    key().value = 'dummy-key-123';
    key().dispatchEvent(new Event('input'));
    const older = form.beginLockRead();
    const newer = form.beginLockRead();
    newer(open);
    expect(eye().disabled).toBe(false);
    older({ ...open, agent: true });
    expect(eye().disabled).toBe(false); // only the newest read applies
    const newest = form.beginLockRead();
    newer(open); // an older result cannot override the newest, still pending
    newest(undefined); // newest failed: unknown, so locked
    expect(eye().disabled).toBe(true);
  });

  it('the PIN unlock running out hides the key and disables reveal on the page, before any poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const until = Date.now() + 60_000;
      lockNow = { ...open, pinSet: true, pinUnlocked: true, pinUnlockedUntil: until };
      const form = await mountPage();
      form.setLock(lockNow);
      key().value = 'dummy-key-123';
      key().dispatchEvent(new Event('input'));
      eye().click();
      expect(key().type).toBe('text');
      vi.advanceTimersByTime(60_000);
      expect(key().type).toBe('password');
      expect(eye().disabled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
