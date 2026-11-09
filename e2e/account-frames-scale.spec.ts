// The framed section's dialog at a fractional display scaling: a Windows laptop at 125%, or a page zoomed out to 80%
// (a screen pixel then more than a CSS one). A CSS pixel is then a fraction of the screen's and the window's size not a
// whole number of them, so the frame must tell it covers the window from its own size in the page, with a slack of a
// screen pixel and a half, not the window's exact size (account-frames.spec.ts covers the rest at 100%). Its own
// browser each: Playwright's emulated scaling never reaches the extension's frame, which runs in another process.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';
import { openFramed } from './framed-dialog';

for (const [scale, port] of [[1.25, 4291], [0.8, 4293]] as const) {
  test.describe(`at ${scale * 100}% display scaling`, () => {
    test.describe.configure({ mode: 'serial' });
    const h = new Harness(port);
    const extPage = (name: string) => `chrome-extension://${new URL(h.sw.url()).host}/${name}`;

    test.beforeAll(async () => {
      await h.start(
        { mode: 'enforce', cloud: { serviceUrl: `${h.base}/cloud`, timeoutMs: 8000 }, judge: { provider: 'cloud', byok: { id: 'openrouter' }, timeoutMs: 3000, llmTimeoutMs: 6000 } },
        { extraArgs: [`--force-device-scale-factor=${scale}`, '--window-size=1203,801'], windowViewport: true },
      );
      // Signed in to Pro, so the account page frames this browser's Activity.
      await h.assumeJudge(false);
      const options = await h.ctx.newPage();
      await options.goto(extPage('options.html'));
      await options.locator('#gate-signin').click();
      await expect(options).toHaveURL(`${h.base}/cloud/account`, { timeout: 15_000 });
      await options.close();
    });
    test.afterAll(async () => { await h.stop(); });

    test('a dialog covers the window, follows the window resized under it, and goes back', async () => {
      const f = await openFramed(h, `${h.base}/cloud/__frames?account=test.user%40example.com`);
      expect(await f.page.evaluate(() => devicePixelRatio)).toBeCloseTo(scale, 5);
      await f.show();
      await f.covering();
      await f.resize(1001, 703);
      await f.covering();
      await f.resize(1203, 801); // as it opened, for the frame's box to be compared with before
      await f.covering();
      await f.close();
      await f.back();
      await f.show(true);
      await f.covering();
      await f.close();
      await f.back();
      await f.page.close();
    });
  });
}
