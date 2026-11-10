import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../shared/types';

// The log with storage replaced: `failNext` makes the next set reject, `writes` records each set's size.
// One failed write must not poison every later one, and an entry must not rewrite the whole log.
let store: Record<string, unknown>;
let failNext = false;
let writes: number[] = [];
let sets = 0;
let audit: typeof import('./audit');
let health: typeof import('./storage-health');

const keysOf = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
beforeEach(async () => {
  vi.resetModules();
  store = {}; failNext = false; writes = []; sets = 0;
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (k: string | string[]) => Object.fromEntries(keysOf(k).filter((x) => x in store).map((x) => [x, structuredClone(store[x])])),
    set: async (o: Record<string, unknown>) => {
      sets++;
      if (failNext) { failNext = false; throw new Error('QUOTA_BYTES quota exceeded'); }
      writes.push(JSON.stringify(o).length);
      Object.assign(store, structuredClone(o));
    },
    remove: async (k: string | string[]) => { for (const x of keysOf(k)) delete store[x]; },
  } }, action: { setBadgeText: async () => {} } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  audit = await import('./audit');
  health = await import('./storage-health');
});
// A write still scheduled goes now, into this test's storage, not into the next test's once its timer fires.
afterEach(async () => { await audit.flush(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const entry = (i: number, over: Partial<AuditEntry> = {}): AuditEntry => ({ kind: 'system', ts: i, tabId: -1, method: '-', url: '-', verdict: 'allow', source: 'system', reason: `r${i}`, mode: 'enforce', enforced: false, ...over });
/** What storage holds, oldest first, read the way the e2e helper does. */
const stored = (): AuditEntry[] => ((store.auditIndex ?? []) as number[]).flatMap((id) => (store[`audit.${id}`] ?? []) as AuditEntry[]);
const chunkKeys = () => Object.keys(store).filter((k) => k.startsWith('audit.')).sort();

describe('toolbar badge', () => {
  const g = globalThis as { __ONLYREAD_DIST__?: boolean; __ONLYREAD_SERVICE_URL__?: string };
  const host = () => chrome as unknown as { action: unknown };
  let action: unknown;
  beforeEach(() => { action = host().action; });
  afterEach(() => { delete g.__ONLYREAD_DIST__; delete g.__ONLYREAD_SERVICE_URL__; host().action = action; });
  const badge = () => {
    const text = vi.fn(async () => {});
    const background = vi.fn(async () => {});
    host().action = { setBadgeText: text, setBadgeBackgroundColor: background, setBadgeTextColor: vi.fn(async () => {}) };
    audit.clearBadge();
    return { text: text.mock.calls.map((c) => (c as unknown[])[0]), background: background.mock.calls.length };
  };
  it('is cleared in a development build and in a store release', () => {
    expect(badge()).toEqual({ text: [{ text: '' }], background: 0 });
    g.__ONLYREAD_DIST__ = true;
    g.__ONLYREAD_SERVICE_URL__ = '';
    expect(badge()).toEqual({ text: [{ text: '' }], background: 0 });
  });
  it('says DEV in a test release', () => {
    g.__ONLYREAD_DIST__ = true;
    g.__ONLYREAD_SERVICE_URL__ = 'https://foo.example';
    expect(badge()).toEqual({ text: [{ text: 'DEV' }], background: 1 });
  });
});

describe('audit log persistence', () => {
  it('keeps writing after a failed write, and says so until a write succeeds', async () => {
    await audit.record(entry(1, { enforced: true }));
    failNext = true;
    await audit.record(entry(2, { enforced: true })); // resolves: a failure never rejects
    expect(health.storageProblem()).toMatch(/activity log could not be saved \(QUOTA_BYTES/);
    expect(stored().map((e) => e.reason)).toEqual(['r1']);
    await audit.record(entry(3, { enforced: true }));
    expect(health.storageProblem()).toBeUndefined();
    expect(stored().map((e) => e.reason)).toEqual(['r1', 'r2', 'r3']);
  });

  it('writes a refusal at once and the rest within half a second, together', async () => {
    vi.useFakeTimers();
    await audit.record(entry(1));
    await audit.record(entry(2));
    expect(sets).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(stored().map((e) => e.reason)).toEqual(['r1', 'r2']);
    expect(sets).toBe(1);
    await audit.record(entry(3, { enforced: true }));
    expect(stored().map((e) => e.reason)).toEqual(['r1', 'r2', 'r3']);
    expect(sets).toBe(2);
  });

  it('rewrites one chunk per append, not the whole log', async () => {
    const preview = 'x'.repeat(1000);
    for (let i = 0; i < audit.MAX_ENTRIES; i++) await audit.record(entry(i, { bodyPreview: preview }));
    await audit.flush();
    const whole = JSON.stringify(stored()).length;
    expect(whole).toBeGreaterThan(2_000_000);
    writes = [];
    await audit.record(entry(9999, { bodyPreview: preview, enforced: true }));
    const perAppend = writes.reduce((a, b) => a + b, 0);
    // The newest chunk (one entry) and the oldest, trimmed by one (CHUNK - 1 entries), plus the index.
    expect(perAppend).toBeLessThan(whole / 10);
    expect(perAppend).toBeLessThan(audit.CHUNK * 1200);
    expect((await audit.size()).entries).toBe(audit.MAX_ENTRIES);
    expect(stored()).toHaveLength(audit.MAX_ENTRIES);
    expect(stored()[0]!.reason).toBe('r1');
  });

  it('drops the oldest past the byte ceiling, whole chunks leaving storage', async () => {
    const preview = 'y'.repeat(5000);
    for (let i = 0; i < 1500; i++) await audit.record(entry(i, { bodyPreview: preview }));
    await audit.flush();
    const { entries, bytes } = await audit.size();
    expect(entries).toBeLessThan(1500);
    expect(bytes).toBeLessThanOrEqual(audit.MAX_BYTES);
    const ids = store.auditIndex as number[];
    expect(ids[0]).toBeGreaterThan(0);
    expect(chunkKeys()).toEqual(ids.map((id) => `audit.${id}`).sort());
    expect(stored()).toHaveLength(entries);
    expect((await audit.list())[0]!.reason).toBe('r1499'); // newest first
  });

  it('clear removes every chunk', async () => {
    for (let i = 0; i < 250; i++) await audit.record(entry(i));
    await audit.flush();
    expect(store.auditIndex).toEqual([0, 1, 2]);
    await audit.clear();
    expect(store.auditIndex).toEqual([]);
    expect(chunkKeys()).toEqual([]);
    expect(await audit.list()).toEqual([]);
  });

  it('comes back from storage in order after a worker restart', async () => {
    for (let i = 0; i < 150; i++) await audit.record(entry(i));
    await audit.flush();
    vi.resetModules();
    audit = await import('./audit');
    expect((await audit.list()).map((e) => e.reason).slice(0, 2)).toEqual(['r149', 'r148']);
    await audit.record(entry(150, { enforced: true }));
    expect(stored()).toHaveLength(151);
    expect(store.auditIndex).toEqual([0, 1]);
  });

  // An unreadable log must not start empty: the next refusal would write a fresh index over the stored chunks
  // (orphaned for good). Entries are held, nothing is written, and once a read succeeds they are merged in behind
  // what was stored.
  it('holds entries while storage cannot be read, writes nothing over the stored log, and merges them once it can', async () => {
    await audit.record(entry(1, { enforced: true }));
    vi.resetModules(); // a fresh worker: the next read comes from storage
    audit = await import('./audit');
    health = await import('./storage-health');
    const local = (globalThis as { chrome: { storage: { local: { get: (k: string | string[]) => Promise<Record<string, unknown>> } } } }).chrome.storage.local;
    const realGet = local.get;
    local.get = async () => { throw new Error('IO error'); };
    await audit.record(entry(2, { enforced: true }));
    await audit.record(entry(3));
    expect(sets).toBe(1); // only the first entry's write; nothing while unreadable
    expect(health.storageProblem()).toMatch(/activity log could not be read \(IO error\)/);
    expect((await audit.list()).map((e) => e.reason)).toEqual(['r3', 'r2']);
    expect((await audit.size()).entries).toBe(2);
    local.get = realGet;
    await audit.record(entry(4, { enforced: true }));
    expect(stored().map((e) => e.reason)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(health.storageProblem()).toBeUndefined();
    expect(store.auditIndex).toEqual([0]);
  });

  // A flush asked for while a write is under way goes again after that write, so an entry appended in the tick
  // after its loop ended does not wait for the next flush.
  it('writes what arrives during a write before a flush asked for meanwhile resolves', async () => {
    const local = (globalThis as { chrome: { storage: { local: { set: (o: Record<string, unknown>) => Promise<void> } } } }).chrome.storage.local;
    const realSet = local.set;
    let release!: () => void;
    local.set = (o) => new Promise<void>((resolve) => { release = () => { void realSet(o).then(resolve); }; });
    const first = audit.record(entry(1, { enforced: true })); // its write is under way, waiting on `release`
    await new Promise((r) => setTimeout(r, 0));
    await audit.record(entry(2)); // appended during the write
    const again = audit.flush();
    local.set = realSet;
    release();
    await first; await again;
    expect(stored().map((e) => e.reason)).toEqual(['r1', 'r2']);
  });
});
