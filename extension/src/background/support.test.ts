import { describe, expect, it } from 'vitest';
import type { AuditEntry, SiteView } from '../shared/types';
import { defaultPolicy } from './policy';
import { entryKey } from './activity';
import { BINARY_PREVIEW, BURST_MS, SUPPORT_MAX, buildReport, supportBurst, cleanEmail, maskUrl, supportContext, supportItems, supportRequest } from './support';

const TOKEN = 'AbCdEf0123456789GhIjKlMnOpQrStUv';
const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  kind: 'decision', ts: 1000, tabId: 1, method: 'POST', url: 'https://www.linkedin.com/voyager/api/x?queryId=abc', verdict: 'block',
  source: 'jev', reason: 'jev', mode: 'enforce', enforced: true, bodyShape: 'li:rsc:w[reactions.create]', ...over,
});
const sites = [{ id: 'linkedin', name: 'LinkedIn', domains: ['linkedin.com'] }] as SiteView[];
const context = supportContext(defaultPolicy(), '1.0.0', false, 'UA');

describe('support reports', () => {
  it('masks secret-named query values and token-like runs in the address, and keeps the rest', () => {
    expect(maskUrl(`https://a.example/p/${TOKEN}?token=s3cret&queryId=abc`)).toBe('https://a.example/p/[redacted]?token=%5Bredacted%5D&queryId=abc');
    expect(maskUrl('not a url')).toBe('not a url');
  });

  it('carries what refused the request and what was clicked, not the addresses or fields of the click', () => {
    const r = supportRequest(entry({ pWrite: 0.9, judgeReason: 'x'.repeat(400), bodyPreview: '{"a":1}', lastUiActions: [{ ts: 1, type: 'click', tag: 'button', name: 'Like', url: 'https://www.linkedin.com/feed/', fields: ['q'] }] }));
    expect(r).toMatchObject({ method: 'POST', verdict: 'block', source: 'jev', reason: 'jev', pWrite: 0.9, bodyPreview: '{"a":1}', lastUiActions: [{ type: 'click', tag: 'button', name: 'Like' }] });
    expect(r.judgeReason).toHaveLength(300);
    expect(r.lastUiActions?.[0]).not.toHaveProperty('url');
  });

  it('carries a body of bytes (gzip, as a LinkedIn write can be) as a note that it was binary, not the bytes', () => {
    expect(supportRequest(entry({ bodyPreview: '\u001f\u008b\b\u0000\u0000\u0000\u0000\u0000\u0000\u0003' })).bodyPreview).toBe(BINARY_PREVIEW);
    expect(supportRequest(entry({ bodyPreview: '\u0001\u0002\u0003\u0000abc' })).bodyPreview).toBe(BINARY_PREVIEW);
  });

  it('keeps a mostly-text body as text, with what the service cannot store (NUL, half an emoji) replaced', () => {
    const text = `--b\r\nContent-Disposition: form-data; name="f"\r\n\r\n${'x'.repeat(600)}\u0000\u0001😀`;
    expect(supportRequest(entry({ bodyPreview: text })).bodyPreview).toBe(text.replace('\u0000', '\uFFFD'));
    expect(supportRequest(entry({ bodyPreview: `{"a":"${'y'.repeat(20)}\uD83D…` })).bodyPreview).toBe(`{"a":"${'y'.repeat(20)}\uFFFD…`);
    expect(supportRequest(entry({ bodyPreview: '\uDE00 and 😀' })).bodyPreview).toBe('\uFFFD and 😀');
  });

  it('keeps the fingerprint and body shape storable when the body\'s own keys hold NUL or half an emoji', () => {
    const r = supportRequest(entry({ fingerprint: 'POST www.linkedin.com/x json:a\u0000b', bodyShape: 'json:a\u0000b,\uD83D' }));
    expect(r.fingerprint).toBe('POST www.linkedin.com/x json:a\uFFFDb');
    expect(r.bodyShape).toBe('json:a\uFFFDb,\uFFFD');
  });

  it('cuts the judge\'s sentence and a clicked name to their sizes without leaving half an emoji', () => {
    const r = supportRequest(entry({ judgeReason: `${'x'.repeat(299)}😀`, lastUiActions: [{ ts: 1, type: 'click', tag: 'button', name: `${'n'.repeat(79)}👍`, url: 'https://www.linkedin.com/feed/' }] }));
    expect(r.judgeReason).toBe(`${'x'.repeat(299)}\uFFFD`);
    expect(r.lastUiActions?.[0]?.name).toBe(`${'n'.repeat(79)}\uFFFD`);
  });

  it('keeps the three actions nearest the request, the list being newest first', () => {
    const actions = [4, 3, 2, 1].map((n) => ({ ts: n, type: 'click' as const, tag: 'button', name: `b${n}`, url: 'https://www.linkedin.com/feed/' }));
    expect(supportRequest(entry({ lastUiActions: actions })).lastUiActions?.map((a) => a.name)).toEqual(['b4', 'b3', 'b2']);
  });

  it('lists refusals only, newest first as the log gives them, named by operation and site', () => {
    const items = supportItems([entry({ ts: 3 }), entry({ ts: 2, enforced: false }), entry({ ts: 1, kind: 'system' })], sites);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ siteName: 'LinkedIn', what: expect.any(String) });
    expect(supportItems(Array.from({ length: SUPPORT_MAX + 5 }, (_, i) => entry({ ts: i })), sites)).toHaveLength(SUPPORT_MAX);
    // An Activity row's report: the refusal it names, however far down the log.
    const log = Array.from({ length: SUPPORT_MAX + 5 }, (_, i) => entry({ ts: 1000 - i }));
    const oldest = supportItems(log, sites, [entryKey(log.at(-1)!)]);
    expect(oldest.map((i) => i.request.ts)).toEqual([1000 - SUPPORT_MAX - 4]);
    expect(supportItems(log, sites, ['gone'])).toEqual([]);
  });

  it('gathers a refusal\'s burst: the same tab\'s other refusals within seconds of it, the one asked for first', () => {
    const log = [
      entry({ ts: 30_000, tabId: 1 }),            // a later burst on the same tab: not this one
      entry({ ts: 12_000, tabId: 1, url: 'https://www.linkedin.com/li/tscp/sct' }), // the beacon after the click
      entry({ ts: 11_500, tabId: 2 }),            // another tab
      entry({ ts: 11_000, tabId: 1, bodyShape: 'li:rsc:w[reactions.create]' }), // the click's own write
      entry({ ts: 11_200, tabId: 1, enforced: false }), // not a refusal
    ];
    const like = entryKey(log[3]!);
    expect(supportBurst(log, sites, like).map((i) => i.request.ts)).toEqual([11_000, 12_000]);
    // From the notice or the popup: the newest refusal and its burst.
    expect(supportBurst(log, sites).map((i) => i.request.ts)).toEqual([30_000]);
    expect(supportBurst(log, sites, 'gone')).toEqual([]);
    expect(BURST_MS).toBeGreaterThanOrEqual(5000);
  });

  it('builds the report from the picked refusals, with the note and a well-formed email', () => {
    const items = supportItems([entry({ ts: 2 }), entry({ ts: 1 })], sites);
    const r = buildReport(items, [items[1]!.key, 'gone'], context, '  liking a post ', ' me@example.com ');
    expect(r).toMatchObject({ note: 'liking a post', email: 'me@example.com', extension: { version: '1.0.0', build: 'release', mode: 'enforce' }, requests: [{ ts: 1 }] });
    expect(buildReport(items, ['gone'], context)).toEqual({ error: expect.any(String) });
    expect(buildReport(items, [items[0]!.key], context, '', 'not an email')).toEqual({ error: expect.any(String) });
    expect(cleanEmail('a@b.co')).toBe('a@b.co');
    expect(cleanEmail('a b@c.d')).toBeUndefined();
  });
});
