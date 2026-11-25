// The report dialog: a refusal the person thinks was a mistake, sent to OnlyRead support with a note and an email for
// a reply (background/support.ts builds the report and sends it). Opened from an Activity row's report button, or with
// the newest refusal from the address `#report` (the notice's report icon, the popup's "Report a mistake"). It lists
// the rest of that refusal's burst too (one click's write, the app's retries, the beacon after it), all ticked, so
// they go together. "What is sent" shows the report exactly as Send would send it.
import type { SupportItem, SupportList, SupportReport } from '../shared/types';
import { $, send } from '../popup/ui';
import { relativeTime } from '../shared/refusals';

/** A megaphone, for the Activity rows' report button. */
export const MEGAPHONE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>';

const dialog = () => $<HTMLDialogElement>('report-dialog');
let list: SupportList | undefined;
/** The refusals ticked to send, by key. */
const picked = new Set<string>();
let sent = false;
let sending = false;

function el(tag: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}

const chosen = (): SupportItem[] => (list?.items ?? []).filter((i) => picked.has(i.key));

/** The note's maxlength; the counter counts the same units the browser does. */
const NOTE_MAX = 2000;
/** "1,995 characters remaining", refreshed when the dialog opens and on every edit. */
function count(): void {
  const left = NOTE_MAX - $<HTMLTextAreaElement>('report-note').value.length;
  $('report-note-count').textContent = `${left.toLocaleString('en-US')} character${left === 1 ? '' : 's'} remaining`;
}

/** The report as Send would send it now. */
function report(): SupportReport | undefined {
  if (!list) return undefined;
  const note = $<HTMLTextAreaElement>('report-note').value.trim();
  const email = $<HTMLInputElement>('report-email').value.trim();
  return { ...(note ? { note } : {}), ...(email ? { email } : {}), ...list.context, requests: chosen().map((i) => i.request) };
}

/** "What is sent", and Send only with something ticked. */
function preview(): void {
  if (!sent) $<HTMLButtonElement>('report-send').disabled = sending || chosen().length === 0;
  if ($<HTMLDetailsElement>('report-details').open) $('report-preview').textContent = JSON.stringify(report(), null, 2);
}

function pickAll(checked: boolean): void {
  picked.clear();
  if (checked) {
    for (const i of list?.items ?? []) picked.add(i.key);
  }
  for (const box of $('report-what').querySelectorAll<HTMLInputElement>('.pick input')) box.checked = checked;
  preview();
}

/** One refusal of the burst, with its box. */
function row(i: SupportItem, now: number): HTMLElement {
  const label = document.createElement('label');
  label.className = 'pick';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = picked.has(i.key);
  box.addEventListener('change', () => { if (box.checked) picked.add(i.key); else picked.delete(i.key); preview(); });
  const text = document.createElement('span');
  text.append(el('b', i.what), el('span', `${i.siteName}, ${relativeTime(i.request.ts, now).toLowerCase()}`), el('code', `${i.request.method} ${i.request.url}`));
  label.append(box, text);
  return label;
}

function result(text: string, kind: '' | 'ok' | 'err' = ''): void {
  const out = $('report-result');
  out.textContent = text;
  out.className = kind ? `result ${kind}` : 'result';
}

/** Opens the dialog on the refusal with `key`, or on the newest one. */
export async function openReport(key?: string): Promise<void> {
  list = await send<SupportList>({ type: 'support:list', ...(key ? { key } : {}) }).catch(() => undefined);
  picked.clear();
  for (const i of list?.items ?? []) picked.add(i.key);
  sent = false;
  result('');
  clearTimeout(closeTimer);
  clearTimeout(animationTimer);
  automaticallyClosing = false;
  clearTimeout(feedbackTimer);
  copyGeneration++;
  copying = false;
  $('report-id').textContent = '';
  $('report-copy-feedback').textContent = '';
  $('report-copy-feedback').dataset.failed = 'false';
  dialog().classList.remove('closing');
  $('report-done').hidden = true;
  $('report-form').hidden = false;
  $<HTMLButtonElement>('report-send').hidden = false;

  $('report-cancel').textContent = 'Cancel';
  $<HTMLTextAreaElement>('report-note').value = '';
  count();
  const email = $<HTMLInputElement>('report-email');
  if (!email.value && list?.email) email.value = list.email;
  const what = $('report-what');
  const items = list?.items ?? [];
  $('report-selection').hidden = items.length <= 1;
  if (items.length) {
    const now = Date.now();
    what.replaceChildren(...items.map((i) => row(i, now)));
  } else {
    what.replaceChildren(el('span', key ? 'This refusal is no longer in the activity log.' : 'Nothing refused yet. When OnlyRead refuses a request, you can report it from Activity.'));
  }
  preview();
  if (!dialog().open) dialog().showModal();
  if (items.length) $('report-note').focus();
}

async function sendReport(): Promise<void> {
  if (!chosen().length || sent || sending) return;
  const btn = $<HTMLButtonElement>('report-send');
  sending = true;
  btn.disabled = true;
  result('Sending…');
  const r = await send<{ ok: true; id: string } | { ok: false; error: string }>({
    type: 'support:send', keys: chosen().map((i) => i.key), note: $<HTMLTextAreaElement>('report-note').value, email: $<HTMLInputElement>('report-email').value,
  }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  sending = false;
  if (r.ok) {
    sent = true;
    result(`Sent, thank you. Your report number is ${r.id}. Mention it if you write to us.`, 'ok');
    btn.hidden = true;
    $('report-cancel').textContent = 'Close';
    // The form gives way to the check, drawing itself, and the report's number; then the dialog closes (a click on it
    // closes it sooner).
    $('report-id').textContent = r.id;
    $('report-form').hidden = true;
    $('report-done').hidden = false;
    scheduleClose();
  } else {
    result(r.error, 'err');
    preview();
  }
}

/** How long the "Sent" card stays before the dialog closes: time to read the report's number. */
const DONE_MS = 3200;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let animationTimer: ReturnType<typeof setTimeout> | undefined;
let copyGeneration = 0;
let copying = false;
let automaticallyClosing = false;

function scheduleClose(): void {
  clearTimeout(closeTimer);
  if (!sent || copying || document.activeElement === $('report-copy') || $('report-copy-feedback').dataset.failed === 'true') return;
  closeTimer = setTimeout(() => closeAnimated(true), DONE_MS);
}

/** Copying and focus can interrupt automatic dismissal, but not an explicit Close. */
function holdDismissal(): void {
  clearTimeout(closeTimer);
  if (!automaticallyClosing) return;
  clearTimeout(animationTimer);
  automaticallyClosing = false;
  dialog().classList.remove('closing');
}

async function copyReport(): Promise<void> {
  if (copying || !sent) return;
  const generation = copyGeneration;
  const id = $('report-id').textContent ?? '';
  copying = true;
  clearTimeout(feedbackTimer);
  holdDismissal();
  try {
    await navigator.clipboard.writeText(id);
    if (generation !== copyGeneration) return;
    $('report-copy-feedback').textContent = 'Copied';
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { $('report-copy-feedback').textContent = ''; }, 2000);
    $('report-copy-feedback').dataset.failed = 'false';
  } catch {
    if (generation !== copyGeneration) return;
    $('report-copy-feedback').textContent = 'Could not copy. Select the report number and copy it manually.';
    $('report-copy-feedback').dataset.failed = 'true';
  } finally {
    if (generation === copyGeneration) {
      copying = false;
      scheduleClose();
    }
  }
}

/** Closes the dialog with its closing animation (at once when motion is reduced). */
function closeAnimated(automatic = false): void {
  clearTimeout(closeTimer);
  const d = dialog();
  if (!d.open) return;
  if (d.classList.contains('closing')) {
    // An explicit Close takes precedence even if an automatic animation already started.
    if (!automatic) automaticallyClosing = false;
    return;
  }
  automaticallyClosing = automatic;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { d.close(); return; }
  d.classList.add('closing');
  animationTimer = setTimeout(() => { d.close(); d.classList.remove('closing'); }, 280);
}

/** `#report` in the address: the Activity list, with the dialog on the newest refusal. */
function fromAddress(): void {
  if (location.hash !== '#report') return;
  history.replaceState(null, '', '#activity');
  document.getElementById('activity')?.scrollIntoView();
  void openReport();
}

export function mountReport(): void {
  const sendButton = $<HTMLButtonElement>('report-send');
  sendButton.addEventListener('click', () => void sendReport());
  $('report-select-all').addEventListener('click', () => pickAll(true));
  $('report-clear-selection').addEventListener('click', () => pickAll(false));
  $('report-email').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    sendButton.click();
  });
  $('report-done-close').addEventListener('click', (event) => { event.stopPropagation(); closeAnimated(); });
  $('report-copy').addEventListener('click', (event) => {
    event.stopPropagation();
    void copyReport();
  });
  $('report-copy').addEventListener('focus', holdDismissal);
  $('report-copy').addEventListener('blur', scheduleClose);
  $('report-done').addEventListener('click', (event) => {
    // Keep the number selectable for manual copying.
    if ((event.target as HTMLElement).closest('#report-id, #report-copy-feedback')) return;
    closeAnimated();
  });
  dialog().addEventListener('close', () => { clearTimeout(closeTimer); clearTimeout(feedbackTimer); automaticallyClosing = false; copyGeneration++; copying = false; });
  $('report-details').addEventListener('toggle', preview);
  $('report-note').addEventListener('input', () => { count(); preview(); });
  $('report-email').addEventListener('input', preview);
  addEventListener('hashchange', fromAddress);
  fromAddress();
}
