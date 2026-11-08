// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The notice and the coach card live in closed shadow roots; the tests reach them by keeping roots open here, and
// press their buttons with real (isTrusted) clicks, which happy-dom never makes by itself.
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init: ShadowRootInit) { return attach.call(this, { ...init, mode: 'open' }); };
const trustedClick = (b: HTMLElement) => {
  const ev = new MouseEvent('click', { bubbles: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  b.dispatchEvent(ev);
};

// The content script runs as it does in a page: loaded once into a simulated document with a fake
// chrome.runtime. The background's answer (a guarded site, enforcing, uploads off, editor guard off at first)
// comes from `answers`, and messages the background pushes are delivered through the listeners the script registered.
const sent: { type: string; action?: Record<string, unknown> }[] = [];
const listeners: ((msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown)[] = [];
const answers: Record<string, unknown> = { 'guard:config': { guarded: true, editorGuard: false, holdClose: true, uploadsOff: true } };

const push = (msg: unknown) => { for (const l of listeners) l(msg, {}, () => {}); };
const tick = () => new Promise((r) => setTimeout(r, 0));
// The event types the script listens for on the window as it loads (never `unload`).
const loadListeners: string[] = [];
const notice = () => {
  const host = [...document.documentElement.children].find((e) => e.shadowRoot) as HTMLElement | undefined;
  const root = host?.shadowRoot;
  return {
    visible: host?.style.display === 'block',
    title: root?.querySelector('.title')?.textContent ?? '',
    lines: [...(root?.querySelectorAll('li') ?? [])].map((li) => li.textContent ?? ''),
    checks: [...(root?.querySelectorAll('.check') ?? [])].map((p) => p.textContent ?? ''),
    // A button's name: its words, or the label of an icon.
    buttons: [...(root?.querySelectorAll<HTMLButtonElement>('.acts button') ?? [])].filter((b) => !b.hidden).map((b) => b.textContent || b.getAttribute('aria-label') || ''),
    codes: root?.querySelector<HTMLElement>('.codes') ?? null,
    text: root?.querySelector('.box')?.textContent ?? '',
    click: (label: string) => trustedClick([...(root?.querySelectorAll<HTMLButtonElement>('.acts button') ?? [])].find((b) => (b.textContent || b.getAttribute('aria-label')) === label)!),
  };
};

beforeAll(async () => {
  document.body.innerHTML = '<button id="send">Send</button><input id="pw" type="password" name="pw"><input id="file" type="file" name="doc"><div id="ed" contenteditable="true">Draft</div><div id="pm" class="ProseMirror">A read-only view</div>';
  // happy-dom has no layout, so no elementsFromPoint; the notice uses it to pick light or dark glass.
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [];
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: async (msg: { type: string; action?: Record<string, unknown> }) => {
      sent.push(msg);
      // The guard answer comes a task later, as from the background, so what the script registers as it loads is told
      // from what the answer adds.
      if (msg.type === 'guard:config') await tick();
      return answers[msg.type];
    },
    onMessage: { addListener: (l: (typeof listeners)[number]) => { listeners.push(l); } },
  } });
  const add = window.addEventListener;
  const spy = vi.spyOn(window, 'addEventListener').mockImplementation(function (this: Window, type: string, ...rest: unknown[]) {
    loadListeners.push(type);
    return (add as (...a: unknown[]) => void).call(this, type, ...rest);
  } as typeof window.addEventListener);
  await import('./actions');
  spy.mockRestore();
  await tick();
});

describe('recording what the agent clicks', () => {
  // A browser sets isTrusted only for real input (an agent's CDP clicks are real input); happy-dom never does.
  const click = (id: string, trusted = true) => {
    const ev = new MouseEvent('click', { bubbles: true, composed: true });
    if (trusted) Object.defineProperty(ev, 'isTrusted', { value: true });
    document.getElementById(id)!.dispatchEvent(ev);
  };
  it('sends a click with the control\'s name', () => {
    click('send');
    expect(sent.at(-1)).toMatchObject({ type: 'ui:action', action: { type: 'click', tag: 'button', name: 'Send' } });
  });
  it('marks a password field as sensitive', () => {
    click('pw');
    expect(sent.at(-1)?.action).toMatchObject({ tag: 'input', sensitive: true });
  });
  it('ignores a click a page script made', () => {
    sent.length = 0;
    click('send', false);
    expect(sent).toEqual([]);
  });
});

describe('typed secrets', () => {
  const type = (value: string, trusted: boolean) => {
    const pw = document.getElementById('pw') as HTMLInputElement;
    pw.value = value;
    const ev = new Event('input', { bubbles: true, composed: true });
    // A browser sets isTrusted only for real input; happy-dom never does, so the test sets it.
    if (trusted) Object.defineProperty(ev, 'isTrusted', { value: true });
    pw.dispatchEvent(ev);
  };
  it('sends a password field\'s value under a numbered field id, not its name', () => {
    type('hunter22', true);
    expect(sent.at(-1)).toEqual({ type: 'secret:typed', field: `${location.origin}#0`, value: 'hunter22' });
  });
  it('ignores input a page script dispatched', () => {
    type('planted-word', false);
    expect(sent.some((m) => (m as { value?: string }).value === 'planted-word')).toBe(false);
  });
});

describe('uploads off', () => {
  it('disables file inputs on the page and ones added later', async () => {
    expect((document.getElementById('file') as HTMLInputElement).disabled).toBe(true);
    const later = Object.assign(document.createElement('input'), { type: 'file' });
    document.body.append(later);
    await vi.waitFor(() => expect(later.disabled).toBe(true));
    expect(later.disabled).toBe(true);
  });
  it('swallows a click on a file input the page enabled again, and says why', () => {
    const file = document.getElementById('file') as HTMLInputElement;
    file.disabled = false; // the page's script re-enabled it; a disabled input gets no click at all
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    file.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(notice().title).toBe('Uploads are turned off here');
    file.disabled = true;
  });
});

// The script reports and changes the page only on a guarded site while protection is attached.
describe('a site that is not guarded, or protection off', () => {
  const trustedClick = (id: string) => {
    const ev = new MouseEvent('click', { bubbles: true, composed: true });
    Object.defineProperty(ev, 'isTrusted', { value: true });
    document.getElementById(id)!.dispatchEvent(ev);
  };
  const trustedInput = (value: string) => {
    const pw = document.getElementById('pw') as HTMLInputElement;
    pw.value = value;
    const ev = new Event('input', { bubbles: true, composed: true });
    Object.defineProperty(ev, 'isTrusted', { value: true });
    pw.dispatchEvent(ev);
  };
  it('sends nothing and gives the file inputs back', () => {
    push({ type: 'onlyread:config', guarded: false, editorGuard: false, holdClose: false, uploadsOff: false });
    sent.length = 0;
    trustedClick('send');
    trustedInput('not-for-the-background');
    expect(sent).toEqual([]);
    const file = document.getElementById('file') as HTMLInputElement;
    expect(file.disabled).toBe(false);
    expect(file.dataset.onlyread).toBeUndefined();
  });
  it('reports again, and disables the inputs again, once the site is guarded and enforcing', () => {
    push({ type: 'onlyread:config', guarded: true, editorGuard: false, holdClose: true, uploadsOff: true });
    sent.length = 0;
    trustedClick('send');
    expect(sent.at(-1)).toMatchObject({ type: 'ui:action', action: { type: 'click', name: 'Send' } });
    trustedInput('hunter23');
    expect(sent.at(-1)).toMatchObject({ type: 'secret:typed', value: 'hunter23' });
    expect((document.getElementById('file') as HTMLInputElement).disabled).toBe(true);
  });
  it('sends a password typed while nothing was reported once the site is guarded, but not one a page script set', () => {
    push({ type: 'onlyread:config', guarded: false, editorGuard: false, holdClose: false, uploadsOff: false });
    sent.length = 0;
    trustedInput('typed-before-session');
    (document.getElementById('pw') as HTMLInputElement).value = 'planted-later';
    expect(sent).toEqual([]);
    push({ type: 'onlyread:config', guarded: true, editorGuard: false, holdClose: true, uploadsOff: true });
    expect(sent.filter((m) => m.type === 'secret:typed')).toEqual([{ type: 'secret:typed', field: `${location.origin}#0`, value: 'typed-before-session' }]);
  });
  it('leaves an input the page disabled itself alone when uploads come back', () => {
    const theirs = Object.assign(document.createElement('input'), { type: 'file', disabled: true, id: 'theirs' });
    document.body.append(theirs);
    push({ type: 'onlyread:config', guarded: true, editorGuard: false, holdClose: false, uploadsOff: false });
    expect(theirs.disabled).toBe(true);
    push({ type: 'onlyread:config', guarded: true, editorGuard: false, holdClose: true, uploadsOff: true });
  });
});

describe('the notice for refused writes', () => {
  const dismiss = () => { if (notice().visible) notice().click('Dismiss'); };
  it('says what was kept read-only on which site, one plain line per change, with no codes in view', () => {
    push({ type: 'onlyread:blocked', shape: 'fb:gql:w[useCometUFICreateCommentMutation]', reason: 'cached:label', path: '/api/graphql/', site: 'Facebook' });
    const n = notice();
    expect(n.visible).toBe(true);
    expect(n.title).toBe('OnlyRead kept Facebook read-only');
    expect(n.lines).toEqual(['Stopped a change: Create comment.']);
    expect(n.checks).toEqual([]);
    expect(n.buttons).toEqual(['Details', 'Dismiss']);
    expect(n.codes?.hidden).toBe(true);
    expect(n.text).not.toMatch(/Nice try/);
    expect([n.title, ...n.lines].join(' ')).not.toMatch(/cached:|fb:gql/);
  });
  it('groups a repeat of the same change with a count', () => {
    push({ type: 'onlyread:blocked', shape: 'fb:gql:w[useCometUFICreateCommentMutation]', reason: 'cached:label', path: '/api/graphql/', site: 'Facebook' });
    const n = notice();
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0]).toContain('×2');
  });
  // LinkedIn resends a refused message twice as it was: one message, so no ×3; a different one in the same notice is ×2.
  it('counts a request the page sends again as it was once', () => {
    dismiss();
    const send = (sig: string) => push({ type: 'onlyread:blocked', shape: 'li:msg:w[send]', reason: 'decoded-write', path: '/m', site: 'LinkedIn', sig });
    send('a1'); send('a1'); send('a1');
    expect(notice().lines).toEqual(['Stopped a change: Send.']);
    send('b2');
    expect(notice().lines[0]).toContain('×2');
    dismiss();
    send('a1'); // a new notice counts afresh
    expect(notice().lines).toEqual(['Stopped a change: Send.']);
    dismiss();
  });
  it('names a change it cannot name by its site, and shows at most three kinds, dropping the oldest', () => {
    push({ type: 'onlyread:blocked', shape: 'json:title', reason: 'p>block', path: '/api/v2/items/123', site: 'Facebook' });
    expect(notice().lines.at(-1)).toBe('Stopped a change on Facebook.');
    push({ type: 'onlyread:blocked', shape: 'li:rsc:w[sharing.CreatePost]', reason: 'decoded-write', path: '/a' });
    push({ type: 'onlyread:blocked', shape: 'li:rsc:w[update.deletePost]', reason: 'decoded-write', path: '/b' });
    const n = notice();
    expect(n.lines).toHaveLength(3);
    expect(n.lines.join(' ')).not.toContain('Create comment');
    // No site in the message: the page's own host.
    expect(n.title).toBe(`OnlyRead kept ${location.hostname.replace(/^www\./, '')} read-only`);
  });
  it('reveals the internal codes under Details, and Dismiss hides the notice', () => {
    notice().click('Details');
    expect(notice().codes?.hidden).toBe(false);
    expect(notice().codes?.textContent).toContain('li:rsc:w[update.deletePost] · decoded-write');
    expect(notice().buttons).toContain('Hide details');
    notice().click('Dismiss');
    expect(notice().visible).toBe(false);
  });
  it('shows the report icon with the details, and it opens the report dialog for a refusal that was a mistake', () => {
    dismiss();
    push({ type: 'onlyread:blocked', shape: 'gql:mutation:IssueUpdate', reason: 'decoded-write', path: '/graphql', site: 'Linear' });
    expect(notice().buttons).not.toContain('Report a mistake');
    notice().click('Details');
    expect(notice().buttons).toEqual(['Hide details', 'Dismiss', 'Report a mistake']);
    sent.length = 0;
    notice().click('Report a mistake');
    expect(sent).toContainEqual({ type: 'settings:open', section: 'support' });
    expect(notice().visible).toBe(false);
  });
  it('keeps a request stopped only because Pro could not check it apart, with the fix that opens the settings', () => {
    dismiss();
    push({ type: 'onlyread:blocked', shape: 'gql:mutation:UserSettingsUpdate', reason: 'cached:label', path: '/graphql', site: 'Linear' });
    push({ type: 'onlyread:blocked', shape: 'gql:query:Flags', reason: 'judge-error:cloud:not_signed_in', path: '/graphql', site: 'Linear' });
    const n = notice();
    expect(n.title).toBe('OnlyRead kept Linear read-only');
    expect(n.lines).toEqual(['Stopped a change: User settings update.']);
    expect(n.checks).toEqual(["1 request was stopped because OnlyRead Pro is signed out and couldn't check it. Some of the page may not load."]);
    expect(n.buttons).toEqual(['Sign in to Pro', 'Details', 'Dismiss']);
    expect([n.title, ...n.lines, ...n.checks].join(' ')).not.toMatch(/judge-error|cached:|gql:/);
    sent.length = 0;
    // A page script pressing it does nothing: only real input opens OnlyRead's settings.
    const root = [...document.documentElement.children].find((e) => e.shadowRoot)?.shadowRoot;
    [...(root?.querySelectorAll<HTMLButtonElement>('.acts button') ?? [])].find((b) => b.textContent === 'Sign in to Pro')!.click();
    expect(sent).not.toContainEqual({ type: 'settings:open', section: 'ai-judge' });
    n.click('Sign in to Pro');
    expect(sent).toContainEqual({ type: 'settings:open', section: 'ai-judge' });
    expect(notice().visible).toBe(false);
  });
  it('says OnlyRead Pro\'s own words for refusing to check a request', () => {
    push({ type: 'onlyread:blocked', shape: 'json:q', reason: 'judge-error:cloud:subscription_inactive', path: '/x', site: 'App', explain: 'Your trial ended. Subscribe to keep using Pro.' });
    expect(notice().checks).toEqual(['1 request was stopped: Your trial ended. Subscribe to keep using Pro. Some of the page may not load.']);
    notice().click('Dismiss');
  });
  it('offers no fix for a check that failed for another reason', () => {
    push({ type: 'onlyread:blocked', shape: 'json:q', reason: 'judge-timeout', path: '/x', site: 'App' });
    push({ type: 'onlyread:blocked', shape: 'json:q', reason: 'judge-timeout', path: '/x', site: 'App' });
    const n = notice();
    expect(n.lines).toEqual([]);
    expect(n.checks).toEqual(["2 requests were stopped because the AI judge didn't answer in time. Some of the page may not load."]);
    expect(n.buttons).toEqual(['Details', 'Dismiss']);
    dismiss();
  });
  // Development builds send each refused request's method and address; a release's notice never has them (above).
  it('copies the refused requests of the page, past a dismissed notice, in a development build', async () => {
    const copied: string[] = [];
    const real = navigator;
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => { copied.push(t); } } });
    push({ type: 'onlyread:blocked', shape: 'json:until', reason: 'cached:label', path: '/b', site: 'LinkedIn', request: 'POST https://www.linkedin.com/b?action=markAllMessagesAsSeen' });
    dismiss();
    push({ type: 'onlyread:blocked', shape: 'gql:w', reason: 'cached:label', path: '/g', site: 'LinkedIn', request: 'POST https://www.linkedin.com/g?queryId=x' });
    expect(notice().buttons).toEqual(['Details', 'Dismiss', 'Copy requests (2)']); // the last is a copy icon
    notice().click('Copy requests (2)');
    await tick();
    expect(copied).toEqual(['POST https://www.linkedin.com/b?action=markAllMessagesAsSeen · json:until · cached:label\nPOST https://www.linkedin.com/g?queryId=x · gql:w · cached:label']);
    expect(notice().buttons).toContain('Copied');
    // Where the page refuses the clipboard, the requests are shown, selected, to copy by hand.
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    notice().click('Copied');
    await tick();
    expect(notice().codes?.hidden).toBe(false);
    expect(notice().codes?.textContent).toContain('queryId=x');
    vi.stubGlobal('navigator', real);
    dismiss();
  });
  // The search for the page's own toast costs hit tests: it runs for a few seconds after a refusal, not for as long as
  // the notice shows.
  it('looks for the page\'s toast only for a few seconds after a refusal', () => {
    vi.useFakeTimers();
    const doc = document as unknown as { elementsFromPoint: () => Element[] };
    const was = doc.elementsFromPoint;
    let looks = 0;
    doc.elementsFromPoint = () => { looks++; return []; };
    try {
      dismiss();
      push({ type: 'onlyread:blocked', shape: 'li:msg:w[send]', reason: 'decoded-write', path: '/m', site: 'LinkedIn', sig: 'w1' });
      vi.advanceTimersByTime(2_000);
      const during = looks;
      expect(during).toBeGreaterThan(0);
      vi.advanceTimersByTime(1_500); // past the window, the notice still showing
      const after = looks;
      vi.advanceTimersByTime(2_000);
      expect(notice().visible).toBe(true);
      expect(looks).toBe(after);
    } finally {
      doc.elementsFromPoint = was;
      dismiss();
      vi.useRealTimers();
    }
  });
  // No z-index is above a modal dialog and its backdrop (LinkedIn's message box dimmed the notice under it): the notice
  // goes to the top layer as the newest there, inside the modal while one is open (everything outside it is inert).
  it('shows above a modal dialog, inside it, and moves back out to the page when the dialog closes', () => {
    const host = () => document.querySelector<HTMLElement>('[data-onlyread=notice]')!;
    const shown: (Element | null)[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const had = { show: proto.showPopover, hide: proto.hidePopover };
    proto.showPopover = function (this: HTMLElement) { shown.push(this.parentElement); };
    proto.hidePopover = () => {};
    const dialog = document.createElement('dialog');
    const matches = dialog.matches.bind(dialog);
    let modal = true;
    Object.defineProperty(dialog, 'matches', { value: (s: string) => (s === ':modal' && modal) || matches(s) });
    document.body.append(dialog);
    try {
      push({ type: 'onlyread:blocked', shape: 'li:rsc:w[messenger.batchCreateMessages]', reason: 'decoded-write', path: '/a', site: 'LinkedIn' });
      expect(host().getAttribute('popover')).toBe('manual');
      expect(host().parentElement).toBe(dialog);
      expect(shown).toEqual([dialog]);
      // The page closes its dialog while the notice shows: the notice moves out to the page, still showing.
      modal = false;
      dialog.dispatchEvent(new Event('close'));
      expect(host().parentElement).toBe(document.documentElement);
      expect(host().style.display).toBe('block');
      expect(shown).toEqual([dialog, document.documentElement]);
      dialog.remove();
    } finally {
      proto.showPopover = had.show; proto.hidePopover = had.hide;
      dismiss();
    }
  });
});

describe('the editor guard', () => {
  const editor = () => document.getElementById('ed')!;

  it('locks editors when the background says this site is guarded', () => {
    push({ type: 'onlyread:config', editorGuard: true });
    expect(editor().getAttribute('contenteditable')).toBe('false');
    expect(document.getElementById('pm')!.getAttribute('contenteditable')).toBe('false');
  });
  it('forces an editor back to locked when the app re-enables it', async () => {
    editor().setAttribute('contenteditable', 'true');
    await tick();
    expect(editor().getAttribute('contenteditable')).toBe('false');
  });
  it('swallows typing inside a locked editor and tells the person why', () => {
    const typing = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    editor().dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(true);
    expect(notice().title).toBe('Editing is turned off here');
  });
  it('lets navigation and copy keys through', () => {
    for (const init of [{ key: 'ArrowDown' }, { key: 'c', metaKey: true }, { key: 'Tab' }]) {
      const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      editor().dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
  });
  it('unlocks the editors when the guard is switched off, each as it was (a read-only view stays read-only)', () => {
    push({ type: 'onlyread:config', editorGuard: false });
    expect(editor().getAttribute('contenteditable')).toBe('true');
    expect(document.getElementById('pm')!.hasAttribute('contenteditable')).toBe(false);
    const typing = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    editor().dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
  });
});

describe('a closing page', () => {
  const close = () => {
    const seen: string[] = [];
    const page = (name: string) => () => seen.push(name);
    addEventListener('pagehide', page('pagehide'));
    document.addEventListener('visibilitychange', page('visibilitychange'));
    addEventListener('unload', page('unload'));
    for (const t of ['pagehide', 'visibilitychange', 'unload']) (t === 'visibilitychange' ? document : window).dispatchEvent(new Event(t, { bubbles: true }));
    return seen;
  };
  it('lets the page\'s close handlers run when its writes are not refused', () => {
    expect(close()).toEqual(['pagehide', 'visibilitychange', 'unload']);
  });
  it('stops them on a guarded page and tells the background the tab is closing', async () => {
    push({ type: 'onlyread:config', editorGuard: false, holdClose: true });
    sent.length = 0;
    expect(close()).toEqual([]);
    await tick();
    expect(sent.map((m) => m.type)).toContain('page:closing');
    // Restored from the back/forward cache: the page's handlers run again.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    push({ type: 'onlyread:config', editorGuard: false, holdClose: false });
    expect(close()).toEqual(['pagehide', 'visibilitychange', 'unload']);
  });
  // An unload listener makes a page ineligible for the back/forward cache, so the script adds none as it loads, and
  // has one only while the close is held.
  it('registers no unload listener as it loads, one while the close is held, and drops it when the hold ends', () => {
    expect(loadListeners).toContain('pagehide');
    expect(loadListeners).not.toContain('unload');
    const added: string[] = [];
    const removed: string[] = [];
    const add = vi.spyOn(window, 'addEventListener').mockImplementation(((type: string) => { added.push(type); }) as typeof window.addEventListener);
    const remove = vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string) => { removed.push(type); }) as typeof window.removeEventListener);
    try {
      push({ type: 'onlyread:config', editorGuard: false, holdClose: true });
      expect(added).toEqual(['unload']);
      push({ type: 'onlyread:config', editorGuard: false, holdClose: false });
      expect(removed).toEqual(['unload']);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
  // Where unload is not allowed (Chrome's default), the page's own unload handlers never run, and adding one only
  // logs a permissions policy violation on the extension's error page.
  it('adds no unload listener where the document does not allow unload', () => {
    const added: string[] = [];
    const add = vi.spyOn(window, 'addEventListener').mockImplementation(((type: string) => { added.push(type); }) as typeof window.addEventListener);
    Object.defineProperty(document, 'featurePolicy', { configurable: true, value: { allowsFeature: (f: string) => f !== 'unload' } });
    try {
      push({ type: 'onlyread:config', editorGuard: false, holdClose: true });
      expect(added).toEqual([]);
      push({ type: 'onlyread:config', editorGuard: false, holdClose: false });
    } finally {
      delete (document as { featurePolicy?: unknown }).featurePolicy;
      add.mockRestore();
    }
  });
});

describe('site identity for the popup', () => {
  it('answers with the page\'s own name and title', async () => {
    document.head.innerHTML = '<meta property="og:site_name" content="Example Mail">';
    document.title = 'Inbox';
    const reply = await new Promise((resolve) => { for (const l of listeners) l({ type: 'site:meta' }, {}, resolve); });
    expect(reply).toMatchObject({ siteName: 'Example Mail', title: 'Inbox' });
  });
});
