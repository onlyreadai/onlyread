// Support reports: the person picks refusals from the activity log on the settings page and sends them, with a note,
// to OnlyRead support (POST /v1/support). Nothing is sent without that click, and what is sent is what the page shows:
// the log's entries with their addresses masked here (secret-named query values, token-like runs) and their body
// previews as the log keeps them (already redacted when recorded, at most 2 KB), a body of bytes named as one instead
// (BINARY_PREVIEW). Pure: the log, the sites and the settings in.
import type { AuditEntry, Policy, SiteView, SupportItem, SupportList, SupportReport, SupportRequest } from '../shared/types';
import { operationName, stoppedBy } from '../shared/refusals';
import { entryKey, isRefusal } from './activity';
import { binaryBody, isTargetHost } from './decision';
import { SECRET_KEY, redactTokens } from './fingerprint';
import { guardedSiteIds } from './sites';

/** The most refusals the list offers, and one report carries. */
export const SUPPORT_MAX = 50;
const NOTE_MAX = 2000;
const EMAIL_MAX = 200;
const PREVIEW_MAX = 2048;
/** What a report carries in place of a body of bytes (gzip, an encrypted protocol): nothing anyone could read, and
 *  text the service can store (Postgres refuses the NUL such a body holds). */
export const BINARY_PREVIEW = '[binary body, not shown]';
/** Half an emoji: a surrogate without its pair, as cutting a string to a length can leave one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text cut to `max` that the service can store: Postgres refuses NUL and half an emoji, so each becomes U+FFFD. */
function storable(text: string, max: number): string {
  return text.slice(0, max).replaceAll('\0', '\uFFFD').replace(LONE_SURROGATE, '\uFFFD');
}

/** A body preview as a report carries it: a body of bytes named as one, else the log's text made storable. */
function reportPreview(preview: string): string {
  return binaryBody(preview) ? BINARY_PREVIEW : storable(preview, PREVIEW_MAX);
}

/** The address with secret-named query values replaced, and token-like runs (ids that work as keys) masked in each
 *  path segment and query value; the host stays. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.split('/').map((seg) => redactTokens(seg)).join('/');
    for (const k of [...new Set(u.searchParams.keys())]) {
      const values = u.searchParams.getAll(k).map((v) => (SECRET_KEY.test(k) ? '[redacted]' : redactTokens(v)));
      u.searchParams.delete(k);
      for (const v of values) u.searchParams.append(k, v);
    }
    return u.toString();
  } catch { return redactTokens(url); }
}

/** One log entry as a report carries it. */
export function supportRequest(e: AuditEntry): SupportRequest {
  const r: SupportRequest = { ts: e.ts, method: e.method, url: maskUrl(e.url), verdict: e.verdict, source: e.source, reason: e.reason };
  if (typeof e.pWrite === 'number') r.pWrite = e.pWrite;
  if (e.judgeModel) r.judgeModel = e.judgeModel;
  if (e.judgeReason) r.judgeReason = storable(e.judgeReason, 300);
  if (e.fingerprint) r.fingerprint = storable(redactTokens(e.fingerprint), Infinity);
  if (e.contentType) r.contentType = e.contentType;
  if (e.bodyShape) r.bodyShape = storable(e.bodyShape, Infinity); // a body's own keys, and those can hold NUL
  if (e.bodyPreview) r.bodyPreview = reportPreview(e.bodyPreview);
  // What was clicked, the three actions nearest the request (the list is newest first): the element and its visible
  // name, not the addresses or field names the action also notes.
  if (e.lastUiActions?.length) r.lastUiActions = e.lastUiActions.slice(0, 3).map((a) => ({ type: a.type, tag: a.tag, ...(a.role ? { role: a.role } : {}), ...(a.name ? { name: storable(a.name, 80) } : {}) }));
  return r;
}


function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** This extension's settings that bear on a refusal. */
export function supportContext(p: Policy, version: string, dev: boolean, userAgent: string): SupportList['context'] {
  return {
    extension: {
      version, build: dev ? 'development' : 'release', mode: p.mode, attachWhen: p.attachWhen,
      judge: p.judge.provider, readTracking: Boolean(p.allowReadTracking), sites: guardedSiteIds(p),
    },
    userAgent: storable(userAgent, 300),
  };
}

/** How close to a refusal the others of its burst are: one click's refused request, the app's retries of it and the
 *  beacons after it come within a second or two of each other. */
export const BURST_MS = 10_000;

/** Refusals as a report would carry them: those named by `keys` (at any age), or the most recent ones, newest first.
 *  `entries` is the log newest first. */
export function supportItems(entries: AuditEntry[], sites: SiteView[], keys?: string[]): SupportItem[] {
  const refusals = entries.filter(isRefusal);
  const picked = keys ? new Set(keys) : undefined;
  return (picked ? refusals.filter((e) => picked.has(entryKey(e))) : refusals.slice(0, SUPPORT_MAX)).map((e) => item(e, sites));
}

/** A refusal and the rest of its burst, for the report dialog: the one named by `key` (else the newest), then the other
 *  refusals of the same tab within BURST_MS of it, newest first, at most SUPPORT_MAX in all. */
export function supportBurst(entries: AuditEntry[], sites: SiteView[], key?: string): SupportItem[] {
  const refusals = entries.filter(isRefusal);
  const target = key ? refusals.find((e) => entryKey(e) === key) : refusals[0];
  if (!target) return [];
  const rest = refusals.filter((e) => e !== target && e.tabId === target.tabId && Math.abs(e.ts - target.ts) <= BURST_MS);
  return [target, ...rest].slice(0, SUPPORT_MAX).map((e) => item(e, sites));
}

/** One refusal as the dialog shows it and a report carries it. */
function item(e: AuditEntry, sites: SiteView[]): SupportItem {
  const host = hostOf(e.url);
  const siteName = sites.find((s) => isTargetHost(host, s.domains))?.name ?? (host.replace(/^www\./, '') || 'a site');
  return { key: entryKey(e), siteName, what: operationName(e.bodyShape) ?? `A change on ${siteName}`, by: stoppedBy(e).text, request: supportRequest(e) };
}

/** An email the person typed, when it looks like one. */
export function cleanEmail(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : undefined;
}

/** The report for the refusals picked by key (those no longer in the log are left out), or why there is none. */
export function buildReport(items: SupportItem[], keys: string[], context: SupportList['context'], note?: string, email?: string): SupportReport | { error: string } {
  const picked = new Set(keys);
  const requests = items.filter((i) => picked.has(i.key)).map((i) => i.request);
  if (!requests.length) return { error: 'Pick at least one refused request.' };
  const n = typeof note === 'string' ? storable(note.trim(), NOTE_MAX) : '';
  const e = cleanEmail(email);
  if (email?.trim() && !e) return { error: 'That email address does not look right.' };
  return { ...(n ? { note: n } : {}), ...(e ? { email: e } : {}), ...context, requests };
}
