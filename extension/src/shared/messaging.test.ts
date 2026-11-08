import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockedBy, send } from './messaging';

afterEach(() => { vi.unstubAllGlobals(); });
const answer = (r: unknown) => vi.stubGlobal('chrome', { runtime: { id: 'onlyread', sendMessage: async () => r } });

describe('send', () => {
  it('rejects when the background answers only an error, so a refused change is not a success', async () => {
    answer({ error: 'locked:agent:An AI agent is active in this browser, so OnlyRead can\'t turn protection off until it finishes.' });
    await expect(send({ type: 'guard:set', enabled: false })).rejects.toThrow(/^locked:agent:/);
  });
  // Reloaded or updated, the extension leaves a page of it open with nothing behind it (chrome.runtime.id is gone and
  // every call throws "Extension context invalidated"): the call never settles, instead of failing every refresh.
  it('never settles, and never calls, once the extension behind the page is gone', async () => {
    const sendMessage = vi.fn(async () => { throw new Error('Extension context invalidated.'); });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const settled = await Promise.race([send({ type: 'status:get' }).then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('pending');
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it('passes through answers that carry an error next to other fields', async () => {
    answer({ ok: false, error: 'That PIN is not right.' });
    expect(await send({ type: 'pin:unlock', pin: '0000' })).toEqual({ ok: false, error: 'That PIN is not right.' });
  });
});

describe('lockedBy', () => {
  it('reads the reason and the sentence of a lock refusal', () => {
    expect(lockedBy(new Error('locked:pin:Enter your settings PIN to switch gmail off.'))).toEqual({ reason: 'pin', text: 'Enter your settings PIN to switch gmail off.' });
  });
  it('is undefined for any other failure', () => {
    expect(lockedBy(new Error('network down'))).toBeUndefined();
  });
});
