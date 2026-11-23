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

test('the note counter starts at the limit, follows edits and resets when the dialog reopens', async () => {
  expect(await h.pageFetch('PUT', '/api/items/2', '{"name":"x"}')).toMatch(/^error:/);
  const o = await h.ctx.newPage();
  const url = `chrome-extension://${new URL(h.sw.url()).host}/options.html#report`;
  const dialog = o.locator('#report-dialog');
  const note = dialog.locator('#report-note');
  const counter = dialog.locator('#report-note-count');
  await o.goto(url);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(note).toHaveAttribute('aria-describedby', 'report-note-count');
  await expect(counter).toHaveText('2,000 characters remaining');
  await note.fill('hello');
  await expect(counter).toHaveText('1,995 characters remaining');
  await note.fill('a'.repeat(2000));
  await expect(counter).toHaveText('0 characters remaining');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await o.goto(url);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(counter).toHaveText('2,000 characters remaining');
  await o.close();
});

for (const reject of [false, true]) {
  test(`copy report number with ${reject ? 'rejected' : 'successful'} clipboard access`, async () => {
    expect(await h.pageFetch('PUT', '/api/items/2', '{"name":"x"}')).toMatch(/^error:/);
    const o = await h.ctx.newPage();
    await o.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html#report`);
    await o.evaluate((reject) => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
          document.documentElement.dataset.copyCount = String(Number(document.documentElement.dataset.copyCount ?? 0) + 1);
          if (reject) throw new Error('Permission denied');
        },
      } });
    }, reject);
    const dialog = o.locator('#report-dialog');
    const copy = o.getByRole('button', { name: 'Copy report number', exact: true });
    await o.getByRole('button', { name: 'Send to Support', exact: true }).click();
    await expect(copy).toBeVisible({ timeout: 15_000 });
    const id = (await o.locator('#report-id').textContent())!;
    let copies = 0;
    for (const activation of ['click', 'Enter', 'Space'] as const) {
      if (activation === 'click') await copy.click();
      else await copy.press(activation);
      await expect(o.locator('html')).toHaveAttribute('data-copied', id);
      await expect(o.locator('html')).toHaveAttribute('data-copy-count', String(++copies));
      await expect(o.locator('#report-copy-feedback')).toHaveText(reject
        ? 'Could not copy. Select the report number and copy it manually.' : 'Copied');
      await expect(dialog).toBeVisible();
    }
    await dialog.screenshot({ animations: 'disabled', path: test.info().outputPath('report-copy.png') });
    await o.waitForTimeout(3600);
    await expect(dialog).toBeVisible();
    await expect(o.locator('#report-id')).toHaveText(id);
    await expect(o.locator('#report-done b')).toHaveText('Sent, thank you');
    if (!reject) await expect(o.locator('#report-copy-feedback')).toBeEmpty();
    expect(await reports()).toHaveLength(1);
    if (reject) {
      await o.getByRole('button', { name: 'Close', exact: true }).focus();
      await o.waitForTimeout(3600);
      await expect(dialog).toBeVisible();
    }
    await o.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    // Reuse the same page and report UI. Feedback from the previous report must be gone.
    await o.evaluate(() => { location.hash = '#report'; });
    await expect(dialog).toBeVisible();
    await expect(o.locator('#report-copy-feedback')).toBeEmpty();
    await expect(o.locator('#report-id')).toBeEmpty();
    await o.getByRole('button', { name: 'Send to Support', exact: true }).click();
    await expect(copy).toBeVisible();
    const nextId = (await o.locator('#report-id').textContent())!;
    expect(nextId).not.toBe(id);
    await copy.click();
    await expect(o.locator('html')).toHaveAttribute('data-copied', nextId);
    if (!reject) {
      // An old clipboard promise and dismissal timer cannot affect a later report.
      await o.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: () => new Promise<void>((resolve) => {
            (window as unknown as { finishCopy: () => void }).finishCopy = resolve;
          }),
        } });
      });
      await copy.click();
      await o.evaluate(() => { location.hash = '#report'; });
      await expect(o.locator('#report-done')).toBeHidden();
      await o.evaluate(() => { (window as unknown as { finishCopy: () => void }).finishCopy(); });
      await expect(o.locator('#report-copy-feedback')).toBeEmpty();
      await expect(o.locator('#report-id')).toBeEmpty();
      await o.waitForTimeout(3600);
      await expect(dialog).toBeVisible();
      await o.getByRole('button', { name: 'Send to Support', exact: true }).click();
      await expect(copy).toBeVisible();
    }
    await o.locator('#report-done b').click();
    await expect(dialog).toBeHidden();
    await o.close();
  });
}

for (const interaction of ['focus', 'copy', 'reject'] as const) {
  test(`copy interaction during automatic closing: ${interaction}`, async () => {
    expect(await h.pageFetch('PUT', '/api/items/2', '{"name":"x"}')).toMatch(/^error:/);
    const o = await h.ctx.newPage();
    await o.goto(`chrome-extension://${new URL(h.sw.url()).host}/options.html#report`);
    await o.emulateMedia({ reducedMotion: 'no-preference' });
    await o.clock.install();
    await o.clock.pauseAt(new Date());
    await o.evaluate((reject) => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { if (reject) throw new Error('Permission denied'); },
      } });
    }, interaction === 'reject');
    await o.getByRole('button', { name: 'Send to Support', exact: true }).click();
    await expect(o.locator('#report-done')).toBeVisible({ timeout: 15_000 });
    const dialog = o.locator('#report-dialog');
    await o.clock.runFor(3200);
    await expect(dialog).toHaveClass(/closing/);
    // Act inside the 280 ms window, without Playwright waiting for the animation to finish.
    await o.evaluate((interaction) => {
      const copy = document.getElementById('report-copy') as HTMLButtonElement;
      if (interaction === 'focus') copy.focus();
      else copy.click();
    }, interaction);
    await o.clock.runFor(280);
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveClass(/closing/);
    if (interaction !== 'focus') {
      await expect(o.locator('#report-copy-feedback')).toContainText(interaction === 'reject' ? 'Could not copy.' : 'Copied');
    }
    // Focus must not undo the person's explicit Close.
    await o.evaluate(() => {
      (document.getElementById('report-done-close') as HTMLButtonElement).click();
      document.getElementById('report-copy')!.focus();
    });
    await o.clock.runFor(280);
    await expect(dialog).toBeHidden();
    expect(await reports()).toHaveLength(1);
    await o.close();
  });
}
