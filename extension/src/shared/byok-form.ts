// The "your own key" form, shared by the settings page and the first-run window: pick a gateway,
// paste its key, and (settings page only) pick the review model. An Anthropic key for a Claude review model has no
// field here: it is set in code (the dev tools), and the test below reports on it when there is one. Keys are stored per provider in
// `secrets.keys` by the background (secrets:key), like the choice itself (policy.judge.byok).
import type { Policy } from './types';
import { send } from './messaging';
import { mountKeyReveal } from './key-reveal';
import type { SettingsLock } from './types';
import { PROVIDERS, isProviderId, type ByokChoice, type KeyId, type Secrets } from './providers';

const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

async function getSecrets(): Promise<Secrets> {
  const { secrets } = await chrome.storage.local.get('secrets');
  return typeof secrets === 'object' && secrets !== null ? (secrets as Secrets) : {};
}

/** Through the background, which refuses replacing or removing a key while the settings are locked. */
async function setKey(id: KeyId, key: string | undefined): Promise<void> {
  await send({ type: 'secrets:key', provider: id, key });
}

/** The test of the Anthropic key, beside the judge's (background judge:test). */
export interface AnthropicTest { ok: boolean; model?: string; latencyMs: number; error?: string }

/** The test's sentence on Anthropic, after the judge's: empty without an Anthropic key. */
export function anthropicLine(a: AnthropicTest | undefined): string {
  if (!a) return '';
  return a.ok ? ` Claude through Anthropic answered in ${a.latencyMs} ms.` : ` Anthropic failed (${a.error}), so Claude goes through your provider.`;
}

/** What Save and test answers. */
export interface SaveResult { ok: boolean; problem?: string; error?: string; judge?: string; model?: string; latencyMs?: number; anthropic?: AnthropicTest }

interface ByokForm {
  /** The provider and review model currently in the form (not necessarily saved). */
  choice(): ByokChoice;
  /** Save and test: the background tests the provider with the key typed (or the one stored for it) and puts them into
   *  force only once they pass (background messages.ts chooseByok). `problem`: not testable yet (no key);
   *  `error`: tested, and the test failed. Either way the judge in force is left as it was. */
  save(): Promise<SaveResult>;
  /** The settings lock, for the show/hide button on the key field (it stays off while the settings are locked). */
  setLock(lock: SettingsLock | undefined): void;
  /** Take a place in line for a lock read; only the newest read's result is applied (see key-reveal.ts). */
  beginLockRead(): (lock: SettingsLock | undefined) => void;
  /** Put the key field back to hidden (a Save and test that stops before it reaches `save()`). */
  hideKey(): void;
  removeKey(): Promise<void>;
}

/** The provider picker: one tile per provider (logo, name, tagline) over the hidden byok-provider select, which stays
 *  the form's value. A radio group: arrow keys move between tiles. */
function mountTiles(box: HTMLElement, provider: HTMLSelectElement): () => void {
  const tiles = Object.values(PROVIDERS).map((spec) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'provider-tile'; b.dataset.provider = spec.id; b.setAttribute('role', 'radio');
    const logo = document.createElement('img'); logo.src = spec.logo; logo.alt = '';
    const text = document.createElement('span'); text.className = 'pt-text';
    const name = document.createElement('span'); name.className = 'pt-name'; name.textContent = spec.label;
    const tag = document.createElement('span'); tag.className = 'pt-tag'; tag.textContent = spec.tagline;
    text.append(name, tag);
    b.append(logo, text);
    b.addEventListener('click', () => { provider.value = spec.id; provider.dispatchEvent(new Event('change')); });
    return b;
  });
  box.replaceChildren(...tiles);
  box.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = tiles.findIndex((t) => t.dataset.provider === provider.value);
    const next = tiles[(i + step + tiles.length) % tiles.length]!;
    next.click(); next.focus();
  });
  return () => {
    for (const t of tiles) {
      const on = t.dataset.provider === provider.value;
      t.setAttribute('aria-checked', String(on)); t.tabIndex = on ? 0 : -1;
    }
  };
}

/** Binds byok-provider (and its tiles in byok-tiles), api-key, byok-keylink, byok-saved and, when present, byok-model. */
export async function mountByokForm(): Promise<ByokForm> {
  const provider = byId<HTMLSelectElement>('byok-provider')!;
  const key = byId<HTMLInputElement>('api-key')!;
  const model = byId<HTMLSelectElement>('byok-model');
  const reveal = mountKeyReveal(key, byId<HTMLButtonElement>('key-reveal'));

  provider.replaceChildren(...Object.values(PROVIDERS).map((spec) => {
    const o = document.createElement('option');
    o.value = spec.id; o.textContent = spec.label;
    return o;
  }));

  const tilesBox = byId('byok-tiles');
  const markTiles = tilesBox ? mountTiles(tilesBox, provider) : () => {};

  let saved: ByokChoice = { id: 'openrouter' };
  let secrets: Secrets = {};

  /** Fill the fields for the selected provider from what is saved for it. */
  const render = () => {
    const spec = PROVIDERS[isProviderId(provider.value) ? provider.value : 'openrouter'];
    markTiles();
    key.placeholder = spec.keyPlaceholder;
    key.value = secrets.keys?.[spec.id] ?? '';
    reveal.loaded(secrets.keys?.[spec.id]);
    const savedMark = byId('byok-saved');
    if (savedMark) savedMark.hidden = !secrets.keys?.[spec.id];
    const clear = byId('clear-key'); // "Remove key" only when there is one
    if (clear) clear.hidden = !secrets.keys?.[spec.id];
    byId<HTMLAnchorElement>('byok-keylink')!.href = spec.keyUrl;
    if (model) {
      model.replaceChildren(...spec.review.models.map((m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; return o; }));
      model.value = saved.id === spec.id && saved.model ? saved.model : spec.review.defaultModel;
    }
  };

  const reload = async () => {
    const p = await send<Policy>({ type: 'policy:get' });
    saved = p?.judge?.byok ?? { id: 'openrouter' };
    secrets = await getSecrets();
    provider.value = saved.id;
    render();
  };

  const choice = (): ByokChoice => {
    const id = isProviderId(provider.value) ? provider.value : 'openrouter';
    return { id, ...(model?.value ? { model: model.value } : {}) };
  };

  provider.addEventListener('change', render);
  await reload();
  return {
    choice,
    setLock: reveal.setLock,
    beginLockRead: reveal.beginLockRead,
    hideKey: reveal.hide,
    async save() {
      reveal.hide(); // hidden for every attempt, a failed one included
      try {
        const r = await send<SaveResult & { error?: string }>({ type: 'judge:byok', choice: choice(), key: key.value.trim() || undefined });
        // Passed: stored now, and the saved mark says so. Failed: nothing changed, and the form keeps what was typed and
        // the provider picked, to put right and try again.
        if (r.ok) { key.value = ''; await reload(); }
        return r;
      } finally { reveal.hide(); }
    },
    async removeKey() {
      await setKey(choice().id, undefined);
      await reload();
    },
  };
}
