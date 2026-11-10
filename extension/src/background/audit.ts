import type { AuditEntry } from '../shared/types';
import { storageFailed, storageOk } from './storage-health';

// The log is stored in chunks of CHUNK entries under `audit.<id>`, with the chunk order under `auditIndex`, so
// an append rewrites one small key. One array rewritten whole on every entry costs 4.8 MB per entry once full
// (2,000 entries with 2 KB previews), for allows and system events too, which pegs the worker on a busy page. Writes are coalesced: a refusal is written at once (it
// must survive a worker shutdown that can follow any moment); everything else goes with the next write, at
// most every FLUSH_MS. A failed write is reported (storage-health.ts) and retried with the next one; it never
// poisons later writes.
const INDEX_KEY = 'auditIndex';
const chunkKey = (id: number) => `audit.${id}`;
export const MAX_ENTRIES = 2000;
/** Entries per storage key: the most one append rewrites. */
export const CHUNK = 100;
/** The log's share of storage.local's 10 MB (with the request log and the verdict cache, see docs/ARCHITECTURE.md):
 *  2,000 ordinary entries fit; with the largest previews (4.8 MB at MAX_ENTRIES, measured) the oldest go first. */
export const MAX_BYTES = 3 * 1024 * 1024;
const FLUSH_MS = 500;

interface Chunk { id: number; entries: AuditEntry[]; sizes: number[]; dirty: boolean }

let chunks: Chunk[] | null = null;
let loading: Promise<Chunk[]> | null = null;
let nextId = 0;
let total = 0;
let totalBytes = 0;
let indexDirty = false;
const removed = new Set<number>();
let writing: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
/** Entries recorded while storage could not be read: kept here, listed, and merged in once a read succeeds, so a
 *  fresh log is never written over one that could not be read (the same rule as the cache's reads). */
const held: AuditEntry[] = [];
const HELD_MAX = 500;

/** Bytes the entry takes in storage, near enough (JSON text plus the separator). */
const sizeOf = (e: AuditEntry): number => JSON.stringify(e).length + 1;

function chunkOf(id: number, entries: AuditEntry[], dirty: boolean): Chunk {
  const sizes = entries.map(sizeOf);
  total += entries.length;
  for (const s of sizes) totalBytes += s;
  return { id, entries, sizes, dirty };
}

async function loadChunks(): Promise<Chunk[]> {
  total = 0; totalBytes = 0;
  const out: Chunk[] = [];
  const r = await chrome.storage.local.get([INDEX_KEY]);
  const ids = Array.isArray(r[INDEX_KEY]) ? (r[INDEX_KEY] as unknown[]).filter((n): n is number => Number.isInteger(n)) : [];
  if (ids.length) {
    const stored = await chrome.storage.local.get(ids.map(chunkKey));
    for (const id of ids) {
      const entries = stored[chunkKey(id)];
      if (Array.isArray(entries)) out.push(chunkOf(id, entries as AuditEntry[], false));
    }
  }
  nextId = (out.at(-1)?.id ?? -1) + 1;
  chunks = out;
  storageOk('audit', 'read');
  for (const e of held.splice(0)) append(out, e); // what was recorded while the log could not be read
  if (pending(out)) scheduleFlush();
  return out;
}

// One shared load: concurrent first calls must not each read storage and then overwrite each other's copy. A
// failed read is reported and forgotten, so the next call reads again; meanwhile entries are held (see `held`).
function load(): Promise<Chunk[]> {
  if (chunks) return Promise.resolve(chunks);
  if (!loading) {
    loading = loadChunks().then((cs) => cs, (err: unknown) => {
      loading = null;
      storageFailed('audit', err, 'read');
      throw err;
    });
  }
  return loading;
}

/** The chunks, or null while storage cannot be read. */
const loaded = (): Promise<Chunk[] | null> => load().catch(() => null);

function append(cs: Chunk[], entry: AuditEntry): void {
  let last = cs.at(-1);
  if (!last || last.entries.length >= CHUNK) { last = { id: nextId++, entries: [], sizes: [], dirty: true }; cs.push(last); indexDirty = true; }
  const size = sizeOf(entry);
  last.entries.push(entry); last.sizes.push(size); last.dirty = true;
  total++; totalBytes += size;
  trim(cs);
}

/** Drop the oldest entries past the count and byte ceilings; an emptied chunk leaves storage with the next write. */
function trim(cs: Chunk[]): void {
  while (cs.length && (total > MAX_ENTRIES || totalBytes > MAX_BYTES)) {
    const oldest = cs[0]!;
    const n = Math.max(1, Math.min(oldest.entries.length, total - MAX_ENTRIES));
    oldest.entries.splice(0, n);
    for (const s of oldest.sizes.splice(0, n)) totalBytes -= s;
    total -= n;
    oldest.dirty = true;
    if (!oldest.entries.length) { cs.shift(); removed.add(oldest.id); indexDirty = true; }
  }
}

const pending = (cs: Chunk[]): boolean => indexDirty || removed.size > 0 || cs.some((c) => c.dirty);

/** What one write carries: the dirty chunks (copied, so a push during the write is not half-serialized), the index
 *  when the chunk list changed, and the keys to remove. Taking it clears the marks; `undo` puts them back. */
interface Batch { set: Record<string, unknown>; remove: string[]; dirty: Chunk[]; index: boolean; gone: number[] }

function takeBatch(cs: Chunk[]): Batch {
  const dirty = cs.filter((c) => c.dirty);
  const set: Record<string, unknown> = {};
  for (const c of dirty) { c.dirty = false; set[chunkKey(c.id)] = [...c.entries]; }
  const index = indexDirty; indexDirty = false;
  if (index) set[INDEX_KEY] = cs.map((c) => c.id);
  const gone = [...removed]; removed.clear();
  return { set, remove: gone.map(chunkKey), dirty, index, gone };
}

function undoBatch(b: Batch): void {
  for (const c of b.dirty) c.dirty = true;
  indexDirty ||= b.index;
  for (const id of b.gone) removed.add(id);
}

/** Writes what changed, then what changed meanwhile, until nothing is left. One write at a time; a failure
 *  leaves the work marked for the next flush and ends this one, so a persistent failure cannot spin. */
async function writeAll(): Promise<void> {
  const cs = await loaded();
  if (!cs) return; // nothing is written over a log that could not be read
  while (pending(cs)) {
    const b = takeBatch(cs);
    try {
      if (Object.keys(b.set).length) await chrome.storage.local.set(b.set);
      if (b.remove.length) await chrome.storage.local.remove(b.remove);
      storageOk('audit');
    } catch (err) {
      undoBatch(b);
      storageFailed('audit', err);
      return;
    }
  }
}

/** Write every pending change now. Resolves once the attempt is over; never rejects (a failure is in status).
 *  A flush asked for while a write is under way goes again after it: an entry recorded in the tick between the
 *  write loop ending and `writing` clearing would otherwise wait for the next flush. */
export function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
  if (writing) return writing.then(() => flush());
  writing = writeAll().finally(() => { writing = null; });
  return writing;
}

function scheduleFlush(): void {
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = undefined; void flush(); }, FLUSH_MS);
}

export async function record(entry: AuditEntry): Promise<void> {
  const cs = await loaded();
  if (!cs) {
    held.push(entry);
    if (held.length > HELD_MAX) held.splice(0, held.length - HELD_MAX);
    return;
  }
  append(cs, entry);
  if (entry.enforced) await flush(); else scheduleFlush();
}

/** Newest first; while storage cannot be read, what was recorded meanwhile. */
export async function list(): Promise<AuditEntry[]> {
  const cs = await loaded();
  return [...(cs ?? []).flatMap((c) => c.entries), ...held].reverse();
}

/** Tests: how much the log holds now, entries and bytes as the trimming counts them. */
export async function size(): Promise<{ entries: number; bytes: number }> {
  if (!(await loaded())) return { entries: held.length, bytes: held.reduce((n, e) => n + sizeOf(e), 0) };
  return { entries: total, bytes: totalBytes };
}

export async function clear(): Promise<void> {
  const cs = await load();
  for (const c of cs) removed.add(c.id);
  cs.length = 0; total = 0; totalBytes = 0; indexDirty = true;
  await flush();
}

// Replaced by esbuild at build time (scripts/build.mjs); unit tests set them as globals or not at all (typeof keeps
// them running). Read directly, not through policy.ts, so the store build folds the test to false and drops the badge.
declare const __ONLYREAD_DIST__: boolean;
declare const __ONLYREAD_SERVICE_URL__: string;

/** The toolbar icon carries no counter: the popup shows the site's status and the page shows refusals. A test release
 *  (harness/bundle.py --service-url) carries "DEV" instead, so it is never mistaken for the store copy. */
export function clearBadge(): void {
  if (typeof __ONLYREAD_DIST__ !== 'undefined' && __ONLYREAD_DIST__ && typeof __ONLYREAD_SERVICE_URL__ !== 'undefined' && __ONLYREAD_SERVICE_URL__) {
    void chrome.action.setBadgeText({ text: 'DEV' });
    void chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    void chrome.action.setBadgeTextColor({ color: '#ffffff' });
    return;
  }
  void chrome.action.setBadgeText({ text: '' });
}
