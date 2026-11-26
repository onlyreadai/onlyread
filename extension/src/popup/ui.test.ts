import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeWebTab, samePixels } from './ui';

// The favicon cache's default globe is recognised by its pixels: only an exact match counts as the globe.
describe('samePixels', () => {
  const px = (...v: number[]) => new Uint8ClampedArray(v);
  it('matches identical pixels', () => { expect(samePixels(px(1, 2, 3, 255), px(1, 2, 3, 255))).toBe(true); });
  it('rejects one differing value or a different size', () => {
    expect(samePixels(px(1, 2, 3, 255), px(1, 2, 4, 255))).toBe(false);
    expect(samePixels(px(1, 2, 3, 255), px(1, 2, 3, 255, 0, 0, 0, 0))).toBe(false);
  });
  it('never matches when either image could not be read', () => {
    expect(samePixels(undefined, px(0))).toBe(false);
    expect(samePixels(px(0), undefined)).toBe(false);
  });
});

describe('activeWebTab', () => {
  const tab = (over: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab => ({ id: 1, ...over }) as chrome.tabs.Tab;
  // A fake chrome.tabs.query answering with `answer` (or rejecting with it); the query itself is recorded.
  const stubQuery = (answer: chrome.tabs.Tab[] | Error) => {
    const query = vi.fn(async () => { if (answer instanceof Error) throw answer; return answer; });
    vi.stubGlobal('chrome', { tabs: { query } });
    return query;
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks chrome for the current window\'s tabs', async () => {
    const query = stubQuery([tab({ active: true, url: 'https://example.com/' })]);
    await expect(activeWebTab()).resolves.toEqual({ tab: { id: 1, active: true, url: 'https://example.com/' }, host: 'example.com' });
    expect(query).toHaveBeenCalledWith({ currentWindow: true });
  });

  it('prefers the active web tab even when another web tab was accessed more recently', async () => {
    const active = tab({ id: 1, active: true, url: 'https://active.example.com/page', lastAccessed: 10 });
    stubQuery([tab({ id: 2, url: 'https://newer.example.com/', lastAccessed: 900 }), active]);
    await expect(activeWebTab()).resolves.toEqual({ tab: active, host: 'active.example.com' });
  });

  it('falls back to the most recently accessed web tab when the active tab is an extension page', async () => {
    const oldest = tab({ id: 1, url: 'https://old.example.com/', lastAccessed: 100 });
    const newest = tab({ id: 2, url: 'http://new.example.com/', lastAccessed: 300 });
    const middle = tab({ id: 3, url: 'https://mid.example.com/', lastAccessed: 200 });
    stubQuery([middle, tab({ id: 4, active: true, url: 'chrome-extension://onlyread/popup.html' }), oldest, newest]);
    await expect(activeWebTab()).resolves.toEqual({ tab: newest, host: 'new.example.com' });
  });

  it('ignores tabs with no, malformed or non-web URLs, and treats a missing lastAccessed as 0', async () => {
    const dated = tab({ id: 1, url: 'https://dated.example.com/', lastAccessed: 50 });
    const undated = tab({ id: 2, url: 'https://undated.example.com/' });
    stubQuery([
      tab({ id: 3, active: true, url: 'chrome://extensions/' }),
      tab({ id: 4, url: 'ftp://files.example.com/', lastAccessed: 999 }),
      tab({ id: 5, url: 'not a url', lastAccessed: 999 }),
      tab({ id: 6, lastAccessed: 999 }),
      undated, dated,
    ]);
    await expect(activeWebTab()).resolves.toEqual({ tab: dated, host: 'dated.example.com' });
  });

  it('still picks the only web tab when it has no lastAccessed', async () => {
    const only = tab({ id: 1, url: 'https://only.example.com/' });
    stubQuery([tab({ id: 2, active: true, url: 'chrome://newtab/' }), only]);
    await expect(activeWebTab()).resolves.toEqual({ tab: only, host: 'only.example.com' });
  });

  it('returns undefined when there is no web tab, the query is empty, or the query rejects', async () => {
    stubQuery([tab({ id: 1, active: true, url: 'chrome://newtab/' })]);
    await expect(activeWebTab()).resolves.toBeUndefined();
    stubQuery([]);
    await expect(activeWebTab()).resolves.toBeUndefined();
    stubQuery(new Error('tabs unavailable'));
    await expect(activeWebTab()).resolves.toBeUndefined();
  });
});
