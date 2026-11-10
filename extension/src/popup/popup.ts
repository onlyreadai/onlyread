import type { Message, SiteView, Status } from '../shared/types';
import { initTheme } from '../shared/theme';
import { reloadOnDevBuild } from '../shared/dev-reload';
import { setLockText } from '../shared/lock-text';
reloadOnDevBuild();
import { ACCOUNT_ONLY_SWITCH, GUARD_ALL_ACCOUNT_SWITCH, exclusionLine, popupFooter } from '../shared/status-text';
import { $, activeWebTab, faviconImg, iconImg, identify, installIconFallbacks, lockedBy, send, type SiteIdentity } from './ui';

installIconFallbacks();
void initTheme();
chrome.runtime.connect({ name: 'popup' }); // lets the background log when the popup opens and closes
let host = '';
let identity: SiteIdentity | undefined;

/** Why the last change was refused (the settings lock), kept until the lock lifts. */
let refused = '';
let refusedForPin = false;
/** Why the Pro account was not changed (not signed in, a lapsed subscription, the list at its cap, a conflict), kept
 *  until the next change goes through. Not the lock's refusal, so it is shown whatever the lock's state:
 *  `refused` is cleared by render() whenever no agent works and no PIN holds. */
let accountRefused = '';

function render(sites: SiteView[], status: Status): void {
  const agentLock = status.lock?.agent === true;
  const mode = $('mode') as HTMLInputElement;
  // No AI judge: the popup is only the way to set one, as the settings page is (options.html #judge-gate). A fresh
  // install is here with protection on (the default): no switch, no settings button, no footer, one button.
  const noJudge = Boolean(status.judgeMissing);
  document.body.classList.toggle('no-judge', noJudge);
  $('enforce').hidden = noJudge;
  mode.checked = status.enabled;
  // While an agent works, protection can only go up: an on switch cannot be turned off.
  mode.disabled = (agentLock && status.enabled) || status.lock?.agentBrowser === true;
  if (!agentLock && (!status.lock?.pinSet || status.lock.pinUnlocked)) refused = '';
  renderNotes(status, agentLock);
  const box = $('current');
  if (noJudge) { box.replaceChildren(judgeCard()); return; }
  const site = sites.find((s) => s.current);
  if (!site && !host) { box.innerHTML = '<div class="empty">Open a web page to see whether it is guarded.</div>'; return; }
  box.replaceChildren(site ? knownSiteRow(site, status) : unknownSiteRow(status.lock?.agentBrowser === true));
}

/** The lock's box, the account's refusal and the footer. */
function renderNotes(status: Status, agentLock: boolean): void {
  if (agentLock) renderLock(status.lock?.agentBrowser ? 'This browser belongs to an AI agent. Lowering protection is locked here. Release it from your OnlyRead Pro account page in your own browser.' : 'An AI agent is active in this browser. Lowering protection is locked until it finishes.', false);
  else renderLock(refused, refusedForPin);
  // A refusal of the change just made, else the last change the account refused after it was sent (cloud-sync.ts).
  const accountNote = accountRefused || status.accountRefused || '';
  $('note').hidden = !accountNote;
  $('note-text').textContent = accountNote;
  const foot = popupFooter(status);
  $('foot-left').textContent = foot.text;
  $('foot-left').className = foot.warn ? 'warn' : '';
  // A problem in the footer has the line to itself: reporting a refusal has nothing to do with it.
  $('report').hidden = foot.warn;
}

/** In place of the site card while there is no AI judge: the one thing to do, with the setup window's look
 *  (welcome.css). Fixed text only. */
function judgeCard(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'welcome-kit judge-needed';
  row.innerHTML =
    '<div class="hero"><div class="tile-logo"><img src="assets/icon-128.png" alt=""></div></div>' +
    '<div class="title">Turn on OnlyRead</div>' +
    '<p class="lede">Choose an AI judge, and your agent can read everything but never send, post or delete.</p>' +
    '<button type="button" class="btn primary cta" id="judge-card-set"><svg class="lead" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z"/><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" opacity=".8"/></svg>Set up AI judge<svg class="arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>' +
    '<p class="small">Free to start: 1,000 requests with OnlyRead Pro</p>';
  row.querySelector('#judge-card-set')!.addEventListener('click', openJudge);
  return row;
}

function renderLock(text: string, settingsLink: boolean): void {
  $('lock').hidden = !text;
  setLockText($('lock-text'), text);
  $('lock-settings').hidden = !settingsLink;
}

/** Send a change; a refusal by the settings lock is shown, and so is a refusal from the Pro account (not signed in, a
 *  list at its cap), each in its own place; anything else is rethrown. */
async function change(msg: Message): Promise<void> {
  try {
    const r = await send<unknown>(msg);
    const notChanged = r && typeof r === 'object' && !Array.isArray(r) && (r as { ok?: unknown }).ok === false;
    accountRefused = notChanged ? String((r as { error?: unknown }).error ?? 'Not changed.') : '';
  } catch (err) {
    const locked = lockedBy(err);
    if (!locked) throw err;
    refused = locked.reason === 'pin' ? `${locked.text} The PIN is entered in` : locked.text;
    refusedForPin = locked.reason === 'pin';
  } finally { await refresh(); }
}

/** Pro mode (a Pro judge, signed in, the account's lists in force): the switch changes the account's lists. */
const proMode = (st: Status) => st.cloud?.provider === 'cloud' && Boolean(st.cloud.signedIn) && Boolean(st.managed);

/** Beside a site the account guards: in Pro mode nothing once saved there, a small spinner while a change is on its
 *  way; with an own key, where it is changed (the account page). */
function accountMark(site: SiteView, pro: boolean): string {
  if (!pro) return `<span class="sub scope-note">${ACCOUNT_ONLY_SWITCH}</span>`;
  return site.waiting ? '<span class="saving" role="status" aria-label="Saving to your account" title="Saving to your account"></span>' : '';
}

/** Under a guard-every-site switch that is fixed: why (SiteView.guardAll). */
function guardAllNote(site: SiteView, pro: boolean): string {
  const all = site.guardAll;
  // In Pro mode the popup changes the account's sites: a fixed switch there has another reason, said below.
  if (site.account && !pro) return ACCOUNT_ONLY_SWITCH;
  if (all?.with) return `Guarded with ${all.with}`;
  if (all?.shares) return `Shares its address with ${all.shares}`;
  if (all?.shared) return 'Shared address: allow it in settings';
  return GUARD_ALL_ACCOUNT_SWITCH;
}

/** The current page belongs to a site OnlyRead knows (verified or added): its switch. In Pro mode it changes the
 *  account's lists (saved there, said under it); with an own key, a site the Pro account guards is changed only on the
 *  account page: its switch is fixed here, with a line saying where. */
function knownSiteRow(site: SiteView, status: Status): HTMLElement {
  const row = document.createElement('div');
  row.className = 'site';
  const pro = proMode(status);
  // An agent's browser is managed from the account alone: no switch moves here.
  // Every site guarded: the switch says whether the site is, and allows it or guards it again (site:guard-all).
  const all = site.guardAll;
  const on = all ? all.on : site.enabled;
  const locked = (all ? all.fixed === true : site.account && !pro) || (on && status.lock?.agent) || status.lock?.agentBrowser === true;
  const note = all?.fixed ? `<span class="sub scope-note"></span>`
    : !all && site.account && site.enabled ? accountMark(site, pro) : '';
  row.innerHTML =
    '<div class="logo"></div>' +
    `<div class="meta"><div class="name"><span class="n"></span></div><div class="sub"></div>` +
    `<div class="actions"><label class="switch"><input type="checkbox" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}><span></span></label><span class="sub">${on ? 'On' : 'Off'}</span>${note}</div></div>`;
  row.querySelector('.logo')!.append(iconImg(site));
  // A site name goes in as text, never markup.
  const why = row.querySelector('.scope-note');
  if (why && all?.fixed) why.textContent = guardAllNote(site, pro);
  (row.querySelector('.n') as HTMLElement).textContent = site.name;
  // The site's own domains, not their subdomains (x.com, not api.x.com and upload.x.com beside it).
  const mains = site.domains.filter((d) => !site.domains.some((o) => o !== d && d.endsWith(`.${o}`)));
  (row.querySelector('.sub') as HTMLElement).textContent = mains.join(', ');
  // A significant part of the site OnlyRead does not guard (the profile's outOfScope) stays in view, as on the settings page.
  const excl = exclusionLine(site.outOfScope);
  if (excl) row.querySelector('.meta > .sub')!.after(Object.assign(document.createElement('div'), { className: 'excl', textContent: excl }));
  row.querySelector('input')!.addEventListener('change', (ev) => {
    const checked = (ev.target as HTMLInputElement).checked;
    void change(all ? { type: 'site:guard-all', id: site.id, on: checked, host } : { type: 'site:set', id: site.id, enabled: checked, host });
  });
  return row;
}

/** A page on a site OnlyRead does not know yet: offer to guard it (by the AI judge) in this browser. Putting a site on the
 *  Pro account's list is done from the account page, not here. */
function unknownSiteRow(managed = false): HTMLElement {
  const row = document.createElement('div');
  row.className = 'site';
  row.innerHTML =
    '<div class="logo"></div>' +
    `<div class="meta"><div class="name"><span class="n"></span></div><div class="sub"></div><div class="state off">Not guarded</div>` +
    (managed
      ? '<div class="actions"><span class="sub">Managed from your OnlyRead Pro account page</span></div></div>'
      : '<div class="actions"><button id="guard" class="btn primary">Guard this site</button><span class="sub">writes refused by the AI judge</span></div></div>');
  row.querySelector('.logo')!.append(faviconImg(host, identity?.iconUrl));
  (row.querySelector('.n') as HTMLElement).textContent = identity?.name ?? host;
  (row.querySelector('.meta > .sub') as HTMLElement).textContent = host;
  row.querySelector('#guard')?.addEventListener('click', async () => {
    await change({ type: 'site:add', host, name: identity?.name, iconUrl: identity?.iconUrl });
  });
  return row;
}

async function refresh(): Promise<void> {
  const active = await activeWebTab();
  host = active?.host ?? '';
  const [sites, status] = await Promise.all([send<SiteView[]>({ type: 'sites:list', host }), send<Status>({ type: 'status:get' })]);
  if (active && !sites.some((s) => s.current)) identity = await identify(active.tab, host); else identity = undefined;
  render(sites, status);
}

// Settings: the Pro account page in Pro mode, this browser's own page otherwise (background messages.ts openSettings).
const openSettings = (section: 'overview' | 'security') => { void send({ type: 'settings:open', section }).finally(() => window.close()); };
$('options').addEventListener('click', () => openSettings('overview'));
$('mode').addEventListener('change', (ev) => {
  void change({ type: 'guard:set', enabled: (ev.target as HTMLInputElement).checked });
});
$('lock-settings').addEventListener('click', () => openSettings('security'));
/** The settings page, which with no AI judge is only the way to set one. */
function openJudge(): void { void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); window.close(); }
$('report').addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#report') }); window.close(); });
void refresh();
setInterval(() => void refresh(), 3000);
