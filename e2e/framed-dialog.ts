// The framed section's dialog covering the account page's window (content/account-frames.ts, options/framed.ts):
// the checks shared by account-frames.spec.ts and account-frames-scale.spec.ts.
import { expect } from '@playwright/test';
import type { Harness } from './helpers';

const state = (page: import('@playwright/test').Page, id: string) => page.locator(`#${id}`).getAttribute('data-onlyread-state');

type Box = { x: number; y: number; width: number; height: number };
export const near = (a: Box | null, b: Box | null, px = 1) =>
  !!a && !!b && (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(a[k] - b[k]) <= px);

/** The account page (`url`, the mock's /__frames) with Activity framed and settled. `size`: the viewport's; none, the
 *  window's own (a Harness started with windowViewport, at the screen's scaling). `spotStyle`: the placeholder's own
 *  style, as the account page might give it (padding, a border). */
export async function openFramed(h: Harness, url: string, size?: { width: number; height: number }, spotStyle?: string) {
  const page = await h.ctx.newPage();
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  /** The window's content resized (a viewport, or the window itself). */
  const resize = async (width: number, height: number) => {
    if (size) await page.setViewportSize({ width, height });
    else await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
  };
  if (size) await resize(size.width, size.height);
  await page.goto(url);
  await expect.poll(() => state(page, 'activity')).toBe('framed');
  const inner = page.frameLocator('#activity iframe');
  await expect(inner.locator('#activity')).toBeVisible({ timeout: 10_000 });
  const iframe = page.locator('#activity iframe');
  const spot = page.locator('#activity');
  const frame = (await (await iframe.elementHandle())!.contentFrame())!; // Activity's, not Security's
  if (spotStyle) await spot.evaluate((el, css) => { (el as HTMLElement).style.cssText = css; }, spotStyle);
  // The frame sized to its content, as it told the page.
  await expect.poll(async () => (await iframe.evaluate((f) => (f as HTMLIFrameElement).style.height)) ===
    `${await frame.evaluate(() => Math.ceil(document.querySelector('.page')!.getBoundingClientRect().height))}px`).toBe(true);
  // The frame at the screen's scaling, as the page around it.
  expect(await frame.evaluate(() => devicePixelRatio)).toBeCloseTo(await page.evaluate(() => devicePixelRatio), 5);
  // The section's entrance animation over: no finite animation left running in the frame.
  await expect.poll(() => frame.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity).length)).toBe(0);
  const before = { frame: await iframe.boundingBox(), spot: (await spot.boundingBox())!, height: await iframe.evaluate((f) => (f as HTMLIFrameElement).style.height) };
  const section = (await inner.locator('#activity').boundingBox())!;
  const dialog = inner.locator('#report-dialog');
  /** Opens the dialog (`again`: closes it first, and opens it again a task later) and watches every frame for the next
   *  second: the dialog must never be seen (opacity above 0) while the frame is not the window's size, or it shows
   *  clipped to the section's small frame. */
  const show = async (again = false) => {
    const { w, hgt } = await page.evaluate(() => ({ w: document.documentElement.clientWidth, hgt: document.documentElement.clientHeight }));
    const seen = await frame.evaluate(({ again }) => new Promise<{ w: number; h: number }[]>((resolve) => {
      const d = document.getElementById('report-dialog') as HTMLDialogElement;
      const samples: { w: number; h: number }[] = [];
      const t0 = performance.now();
      const sample = () => {
        if (d.open && Number(getComputedStyle(d).opacity) > 0) samples.push({ w: visualViewport!.width, h: visualViewport!.height });
        if (performance.now() - t0 < 1000) requestAnimationFrame(sample); else resolve(samples);
      };
      if (again) { d.close(); setTimeout(() => { d.showModal(); sample(); }, 0); } else { d.showModal(); sample(); }
    }), { again });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(Math.abs(s.w - w) <= 2 && Math.abs(s.h - hgt) <= 2, `dialog seen in a ${s.w}×${s.h} frame`).toBe(true);
  };
  const close = () => frame.evaluate(() => (document.getElementById('report-dialog') as HTMLDialogElement).close());
  /** Covering: the frame is the window, the section drawn at its spot (fixed in the frame, not at the frame's corner),
   *  the dialog shown, in the window's middle. */
  const covering = async () => {
    const { w, hgt } = await page.evaluate(() => ({ w: document.documentElement.clientWidth, hgt: document.documentElement.clientHeight }));
    await expect.poll(async () => near(await iframe.boundingBox(), { x: 0, y: 0, width: w, height: hgt })).toBe(true);
    await expect.poll(() => frame.evaluate(() => getComputedStyle(document.querySelector('.page')!).position)).toBe('fixed');
    // Where the section sits in its spot, and how much narrower it is: the same at any window size.
    const offset = { x: section.x - before.spot.x, y: section.y - before.spot.y, width: before.spot.width - section.width };
    await expect.poll(async () => {
      const at = (await spot.boundingBox())!;
      const got = (await inner.locator('#activity').boundingBox())!;
      return near({ ...got, height: 0 }, { x: at.x + offset.x, y: at.y + offset.y, width: at.width - offset.width, height: 0 });
    }).toBe(true);
    await expect.poll(() => dialog.evaluate((d) => getComputedStyle(d).opacity)).toBe('1');
    const box = (await dialog.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - w / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - hgt / 2)).toBeLessThan(2);
  };
  /** Back in its spot at its own height, the section where it was. */
  const back = async () => {
    await expect.poll(async () => near(await iframe.boundingBox(), before.frame)).toBe(true);
    expect(await iframe.evaluate((f) => (f as HTMLIFrameElement).style.height)).toBe(before.height);
    await expect.poll(async () => near(await inner.locator('#activity').boundingBox(), section)).toBe(true);
    expect(await spot.evaluate((el) => (el as HTMLElement).style.minHeight)).toBe('');
    expect(await frame.evaluate(() => getComputedStyle(document.querySelector('.page')!).position)).not.toBe('fixed');
  };
  return { page, frame, iframe, spot, before, show, close, covering, back, resize };
}

