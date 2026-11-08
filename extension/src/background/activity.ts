// The settings page's Overview counts and Activity list, from the activity log (audit.ts), so the page asks for a
// small answer (`activity:get`) instead of the whole log every few seconds. Pure: the log, the sites and the clock in.
import type { ActivityItem, ActivitySummary, AuditEntry, SiteView } from '../shared/types';
import { operationName, retryKey, stoppedBy } from '../shared/refusals';
import { isTargetHost } from './decision';

const ACTIVITY_DEFAULT = 20;
export const ACTIVITY_MAX = 100;

const JUDGES = new Set(['jev', 'llm', 'cloud']);

/** A refusal: a decision that actually failed the request (monitor mode logs blocks it let through). A guarded
 *  channel's request refused while the guard was still going in is not one a person needs to see: no write was seen,
 *  and the client sends it again. */
export const isRefusal = (e: AuditEntry): boolean => e.kind === 'decision' && Boolean(e.enforced) && e.reason !== 'socket-guard-starting';

/** A live connection (WebSocket) the site's profile keeps closed: refused as a channel writes could go through, which
 *  OnlyRead cannot look inside, not as a write anyone made. Sites reopen them every second or two. */
export const isSocketRefusal = (e: AuditEntry): boolean => isRefusal(e) && e.reason === 'websocket';

/** A request a judge was asked about: decided by one, or refused because it could not answer. */
export const wasJudged = (e: AuditEntry): boolean =>
  e.kind === 'decision' && (JUDGES.has(e.source) || e.reason.startsWith('judge-'));

/** Names one log entry across asks (the Activity row's report button, background/support.ts): the log keeps no ids,
 *  and its time, request id and address together do not repeat. */
export const entryKey = (e: AuditEntry): string => `${e.ts}|${e.requestId ?? ''}|${e.method} ${e.url}`;

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Refusals this close together, of the same change on the same site and stopped the same way, are one row: one
 *  click's write, the app's retries of it and the like. */
const GROUP_MS = 10_000;

/** One refusal as a row of the list. */
function activityItem(e: AuditEntry, sites: SiteView[]): ActivityItem {
  const host = hostOf(e.url);
  const site = sites.find((s) => isTargetHost(host, s.domains));
  const siteName = site?.name ?? (host.replace(/^www\./, '') || 'a site');
  const by = stoppedBy(e);
  return {
    key: entryKey(e), ts: e.ts, host, siteName, siteId: site?.id, iconUrl: site?.iconUrl, builtin: site?.builtin ?? false,
    what: operationName(e.bodyShape) ?? `A change on ${siteName}`, by: by.text, judge: by.judge,
    code: [e.method, e.bodyShape, e.reason].filter(Boolean).join(' · '),
  };
}

/** A site's refused live connections, all as one quiet row at the newest of them. */
function socketItems(refusals: AuditEntry[], sites: SiteView[]): ActivityItem[] {
  const bySite = new Map<string, ActivityItem>();
  for (const e of refusals) { // newest first
    const item = activityItem(e, sites);
    const row = bySite.get(item.siteName);
    if (row) row.count = (row.count ?? 1) + 1;
    else bySite.set(item.siteName, { ...item, what: `${item.siteName}'s live connections kept closed`, by: 'Live connection', judge: false, socket: true });
  }
  return [...bySite.values()];
}

/** Rows newest first, a run of the same refusal folded into its newest: each within GROUP_MS of the one before it, so a
 *  page retrying a refused change every few seconds is one row however long it goes on (measured from the newest alone,
 *  a retry every 3 to 4 seconds came out as row after row). The count is of changes, not requests: one sent again as it
 *  was (same method, address and body; LinkedIn resends a refused message twice) is the same change. */
function groupRefusals(entries: AuditEntry[], sites: SiteView[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  let seen = new Set<string>();
  let prevTs = 0;
  for (const e of entries) {
    const i = activityItem(e, sites);
    const key = e.retryKey ?? retryKey(e.method, e.url, e.bodyPreview); // older entries keep no key
    const last = out.at(-1);
    if (last && last.host === i.host && last.what === i.what && last.by === i.by && prevTs - i.ts <= GROUP_MS) {
      if (!seen.has(key)) { seen.add(key); last.count = (last.count ?? 1) + 1; }
    } else {
      out.push(i);
      seen = new Set([key]);
    }
    prevTs = i.ts;
  }
  return out;
}

/** Today's counts and one page of refusals, newest first: `limit` of them after skipping `offset` (the settings page's
 *  pages). `entries` is the log newest first (audit.list). */
export function summarizeActivity(entries: AuditEntry[], sites: SiteView[], now: number, limit = ACTIVITY_DEFAULT, offset = 0): ActivitySummary {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const today = { refused: 0, judged: 0, seen: 0 };
  const refusals: AuditEntry[] = [];
  for (const e of entries) {
    if (e.kind !== 'decision') continue;
    if (isRefusal(e)) refusals.push(e);
    if (e.ts < midnight) continue;
    today.seen++;
    if (isRefusal(e) && !isSocketRefusal(e)) today.refused++; // a closed live connection is not a refused write
    if (wasJudged(e)) today.judged++;
  }
  const n = Math.min(Math.max(1, Math.floor(limit) || ACTIVITY_DEFAULT), ACTIVITY_MAX);
  const writes = groupRefusals(refusals.filter((e) => !isSocketRefusal(e)), sites);
  const items = [...writes, ...socketItems(refusals.filter(isSocketRefusal), sites)].sort((a, b) => b.ts - a.ts);
  const from = Math.min(Math.max(0, Math.floor(offset) || 0), Math.max(0, items.length - 1));
  const recent = items.slice(from, from + n);
  return { today, recent, more: items.length > from + recent.length, total: items.length, offset: from };
}
