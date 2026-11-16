// Report a mistake: a write refused on the fixture, then its Activity row's report button opens the dialog, which
// sends it with a note to the fixture's mock service, signed out (anonymous). What arrives is what the dialog showed.
// The notice's Report and the popup's link open the same dialog on the newest refusal (options.html#report).
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './helpers';

const h = new Harness(4267);
const reports = async () => ((await (await fetch(`${h.base}/cloud/__mock`)).json()) as { reports: { account?: string; body: { note: string; email?: string; extension: { mode: string }; requests: { method: string; url: string }[] } }[] }).reports;
let profileDir: string;
test.beforeEach(async () => {
  profileDir = await mkdtemp(join(tmpdir(), 'onlyread-support-'));
  await h.start({ mode: 'enforce', reviewBand: 'block' }, { profileDir });
  await h.setPolicy({ cloud: { serviceUrl: `${h.base}/cloud`, timeoutMs: 8000 } });
  await fetch(`${h.base}/cloud/__mock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true }) });
});
test.afterEach(async () => {
  await h.stop();
  await rm(profileDir, { recursive: true, force: true });
});

test('bulk selection updates the open preview and Enter sends only the selected refusal', async () => {
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
  const boxes = dialog.getByRole('checkbox');
  const selectAll = dialog.getByRole('button', { name: 'Select all' });
  const clearSelection = dialog.getByRole('button', { name: 'Clear selection' });
  const send = dialog.getByRole('button', { name: 'Send to Support', exact: true });
  const preview = dialog.locator('#report-preview');
  const email = dialog.locator('#report-email');
  await expect(send).toBeEnabled();
  await expect(selectAll).toHaveAttribute('type', 'button');
  await expect(clearSelection).toHaveAttribute('type', 'button');
  await dialog.locator('#report-details summary').click();
  await expect(preview).toContainText('"method": "DELETE"');
  await expect(preview).toContainText('"method": "PUT"');

  for (const activation of ['click', 'Enter', 'Space'] as const) {
    if (activation === 'click') await clearSelection.click();
    else await clearSelection.press(activation);
    await expect(dialog).toHaveAttribute('open', '');
    await expect(boxes.nth(0)).not.toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('"requests": []');
    await expect(send).toBeDisabled();

    if (activation === 'click') await selectAll.click();
    else await selectAll.press(activation);
    await expect(dialog).toHaveAttribute('open', '');
    await expect(boxes.nth(0)).toBeChecked();
    await expect(boxes.nth(1)).toBeChecked();
    await expect(preview).toContainText('"method": "DELETE"');
    await expect(preview).toContainText('"method": "PUT"');
    await expect(send).toBeEnabled();
  }
  expect(await reports()).toHaveLength(0);

  await clearSelection.click();
  await email.press('Enter');
  await expect(dialog).toHaveAttribute('open', '');
  await expect(dialog.locator('#report-done')).toBeHidden();
  expect(await reports()).toHaveLength(0);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await button.click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await expect(send).toBeEnabled();
  await expect(preview).toContainText('"method": "PUT"');

  await boxes.nth(1).uncheck();
  await expect(preview).not.toContainText('"method": "PUT"');
  await o.locator('#report-note').fill('deleting is a read here, honestly');
  await email.fill('reporter@example.com');
  await expect(preview).toContainText('reporter@example.com');
  const shown = JSON.parse((await preview.textContent()) ?? '') as { requests: unknown[] };
  await email.press('Enter');
  // Sent: the check with the report's number over the form, then the dialog closes by itself.
  await expect(o.locator('#report-done')).toBeVisible({ timeout: 15_000 });
  await expect(o.locator('#report-id')).toHaveText(/^[0-9A-F]{8}$/);
  const received = await reports();
  expect(received).toHaveLength(1);
  const [r] = received;
  expect(r!.account).toBeUndefined();
  expect(r!.body.note).toBe('deleting is a read here, honestly');
  expect(r!.body.email).toBe('reporter@example.com');
  expect(r!.body.extension.mode).toBe('enforce');
  expect(r!.body.requests).toEqual(shown.requests);
  expect(r!.body.requests.map((q) => q.method)).toEqual(['DELETE']);
  expect(r!.body.requests[0]!.url).toContain('/api/items/1');
  expect(r!.body.requests[0]!.url).not.toContain('s3cret');
  await expect(dialog).toBeHidden({ timeout: 6_000 });
  await o.close();
});

test('#report hides bulk selection with zero or one refusal', async () => {
  const o = await h.ctx.newPage();
  const url = `chrome-extension://${new URL(h.sw.url()).host}/options.html#report`;
  const dialog = o.locator('#report-dialog');
  const boxes = dialog.getByRole('checkbox');
  const send = dialog.getByRole('button', { name: 'Send to Support', exact: true });
  const selection = dialog.locator('#report-selection');
  await o.goto(url);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  expect(new URL(o.url()).hash).toBe('#activity');
  await expect(boxes).toHaveCount(0);
  await expect(selection).toBeHidden();
  await expect(send).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  expect(await h.pageFetch('PUT', '/api/items/2', '{"name":"x"}')).toMatch(/^error:/);
  await o.goto(url);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(boxes).toHaveCount(1);
  await expect(boxes.first()).toBeChecked();
  await expect(selection).toBeHidden();
  await expect(send).toBeEnabled();
  await boxes.first().uncheck();
  await expect(send).toBeDisabled();
  await o.locator('#report-email').press('Enter');
  await expect(dialog).toBeVisible();
  await expect(o.locator('#report-done')).toBeHidden();
  expect(await reports()).toHaveLength(0);
  await o.close();
});
