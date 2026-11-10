// This browser's Activity and Security framed on the Pro account page (PLAN-PRO-UI step 3): the content script puts the
// extension's own settings page in a frame where the page asks, only for the account this browser is signed in to;
// the page's scripts cannot read into it; opened anywhere else the framed page stays blank. Against the mock Pro
// service, whose /__frames page stands in for the account page.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';
import { openFramed } from './framed-dialog';

test.describe.configure({ mode: 'serial' });

const h = new Harness(4243);
const extPage = (name: string) => `chrome-extension://${new URL(h.sw.url()).host}/${name}`;
const framesPage = (account: string) => `${h.base}/cloud/__frames?account=${encodeURIComponent(account)}`;
const state = (page: import('@playwright/test').Page, id: string) => page.locator(`#${id}`).getAttribute('data-onlyread-state');

test.beforeAll(async () => {
  await h.start({ mode: 'enforce', customSites: [{ id: 'other.example', name: 'Other', domains: ['other.example'], enabled: true }] });
  await h.setPolicy({ cloud: { serviceUrl: `${h.base}/cloud`, timeoutMs: 8000 }, judge: { provider: 'cloud', byok: { id: 'openrouter' }, timeoutMs: 3000, llmTimeoutMs: 6000 } });
});
test.afterAll(async () => { await h.stop(); });

test('signed out, nothing is framed: the page keeps its own words and learns why', async () => {
  const page = await h.ctx.newPage();
  await page.goto(framesPage('test.user@example.com'));
  await expect.poll(() => state(page, 'activity')).toBe('signed-out');
  await expect(page.locator('#activity')).toHaveText("Install OnlyRead to see this browser's activity.");
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.close();
});

test('signed in, the account\'s page frames Activity and Security, sized to their content and unreadable by the page', async () => {
  // No AI judge yet: the settings page is only the way to set one, and its Pro button signs in.
  await h.assumeJudge(false);
  const options = await h.ctx.newPage();
  await options.goto(extPage('options.html'));
  await options.locator('#gate-signin').click();
  await expect(options).toHaveURL(`${h.base}/cloud/account`, { timeout: 15_000 }); // signed in, on to the account page
  await options.close();

  const page = await h.ctx.newPage();
  await page.goto(framesPage('Test.User@example.com')); // the address as the page writes it: case does not matter
  await expect.poll(() => state(page, 'activity')).toBe('framed');
  await expect.poll(() => state(page, 'security')).toBe('framed');
  const activity = page.frameLocator('#activity iframe');
  await expect(activity.locator('#activity')).toBeVisible({ timeout: 10_000 });
  // One section: no sidebar, no header, no other section.
  await expect(activity.locator('#side')).toBeHidden();
  await expect(activity.locator('header.top')).toBeHidden();
  await expect(activity.locator('#guarded-sites')).toBeHidden();
  await expect(page.frameLocator('#security iframe').locator('#security')).toBeVisible();
  // The frame told the page its height.
  await expect.poll(async () => page.locator('#activity iframe').evaluate((f) => (f as HTMLIFrameElement).style.height)).not.toBe('240px');
  // The page's own code dropping the frame (a re-render): the extension puts it back.
  await page.evaluate(() => { document.querySelector('#activity')!.replaceChildren(); });
  await expect(page.locator('#activity iframe')).toHaveCount(1);
  await expect(activity.locator('#activity')).toBeVisible();
  // Which row of the account's Browsers list this browser is: its sign-in's id, for this account's page only.
  const ask = (account: string) => page.evaluate((acct) => new Promise<unknown>((resolve) => {
    addEventListener('message', function on(e) { if (e.data?.source === 'onlyread-extension' && e.data.type === 'this-browser') { removeEventListener('message', on); resolve(e.data); } });
    postMessage({ source: 'onlyread-pro', type: 'which-browser', account: acct }, location.origin);
  }), account);
  expect(await ask('test.user@example.com')).toMatchObject({ family: expect.stringMatching(/^[0-9a-f-]{36}$/), demo: true });
  expect(await ask('someone.else@example.com')).toEqual({ source: 'onlyread-extension', type: 'this-browser', reason: 'other-account' });
  // The page's own scripts cannot read inside.
  expect(await page.evaluate(() => {
    const f = document.querySelector('#activity iframe') as HTMLIFrameElement;
    try { return f.contentDocument === null && f.contentWindow?.document === undefined; } catch { return true; }
  })).toBe(true);
  await page.close();
});

// A dialog in the framed section (the report, the PIN) is the window's, however short the section: while it is open the
// frame covers the page's whole window, its spot on the page keeping its height and the section drawn there still;
// the section follows its spot as the page scrolls or the window is resized; closed, the frame is back in its spot at
// its own height. At any display scaling: the frame tells "covering" from its own size in the page, not the window's
// exact size, which a fractional scale never matches.
test('a dialog opened in the framed section covers the whole window, follows a scroll and a resize, and goes back when it closes', async () => {
  const f = await openFramed(h, framesPage('test.user@example.com'), { width: 1200, height: 800 });
  await f.show();
  await f.covering();
  expect((await f.spot.boundingBox())!.height).toBeCloseTo(f.before.spot.height, 0);
  // The page scrolled under the open dialog (a wheel over the dimmed page): the section moves with its spot.
  await f.page.evaluate(() => { document.body.style.paddingBottom = '2000px'; scrollBy(0, 120); });
  expect((await f.spot.boundingBox())!.y).toBeCloseTo(f.before.spot.y - 120, 0);
  await f.covering();
  await f.page.evaluate(() => { scrollTo(0, 0); document.body.style.paddingBottom = ''; });
  // The window resized under it.
  await f.resize(1000, 700);
  await f.covering();
  await f.resize(1200, 800);
  await f.close();
  await f.back();
  await f.page.close();
});

// The spot measured from the frame itself, not the placeholder around it: padded or bordered by the account page, the
// section still stays where it was and the dialog still waits for the cover.
test('with the placeholder padded and bordered, a dialog covers the window and the section stays in place', async () => {
  const f = await openFramed(h, framesPage('test.user@example.com'), { width: 1200, height: 800 }, 'padding: 14px 30px; border: 3px solid red;');
  await f.show();
  await f.covering();
  expect((await f.spot.boundingBox())!.height).toBeCloseTo(f.before.spot.height, 0);
  await f.close();
  await f.back();
  await f.page.close();
});

test('a dialog closed and opened again at once covers the window as the first did', async () => {
  const f = await openFramed(h, framesPage('test.user@example.com'), { width: 1200, height: 800 });
  await f.show();
  await f.covering();
  await f.show(true); // never seen clipped while the frame shrinks back and grows again
  await f.covering();
  await f.close();
  await f.back();
  await f.page.close();
});

// The account page's "Try the demo" (in Pro mode this browser's own settings page is out of the way): a real click opens
// the demo's choice of site; the page's own script clicking it, or a button naming another account, opens nothing.
test('the account page\'s "Try the demo" opens the demo\'s choice of site, on a real click for this account only', async () => {
  const setupOpen = () => h.ctx.pages().some((p) => p.url().endsWith('setup.html#demo'));
  for (const p of h.ctx.pages().filter((x) => x.url().startsWith(extPage('setup.html')))) await p.close();
  const page = await h.ctx.newPage();
  await page.goto(framesPage('test.user@example.com'));
  await page.evaluate(() => {
    for (const [id, account] of [['demo-here', 'Test.User@example.com'], ['demo-other', 'someone.else@example.com']] as const) {
      const b = document.createElement('button');
      b.id = id; b.textContent = 'Try the demo'; b.dataset.onlyreadDemo = ''; b.dataset.account = account;
      document.body.append(b);
    }
  });
  await page.evaluate(() => (document.getElementById('demo-here') as HTMLButtonElement).click()); // the page's own script
  await page.locator('#demo-other').click(); // a real click, another account
  await page.waitForTimeout(1500);
  expect(setupOpen()).toBe(false);
  await page.locator('#demo-here').click();
  await expect.poll(setupOpen, { timeout: 10_000 }).toBe(true);
  await expect(h.ctx.pages().find((p) => p.url().endsWith('setup.html#demo'))!.locator('#step-demo')).toBeVisible();
  for (const p of h.ctx.pages().filter((x) => x.url().startsWith(extPage('setup.html')))) await p.close();
  await page.close();
});

// Framed, the section looks like the account page around it, whatever the extension's own setting: the page's light or
// dark (`data-theme` on its <html>) as it opens and as it switches; the frame's colour scheme as the page's, or Chrome
// paints the framed page's backdrop whole and square behind its round cards.
test('the framed section follows the account page\'s light or dark, and switches with it', async () => {
  await h.sw.evaluate(() => chrome.storage.local.set({ theme: 'dark' })); // the extension's own: dark
  const page = await h.ctx.newPage();
  await page.goto(framesPage('test.user@example.com'));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.evaluate(() => document.querySelector('#security')!.replaceChildren()); // framed afresh, the page light
  const frame = page.frameLocator('#security iframe');
  await expect(frame.locator('#security')).toBeVisible({ timeout: 10_000 });
  const iframe = page.locator('#security iframe');
  await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe('light');
  expect(await iframe.evaluate((f) => (f as HTMLIFrameElement).style.colorScheme)).toBe('light');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe('dark');
  expect(await iframe.evaluate((f) => (f as HTMLIFrameElement).style.colorScheme)).toBe('dark');
  await page.evaluate(() => { delete document.documentElement.dataset.theme; }); // the system's
  await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBeNull();
  expect(await iframe.evaluate((f) => (f as HTMLIFrameElement).style.colorScheme)).toBe('light dark');
  await h.sw.evaluate(() => chrome.storage.local.remove('theme'));
  await page.close();
});

test('another account\'s page gets no frame', async () => {
  const page = await h.ctx.newPage();
  await page.goto(framesPage('someone.else@example.com'));
  await expect.poll(() => state(page, 'activity')).toBe('other-account');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.close();
});

test('opened on its own, the framed page stays blank', async () => {
  const page = await h.ctx.newPage();
  await page.goto(`${extPage('options.html')}?framed=1#activity`);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => document.body.children.length)).toBe(0);
  await page.close();
});
