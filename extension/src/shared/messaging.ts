// Messages from OnlyRead's own pages to the background. A handler that throws answers `{ error }` alone;
// `send` turns that back into a rejection, so a refused settings change cannot pass for a success.
import type { Message } from './types';

/** Prefix of a refusal by the settings lock (background/protection.ts LOCKED_PREFIX), then the reason. */
const LOCKED = /^locked:(agent|pin):/;

/** Whether the extension this page belongs to is still there. After it is reloaded or updated, a page of it left open
 *  (the settings page framed on the Pro account page) has no extension behind it, and every call to it throws
 *  "Extension context invalidated". */
export const extensionGone = (): boolean => {
  try { return !chrome.runtime?.id; } catch { return true; }
};

export async function send<T>(msg: Message): Promise<T> {
  // Nothing will answer: the call never settles, so the page stays as it was instead of failing on every refresh.
  if (extensionGone()) return new Promise<T>(() => {});
  const r = (await chrome.runtime.sendMessage(msg)) as unknown;
  if (r && typeof r === 'object' && 'error' in r && Object.keys(r).length === 1) throw new Error(String((r as { error: unknown }).error));
  return r as T;
}

interface Locked { reason: 'agent' | 'pin'; text: string }

/** The settings lock's refusal in an error, or undefined for any other failure. */
export function lockedBy(err: unknown): Locked | undefined {
  const m = err instanceof Error ? err.message : String(err);
  const hit = LOCKED.exec(m);
  return hit ? { reason: hit[1] as Locked['reason'], text: m.slice(hit[0].length) } : undefined;
}
