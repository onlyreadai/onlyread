// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SettingsLock } from './types';

// The key field's show/hide button as the shared form wires it: the messages to the background and the stored
// secrets are local mocks (dummy values only), so no provider is contacted.
let secrets: { keys?: Record<string, string> };
let saveOk: boolean;
const sent: Message[] = [];

vi.mock('./messaging', () => ({
  send: vi.fn(async (msg: Message) => {
    sent.push(msg);
    if (msg.type === 'policy:get') return { judge: { byok: { id: 'openrouter' } } };
    if (msg.type === 'judge:byok') {
      if (saveOk) secrets = { keys: { ...secrets.keys, [msg.choice.id]: msg.key ?? '' } };
      return saveOk ? { ok: true } : { ok: false, error: 'bad key' };
    }
    return undefined;
  }),
}));

const open: SettingsLock = { agent: false, pinSet: false, pinUnlocked: false };

async function mount() {
  document.body.innerHTML = `
    <div id="byok-tiles"></div><select id="byok-provider"></select>
    <span id="byok-saved" hidden></span><a id="byok-keylink"></a><button id="clear-key" hidden></button>
    <input id="api-key" type="password"><button id="key-reveal" type="button" disabled></button>`;
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ secrets }) } } });
  const { mountByokForm } = await import('./byok-form');
  return mountByokForm();
}
const key = () => document.getElementById('api-key') as HTMLInputElement;
const eye = () => document.getElementById('key-reveal') as HTMLButtonElement;
const typeKey = (v: string) => { key().value = v; key().dispatchEvent(new Event('input')); };
const pick = (id: string) => { const p = document.getElementById('byok-provider') as HTMLSelectElement; p.value = id; p.dispatchEvent(new Event('change')); };

beforeEach(() => { secrets = {}; saveOk = true; sent.length = 0; });

describe('byok form: key show/hide', () => {
  it('shows a key typed during this visit', async () => {
    const form = await mount();
    expect(eye().disabled).toBe(true); // lock not known yet
    form.setLock(open);
    typeKey('dummy-typed');
    eye().click();
    expect(key().type).toBe('text');
    expect(eye().getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a stored key hidden and its button disabled, also after a partial edit', async () => {
    secrets = { keys: { openrouter: 'dummy-saved-key' } };
    const form = await mount();
    form.setLock(open);
    expect(key().value).toBe('dummy-saved-key');
    expect(eye().disabled).toBe(true);
    typeKey('dummy-saved-ke');
    expect(eye().disabled).toBe(true);
    expect(key().type).toBe('password');
  });

  it('goes back to hidden when the provider changes, and a provider with a stored key is not revealable', async () => {
    secrets = { keys: { vercel: 'dummy-saved-vercel' } };
    const form = await mount();
    form.setLock(open);
    typeKey('dummy-typed');
    eye().click();
    expect(key().type).toBe('text');
    pick('vercel');
    expect(key().type).toBe('password');
    expect(key().value).toBe('dummy-saved-vercel');
    expect(eye().disabled).toBe(true);
    pick('openrouter');
    expect(key().value).toBe('');
    expect(eye().disabled).toBe(false);
    expect(key().type).toBe('password');
  });

  it('hides after a failed Save and test and keeps what was typed', async () => {
    saveOk = false;
    const form = await mount();
    form.setLock(open);
    typeKey('dummy-typed');
    eye().click();
    expect(key().type).toBe('text');
    const r = await form.save();
    expect(r.ok).toBe(false);
    expect(key().type).toBe('password');
    expect(key().value).toBe('dummy-typed');
    expect(eye().getAttribute('aria-pressed')).toBe('false');
  });

  it('hides after a passed Save and test, and the key now stored is not revealable', async () => {
    const form = await mount();
    form.setLock(open);
    typeKey('dummy-typed');
    eye().click();
    const r = await form.save();
    expect(r.ok).toBe(true);
    expect(key().type).toBe('password');
    expect(key().value).toBe('dummy-typed'); // loaded back from the (mock) storage
    expect(eye().disabled).toBe(true);
  });

  it('is off, and hides a shown key, once an agent lock appears', async () => {
    const form = await mount();
    form.setLock(open);
    typeKey('dummy-typed');
    eye().click();
    form.setLock({ ...open, agent: true });
    expect(key().type).toBe('password');
    expect(eye().disabled).toBe(true);
  });
});
