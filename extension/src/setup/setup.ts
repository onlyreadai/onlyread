// First-run judge window: OnlyRead Pro, or your own OpenRouter or Vercel AI Gateway key. Same form,
// storage and judge test as the settings page.
import { celebrate } from '../shared/confetti';
import { initTheme } from '../shared/theme';
import { cloudProblem } from '../shared/cloud-ui';
import { anthropicLine, mountByokForm, type SaveResult } from '../shared/byok-form';
import { lockedBy, send } from '../shared/messaging';
import { watchLock } from '../shared/key-reveal';
import { takeSignInResult } from '../shared/sign-in-result';
import type { CloudStatus, Status } from '../shared/types';
import { agreeToJudge } from '../shared/consent-ui';
import { go, installDemo, showDemo } from './demo-steps';
import { mountScene } from '../shared/demo-scene';
import { reloadOnDevBuild } from '../shared/dev-reload';
import { markFirstJudge } from '../shared/first-judge';
reloadOnDevBuild();
mountScene(document.querySelector<HTMLElement>('.scene'));
void initTheme();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

function result(text: string, kind: '' | 'ok' | 'err' | 'warn' = ''): void {
  const el = $('key-result'); el.textContent = text; el.className = `result ${kind}`;
}

const save = $<HTMLButtonElement>('save-key');
const done = $<HTMLButtonElement>('done');
const form = mountByokForm();
// The show/hide button on the key field follows the settings lock, which this window learns from the background.
const followLock = async () => {
  const apply = (await form).beginLockRead(); // an older poll that settles late is dropped
  try { apply((await send<Status>({ type: 'status:get' })).lock); } catch { apply(undefined); }
};
void followLock();
setInterval(() => void followLock(), 3000);
// A lock that starts hides the key at once, without waiting for the poll.
void form.then((f) => watchLock(f, async () => (await send<Status>({ type: 'status:get' })).lock));

save.addEventListener('click', async () => {
  const f = await form;
  save.classList.add('busy'); // spins while it saves and tests
  result('');
  f.hideKey(); // hidden for every attempt, also one that stops at the consent
  await agreeToJudge(); // saving a key is the agreement the note under it states
  // Tested before anything is stored: a key that fails changes nothing.
  let t: SaveResult;
  try { t = await f.save(); } catch (err) { t = { ok: false, problem: lockedBy(err)?.text ?? (err instanceof Error ? err.message : String(err)) }; }
  save.classList.remove('busy');
  if (!t.ok && t.problem) { result(`Not ready yet: ${t.problem}.`, 'warn'); return; }
  if (t.ok) {
    // A key that works is a judge: protection goes on (off for want of one until now).
    await chrome.runtime.sendMessage({ type: 'guard:set', enabled: true }).catch(() => undefined);
    // Just that it works; an Anthropic key that failed is said beside it.
    result(`It works${t.anthropic?.ok === false ? `.${anthropicLine(t.anthropic)}` : ''}`, t.anthropic?.ok === false ? 'warn' : 'ok');
    celebrate(save);
    done.hidden = false; done.focus();
    // The first AI judge this browser sets up is followed by the demo (shared/first-judge.ts): on to it by itself, once
    // the confetti has had its moment. A later key keeps the Next button.
    if (await markFirstJudge()) setTimeout(() => showDemo(), 1400);
  } else {
    result(`The test failed: ${t.error ?? 'unknown error'}. Check the key and your network, then try again.`, 'err');
  }
});
$('api-key').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') save.click(); });
// The judge step done (signed in to Pro, or a key saved and tested), the demo comes next (demo-steps.ts); it can be skipped.
done.addEventListener('click', () => showDemo());

// ---- OnlyRead Pro
const cloudBtn = $<HTMLButtonElement>('cloud-signin');
const subBtn = $<HTMLButtonElement>('cloud-subscribe');
let cloud: CloudStatus | undefined;
function cloudResult(text: string, kind: '' | 'ok' | 'err' | 'warn' = ''): void {
  const el = $('cloud-result'); el.textContent = text; el.className = `result ${kind}`;
}
// "Sign in" sends this window to the Pro sign-in page; it comes back here when the sign-in ends (the result in the
// address, shared/sign-in-result.ts).
cloudBtn.addEventListener('click', async () => {
  cloudBtn.classList.add('busy');
  cloudResult('');
  await agreeToJudge(); // signing in is the agreement the note under it states
  // The sign-in makes Pro the judge as it finishes (two modes, never mixed); one the lock would refuse (an agent at
  // work, a settings PIN) does not start, and says why.
  const r = (await chrome.runtime.sendMessage({ type: 'cloud:signin' })) as { ok: boolean; locked?: boolean; error?: string; cloud: CloudStatus };
  if (!r.ok) { cloudBtn.classList.remove('busy'); cloudResult(r.locked ? (r.error ?? '') : `Sign-in failed: ${r.error}`, 'err'); }
});
addEventListener('pageshow', (e) => { if (e.persisted) cloudBtn.classList.remove('busy'); });
/** Closes this page's tab (and so the setup window): window.close() alone only works when a script opened the window. */
function closeSelf(): void {
  // The browser window the person came from comes forward first: from a window in full screen on macOS (a Space of
  // its own), closing this one alone would leave them on the desktop.
  void chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then((w) => (w.id !== undefined ? chrome.windows.update(w.id, { focused: true }) : undefined)).catch(() => undefined).finally(() => {
    chrome.tabs.getCurrent((t) => { if (t?.id !== undefined) void chrome.tabs.remove(t.id).catch(() => window.close()); else window.close(); });
  });
}
/** Something to say after a sign-in (a plan to get, a problem): back on the judge step, which says it. */
function showIssue(c: CloudStatus, issue: NonNullable<ReturnType<typeof cloudProblem>>): void {
  go('step-judge');
  if (issue.action !== 'subscribe') { cloudResult(issue.text, 'warn'); return; }
  const offer = c.account?.offer;
  cloudResult(c.account?.credits || c.lastError?.message ? issue.text : `Signed in as ${c.account?.name || c.account?.email || ''}. ${offer ? `${offer.label} to start.` : 'Get Pro to start.'}`, 'warn');
  if (offer) subBtn.textContent = offer.label;
  subBtn.hidden = false;
}

async function showSignedIn(): Promise<void> {
  const back = takeSignInResult();
  if (!back) return;
  if (!back.ok) { cloudResult(`Sign-in failed: ${back.reason ?? 'unknown error'}`, 'err'); return; }
  const c = (await chrome.runtime.sendMessage({ type: 'cloud:status', refresh: true })) as CloudStatus;
  cloud = c;
  const issue = cloudProblem(c);
  if (issue) { showIssue(c, issue); return; }
  // Nothing left to do here: the demo is already showing (below).
  cloudResult(`Signed in as ${c.account?.name || c.account?.email || ''}. OnlyRead Pro is on.`, 'ok');
  done.hidden = false;
}
// Back from a sign-in that went through: straight on to the demo, with no glimpse of the judge step (showSignedIn goes
// back to it only when there is something to say).
if (/[?&]signin=ok\b/.test(location.search)) showDemo();
// Opened for the demo alone (the demo summary's "Try another", the settings page's "Try the demo"): its choice of site,
// also when an open setup window is sent there.
const demoAsked = () => { if (location.hash === '#demo') showDemo(true); };
demoAsked();
addEventListener('hashchange', demoAsked);
void showSignedIn();
installDemo(closeSelf);

subBtn.addEventListener('click', () => { const a = cloud?.account; const u = a?.offer?.url ?? a?.links.pricing; if (u) void chrome.tabs.create({ url: u }); });
