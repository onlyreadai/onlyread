// Report a mistake: a write refused on the fixture, then its Activity row's report button opens the dialog, which
// sends it with a note to the fixture's mock service, signed out (anonymous). What arrives is what the dialog showed.
// The notice's Report and the popup's link open the same dialog on the newest refusal (options.html#report).
import { test, expect } from '@playwright/test';
import { Harness } from './helpers';

const h = new Harness(4267);
const reports = async () => ((await (await fetch(`${h.base}/cloud/__mock`)).json()) as { reports: { account?: string; body: { note: string; email?: string; extension: { mode: string }; requests: { method: string; url: string }[] } }[] }).reports;
test.beforeAll(async () => {
  await h.start({ mode: 'enforce', reviewBand: 'block' });
  await h.setPolicy({ cloud: { serviceUrl: `${h.base}/cloud`, timeoutMs: 8000 } });
  await fetch(`${h.base}/cloud/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true }) });
});
test.afterAll(async () => { await h.stop(); });

test('Enter in the report email field sends the selected refusals and note shown in the dialog', async () => {
  expect(await h.pageFetch('PUT', '/api/items/2', '{"name":"x"}')).toMatch(/^error:/);
  expect(await h.pageFetch('DELETE', '/api/items/1?token=s3cret')).toMatch(/^error:/);
  const o = await h.ctx.newPage();
  await o.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html#activity`);
  const button = o.locator('#activity-list .report-btn').first();
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  const dialog = o.locator('#report-dialog');
  await expect(dialog).toBeVisible();
  // The newest refusal first, the one just before it in the same tab with it, both ticked.
  await expect(dialog.locator('#report-what .pick')).toHaveCount(2);
  await expect(dialog.locator('#report-what .pick input:checked')).toHaveCount(2);
  await expect(dialog.locator('#report-what .pick').first()).toContainText('DELETE');
  await expect(dialog.locator('#report-what')).not.toContainText('s3cret');
  await o.locator('#report-note').fill('deleting is a read here, honestly');
  await o.locator('#report-details summary').click();
  await expect(o.locator('#report-preview')).toContainText('deleting is a read here');
  const email = o.locator('#report-email');
  await email.fill('reporter@example.com');
  await email.press('Enter');
  // Sent: the check with the report's number over the form, then the dialog closes by itself.
  await expect(o.locator('#report-done')).toBeVisible({ timeout: 15_000 });
  await expect(o.locator('#report-id')).toHaveText(/^[0-9A-F]{8}$/);
  const [r] = await reports();
  expect(r!.account).toBeUndefined();
  expect(r!.body.note).toBe('deleting is a read here, honestly');
  expect(r!.body.email).toBe('reporter@example.com');
  expect(r!.body.extension.mode).toBe('enforce');
  expect(r!.body.requests.map((q) => q.method)).toEqual(['DELETE', 'PUT']);
  expect(r!.body.requests[0]!.url).toContain('/api/items/1');
  expect(r!.body.requests[0]!.url).not.toContain('s3cret');
  await expect(dialog).toBeHidden({ timeout: 6_000 });
  await o.close();
});

test('#report opens the dialog on the newest refusal, over the Activity list', async () => {
  const o = await h.ctx.newPage();
  await o.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html#report`);
  await expect(o.locator('#report-dialog')).toBeVisible({ timeout: 15_000 });
  await expect(o.locator('#report-send')).toBeEnabled();
  expect(new URL(o.url()).hash).toBe('#activity');
  const checked = o.locator('#report-what .pick input:checked');
  while (await checked.count()) await checked.first().uncheck();
  await o.locator('#report-email').press('Enter');
  await expect(o.locator('#report-dialog')).toBeVisible();
  await expect(o.locator('#report-done')).toBeHidden();
  await o.close();
});
