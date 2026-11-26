// The eye button on the API key field (shared by the settings page and the first-run window). The key protects the
// person's AI judge, so the button shows only what was typed during this visit: never a key the form filled in from
// storage, and never while the settings are locked.
import type { SettingsLock } from './types';

export interface KeyReveal {
  /** The field was just filled: `saved` is the stored key it holds, if any (not revealable until the field is emptied). */
  loaded(saved: string | undefined): void;
  /** The settings lock as the background reports it; `undefined` until known. */
  setLock(lock: SettingsLock | undefined): void;
  /** Start a lock read: take its place in line now, before asking the background. The returned function applies the
   *  result only if no later read (or direct `setLock`) has started since, so an older answer that settles late never
   *  puts back an older lock state. */
  beginLockRead(): (lock: SettingsLock | undefined) => void;
  /** Back to hidden (provider changed, Save and test). */
  hide(): void;
}

/** True when the lock keeps the key from being shown: an agent working, an agent's browser, or a PIN set and not entered. */
export function lockedForReveal(lock: SettingsLock | undefined): boolean {
  if (!lock) return true; // not known yet: treated as locked
  return lock.agent === true || lock.agentBrowser === true || (lock.pinSet === true && lock.pinUnlocked !== true);
}

export function mountKeyReveal(key: HTMLInputElement, button: HTMLButtonElement | null): KeyReveal {
  if (!button) return { loaded() {}, setLock() {}, beginLockRead: () => () => {}, hide() { key.type = 'password'; } }; // a page without the button
  // `fresh`: the field's content was typed during this visit. A stored key loaded into the field is not fresh, and an
  // edit of it does not make it so: only emptying the field first does, so the stored part never shows.
  let fresh = true;
  let storedKey: string | undefined; // what the form filled in from storage
  let lock: SettingsLock | undefined;
  let lockSeq = 0; // the newest lock read (or direct set) that has started
  let expiry: ReturnType<typeof setTimeout> | undefined;

  /** Every lock change goes through here: stores it, and (re)sets the one timer that ends a PIN unlock. When the unlock
   *  runs out the key is hidden and the button disabled right then, not at the next poll. No expiry time: no timer. */
  const adopt = (next: SettingsLock | undefined) => {
    lock = next;
    if (expiry !== undefined) { clearTimeout(expiry); expiry = undefined; }
    const until = next?.pinUnlocked === true ? next.pinUnlockedUntil : undefined;
    if (typeof until === 'number' && Number.isFinite(until)) {
      const lapse = () => {
        expiry = undefined;
        if (Date.now() < until) { expiry = setTimeout(lapse, until - Date.now()); return; } // fired early
        if (lock) lock = { ...lock, pinUnlocked: false, pinUnlockedUntil: undefined };
        render();
      };
      expiry = setTimeout(lapse, Math.max(0, until - Date.now()));
    }
    render();
  };

  const render = () => {
    const allowed = fresh && !lockedForReveal(lock);
    if (!allowed) key.type = 'password';
    const shown = key.type === 'text';
    button.disabled = !allowed;
    button.setAttribute('aria-pressed', String(shown));
    button.setAttribute('aria-label', shown ? 'Hide key' : 'Show key');
    button.title = shown ? 'Hide key' : 'Show key';
    button.classList.toggle('on', shown);
  };

  button.addEventListener('click', () => {
    if (button.disabled) return;
    key.type = key.type === 'text' ? 'password' : 'text';
    render();
  });
  key.addEventListener('input', (e) => {
    const undoRedo = typeof (e as InputEvent).inputType === 'string' && (e as InputEvent).inputType.startsWith('history');
    // Undo or redo can bring the stored key (or a piece of it) back into a field that was emptied: not fresh again.
    if (key.value === '') fresh = true;
    else if (storedKey && (undoRedo || key.value === storedKey)) fresh = false;
    render();
  });
  render();
  return {
    loaded(saved) { storedKey = saved || undefined; fresh = !storedKey; key.type = 'password'; render(); },
    setLock(next) { lockSeq++; adopt(next); },
    beginLockRead() {
      const mine = ++lockSeq;
      return (next) => { if (mine === lockSeq) adopt(next); };
    },
    hide() { key.type = 'password'; render(); },
  };
}

/** What the background writes to storage when a lock starts or ends: the agent browser mark, the settings PIN, and the
 *  agent session (session storage). */
const LOCK_KEYS = ['agentBrowser', 'settingsPin', 'agentTabs', 'declaredSession'];

/** Follows the lock between polls: the moment one of those values changes, the key is hidden and the button disabled
 *  (the lock counts as unknown), then `read` says what the lock is now. Without this a key typed just before a lock
 *  activates stays visible until the next poll. */
export function watchLock(reveal: Pick<KeyReveal, 'setLock' | 'beginLockRead'>, read: () => Promise<SettingsLock | undefined>): void {
  chrome.storage.onChanged.addListener((changes) => {
    const moved = LOCK_KEYS.some((k) => changes[k] && JSON.stringify(changes[k]!.oldValue) !== JSON.stringify(changes[k]!.newValue));
    if (!moved) return;
    reveal.setLock(undefined);
    const apply = reveal.beginLockRead(); // taken after the unknown state above, so it is the newest read
    void read().then((lock) => apply(lock), () => apply(undefined));
  });
}
