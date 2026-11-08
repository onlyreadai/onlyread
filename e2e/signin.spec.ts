// Signing in to OnlyRead Pro in the page that asked: the setup window and the settings tab go to the
// service's sign-in page, the service sends the tab to its done page with a one-time code in the fragment, the content
// script hands the code to the background (from that page only), and the tab comes back signed in. Against the
// fixture's mock Pro service, which approves at once.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4241);
const extPage = (name: string) => `chrome-extension://${new URL(h.sw.url()).host}/${name}`;
const signedIn = async () => (await h.sw.evaluate(() => chrome.storage.local.get('cloudTokens'))).cloudTokens !== undefined;

test.beforeAll(async () => {
  // The browser guards some other site, not the fixture, whose host also serves the mock service.
  await h.start({ mode: 'enforce', customSites: [{ id: 'other.example', name: 'Other', domains: ['other.example'], enabled: true }] });
  // The judge starts on Pro, the product's default, as on a fresh install: the setup window's "Continue" then changes no
  // setting. (Playwright drives the browser, so OnlyRead sees an agent at work, and its lock would refuse a move to Pro
  // from the harness's own-key judge: that refusal is setup.ts's to show, not this test's.)
  await h.setPolicy({ cloud: { serviceUrl: `${h.base}/cloud`, timeoutMs: 8000 }, judge: { provider: 'cloud', byok: { id: 'openrouter' }, timeoutMs: 3000, llmTimeoutMs: 6000 } });
});
test.afterAll(async () => { await h.stop(); });

test('the setup window signs in through the service, comes back and goes on to the demo, the code gone from every address', async () => {
  const setup = await h.ctx.newPage();
  await setup.goto(extPage('setup.html'));
  expect(await signedIn()).toBe(false);
  const visited: string[] = [];
  setup.on('framenavigated', (f) => { if (f === setup.mainFrame()) visited.push(f.url()); });
  await setup.locator('#cloud-signin').click();
  // Back in the setup window, signed in; the demo comes next (setup/demo-steps.ts), its sites drawn, and can be skipped.
  await expect(setup.locator('#step-demo')).toBeVisible({ timeout: 15_000 });
  expect(await signedIn()).toBe(true);
  expect(visited.some((u) => u.includes('/cloud/signin/done'))).toBe(true);
  expect(visited.some((u) => u.includes('setup.html?signin=ok'))).toBe(true); // then taken out of the address
  await expect(setup.locator('#demo-tiles .tile')).toHaveCount(5);
  // The first sign-in is recorded (the demo follows it wherever it starts), and no second demo window opens over this one.
  expect(await h.sw.evaluate(async () => typeof (await chrome.storage.local.get('firstJudgeAt')).firstJudgeAt)).toBe('number');
  expect(h.ctx.pages().filter((p) => p.url().includes('setup.html#demo'))).toHaveLength(0);
  await expect(setup.locator('#demo-tiles .tile').first()).toContainText('Like any post');
  // The code rode in the done page's fragment only, never in a query, and nothing in the pages' history keeps it.
  expect(visited.filter((u) => /[?&]code=/.test(u))).toEqual([]);
  // "Skip demo" closes the setup window and, signed in to Pro, opens the Pro account page (PLAN-PRO-UI step 5).
  const closed = setup.waitForEvent('close', { timeout: 5_000 });
  const settings = h.ctx.waitForEvent('page', { predicate: (p) => p.url() === `${h.base}/cloud/account`, timeout: 5_000 });
  await setup.locator('#demo-skip').click();
  await closed;
  await (await settings).close(); // none open: the next test's button opens one (an open one would come forward instead)
});

test('a done page whose code no sign-in here asked for changes nothing', async () => {
  const ext = await h.ctx.newPage();
  await ext.goto(extPage('setup.html'));
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'cloud:signout' }));
  await ext.close();
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/signin/done#code=forged&state=forged`);
  await expect(page.locator('body')).toContainText('Finishing sign-in');
  await page.waitForTimeout(1000);
  expect(new URL(page.url()).pathname).toBe('/cloud/signin/done');
  expect(new URL(page.url()).hash).toBe(''); // the content script still drops the fragment
  expect(await signedIn()).toBe(false);
  await page.close();
});

test('the settings page signs in in its own tab and goes on to the Pro account page', async () => {
  const options = await h.ctx.newPage();
  await options.goto(`${extPage('options.html')}#ai-judge`);
  // Pro chosen as the judge (Playwright's CDP session is an agent, so the page's own switch would ask to confirm).
  await h.setPolicy({ judge: { ...(await h.sw.evaluate(async () => ((await chrome.storage.local.get('policy')).policy as { judge: object }).judge)), provider: 'cloud' } });
  await options.reload();
  // No AI judge yet: the page is only the way to set one, Pro's offer first; its button signs in.
  await h.assumeJudge(false);
  await options.reload();
  await expect(options.locator('#judge-gate')).toContainText('No API key, no credit card');
  await expect(options.locator('#guarded-sites')).toBeHidden();
  await options.locator('#gate-signin').click();
  // Signed in, the tab goes on to the Pro account page, where Pro mode is managed, and the demo opens over it.
  await expect(options).toHaveURL(`${h.base}/cloud/account`, { timeout: 15_000 });
  await expect.poll(() => h.ctx.pages().some((p) => p.url().endsWith('setup.html#demo')), { timeout: 10_000 }).toBe(true);
  // The first sign-in is recorded, so the demo follows it whichever page started it.
  expect(await h.sw.evaluate(async () => typeof (await chrome.storage.local.get('firstJudgeAt')).firstJudgeAt)).toBe('number');
  expect(await signedIn()).toBe(true);
  await options.close();
});

// Pro mode (PLAN-PRO-UI 2b–2e, 6): signed in, this browser's own site moved to the account at the first sync. While
// Pro is reachable the settings page is cut short: a card opening the account page, and the AI judge. With Pro out of
// reach the whole page stands in: the account's sites as last synced, a site added there waiting to be sent.
// Playwright's session is an agent at work, so removing (a lowering) is locked: the rows' remove buttons are disabled.
test('signed in to Pro, the settings page sends to the account page; with Pro out of reach it stands in, the account\'s sites as last synced', async () => {
  const mock = (patch: Record<string, unknown>) => fetch(`${h.base}/cloud/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  const mockState = async () => ((await (await fetch(`${h.base}/cloud/__mock`)).json()) as { state: { managed: { customSites: { id: string }[] } } }).state.managed;
  const options = await h.ctx.newPage();
  await options.goto(`${extPage('options.html')}#guarded-sites`);
  await expect(options.locator('#pro-managed')).toBeVisible({ timeout: 10_000 });
  await expect(options.locator('#guarded-sites')).toBeHidden();
  await expect(options.locator('#overview')).toBeHidden();
  await expect(options.locator('#ai-judge')).toBeVisible();
  await expect.poll(async () => (await mockState()).customSites.map((c) => c.id)).toContain('other.example');
  const account = h.ctx.waitForEvent('page', { predicate: (p) => p.url() === `${h.base}/cloud/account`, timeout: 5_000 });
  await options.locator('#pro-managed-open').click();
  await (await account).close();

  // The demo again: in Pro mode the Overview card is gone, so the Pro card carries its "Try the demo".
  for (const p of h.ctx.pages().filter((x) => x.url().startsWith(extPage('setup.html')))) await p.close();
  await options.locator('#pro-managed [data-demo-again]').click();
  await expect.poll(() => h.ctx.pages().some((p) => p.url().endsWith('setup.html#demo')), { timeout: 10_000 }).toBe(true);
  const demo = h.ctx.pages().find((p) => p.url().endsWith('setup.html#demo'))!;
  await expect(demo.locator('#step-demo')).toBeVisible();
  await demo.close();

  // Pro out of reach: the whole page, the account's sites as last synced.
  await mock({ down: true });
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'cloud:status', refresh: true }));
  await options.reload();
  await expect(options.locator('#pro-managed')).toBeHidden({ timeout: 10_000 });
  await expect(options.locator('#managed-head')).toHaveText('Guarded sites');
  await expect(options.locator('#managed-text')).toContainText("Pro can't be reached. Your account's sites as of");
  await expect(options.locator('#account-sites .site-row[data-id="other.example"]')).toBeVisible();
  await expect(options.locator('#sites')).toBeHidden(); // no list of this browser's own, nor its heading
  await expect(options.locator('#browser-head')).toBeHidden();
  await expect(options.locator('#add-scope')).toBeHidden(); // one browser: no choice of where
  await options.locator('#add-host').fill('crm.example.com');
  await options.locator('#add').click();
  await expect(options.locator('#account-sites .site-row[data-id="crm.example.com"] .saving')).toBeVisible(); // waits for Pro
  await expect(options.locator('#add-result')).toBeEmpty(); // the row sliding in says it
  await expect(options.locator('#account-sites .site-row[data-id="crm.example.com"] .icon-btn.danger')).toBeDisabled();
  // Pro back: the change goes, and the page is cut short again.
  await mock({ down: false });
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'cloud:sync', reason: 'test' }));
  await expect.poll(async () => (await mockState()).customSites.map((c) => c.id)).toContain('crm.example.com');
  await options.close();
});

// Signing out on the Pro account page in this browser signs the extension out too, for its own account only.
test('signing out of the account page signs this browser out of Pro, but only for its own account', async () => {
  await h.setPolicy({ cloud: { serviceUrl: `${h.base}/cloud`, timeoutMs: 8000 } });
  await fetch(`${h.base}/cloud/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ down: false }) });
  if (!(await signedIn())) {
    const setup = await h.ctx.newPage();
    await setup.goto(extPage('setup.html'));
    await setup.locator('#cloud-signin').click();
    await expect.poll(signedIn, { timeout: 15_000 }).toBe(true);
    await setup.close().catch(() => {});
  }
  const page = await h.ctx.newPage();
  await page.goto(`${h.base}/cloud/account`);
  const post = (account: string) => page.evaluate((a) => window.postMessage({ source: 'onlyread-pro', type: 'signed-out', account: a }, location.origin), account);
  await post('someone.else@example.com');
  await page.waitForTimeout(1500);
  expect(await signedIn()).toBe(true); // another account's sign-out leaves this browser alone
  await post('Test.User@example.com'); // its own (case does not matter)
  await expect.poll(signedIn, { timeout: 10_000 }).toBe(false);
  await page.close();
});
