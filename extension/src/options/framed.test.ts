import { describe, expect, it } from 'vitest';
import { coverFrom, coverQueryFor, coverRule, coverSlack, framedByService, strayFrame } from './framed';

// The framed settings page shows anything only inside the Pro service's own page (options/framed.ts).
describe('framedByService', () => {
  const pro = 'https://pro.onlyread.ai';
  it('takes exactly one ancestor, the service\'s origin', () => {
    expect(framedByService(['https://pro.onlyread.ai'], pro)).toBe(true);
    expect(framedByService(['https://pro.onlyread.ai'], `${pro}/`)).toBe(true);
    expect(framedByService(['http://localhost:4173'], 'http://localhost:4173/cloud')).toBe(true);
  });
  it('refuses any other page, a frame inside a frame, no frame at all, and a broken address', () => {
    expect(framedByService(['https://evil.example'], pro)).toBe(false);
    expect(framedByService(['https://pro.onlyread.ai.evil.example'], pro)).toBe(false);
    expect(framedByService(['http://pro.onlyread.ai'], pro)).toBe(false);
    expect(framedByService(['https://pro.onlyread.ai', 'https://pro.onlyread.ai'], pro)).toBe(false);
    expect(framedByService(['https://evil.example', 'https://pro.onlyread.ai'], pro)).toBe(false);
    expect(framedByService([], pro)).toBe(false);
    expect(framedByService(['https://pro.onlyread.ai'], 'not a url')).toBe(false);
  });
});

// The whole settings page in another page's frame could be clicked through from there: only framed mode may be framed.
describe('strayFrame', () => {
  it('lets the page show on its own, and framed mode go on to its own check', () => {
    expect(strayFrame([], true, false)).toBe(false);
    expect(strayFrame(['https://evil.example'], false, true)).toBe(false); // allowFrame then checks the framing page
    expect(strayFrame(['https://pro.onlyread.ai'], false, true)).toBe(false);
  });
  it('blanks the full page in any frame, whoever frames it', () => {
    expect(strayFrame(['https://evil.example'], false, false)).toBe(true);
    expect(strayFrame(['https://pro.onlyread.ai'], false, false)).toBe(true);
    expect(strayFrame([], false, false)).toBe(true); // no ancestor list (a sandboxed frame): not the top window still counts
    expect(strayFrame(['https://evil.example'], true, false)).toBe(true);
  });
});

// While a dialog is open the account page has the frame cover its window, and says where the section's spot is.
describe('coverFrom', () => {
  it('takes the spot, or null once the frame is back in its spot', () => {
    expect(coverFrom({ x: 280, y: 412.5, width: 760 })).toEqual({ x: 280, y: 412.5, width: 760 });
    expect(coverFrom({ x: -4, y: -900, width: 1, height: 3 })).toEqual({ x: -4, y: -900, width: 1 });
    expect(coverFrom(null)).toBeNull();
  });
  it('ignores anything else', () => {
    expect(coverFrom(undefined)).toBeUndefined();
    expect(coverFrom('cover')).toBeUndefined();
    expect(coverFrom({ x: 1, y: 2 })).toBeUndefined();
    expect(coverFrom({ x: '1', y: 2, width: 3 })).toBeUndefined();
    expect(coverFrom({ x: 1, y: NaN, width: 3 })).toBeUndefined();
    expect(coverFrom({ x: 1, y: 2, width: 0 })).toBeUndefined();
    expect(coverFrom({ x: 1, y: 2, width: Infinity })).toBeUndefined();
  });
});

describe('coverRule', () => {
  const c = { x: 280, y: 412.5, width: 760 };
  it('draws the section at its spot whenever the frame is not its size in the page, give or take the slack', () => {
    expect(coverQueryFor(c, 102, 1)).toBe('not all and (759px < width < 761px) and (101px < height < 103px)');
    expect(coverRule(c, 102, 1)).toBe(
      '@media not all and (759px < width < 761px) and (101px < height < 103px) { html.framed-cover .page { position: fixed; top: 412.5px; left: 280px; width: 760px; box-sizing: border-box; } }');
  });
  it('allows a screen pixel and a half, a CSS pixel at least', () => {
    expect(coverSlack(1)).toBe(1.5);
    expect(coverSlack(1.25)).toBeCloseTo(1.2);
    expect(coverSlack(2)).toBe(1);
    expect(coverSlack(0.8)).toBeCloseTo(1.875);
    expect(coverSlack(0.67)).toBeCloseTo(2.24);
  });
});
