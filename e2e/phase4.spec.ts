// Sites from the Pro account (background/cloud-sync.ts), against the fixture's mock Pro service. The account's list
// is guarded together with this browser's own: a site the account lists is guarded
// here with no local toggle and the local sites stay guarded; the settings page lists the two apart ("Managed by your
// Pro account", "Managed by this browser") and adds a site to every browser on the account; a list that
// drops a site only the account guarded waits while an agent (Playwright's CDP session) works, and so does a removal
// from the account made here.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4231);
// A custom site in the account's list is a host name of at least two labels (policy.ts normalizeManaged),
// which `localhost` is not: the fixture tab is opened at 127.0.0.1 and the list guards that.
const FIXTURE = { id: '127.0.0.1', name: 'fixture', domains: ['127.0.0.1'], enabled: true };
const OTHER = { id: 'other.example', name: 'Other', domains: ['other.example'], enabled: true };

test.beforeAll(async () => {
  // The browser's own settings guard some other site, not the fixture.
  await h.start({ mode: 'enforce', reviewBand: 'block', customSites: [OTHER] });
  await h.signInToMock();
  await h.page.goto(`http://127.0.0.1:${h.port}/`);
});
test.afterAll(async () => { await h.stop(); });

const mockList = async () => ((await (await fetch(`${h.base}/cloud/__mock`)).json()) as { state: { managed: { enabled: boolean; version: number; customSites: { id: string; name: string }[] } } }).state.managed;
const optionsPage = async () => {
  const options = await h.ctx.newPage();
  await options.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html`);
  return options;
};

test('a site the Pro account guards is guarded here, with no local toggle, and the local sites stay guarded', async () => {
  expect((await h.status()).targetDomains).not.toContain('127.0.0.1');
  expect(await h.pageFetch('POST', '/api/items', '{"name":"before"}')).toBe('status:201');
  // Playwright's CDP session is an agent to OnlyRead from the start; adding a site raises protection, so it applies.
  expect((await h.status()).agentSession).toBe(true);
  await h.mock({ managed: { enabled: true, sites: {}, customSites: [FIXTURE] } });
  await h.syncManaged();
  await h.waitFor(async () => (await h.status()).targetDomains.includes('127.0.0.1'), 'the account list in force');
  const st = await h.status();
  expect(st.managed?.version).toBe(1);
  expect(st.targetDomains).toContain('other.example'); // the union: this browser's own site is still guarded
  expect(await h.pageFetch('POST', '/api/items', '{"name":"managed-blocked"}')).toMatch(/^error:/);
  expect((await h.serverLog()).filter((e) => e.method === 'POST' && e.path === '/api/items' && e.body?.includes('managed-blocked'))).toEqual([]);
  // The in-page notice names the site in plain words, with no internal code in view.
  const notice = h.page.locator('[data-onlyread="notice"]');
  await expect(notice.locator('.title')).toHaveText('OnlyRead kept fixture read-only');
  await expect(notice.locator('.codes')).toBeHidden();
  await expect(notice.locator('.box')).not.toContainText('Nice try');
  await notice.locator('button.dismiss').click();
  await expect(notice.locator('.box')).toBeHidden();
  // The local settings are untouched underneath.
  const { policy } = await h.sw.evaluate(() => chrome.storage.local.get('policy'));
  expect((policy as { customSites: { id: string }[] }).customSites.map((c) => c.id)).toEqual(['other.example']);
});

test('the settings page lists the account\'s sites and this browser\'s apart, shows no version, and changes the account only on its page', async () => {
  const options = await optionsPage();
  // A built-in site is listed once it is switched on in this browser; one never added waits like any other site.
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'site:set', id: 'gmail', enabled: true }));
  // Two sections: the fixture under "Managed by your Pro account", with nothing to change it here (the account page
  // does); this browser's own sites under "Managed by this browser", each with its trash button. No chips, no version.
  const fixture = options.locator('#account-sites .site-row[data-id="127.0.0.1"]');
  await expect(fixture).toBeVisible();
  await expect(fixture.locator('button, input')).toHaveCount(0);
  await expect(options.locator('#sites .site-row[data-id="127.0.0.1"]')).toHaveCount(0);
  const other = options.locator('#sites .site-row[data-id="other.example"]');
  // Its trash button: removing lowers protection, so it is disabled while an agent (this CDP session) works.
  await expect(other.locator('.icon-btn.danger')).toHaveAttribute('aria-label', 'Remove Other');
  await expect(other.locator('.icon-btn.danger')).toBeDisabled();
  await expect(other.locator('input[type="checkbox"]')).toHaveCount(0); // the switch lives in the popup only
  // Tested sites say so quietly on the right; the search box filters the rows.
  await expect(options.locator('#sites .site-row[data-id="gmail"] .tested')).toHaveCount(0); // no tested numbers beside a site
  await options.locator('#site-search').fill('other');
  await expect(options.locator('#sites .site-row[data-id="gmail"]')).toBeHidden();
  await expect(other).toBeVisible();
  await options.locator('#site-search').fill('');
  await expect(options.locator('#account-sites .site-row[data-id="other.example"]')).toHaveCount(0);
  await expect(options.locator('#sites .site-row[data-id="gmail"]')).toBeVisible(); // a built-in the account does not list
  // The built-in sites not listed yet are offered under "Add any site" as popular ones, one click to add (as on the Pro
  // account page); a listed one is not among them.
  await expect(options.locator('#popular')).toBeVisible();
  await expect(options.locator('#popular-chips .chip[aria-label="Add Linear"]')).toBeVisible();
  await expect(options.locator('#popular-chips .chip[aria-label="Add Gmail"]')).toHaveCount(0);
  await expect(options.locator('#sites .site-row[data-id="linear"]')).toHaveCount(0);
  await expect(options.locator('.badge.scope')).toHaveCount(0);
  // GET /v1/me told the service about this browser (x-onlyread-browser): platform, the sites guarded now, the version.
  const seenBrowser = async () => ((await (await fetch(`${h.base}/cloud/__mock`)).json()) as { browser: { platform: string; sites: number; version: string } | null }).browser;
  await h.waitFor(async () => Boolean(await seenBrowser()), 'the browser header on GET /v1/me');
  // (The count is the one at the last GET /v1/me, which may predate the account's list.)
  const told = await seenBrowser();
  expect(told).toEqual({ platform: expect.stringMatching(/^(mac|windows|linux|chromeos|other)$/), sites: expect.any(Number), version: await h.sw.evaluate(() => chrome.runtime.getManifest().version) });
  expect(told!.sites).toBeGreaterThanOrEqual(1);
  // The refusal from the first test is in Activity, under the site it was made on; today's count says so too.
  await expect(options.locator('#activity-list .row').first()).toContainText('Refused on fixture');
  await expect(options.locator('#t-refused')).not.toHaveText('0');
  await expect(options.locator('#managed-text')).toContainText('Last applied');
  await expect(options.locator('#managed-text')).not.toContainText(/version/i);
  // The account's list is not changed from here: an edit of it is refused, and the account keeps its list.
  expect(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'site:set', id: 'other.example', enabled: true, scope: 'account' }))).toEqual({ ok: false, error: "Your Pro account's sites are changed on your account page." });
  expect((await mockList()).customSites.map((c) => c.id)).toEqual(['127.0.0.1']);
  // No add box and no Sync now for the account here: its list is edited on the account page and fetched on its own;
  // this browser's add box stays.
  await expect(options.locator('#account-add-host')).toHaveCount(0);
  await expect(options.locator('#managed-sync')).toHaveCount(0);
  await expect(options.locator('#add-row')).toBeVisible();
  await options.screenshot({ path: 'test-results/ui/options-sections.png', fullPage: true });
  await options.emulateMedia({ colorScheme: 'dark' });
  await options.waitForTimeout(300);
  await options.screenshot({ path: 'test-results/ui/options-sections-dark.png', fullPage: true });
  await options.close();
});

test('site search announces visible guarded rows and suggestions as the lists change', async () => {
  const options = await optionsPage();
  await options.setViewportSize({ width: 375, height: 800 });
  const search = options.getByRole('searchbox', { name: 'Search sites' });
  const summary = options.locator('#site-search-summary');
  await expect(summary).toHaveAttribute('role', 'status');
  await expect(options.locator('#sites .site-row[data-id="other.example"]')).toBeVisible();
  await search.fill('  OTHER.EXAMPLE ');
  await expect(summary).toHaveText('1 guarded site · 0 suggestions');
  await expect(search).toBeFocused();
  await options.locator('.sites > .search').screenshot({ path: 'test-results/ui/site-search-match.png' });

  await search.fill(' FiXtUrE ');
  await expect(summary).toHaveText('1 guarded site · 0 suggestions');
  await options.locator('#account-section').evaluate((group) => group.setAttribute('hidden', ''));
  await search.dispatchEvent('input');
  await expect(summary).toHaveText('No sites or suggestions match.');
  await options.locator('#account-section').evaluate((group) => group.removeAttribute('hidden'));

  await search.fill('not-a-site.invalid');
  await expect(summary).toHaveText('No sites or suggestions match.');
  await expect(search).toBeFocused();
  await options.locator('.sites > .search').screenshot({ path: 'test-results/ui/site-search-zero.png' });
  await search.fill('   ');
  await expect(summary).toBeEmpty();
  await search.fill(' LiNeAr ');
  await expect(summary).toHaveText('0 guarded sites · 1 suggestion');
  await options.getByRole('button', { name: 'Add Linear' }).click();
  await expect(summary).toHaveText('1 guarded site · 0 suggestions');
  await expect(options.locator('#sites .site-row[data-id="linear"]')).toBeVisible();
  await search.clear();
  await expect(summary).toBeEmpty();
  await options.close();
});

test('a list that drops a site waits while an agent works; the account is not changed from here', async () => {
  const options = await optionsPage();
  const fixture = options.locator('#account-sites .site-row[data-id="127.0.0.1"]');
  expect(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'site:remove', id: '127.0.0.1', scope: 'account' }))).toEqual({ ok: false, error: "Your Pro account's sites are changed on your account page." });
  expect((await mockList()).customSites.map((c) => c.id)).toEqual(['127.0.0.1']);

  // The same from the account page: the list is fetched and kept pending.
  await h.mock({ managed: { enabled: true, sites: {}, customSites: [{ id: 'new.example.org', name: 'new.example.org', domains: ['new.example.org'], enabled: true }] } });
  await h.syncManaged();
  await h.waitFor(async () => Boolean((await h.status()).managedPending), 'pending change');
  const st = await h.status();
  expect(st.managedPending).toBe('Your Pro account asks to remove 127.0.0.1; this applies when the agent session ends');
  expect(st.targetDomains).toContain('127.0.0.1');
  expect(await h.pageFetch('POST', '/api/items', '{"name":"still-blocked"}')).toMatch(/^error:/);

  await expect(options.locator('#managed-pending')).toContainText('remove 127.0.0.1');
  await expect(fixture).toBeVisible();
  // The backstop: a site the account guards is not switched off in this browser.
  expect(await options.evaluate(() => chrome.runtime.sendMessage({ type: 'site:set', id: '127.0.0.1', enabled: false }))).toMatchObject({ ok: false, error: expect.stringContaining('Your Pro account guards this site') });
  await options.close();
});

test('a save on the account page reaches this browser on its own: the page pings the background, which fetches the list', async () => {
  // The browser is signed in to the mock at this origin, so a top-frame page there at /account?sites=saved is the
  // account page's "Saved" redirect, and the content script's ping is taken (background/messages.ts accountPageSaved).
  // The list only adds (the fixture back, a new site), so it applies at once, agent session or not; nothing here calls
  // Sync now or the test hook.
  const before = (await h.status()).managed?.version ?? 0;
  await h.mock({ managed: { enabled: true, sites: {}, customSites: [FIXTURE, { id: 'pinged.example', name: 'pinged', domains: ['pinged.example'], enabled: true }] } });
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/account?sites=saved`);
  await h.waitFor(async () => (await h.status()).targetDomains.includes('pinged.example'), 'the list fetched on the account page\'s ping');
  expect((await h.status()).managed?.version).toBeGreaterThan(before);
  await page.close();
  // The same ping from a page on another origin is nothing (the service is at localhost; 127.0.0.1 is another origin).
  await h.mock({ managed: { enabled: true, sites: {}, customSites: [FIXTURE, { id: 'pinged.example', name: 'pinged', domains: ['pinged.example'], enabled: true }, { id: 'unpinged.example', name: 'unpinged', domains: ['unpinged.example'], enabled: true }] } });
  const elsewhere = await h.ctx.newPage();
  await elsewhere.goto(`http://127.0.0.1:${h.port}/account?sites=saved`);
  await elsewhere.waitForTimeout(1500);
  expect((await h.status()).targetDomains).not.toContain('unpinged.example');
  await elsewhere.close();
});
