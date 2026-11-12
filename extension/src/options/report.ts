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

function el(tag: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}

const chosen = (): SupportItem[] => (list?.items ?? []).filter((i) => picked.has(i.key));

/** The report as Send would send it now. */
function report(): SupportReport | undefined {
  if (!list) return undefined;
  const note = $<HTMLTextAreaElement>('report-note').value.trim();
  const email = $<HTMLInputElement>('report-email').value.trim();
  return { ...(note ? { note } : {}), ...(email ? { email } : {}), ...list.context, requests: chosen().map((i) => i.request) };
}

/** "What is sent", and Send only with something ticked. */
function preview(): void {
  if (!sent) $<HTMLButtonElement>('report-send').disabled = chosen().length === 0;
  if ($<HTMLDetailsElement>('report-details').open) $('report-preview').textContent = JSON.stringify(report(), null, 2);
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
  dialog().classList.remove('closing');
  $('report-done').hidden = true;
  $('report-form').hidden = false;
  $<HTMLButtonElement>('report-send').hidden = false;

  $('report-cancel').textContent = 'Cancel';
  $<HTMLTextAreaElement>('report-note').value = '';
  const email = $<HTMLInputElement>('report-email');
  if (!email.value && list?.email) email.value = list.email;
  const what = $('report-what');
  const items = list?.items ?? [];
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
  if (!chosen().length || sent) return;
  const btn = $<HTMLButtonElement>('report-send');
  btn.disabled = true;
  result('Sending…');
  const r = await send<{ ok: true; id: string } | { ok: false; error: string }>({
    type: 'support:send', keys: chosen().map((i) => i.key), note: $<HTMLTextAreaElement>('report-note').value, email: $<HTMLInputElement>('report-email').value,
  }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
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
    closeTimer = setTimeout(closeAnimated, DONE_MS);
  } else {
    result(r.error, 'err');
    btn.disabled = false;
  }
}

/** How long the "Sent" card stays before the dialog closes: time to read the report's number. */
const DONE_MS = 3200;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

/** Closes the dialog with its closing animation (at once when motion is reduced). */
function closeAnimated(): void {
  clearTimeout(closeTimer);
  const d = dialog();
  if (!d.open || d.classList.contains('closing')) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { d.close(); return; }
  d.classList.add('closing');
  setTimeout(() => { d.close(); d.classList.remove('closing'); }, 280);
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
  $('report-email').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    sendButton.click();
  });
  $('report-done').addEventListener('click', closeAnimated);
  dialog().addEventListener('close', () => { clearTimeout(closeTimer); });
  $('report-details').addEventListener('toggle', preview);
  $('report-note').addEventListener('input', preview);
  $('report-email').addEventListener('input', preview);
  addEventListener('hashchange', fromAddress);
  fromAddress();
}
