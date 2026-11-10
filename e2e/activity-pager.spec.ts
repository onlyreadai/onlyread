// The Activity list's pages: Previous/Next and the per-page choice, with the settings page's own refresh
// every 3 s overlapping the clicks. Each activity answer is held back here, as a large log makes it slow; an answer
// for the page the person just left must not put them back on it.
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

const h = new Harness(4263);
test.beforeAll(async () => { await h.start({ mode: 'enforce', reviewBand: 'block' }); });
test.afterAll(async () => { await h.stop(); });

test('Next and Previous hold while slow refreshes overlap them', async () => {
  // Thirteen different changes (refusals of one change close together are one row, background/activity.ts).
  for (let i = 0; i < 13; i++) await h.pageFetch('POST', '/graphql', JSON.stringify({ operationName: `MakeItem${i}`, query: `mutation MakeItem${i} { make { id } }` }));
  await h.page.close(); // the fixture page keeps sending; the count holds still without it
  const o = await h.ctx.newPage();
  await o.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
    (chrome.runtime as unknown as { sendMessage: (m: { type?: string }) => Promise<unknown> }).sendMessage = async (m) => {
      const answer = await send(m);
      if (m?.type === 'activity:get') await new Promise((r) => setTimeout(r, 2500));
      return answer;
    };
  });
  await o.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html#activity`);
  const range = o.locator('#activity-range');
  await expect(range).toContainText(/^1–5 of \d+/, { timeout: 15_000 });
  await o.locator('#activity-next').click();
  await expect(range).toContainText(/^6–10 of/, { timeout: 15_000 });
  await o.waitForTimeout(7000); // several overlapping refreshes, each answered late
  await expect(range).toContainText(/^6–10 of/);
  await o.locator('#activity-prev').click();
  await expect(range).toContainText(/^1–5 of/, { timeout: 15_000 });
  await o.locator('#activity-size').selectOption('10');
  await expect(range).toContainText(/^1–10 of/, { timeout: 15_000 });
  await o.waitForTimeout(7000);
  await expect(range).toContainText(/^1–10 of/);
  await o.close();
});

test('each row shows its exact date and time on hover', async () => {
  const o = await h.ctx.newPage();
  await o.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html#activity`);
  const when = o.locator('time.when-ago').first();
  await expect(when).toBeVisible({ timeout: 15_000 });
  const iso = await when.getAttribute('datetime');
  expect(Number.isNaN(Date.parse(iso ?? ''))).toBe(false);
  expect(await when.getAttribute('title')).toBe(await o.evaluate((iso) => new Date(iso).toLocaleString(), iso as string));
  await o.close();
});
