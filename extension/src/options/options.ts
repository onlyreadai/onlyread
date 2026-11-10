import { celebrate } from '../shared/confetti';
import type { ActivityItem, ActivitySummary, CloudStatus, Message, SettingsLock, SiteView, Status } from '../shared/types';
import { agreeToJudge } from '../shared/consent-ui';
import { accountActive, accountStatusText, cloudProblem, cloudUsage, proManaged, usagePercent } from '../shared/cloud-ui';
import { $, faviconImg, iconImg, installIconFallbacks, lockedBy, send } from '../popup/ui';
import { extensionGone } from '../shared/messaging';
import { applyTheme, initTheme, normalizeTheme, setTheme, type Theme } from '../shared/theme';
import { anthropicLine, mountByokForm } from '../shared/byok-form';
import { exclusionLine, type OverviewButton, overviewAction, overviewFacts, overviewHeading, setupLine, siteSummary } from '../shared/status-text';
import { relativeTime } from '../shared/refusals';
import { installSidebar, reducedMotion, scrollToSection, setCount } from './sections';
import { takeSignInResult } from '../shared/sign-in-result';
import { MEGAPHONE, mountReport, openReport } from './report';
import { allowFrame, enterFramed, framedSection, framedTheme } from './framed';
import { mountScene } from '../shared/demo-scene';
import { reloadOnDevBuild } from '../shared/dev-reload';
import { markFirstJudge } from '../shared/first-judge';
import { setLockText } from '../shared/lock-text';
reloadOnDevBuild();

// The view the page opened in last time (renderProManaged): the no-judge view shows at once when it was that, before
// the first status; otherwise the page stays hidden (html.booting) until the status says. Never hidden for long.
const GATE_KEY = 'onlyread:judge-gate';
const shown = (): void => document.documentElement.classList.remove('booting');
try {
  if (localStorage.getItem(GATE_KEY) === '1' && new URLSearchParams(location.search).get('framed') !== '1') {
    document.documentElement.classList.add('judge-setup');
    document.getElementById('judge-gate')!.hidden = false;
    mountScene(document.querySelector<HTMLElement>('#judge-gate .scene'));
    shown();
  }
} catch { /* no storage: wait for the status */ }
setTimeout(shown, 1500);

// The settings page: a sidebar of topics beside five sections. Overview (the status card: the
// state, at most one action, today's counts), Sites (the account's and this browser's, a search box, each row's text
// actions behind ⋯), Activity (the recent refusals, from the activity log), AI judge, and Security (when to protect,
// the settings PIN, the agent lock), and the report dialog (an Activity row's refusal sent to OnlyRead support, options/report.ts). Every change goes through the settings lock (background/protection.ts).

// Framed on the Pro account page (options/framed.ts): one section, shown once the framing page is known to be Pro's.
const framed = framedSection();
if (framed) enterFramed(framed);

installIconFallbacks();
mountReport();
// The demo again, on any of its sites: the setup window's choice of site (background/messages.ts openSetupWindow). In
// the Overview card, and in Pro mode in the "Managed on your Pro account" card, which is all the page shows there.
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-demo-again]')) {
  b.addEventListener('click', () => void send({ type: 'setup:open', step: 'demo' }));
}
// Appearance: System / Light / Dark, stored once and applied by every extension page.
function renderTheme(t: Theme): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#theme-seg button')) {
    const on = b.dataset.theme === t;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  }
}
// Framed on the Pro account page, the page's own light or dark choice instead (options/framed.ts).
if (framed) applyTheme(framedTheme());
else void initTheme().then(renderTheme);
// Another page (a second options tab, the setup window) may change it: keep the control in step.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.theme) renderTheme(normalizeTheme(changes.theme.newValue));
});
$('theme-seg').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-theme]');
  if (!b) return;
  const t = normalizeTheme(b.dataset.theme);
  renderTheme(t); void setTheme(t);
});

// ---- Sites

/** The two groups of the Sites list:
 *  "Managed by your Pro account" holds every site the account's list guards (sites.ts accountGuards), for every browser
 *  signed in to it; "Managed by this browser" holds the rest, with this browser's own switches. A site in both lists
 *  sits under the account; when the account drops it, it comes back under this browser with its own setting, still
 *  guarded. */
type Section = 'account' | 'browser';

/** Pro mode (a Pro judge, signed in, the account's lists in force): the sites are the account's, changed from here too
 *  (background/messages.ts, sent by cloud-sync.ts). `browsers`: how many browsers are on the account; with two or more,
 *  a site can be guarded in every browser or in this one alone. */
let pro = false;
let browsers = 1;
const proMode = (st: Status) => st.cloud?.provider === 'cloud' && Boolean(st.cloud.signedIn) && Boolean(st.managed);

const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>';

/** A site removed with the trash button, as on the Pro account page (the popup keeps the switch): one of this browser's
 *  own, or in Pro mode one of the account's (off every list of the account that has it). A built-in site is switched
 *  off and leaves the list; one added here is removed. Removing lowers protection: locked while an agent works
 *  (background/messages.ts), and disabled then. With an own key, the account's sites change only on the account page:
 *  no button there. */
function rowTrash(s: SiteView, section: Section): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn danger';
  b.title = 'Remove';
  b.setAttribute('aria-label', `Remove ${s.name}`);
  b.innerHTML = TRASH;
  b.disabled = agentLocked();
  b.addEventListener('click', () => {
    shownBuiltins.delete(s.id);
    void siteChange(s.builtin ? { type: 'site:set', id: s.id, enabled: false } : { type: 'site:remove', id: s.id }, section);
  });
  return b;
}

/** A change on its way to the Pro account: a small spinner, its words for screen readers and on hover. */
function savingMark(): HTMLElement {
  const e = textEl('span', 'saving', '');
  e.setAttribute('role', 'status');
  e.setAttribute('aria-label', 'Saving to your account');
  e.title = 'Saving to your account';
  return e;
}

function textEl(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

function siteRow(s: SiteView, section: Section): HTMLElement {
  const row = document.createElement('div');
  row.className = section === 'account' ? 'row site-row managed' : 'row site-row';
  row.dataset.id = s.id;
  row.dataset.search = [s.name, ...s.domains].join(' ').toLowerCase();
  const logo = textEl('div', 'logo', '');
  logo.append(iconImg(s));
  const meta = textEl('div', 'meta', '');
  const name = textEl('div', 'name', '');
  name.append(textEl('span', 'n', s.name));
  // Pro mode: where on the account the site is (with two or more browsers), and a change not on the account yet.
  if (section === 'account' && pro && browsers > 1) name.append(textEl('span', 'scope-tag', s.scopes?.includes('account') ? 'Every browser' : 'This browser only'));
  if (section === 'account' && s.waiting) name.append(savingMark());
  // One line: the first sentence of the site's description (what works); a significant exclusion stays in view.
  meta.append(name, textEl('div', 'desc', siteSummary(s.description)));
  const excl = exclusionLine(s.outOfScope);
  if (excl) meta.append(textEl('div', 'excl', excl));
  row.append(logo, meta);
  if (section === 'browser' || pro) row.append(rowTrash(s, section));
  return row;
}

/** A site change through the lock; a refusal (the lock, the Pro account not signed in or at its cap) is said under
 *  the group it was made in. */
async function siteChange(msg: Message, where: Section): Promise<void> {
  const r = await change<SiteView[] | { ok: false; error: string }>(msg);
  if (r && !Array.isArray(r) && r.ok === false) addNote(r.error, 'err', where);
}
const NOTE_OF: Record<Section, string> = { account: 'account-result', browser: 'add-result' };
function addNote(text: string, kind: '' | 'ok' | 'err' | 'warn', where: Section): void {
  const note = $(NOTE_OF[where]);
  note.textContent = text;
  note.className = `add-result ${kind}`;
}

const emptyLine = (text: string, cls = '') => textEl('div', `empty ${cls}`.trim(), text);

/** The search box: rows whose name or domains hold the text stay; a group with none left says so. */
function applySearch(): void {
  const q = $<HTMLInputElement>('site-search').value.trim().toLowerCase();
  for (const group of [$('account-sites'), $('sites')]) {
    const rows = [...group.querySelectorAll<HTMLElement>('.site-row')];
    for (const r of rows) r.hidden = Boolean(q) && !r.dataset.search?.includes(q);
    group.querySelector('.nomatch')?.remove();
    if (q && rows.length && rows.every((r) => r.hidden)) group.append(emptyLine('No site here matches your search.', 'nomatch'));
  }
}
$('site-search').addEventListener('input', applySearch);

/** Built-in sites shown on this visit: one switched off stays in the list (off) until the page is opened again, so a
 *  row never vanishes under the click that switched it. */
const shownBuiltins = new Set<string>();

/** Whether a site is in this browser's list: every site added here, and a built-in only once it is switched on (added
 *  by its address, or from the popup); the others wait to be added like any site. */
const listed = (s: SiteView): boolean => !s.builtin || s.enabled || shownBuiltins.has(s.id);

/** No site guarded yet (this browser's list, or the account's in Pro mode): how to add one, with a short recording of
 *  it (assets/add-site-*.webp). */
function sitesEmptyState(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'sites-empty';
  box.innerHTML =
    '<img class="demo demo-light" src="assets/add-site-light.webp" width="560" height="350" alt="On a website, click the OnlyRead icon in the toolbar, then Guard this site.">' +
    '<img class="demo demo-dark" src="assets/add-site-dark.webp" width="560" height="350" alt="">' +
    `<div class="how"><b>${pro ? 'No sites guarded yet.' : 'No sites guarded in this browser yet.'}</b>` +
    '<span>Open the site, click the OnlyRead icon in your toolbar and choose <b>Guard this site</b>. You can also add sites below.</span></div>';
  return box;
}

/** Two groups, each with the built-in sites first, then the ones added: a fixed order, so rows never jump when
 *  switched. A site the account guards sits under the account whatever this browser says about it. */
function renderSites(sites: SiteView[], signedIn: boolean): void {
  const ordered = [...sites.filter((s) => s.builtin), ...sites.filter((s) => !s.builtin)];
  const of = (section: Section) => ordered.filter((s) => Boolean(s.account) === (section === 'account'));
  const account = of('account').map((s) => siteRow(s, 'account'));
  const noAccountSites = pro ? sitesEmptyState() : emptyLine('Your account is not guarding any sites right now. Add them on your account page.');
  $('account-sites').replaceChildren(...(account.length ? account : [noAccountSites]));
  const mine = of('browser').filter(listed);
  for (const s of mine) if (s.builtin) shownBuiltins.add(s.id);
  const browser = mine.map((s) => siteRow(s, 'browser'));
  $('sites').replaceChildren(...(browser.length ? browser : [sitesEmptyState()]));
  // Signed in with no site of this browser's own, the group says nothing the account's does not: only the way to add
  // one stays (the field and the popular sites). Signed out, its empty state is the guide to adding the first.
  const noOwn = signedIn && browser.length === 0;
  $('browser-head').hidden = noOwn;
  $('sites').hidden = noOwn;
  renderPopular(of('browser').filter((s) => s.builtin && !listed(s)));
  applySearch();
}

/** The built-in sites not in either list yet, as one-click chips under "Add any site", as on the Pro account page: so
 *  the list holds only what is guarded, and never reads as a fixed menu of the sites OnlyRead supports. A chip switches
 *  its site on (it raises protection, so the settings lock lets it through), and its row joins the list. */
function renderPopular(sites: SiteView[]): void {
  $('popular').hidden = sites.length === 0;
  $('popular-chips').replaceChildren(...sites.map((s) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.title = siteSummary(s.description);
    chip.setAttribute('aria-label', `Add ${s.name}`);
    chip.append(iconImg(s), document.createTextNode(s.name), textEl('span', 'plus', '+'));
    chip.addEventListener('click', () => {
      shownBuiltins.add(s.id);
      void siteChange({ type: 'site:set', id: s.id, enabled: true, ...addScope() }, pro ? 'account' : 'browser').then(() => {
        const row = document.querySelector<HTMLElement>(`.site-row[data-id="${CSS.escape(s.id)}"]`);
        if (row) { row.classList.add('enter'); row.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' }); }
      });
    });
    return chip;
  }));
}

// ---- Overview: the status card

const ACTIONS: Record<OverviewButton, () => void> = {
  enable: () => void change({ type: 'guard:set', enabled: true }),
  enforce: () => void change({ type: 'guard:set', mode: 'enforce' }),
  signin: () => void cloudSignIn(),
  subscribe: () => openLink('pricing'),
  manage: () => openLink('manage'),
  retry: () => void send<CloudStatus>({ type: 'cloud:status', refresh: true }).then(() => refresh(true)),
  'set-key': () => { scrollToSection('ai-judge'); $<HTMLInputElement>('api-key').focus({ preventScroll: true }); },
  unlock: () => void askPin('Enter your settings PIN to apply the change from your Pro account.').then(() => refresh(true)),
  reload: () => chrome.runtime.reload(),
};
let actionNow: OverviewButton | undefined;
$('action-btn').addEventListener('click', () => { if (actionNow) ACTIONS[actionNow](); });
$('setup-undo').addEventListener('click', () => void change({ type: 'agent-setup:undo' }));

/** The overview's three facts, each with its mark (fixed markup). */
const FACT_ICONS: Record<string, string> = {
  Protection: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  Agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 13h.01M15 13h.01M9 17h6"/></svg>',
  'AI judge': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M5 7h14M7 7l-3 7a3 3 0 0 0 6 0L7 7Zm10 0-3 7a3 3 0 0 0 6 0l-3-7Z"/></svg>',
};

function renderOverview(st: Status): void {
  $('status-heading').textContent = overviewHeading(st);
  $('shield').classList.toggle('off', !st.enabled);
  // No AI judge: the way to set one, and no switch (protection cannot be turned on without it) unless it is still on
  // (a sign-out the lock kept from turning it off): then it stays, so it can be turned off.
  $('enabled-switch').hidden = Boolean(st.judgeMissing) && !st.enabled;
  $('set-judge').hidden = !st.judgeMissing;
  $<HTMLInputElement>('enabled').checked = st.enabled;
  $<HTMLInputElement>('enabled').disabled = agentLocked() && st.enabled;
  $('facts').replaceChildren(...overviewFacts(st).map((f) => {
    const div = document.createElement('div');
    div.className = f.warn ? 'fact warn' : 'fact';
    const icon = document.createElement('span');
    icon.className = 'fact-icon';
    icon.innerHTML = FACT_ICONS[f.label] ?? '';
    const text = document.createElement('div');
    text.append(textEl('dt', '', f.label), textEl('dd', f.warn ? 'warn' : '', f.value));
    div.append(icon, text);
    return div;
  }));
  const action = overviewAction(st);
  $('action').hidden = !action;
  $('action-text').textContent = action?.text ?? '';
  actionNow = action?.button?.action;
  $('action-btn').hidden = !action?.button;
  $('action-btn').textContent = action?.button?.label ?? '';
  const setup = setupLine(st.agentSetup);
  $('setup-note').hidden = !setup;
  $('setup-text').textContent = setup ?? '';
}

function renderCounts(st: Status, sites: SiteView[], activity: ActivitySummary | undefined): void {
  setCount($('t-sites'), st.sites.length);
  $('side-sites').textContent = String(st.sites.length);
  const fromAccount = sites.filter((s) => s.account).length;
  $('t-account').textContent = st.cloud?.signedIn && fromAccount ? `${fromAccount} from your account` : '';
  if (!activity) return;
  setCount($('t-refused'), activity.today.refused);
  // Out of every request OnlyRead checked on guarded sites today, reads included.
  $('t-seen').textContent = `of ${activity.today.seen.toLocaleString()} requests checked`;
}

// ---- Activity: the recent refusals, newest first. Reads are not listed.

/** The activity list's pages: how many refusals a page shows, the
 *  person's choice kept in this browser, and where the page starts. */
const ACTIVITY_SIZES = [5, 10, 25, 50];
const SIZE_KEY = 'onlyread.activityPageSize';
let activityLimit = (() => { try { const n = Number(localStorage.getItem(SIZE_KEY)); return ACTIVITY_SIZES.includes(n) ? n : 5; } catch { return 5; } })();
let activityOffset = 0;
/** Each site's icon, from the last Sites list, for activity entries that carry none. */
let siteIcons = new Map<string, string>();
function activityRow(a: ActivityItem, now: number): HTMLElement {
  const row = textEl('div', a.socket ? 'row socket' : 'row', '');
  row.title = a.code; // the internal codes, for whoever wants them
  const logo = textEl('div', 'logo', '');
  logo.append(a.siteId ? iconImg({ id: a.siteId, builtin: a.builtin, domains: [a.host], iconUrl: a.iconUrl ?? siteIcons.get(a.siteId) }) : faviconImg(a.host));
  const meta = textEl('div', 'meta', '');
  const name = textEl('div', 'name', a.what);
  if (a.count && a.count > 1) name.append(' ', textEl('span', 'times', `×${a.count}`));
  // A site's live connections kept closed: one quiet row, said for what it is, with nothing to report.
  if (a.socket) {
    meta.append(name, textEl('div', 'line', 'Not a write: OnlyRead can’t see inside them, so they stay closed'));
    row.append(logo, meta, textEl('span', 'when-ago', relativeTime(a.ts, now)));
    return row;
  }
  meta.append(name, textEl('div', 'line', `Refused on ${a.siteName}`));
  // Refused by mistake: report it (options/report.ts).
  const report = document.createElement('button');
  report.type = 'button';
  report.className = 'report-btn';
  report.title = 'Report a mistake';
  report.setAttribute('aria-label', `Report a mistake: ${a.what} on ${a.siteName}`);
  report.innerHTML = MEGAPHONE;
  report.addEventListener('click', () => void openReport(a.key));
  row.append(logo, meta, textEl('span', 'when-ago', relativeTime(a.ts, now)), report);
  return row;
}

/** No refusal yet: what one looks like, on a loop: an agent's cursor clicks Send, and OnlyRead refuses it (CSS; still,
 *  the refusal shown, with reduced motion). Fixed markup. */
function activityEmpty(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'activity-empty';
  box.innerHTML =
    '<div class="refuse-demo" aria-hidden="true">' +
    '<span class="rd-send">Send<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
    '<span class="rd-lock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span></span>' +
    '<span class="rd-chip">Refused</span>' +
    '<span class="rd-cursor"><svg width="15" height="17" viewBox="0 0 18 20"><path d="M1 1v15l4.2-3.9 2.8 6.4 2.9-1.3-2.8-6.3H14z" fill="#fff" stroke="#1d1320" stroke-width="1.5" stroke-linejoin="round"/></svg></span></div>' +
    '<div class="words"><b>Nothing refused yet</b><span>When OnlyRead stops a write, it shows up here.</span></div>';
  return box;
}

let lastActivity = '';
function renderActivity(a: ActivitySummary | undefined): void {
  if (!a) return;
  const sig = JSON.stringify([a.recent, a.more, a.total, a.offset, Math.floor(Date.now() / 30_000)]);
  if (sig === lastActivity) return;
  lastActivity = sig;
  const now = Date.now();
  $('activity-list').replaceChildren(...(a.recent.length ? a.recent.map((r) => activityRow(r, now)) : [activityEmpty()]));
  renderPager(a);
}

/** "1–5 of 37", the per-page choice and Previous/Next; hidden while one page holds every refusal. */
function renderPager(a: ActivitySummary): void {
  // The page asked for was past the end (refusals aged out): stay on the last one the service gave.
  if (a.offset < activityOffset) activityOffset = a.offset;
  const total = a.total;
  $('activity-foot').hidden = total <= ACTIVITY_SIZES[0]!;
  $('activity-range').textContent = total ? `${a.offset + 1}–${a.offset + a.recent.length} of ${total}` : '';
  $<HTMLSelectElement>('activity-size').value = String(activityLimit);
  $<HTMLButtonElement>('activity-prev').disabled = a.offset === 0;
  $<HTMLButtonElement>('activity-next').disabled = !a.more;
}
$('activity-prev').addEventListener('click', () => { activityOffset = Math.max(0, activityOffset - activityLimit); void refresh(true); });
$('activity-next').addEventListener('click', () => { activityOffset += activityLimit; void refresh(true); });
$('activity-size').addEventListener('change', (ev) => {
  activityLimit = Number((ev.target as HTMLSelectElement).value) || 5;
  activityOffset = 0;
  try { localStorage.setItem(SIZE_KEY, String(activityLimit)); } catch { /* not kept */ }
  void refresh(true);
});

// ---- The page, refreshed every few seconds

let lastSignature = '';
async function refresh(force = false): Promise<void> {
  // The activity page this refresh asks for: its answer is drawn only if the person has not moved since (a refresh
  // every 3 s overlaps a click on Next, and its older answer put the page back).
  const asked = { limit: activityLimit, offset: activityOffset };
  const [sites, status, activity] = await Promise.all([
    send<SiteView[]>({ type: 'sites:list' }),
    send<Status>({ type: 'status:get' }),
    send<ActivitySummary>({ type: 'activity:get', ...asked }).catch(() => undefined),
  ]);
  const current = asked.limit === activityLimit && asked.offset === activityOffset;
  lock = status.lock;
  siteIcons = new Map(sites.filter((s) => s.iconUrl).map((s) => [s.id, s.iconUrl!]));
  renderCounts(status, sites, activity);
  if (current) renderActivity(activity);
  // Re-render the rest only when the data changed, so an open menu is not rebuilt underneath the reader.
  const signature = JSON.stringify([status.judgeMissing, status.enabled, status.mode, status.attachWhen, status.attachmentActive, status.agentSession, status.judge, status.judgeProblem, status.judgeConsent, status.byokLabel, status.cloud, status.lock, status.storageProblem, status.startupProblem, status.verdictsProblem, status.policyProblem, status.managed, status.managedPending, status.accountRefused, status.agentSetup, status.guardAll, status.allowReadTracking, status.devServices, sites.map((s) => [s.id, s.enabled, s.name, s.iconUrl, s.local, s.account, s.scopes, s.waiting])]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  pro = proMode(status);
  browsers = status.managed?.browsers ?? 1;
  renderProManaged(status);
  renderOverview(status);
  renderSecurity(status);
  renderManaged(status, sites);
  renderLock();
  renderPin();
  keyInUse = !status.cloud?.signedIn && !status.judgeMissing;
  renderCloud(status.cloud);
  renderSites(sites, Boolean(status.cloud?.signedIn));
  renderGuardAll(status);
  renderReadTracking(status);
  accountManagedControls();
}

// ---- Guard every site: the switch, and the hosts left unguarded.
/** What the Pro account sets (for every browser, or for this one on the account page), which this browser cannot undo. */
function accountGuardAllLine(g: NonNullable<Status['guardAll']>): string {
  const from = [g.account?.on && 'for every browser on it', g.browser?.on && 'for this browser'].filter(Boolean).join(' and ');
  if (!from) return '';
  const excluded = g.excludeInForce.length ? `Excluded: ${g.excludeInForce.join(', ')}.` : 'No site is excluded.';
  return `Your OnlyRead Pro account guards every site ${from}. ${excluded} A site excluded here stays guarded unless the account excludes it too.`;
}

function renderGuardAll(st: Status): void {
  const g = st.guardAll ?? { local: false, excludeSites: [], inForce: false, excludeInForce: [] };
  const line = accountGuardAllLine(g);
  $('guard-all-account').hidden = !line;
  $('guard-all-account').textContent = line;
  $<HTMLInputElement>('guard-all').checked = g.local;
  $('guard-all-text').textContent = g.local
    ? 'On: every site is guarded except the ones excluded here. Sites OnlyRead has no profile for go to the AI judge.'
    : 'Off: only the sites below are guarded.';
  $('exclude-section').hidden = !g.local;
  const list = $('exclude-list');
  list.replaceChildren(...(g.excludeSites.length ? g.excludeSites.map(excludeRow) : [Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No site is excluded: every site is guarded.' })]));
}
function excludeRow(host: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  const name = Object.assign(document.createElement('span'), { className: 'name', textContent: host });
  const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Guard again' });
  remove.addEventListener('click', () => void change({ type: 'exclude:remove', host }));
  row.append(name, remove);
  return row;
}
$('guard-all').addEventListener('change', async (ev) => {
  const box = ev.target as HTMLInputElement;
  await change({ type: 'guard-all:set', on: box.checked });
});
async function excludeSite(): Promise<void> {
  const input = $<HTMLInputElement>('exclude-host');
  const r = await change<{ ok?: boolean; error?: string }>({ type: 'exclude:add', host: input.value });
  $('exclude-result').textContent = r?.error ?? '';
  if (!r?.error) input.value = '';
}
$('exclude-add').addEventListener('click', () => void excludeSite());
// Enter in the box does what the button there does, like the add box further down.
$('exclude-host').addEventListener('keydown', (e) => { if (e.key === 'Enter') void excludeSite(); });

// ---- Read tracking: changes that only record what was seen, through or refused.
function renderReadTracking(st: Status): void {
  const on = st.allowReadTracking === true;
  $<HTMLInputElement>('read-tracking').checked = on;
  $('read-tracking-text').textContent = on
    ? 'On: marking notifications or messages as seen, read receipts and view settings go through. They record what was seen, nothing written.'
    : 'Off: they are refused like any change, so unread badges stay unread.';
}
$('read-tracking').addEventListener('change', (ev) => {
  void change({ type: 'read-tracking:set', on: (ev.target as HTMLInputElement).checked });
});

// ---- Security: when to protect, the dev-only monitor switch.
const WHEN_LINE: Record<string, string> = {
  'agent-session': 'During agent sessions. Chrome shows its debugging banner only while an agent works.',
  always: 'Always. Chrome shows its debugging banner the whole time.',
};
function renderSecurity(st: Status): void {
  $('when-line').textContent = WHEN_LINE[st.attachWhen] ?? '';
  for (const r of document.querySelectorAll<HTMLInputElement>('#when input[name="when"]')) r.checked = r.value === st.attachWhen;
  $('dev').hidden = !st.devBuild;
  $<HTMLInputElement>('monitor').checked = st.mode === 'monitor';
  renderDevService(st);
}

/** Development builds: the Pro service in use, the local mock or production (any other address shows as neither). */
function renderDevService(st: Status): void {
  const s = st.devServices;
  $('dev-service').hidden = !s;
  if (!s) return;
  const url = (st.cloud?.serviceUrl ?? '').replace(/\/$/, '');
  const which = url === s.local ? 'local' : url === s.production ? 'production' : '';
  $<HTMLSelectElement>('pro-service').value = which;
  $('dev-service-line').textContent = `${url || 'None'}. Switching signs this browser out of Pro.`;
}
$('pro-service').addEventListener('change', (ev) => {
  const service = (ev.target as HTMLSelectElement).value === 'local' ? 'local' : 'production';
  void change({ type: 'cloud:service-set', service });
});

// ---- Sites from the Pro account (background/cloud-sync.ts): when its list was applied, what waits. No version on the
// page: Status.managed.version is for the log and tests.
const clock = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function renderManaged(st: Status, sites: SiteView[]): void {
  const m = st.managed;
  const signedIn = Boolean(st.cloud?.signedIn);
  // The account's group: shown while signed in to Pro, and while a list or a pending change from it is held. With
  // your own key and no account sites to show (not signed in, or none on the account), a line inviting to Pro instead.
  const invite = st.cloud?.provider === 'byok' && !st.managedPending && (!signedIn || !sites.some((x) => x.account));
  $('pro-prompt').hidden = !invite;
  $('account-section').hidden = invite || (!signedIn && !m && !st.managedPending);
  $('managed-head').textContent = pro ? 'Guarded sites' : 'Managed by your Pro account';
  // Pro out of reach: this page stands in, with the account's sites as last synced.
  const where = pro && !proManaged(st.cloud) && m ? `Pro can't be reached. Your account's sites as of ${clock(m.at)}.` : accountWhere();
  // Pro mode says as little as it can: the rows say the rest (where, and a spinner while a change is on its way).
  const applied = m && !pro ? `\nLast applied ${clock(m.at)}.` : '';
  $('managed-text').textContent = m || signedIn ? `${where}${applied}` : 'Your Pro account has a change for the sites guarded here.';
  $('managed-pending').textContent = st.managedPending ? `${st.managedPending}.` : '';
  // A change made here the account refused stays said until a later one is taken (background/cloud-sync.ts).
  if (st.accountRefused) addNote(st.accountRefused, 'err', 'account');
  // The add box: to the account in Pro mode, with where it goes once there are two or more browsers.
  $<HTMLInputElement>('add-host').placeholder = pro ? 'Add any site, e.g. app.example.com' : 'Add any site to this browser, e.g. app.example.com';
  $('add-scope').hidden = !(pro && browsers > 1);
}

/** Pro mode with Pro reachable: the account page manages this browser, so this page is cut to the card that opens it
 *  and the AI judge (PLAN-PRO-UI step 6). Framed on the account page it shows its section as asked, and out of reach
 *  the whole page stands in, the account's sites as last synced. */
function renderProManaged(st: Status): void {
  const managedThere = !framed && proManaged(st.cloud);
  document.documentElement.classList.toggle('pro-mode', managedThere);
  $('pro-managed').hidden = !managedThere;
  // No AI judge: the page is only the way to set one, as the popup is. A fresh install is here with protection on (the
  // default), and so is a sign-out the lock kept from turning it off: either way, setting a judge is the one thing to do.
  const gate = !framed && !managedThere && Boolean(st.judgeMissing);
  document.documentElement.classList.toggle('judge-setup', gate);
  $('judge-gate').hidden = !gate;
  if (gate) mountScene($('judge-gate').querySelector<HTMLElement>('.scene'));
  else document.documentElement.classList.remove('gate-byok');
  try { localStorage.setItem(GATE_KEY, gate ? '1' : '0'); } catch { /* the next load waits for the status */ }
  shown();
}
// The gate's two ways: Pro's button signs in as #cloud-signin does; "Your own key" brings in the key form below it.
$('gate-signin').addEventListener('click', () => void cloudSignIn($<HTMLButtonElement>('gate-signin')));
$('gate-byok').addEventListener('click', () => {
  const open = !document.documentElement.classList.contains('gate-byok');
  const apply = (): void => {
    document.documentElement.classList.toggle('gate-byok', open);
    if (open) document.querySelector<HTMLButtonElement>('#provider-seg [data-provider="byok"]')?.click();
  };
  // The parts that leave, come in and move do so as one morph (options.html view-transition names), not a jump.
  const morph = (document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }).startViewTransition;
  if (!morph || reducedMotion()) { apply(); if (open) scrollToSection('ai-judge'); return; }
  void morph.call(document, apply).finished.then(() => { if (open) $('api-key').focus({ preventScroll: true }); });
});
$('pro-managed-open').addEventListener('click', () => void send({ type: 'settings:open', section: 'overview' }));

/** What the account's sites are guarded for. In Pro mode, with two or more browsers, each row's tag says where. */
function accountWhere(): string {
  return pro ? 'Saved on your Pro account.' : 'Guarded in every browser signed in to your account.';
}

/** Where an addition goes on the account (Pro mode with two or more browsers): the box's choice. */
const addScope = (): { scope?: 'account' | 'browser' } => (pro && browsers > 1 ? { scope: $<HTMLSelectElement>('add-scope').value === 'account' ? 'account' : 'browser' } : {});

// The account's list is fetched when this page opens and whenever it is shown again (throttled in the background),
// and the account page pings the background as soon as it saves, so there is no Sync now anywhere.
const syncShown = () => void send<Status>({ type: 'cloud:sync', reason: 'settings' }).then(() => refresh(true));
syncShown();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncShown(); });
$('managed-change').addEventListener('click', () => openLink('manage'));
$('set-judge').addEventListener('click', () => scrollToSection('ai-judge'));
// Join OnlyRead Pro: the AI judge section, where Pro is chosen and signed in to.
$('pro-join').addEventListener('click', () => { document.querySelector<HTMLButtonElement>('#provider-seg [data-provider="cloud"]')?.click(); scrollToSection('ai-judge'); });

$('enabled').addEventListener('change', (ev) => {
  void change({ type: 'guard:set', enabled: (ev.target as HTMLInputElement).checked });
});
// "Always" keeps the debugger attached, so Chrome shows its banner the whole time: confirm first.
const alwaysDialog = $<HTMLDialogElement>('always-dialog');
$('when').addEventListener('change', async (ev) => {
  const r = ev.target as HTMLInputElement;
  if (r.name !== 'when') return;
  if (r.value === 'always') {
    alwaysDialog.returnValue = '';
    alwaysDialog.showModal();
    const choice = await new Promise<string>((resolve) => alwaysDialog.addEventListener('close', () => resolve(alwaysDialog.returnValue), { once: true }));
    if (choice !== 'confirm') { await refresh(true); return; }
  }
  await change({ type: 'guard:set', attachWhen: r.value === 'always' ? 'always' : 'agent-session' });
  setPanel('when', false);
});

/** A Security row's form, opened under the row by its button and closed again after a save or by the button. */
function setPanel(which: 'when' | 'pin', open: boolean): void {
  const panel = $(`${which}-panel`);
  const toggle = $(`${which}-toggle`);
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (open) { toggle.textContent = 'Cancel'; toggle.classList.remove('primary'); panel.querySelector<HTMLInputElement>('input:not([type=hidden])')?.focus(); }
  else if (which === 'when') toggle.textContent = 'Change';
  else { renderPin(); }
}
for (const which of ['when', 'pin'] as const) {
  $(`${which}-toggle`).addEventListener('click', () => setPanel(which, $(`${which}-toggle`).getAttribute('aria-expanded') !== 'true'));
}
$('monitor').addEventListener('change', (ev) => {
  void change({ type: 'guard:set', mode: (ev.target as HTMLInputElement).checked ? 'monitor' : 'enforce' });
});
/** The add box under this browser's sites. A host goes to the Pro account's list from the account page. */
const addInput = $<HTMLInputElement>('add-host');
async function addSite(): Promise<void> {
  const host = addInput.value.trim().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  if (!host) return;
  let r: SiteView[] | { ok: false; error: string } | undefined;
  // A host the background refuses (not a host, a public suffix) comes back as an error, not a lock: say why here.
  try { r = await change<SiteView[] | { ok: false; error: string }>({ type: 'site:add', host, ...addScope() }); } catch (err) { addNote(err instanceof Error ? err.message : String(err), 'err', 'browser'); return; }
  if (!r) return;
  if (!Array.isArray(r)) { addNote(r.error, 'err', 'browser'); return; }
  addInput.value = '';
  // A host a verified site covers switches that site on rather than adding a copy: say so.
  const h = host.toLowerCase().replace(/^www\./, '');
  const covered = r.find((s) => s.builtin && s.domains.some((d) => h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`)));
  if (covered) addNote(`${host} is covered by ${covered.name}, a verified site. It is switched on.`, 'ok', 'browser');
  // In Pro mode the row sliding in says it: no words.
  else if (pro) addNote('', '', 'browser');
  else addNote(`${host} added. It is guarded by the AI judge alone.`, '', 'browser');
  const added = document.querySelector<HTMLElement>(`.site-row[data-id="${CSS.escape(covered?.id ?? h)}"]`);
  if (added) { added.classList.add('enter'); added.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' }); }
}
$('add').addEventListener('click', () => void addSite());
addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void addSite(); });

// ---- AI judge, own key: gateway, key and review model (shared with the first-run window).
function keyResult(text: string, kind: '' | 'ok' | 'err' | 'warn' = ''): void { const el = $('key-result'); el.textContent = text; el.className = `result ${kind}`; }
const byokForm = mountByokForm();
$('save-key').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('save-key');
  btn.classList.add('busy'); // spins while it saves and tests; no "testing" line
  keyResult('');
  try {
    await agreeToJudge(); // saving a key is the agreement the note under it states
    const form = await byokForm;
    // Tested before anything is stored: a key or provider that fails leaves the judge in force as it was.
    const r = await unlocking(() => form.save());
    if (!r) { await refresh(true); return; }
    if (!r.ok && r.problem) { keyResult(`Not ready yet: ${r.problem}. Nothing was changed.`, 'warn'); await refresh(true); return; }
    const anthropic = anthropicLine(r.anthropic);
    // Working: the button says so for a moment (and the confetti); only an Anthropic key that failed is written out.
    keyResult(r.ok ? (r.anthropic?.ok === false ? anthropic.trim() : '') : `The test failed, so nothing was changed: ${r.error}${anthropic}`, !r.ok ? 'err' : 'warn');
    if (r.ok) { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 2200); }
    // The first AI judge this browser sets up is followed by the demo (shared/first-judge.ts), a key as well as Pro.
    if (r.ok && (await markFirstJudge())) setTimeout(() => void send({ type: 'setup:open', step: 'demo' }), 1200);
    // A key that works is a judge: protection goes on (off for want of one until now). Raising it, so never refused.
    if (r.ok) { celebrate(btn); await send({ type: 'guard:set', enabled: true }).catch(() => undefined); }
    await refresh(true);
  } finally { btn.classList.remove('busy'); }
});
$('clear-key').addEventListener('click', async () => {
  const form = await byokForm;
  if ((await unlocking(() => form.removeKey().then(() => true))) === undefined) { await refresh(true); return; }
  keyResult('');
  document.documentElement.classList.remove('gate-byok');
  await refresh(true);
  window.scrollTo({ top: 0 });
});

// ---- AI judge provider: your own key or OnlyRead Pro.
function cloudResult(text: string, kind: '' | 'ok' | 'err' | 'warn' = ''): void {
  for (const id of ['cloud-result', 'gate-result']) { const el = $(id); el.textContent = text; el.className = `result ${kind}`; }
}
let lastCloud: CloudStatus | undefined;
/** Two modes, never mixed: Pro (signed in) or an own key (no sign-in). The switch only shows a panel; signing in, or
 *  saving a key, is what changes the mode, and each panel says what its action does to the other mode. */
let viewing: 'cloud' | 'byok' | undefined;
/** An own key judges here now (signed out, and a judge answers). */
let keyInUse = false;
function renderCloud(c: CloudStatus | undefined): void {
  if (!c) return;
  lastCloud = c;
  const shown = viewing ?? (c.signedIn ? 'cloud' : keyInUse ? 'byok' : 'cloud');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#provider-seg button')) {
    const on = b.dataset.provider === shown;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  }
  $('byok-panel').hidden = shown !== 'byok';
  $('cloud-panel').hidden = shown !== 'cloud';
  $('byok-leaves-pro').hidden = !c.signedIn;
  renderCloudAccount(c);
  renderCloudButtons(c);
  // Signed out, the panel itself says so (renderCloudAccount); the warning line is for the other problems.
  const problem = cloudProblem(c);
  const issue = problem?.action === 'signin' && !c.signedIn ? undefined : problem;
  if (issue && !$('cloud-result').textContent) cloudResult(issue.text, 'warn');
  else if (!issue && $('cloud-result').className.includes('warn')) cloudResult('');
}

/** Who is signed in, their plan status, and how much of the month's allowance is used. */
function renderCloudAccount(c: CloudStatus): void {
  const a = c.account;
  const line = $('cloud-account');
  line.replaceChildren(); // the e-mail and status are the server's text: nodes, not markup
  $('cloud-name').textContent = c.signedIn ? 'OnlyRead Pro' : c.signedOutAt ? 'Sign in to OnlyRead Pro again' : 'Sign in to OnlyRead Pro';
  if (!c.signedIn) {
    line.append(c.signedOutAt ? 'OnlyRead Pro signed this browser out.' : 'The AI judge, run for you. No key to manage.');
  } else if (!a) line.textContent = 'Signed in.';
  else {
    const who = document.createElement('b');
    who.textContent = a.name || a.email;
    line.append('Signed in as ', who, `, ${accountStatusText(a)}`);
  }
  // Signed out: Pro's perks instead of the account (and Sign in gently pulsing).
  $('cloud-perks').hidden = c.signedIn;
  $('cloud-panel').classList.toggle('offer', !c.signedIn);
  const usage = cloudUsage(c);
  $('cloud-usage-wrap').hidden = !usage;
  if (!a || !usage) return;
  const pct = usagePercent(a.usage, a.cap);
  const bar = $('cloud-usage-bar'); bar.style.width = `${pct}%`; bar.classList.toggle('full', pct >= 100);
  $('cloud-usage').textContent = usage;
}

/** Sign in or out, test, subscribe (only without an active plan) and manage (only with an account). */
function renderCloudButtons(c: CloudStatus): void {
  const a = c.account;
  const active = accountActive(a);
  $('cloud-signin').hidden = c.signedIn;
  $('cloud-signin').querySelector('.label')!.textContent = c.signedOutAt ? 'Sign in again' : 'Start free with Pro';
  $('cloud-signout').hidden = !c.signedIn;
  $('cloud-subscribe').hidden = !c.signedIn || active;
  $('cloud-manage').hidden = !c.signedIn || !a;
  $('cloud-manage').textContent = a?.manageLabel ?? (a?.credits ? 'Manage account' : 'Manage subscription');
  $('cloud-subscribe').textContent = a?.offer?.label ?? 'Get Pro';
  // One button in the accent: Get Pro when it is offered, else the account's.
  $('cloud-manage').classList.toggle('primary', !c.signedIn || active);
  $('cloud-actions').hidden = !c.signedIn;
}
$('provider-seg').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-provider]');
  if (!b) return;
  cloudResult('');
  viewing = b.dataset.provider === 'cloud' ? 'cloud' : 'byok';
  renderCloud(lastCloud);
});
/** This tab goes to the Pro sign-in page and comes back here when it ends (the result in the address). The button spins
 *  until the page leaves; only a failure is written out. */
async function cloudSignIn(btn = $<HTMLButtonElement>('cloud-signin')): Promise<void> {
  cloudResult('');
  btn.classList.add('busy');
  await agreeToJudge(); // signing in is the agreement the note under it states
  const r = await send<{ ok: boolean; locked?: boolean; error?: string; cloud: CloudStatus }>({ type: 'cloud:signin' });
  if (!r.ok) { btn.classList.remove('busy'); cloudResult(r.locked ? (r.error ?? '') : `Sign-in failed: ${r.error}`, 'err'); renderCloud(r.cloud); }
}
// Back from the sign-in page with the browser's Back button: the page comes from the cache with its button still spinning.
addEventListener('pageshow', (e) => { if (e.persisted) for (const id of ['cloud-signin', 'gate-signin']) $(id).classList.remove('busy'); });
function showSignInResult(): void {
  const back = takeSignInResult();
  if (!back) return;
  if (!back.ok) cloudResult(`Sign-in failed: ${back.reason ?? 'unknown error'}`, 'err');
  if (document.getElementById('ai-judge')) scrollToSection('ai-judge');
}
$('cloud-signin').addEventListener('click', () => void cloudSignIn());
// Withdrawn, nothing is sent to a judge until the next Sign in or Save.
$('cloud-signout').addEventListener('click', async () => {
  viewing = undefined;
  renderCloud(await send<CloudStatus>({ type: 'cloud:signout' }));
  cloudResult('');
  await refresh(true);
});
/** The account's pages: getting Pro goes where the service's offer points, else to its pricing page. */
const openLink = (which: 'pricing' | 'manage') => {
  const a = lastCloud?.account;
  const u = which === 'pricing' ? (a?.offer?.url ?? a?.links.pricing) : a?.links.manage;
  if (u) void chrome.tabs.create({ url: u });
};
$('cloud-subscribe').addEventListener('click', () => openLink('pricing'));
$('cloud-manage').addEventListener('click', () => openLink('manage'));

// ---- The settings lock (background/protection.ts). While an AI agent works, every change that lowers
// protection is refused; with a settings PIN set, such a change asks for the PIN first.
let lock: SettingsLock | undefined;
let refused = '';
const agentLocked = () => lock?.agent === true;

/** A browser that belongs to an AI agent: its settings are managed from the Pro account page alone. */
const agentBrowser = () => lock?.agentBrowser === true;

function renderLock(): void {
  if (!agentLocked() && refused.startsWith('An AI agent')) refused = '';
  const text = agentBrowser()
    ? 'This browser belongs to an AI agent. Its sites and settings are managed from your OnlyRead Pro account page. Nothing here can be changed.'
    : agentLocked() ? 'An AI agent is active in this browser. Settings that lower protection are locked until it finishes.' : refused;
  $('lock').hidden = !text;
  setLockText($('lock-text'), text);
  accountManagedControls();
}

/** In an agent's browser every control that edits settings is off, adding included (the background refuses them as
 *  well). Run after each part of the page is drawn. */
function accountManagedControls(): void {
  document.body.classList.toggle('account-managed', agentBrowser());
  if (!agentBrowser()) return;
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('#guarded-sites input, #guarded-sites button, #security input, #security button')) el.disabled = true;
}

/** Run a change; when the PIN is asked for, ask for it and run the change once more. Resolves undefined
 *  when the change was refused (the reason is on the page). */
async function unlocking<T>(run: () => Promise<T>): Promise<T | undefined> {
  try { return await run(); } catch (err) {
    const locked = lockedBy(err);
    if (!locked) throw err;
    if (locked.reason === 'agent') { refused = locked.text; renderLock(); return undefined; }
    if (!(await askPin(locked.text))) return undefined;
    return run();
  }
}

/** Send a settings change through the lock, then show the result. */
async function change<T>(msg: Message): Promise<T | undefined> {
  try { return await unlocking(() => send<T>(msg)); } finally { await refresh(true); }
}

const pinDialog = $<HTMLDialogElement>('pin-dialog');
/** Ask for the settings PIN; true once it unlocked the settings. */
async function askPin(why: string): Promise<boolean> {
  $('pin-why').textContent = why;
  $('pin-err').textContent = '';
  $<HTMLInputElement>('pin-entry').value = '';
  pinDialog.returnValue = '';
  pinDialog.showModal();
  await new Promise((resolve) => pinDialog.addEventListener('close', resolve, { once: true }));
  return pinDialog.returnValue === 'unlocked';
}
$('pin-form').addEventListener('submit', async (ev) => {
  if ((ev as SubmitEvent).submitter?.id !== 'pin-unlock') return;
  ev.preventDefault();
  const r = await send<{ ok: boolean; error?: string }>({ type: 'pin:unlock', pin: $<HTMLInputElement>('pin-entry').value.trim() });
  if (r.ok) { pinDialog.close('unlocked'); return; }
  $('pin-err').textContent = r.error ?? 'That PIN is not right.';
  $<HTMLInputElement>('pin-entry').select();
});

// ---- Settings PIN: set, change, remove (Security).
function pinResult(text: string, kind: '' | 'ok' | 'err' = ''): void { const el = $('pin-result'); el.textContent = text; el.className = `result ${kind}`; }
function renderPin(): void {
  const set = lock?.pinSet === true;
  $('pin-line').textContent = set
    ? 'Set. Turning protection off, switching a site off or changing the AI judge asks for it first.'
    : 'Some AI agents drive the whole computer. OnlyRead cannot detect those, putting a PIN will prevent the agent from disabling our protection.';
  const toggle = $('pin-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') { toggle.textContent = set ? 'Change PIN' : 'Set a PIN'; toggle.classList.toggle('primary', !set); }
  $('pin-current-field').hidden = !set;
  $('pin-new-label').textContent = set ? 'New PIN, 4 to 12 digits' : 'PIN, 4 to 12 digits';
  $('pin-save').textContent = set ? 'Change PIN' : 'Set PIN';
  $('pin-remove').hidden = !set;
}
const pinField = (id: string) => $<HTMLInputElement>(id).value.trim();
const clearPinFields = () => { for (const id of ['pin-current', 'pin-new']) $<HTMLInputElement>(id).value = ''; };
$('pin-save').addEventListener('click', async () => {
  const set = lock?.pinSet === true;
  try {
    const r = await send<{ ok: boolean; error?: string }>({ type: 'pin:set', pin: pinField('pin-new'), ...(set ? { current: pinField('pin-current') } : {}) });
    if (r.ok) { clearPinFields(); setPanel('pin', false); }
    pinResult(r.ok ? (set ? 'PIN changed.' : 'PIN set. Lowering protection now asks for it.') : r.error ?? 'Could not set the PIN.', r.ok ? 'ok' : 'err');
  } catch (err) {
    // A first PIN while an agent works is refused as a lock (messages.ts setPin): the reason goes where the result does.
    const locked = lockedBy(err);
    if (!locked) throw err;
    pinResult(locked.text, 'err');
  }
  await refresh(true);
});
$('pin-remove').addEventListener('click', async () => {
  try {
    const r = await send<{ ok: boolean; error?: string }>({ type: 'pin:clear', pin: pinField('pin-current') });
    if (r.ok) { clearPinFields(); setPanel('pin', false); }
    pinResult(r.ok ? 'PIN removed.' : r.error ?? 'Could not remove the PIN.', r.ok ? 'ok' : 'err');
  } catch (err) {
    const locked = lockedBy(err);
    if (!locked) throw err;
    pinResult(locked.text, 'err');
  }
  await refresh(true);
});

// The entrance plays once, as the first answer arrives; a link to a section (the notice's "Sign in to Pro" opens
// #ai-judge) scrolls there once the page has its height.
installSidebar($('side'));
$('legal-version').textContent = chrome.runtime.getManifest().version;
void refresh().then(async () => {
  if (framed) { allowFrame((await send<Status>({ type: 'status:get' })).cloud?.serviceUrl ?? ''); return; }
  const at = location.hash.slice(1);
  if (at && document.getElementById(at)) scrollToSection(at);
  showSignInResult();
});
void send({ type: 'sites:discover' });
const refreshing = setInterval(() => {
  if (extensionGone()) { clearInterval(refreshing); return; } // reloaded or updated: this page has no extension behind it
  void refresh();
}, 3000);
