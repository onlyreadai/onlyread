// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SiteView, Status } from '../shared/types';

// The popup as it runs: its own markup (popup.html) in a simulated document, over a fake chrome whose background
// answers `sites:list` and `status:get` from `answers` and every change with `answers.reply`, recording what was sent;
// like content/actions.test.ts for the content script. The popup refreshes on its own every three seconds, which the
// fake clock advances. Covers the popup's row rendering, the scope of "Guard this site", the account-only switch, and
// a refusal from the Pro account with no lock held.
const sent: Message[] = [];
const answers: { sites: SiteView[]; status: Status; reply: unknown } = { sites: [], status: status(), reply: [] };

function status(over: Partial<Status> = {}): Status {
  return {
    version: '0', extensionId: 'id', mode: 'enforce', dynamicRules: 0, targetDomains: [], sites: [], attachedTabs: 0, inFlight: 0, observations: 0, cacheSize: 0,
    judge: 'cloud', failClosed: true, blockResponse: 'fail', enabled: true, attachWhen: 'agent-session', agentSession: false, attachmentActive: false, devBuild: true,
    cloud: { provider: 'cloud', serviceUrl: 'http://localhost:4173/cloud', signedIn: true }, lock: { agent: false, pinSet: false, pinUnlocked: false }, ...over,
  };
}
const view = (over: Partial<SiteView> = {}): SiteView => ({
  id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true, builtin: false, verified: false, current: true, cacheSize: 0, local: true, account: false, ...over,
});

beforeAll(async () => {
  vi.useFakeTimers();
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'popup.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*><\/script>/, '');
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'onlyread',
      connect: () => ({}),
      openOptionsPage: () => {},
      getURL: (p: string) => `chrome-extension://id${p}`,
      sendMessage: async (msg: Message) => {
        if (msg.type === 'sites:list') return answers.sites;
        if (msg.type === 'status:get') return answers.status;
        sent.push(msg);
        return answers.reply;
      },
    },
    tabs: {
      query: async () => [{ id: 1, active: true, url: 'https://app.example.com/inbox', title: 'Inbox' }],
      sendMessage: async () => ({ title: 'Inbox', siteName: 'App' }),
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
  });
  await import('./popup');
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The popup's next refresh (its three-second tick), rendered. */
async function refreshed(): Promise<void> {
  await vi.advanceTimersByTimeAsync(3000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
const row = () => document.querySelector('#current .site') as HTMLElement;
const click = (sel: string) => { row().querySelector<HTMLElement>(sel)!.click(); };
const flip = (checked: boolean) => {
  const input = row().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
const subs = () => [...row().querySelectorAll('.actions .sub')].map((e) => e.textContent);

beforeEach(async () => {
  sent.length = 0;
  answers.reply = [];
  answers.status = status();
});

describe('"Guard this site" on a page OnlyRead does not know', () => {
  it('guards it in this browser, with no choice of scope, signed in to Pro or not', async () => {
    for (const signedIn of [false, true]) {
      answers.sites = [];
      answers.status = status({ cloud: { provider: 'cloud', serviceUrl: '', signedIn } });
      await refreshed();
      expect(row().querySelector('select')).toBeNull();
      click('#guard');
      await refreshed();
      expect(sent.at(-1)).toEqual({ type: 'site:add', host: 'app.example.com', name: 'App', iconUrl: undefined });
    }
  });

  // The account's refusal is kept apart from the lock's, which render() clears whenever no agent works and no PIN
  // holds.
  it('shows why the Pro account was not changed, with no lock held and under the lock alike, until a change goes through', async () => {
    answers.sites = [view({ local: false, account: true })];
    await refreshed();
    answers.reply = { ok: false, error: 'Sign in to OnlyRead Pro to change your account\'s sites.' };
    flip(false);
    await refreshed();
    const note = document.getElementById('note')!;
    expect(note.hidden).toBe(false);
    expect(document.getElementById('note-text')!.textContent).toBe('Sign in to OnlyRead Pro to change your account\'s sites.');
    expect(document.getElementById('lock')!.hidden).toBe(true);
    // It stays over the popup's own refreshes, and beside the lock's sentence when an agent starts.
    await refreshed();
    expect(note.hidden).toBe(false);
    answers.status = status({ lock: { agent: true, pinSet: false, pinUnlocked: false } });
    await refreshed();
    expect(note.hidden).toBe(false);
    expect(document.getElementById('lock')!.hidden).toBe(false);
    expect(document.getElementById('lock-text')!.textContent).toMatch(/^An AI agent is active/);
    // A change that goes through clears it.
    answers.status = status();
    answers.reply = [view({ enabled: false, local: false, account: false })];
    flip(false);
    await refreshed();
    expect(note.hidden).toBe(true);
    expect(document.getElementById('note-text')!.textContent).toBe('');
  });
});

describe('a site OnlyRead knows', () => {
  // The account's sites change only on the account page: here the switch is fixed, with a line saying where.
  it('a row the Pro account guards is fixed here and says where it is managed; a row this browser guards alone changes this browser', async () => {
    for (const local of [false, true]) {
      answers.sites = [view({ local, account: true })];
      await refreshed();
      expect(row().querySelector('.state')).toBeNull(); // no state line: the switch says it
      expect(subs()).toEqual(['On', 'Managed on your Pro account page']);
      expect(row().querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    }
    answers.sites = [view({ local: true, account: false })];
    await refreshed();
    expect(subs()).toEqual(['On']);
    flip(false);
    await refreshed();
    expect(sent.at(-1)).toEqual({ type: 'site:set', id: 'app.example.com', enabled: false, host: 'app.example.com' });
    // Switched off (nowhere guarded), the account line is not shown either.
    answers.sites = [view({ enabled: false, local: false, account: false })];
    await refreshed();
    expect(subs()).toEqual(['Off']);
  });

  // Pro mode (a Pro judge, signed in, the account's lists in force): the switch changes the account's lists.
  it('in Pro mode a site on the account switches here, with a spinner while its change is on its way and no words', async () => {
    answers.status = status({ managed: { version: 3, at: 1 } });
    answers.sites = [view({ local: false, account: true, scopes: ['account'] })];
    await refreshed();
    expect(row().querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false);
    expect(subs()).toEqual(['On']);
    expect(row().querySelector('.saving')).toBeNull();
    flip(false);
    await refreshed();
    expect(sent.at(-1)).toEqual({ type: 'site:set', id: 'app.example.com', enabled: false, host: 'app.example.com' });
    answers.sites = [view({ local: false, account: true, scopes: ['account'], waiting: true })];
    await refreshed();
    expect(subs()).toEqual(['On']);
    expect(row().querySelector('.saving')?.getAttribute('aria-label')).toBe('Saving to your account');
    // A change the account refused after it was sent is said until a later one is taken.
    answers.status = status({ managed: { version: 3, at: 1 }, accountRefused: 'Your Pro account did not take App: its list is full. It is not guarded.' });
    await refreshed();
    expect(document.getElementById('note')!.hidden).toBe(false);
    expect(document.getElementById('note-text')!.textContent).toMatch(/its list is full/);
  });

  // No AI judge: nothing can be guarded, so the popup is only the way to set one: no site switch, no protection switch,
  // no settings button, no footer. A fresh install is here with protection on, the default.
  for (const enabled of [false, true]) it(`with no AI judge (protection ${enabled ? 'on' : 'off'}), the popup only asks to set one`, async () => {
    answers.sites = [view({ local: true, account: false })];
    answers.status = status({ judgeMissing: true, enabled });
    await refreshed();
    const card = document.querySelector('#current .judge-needed')!;
    expect(card.querySelector('input[type="checkbox"]')).toBeNull();
    expect(card.querySelector('#judge-card-set')?.textContent).toBe('Set up AI judge');
    expect(document.getElementById('enforce')!.hidden).toBe(true);
    expect(document.body.classList.contains('no-judge')).toBe(true);
    expect(document.getElementById('set-judge')).toBeNull();
  });

  it('while an agent works, an on switch is disabled and the lock box says why', async () => {
    answers.sites = [view({ local: false, account: true })];
    answers.status = status({ lock: { agent: true, pinSet: false, pinUnlocked: false } });
    await refreshed();
    expect(row().querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    expect(document.getElementById('lock')!.hidden).toBe(false);
  });
});

describe('a site\'s unguarded part', () => {
  it('names what the site leaves unguarded under its address, and nothing for a site with no such part', async () => {
    answers.sites = [view({ id: 'facebook', name: 'Facebook', domains: ['facebook.com'], outOfScope: ['Messenger (chats and sending messages): not guarded, so messages are delivered even in enforce'] })];
    await refreshed();
    expect(row().querySelector('.excl')?.textContent).toBe('Messenger is not guarded.');
    answers.sites = [view()];
    await refreshed();
    expect(row().querySelector('.excl')).toBeNull();
  });
});
