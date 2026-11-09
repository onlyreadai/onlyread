import { describe, expect, it } from 'vitest';
import { coverFrom, coverRule, framedByService } from './framed';

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

// While a dialog is open the account page has the frame cover its window, and says where the section's spot is and
// how big the window is.
describe('coverFrom', () => {
  it('takes the spot and the window\'s size, or null once the frame is back in its spot', () => {
    expect(coverFrom({ x: 280, y: 412.5, width: 760, vw: 1200, vh: 800 })).toEqual({ x: 280, y: 412.5, width: 760, vw: 1200, vh: 800 });
    expect(coverFrom({ x: -4, y: -900, width: 1, vw: 1, vh: 1 })).toEqual({ x: -4, y: -900, width: 1, vw: 1, vh: 1 });
    expect(coverFrom(null)).toBeNull();
  });
  it('ignores anything else', () => {
    expect(coverFrom(undefined)).toBeUndefined();
    expect(coverFrom('cover')).toBeUndefined();
    expect(coverFrom({ x: 1, y: 2, width: 3 })).toBeUndefined();
    expect(coverFrom({ x: '1', y: 2, width: 3, vw: 4, vh: 5 })).toBeUndefined();
    expect(coverFrom({ x: 1, y: NaN, width: 3, vw: 4, vh: 5 })).toBeUndefined();
    expect(coverFrom({ x: 1, y: 2, width: 0, vw: 4, vh: 5 })).toBeUndefined();
    expect(coverFrom({ x: 1, y: 2, width: 3, vw: 4, vh: 0 })).toBeUndefined();
  });
});

describe('coverRule', () => {
  it('draws the section at its spot only while the frame is the window\'s size', () => {
    expect(coverRule({ x: 280, y: 412.5, width: 760, vw: 1200, vh: 799.6 })).toBe(
      '@media (width: 1200px) and (height: 800px) { html.framed-cover .page { position: fixed; top: 412.5px; left: 280px; width: 760px; box-sizing: border-box; } }');
  });
});
