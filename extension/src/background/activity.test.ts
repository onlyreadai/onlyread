import { describe, expect, it } from 'vitest';
import type { AuditEntry, SiteView } from '../shared/types';
import { ACTIVITY_MAX, isRefusal, summarizeActivity, wasJudged } from './activity';

const now = new Date(2026, 9, 17, 15, 0, 0).getTime();
const yesterday = new Date(2026, 9, 16, 12, 0, 0).getTime();
const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  kind: 'decision', ts: now - 60_000, tabId: 1, method: 'POST', url: 'https://linear.app/api/graphql', verdict: 'allow', source: 'rule',
  reason: 'safe-method', mode: 'enforce', enforced: false, ...over,
});
const site = (over: Partial<SiteView>): SiteView => ({
  id: 'linear', name: 'Linear', domains: ['linear.app'], enabled: true, builtin: true, verified: true, current: false, cacheSize: 0, local: true, account: false, ...over,
});
const sites = [site({}), site({ id: 'app.example.com', name: 'App', domains: ['app.example.com'], builtin: false, iconUrl: 'https://app.example.com/i.png' })];

describe('what counts', () => {
  it('a refusal is a decision that failed the request; monitor-mode blocks and system lines are not', () => {
    expect(isRefusal(entry({ verdict: 'block', enforced: true }))).toBe(true);
    expect(isRefusal(entry({ verdict: 'block', enforced: false, mode: 'monitor' }))).toBe(false);
    expect(isRefusal(entry({ kind: 'system', enforced: true }))).toBe(false);
  });
  it('a judged request is one a judge decided, or was asked about and could not answer', () => {
    for (const source of ['jev', 'llm', 'cloud'] as const) expect(wasJudged(entry({ source }))).toBe(true);
    expect(wasJudged(entry({ source: 'rule', reason: 'judge-timeout' }))).toBe(true);
    expect(wasJudged(entry({ source: 'cache', reason: 'cached:label' }))).toBe(false);
    expect(wasJudged(entry({ source: 'rule', reason: 'mutating-method' }))).toBe(false);
  });
});

describe('summarizeActivity', () => {
  const log: AuditEntry[] = [ // newest first, as audit.list answers
    entry({ verdict: 'block', enforced: true, source: 'jev', reason: 'p>block', pWrite: 0.94, url: 'https://app.example.com/api/star', bodyShape: 'json:id' }),
    entry({ source: 'jev', reason: 'p<allow', pWrite: 0.02 }),
    entry({ kind: 'system', reason: 'debugger-detached' }),
    entry({ verdict: 'block', enforced: true, source: 'cache', reason: 'cached:label', bodyShape: 'gql:mutation:UserSettingsUpdate' }),
    entry({ verdict: 'block', enforced: false, mode: 'monitor', source: 'rule', reason: 'mutating-method' }),
    entry({ ts: yesterday, verdict: 'block', enforced: true, source: 'rule', reason: 'judge-error:cloud:not_signed_in', url: 'https://unknown.example.org/x' }),
  ];

  it('counts today\'s refusals, judged requests and every request decided', () => {
    expect(summarizeActivity(log, sites, now).today).toEqual({ refused: 2, judged: 2, seen: 4 });
  });

  it('lists refusals newest first with the site, the operation in words and what stopped it; reads are not listed', () => {
    const { recent, more } = summarizeActivity(log, sites, now);
    expect(more).toBe(false);
    expect(recent.map((r) => [r.siteName, r.what, r.by, r.judge])).toEqual([
      ['App', 'A change on App', 'AI judge', true],
      ['Linear', 'User settings update', 'Tested list', false],
      ['unknown.example.org', 'A change on unknown.example.org', "Pro couldn't check it", false],
    ]);
    expect(recent[0]).toMatchObject({ siteId: 'app.example.com', iconUrl: 'https://app.example.com/i.png', builtin: false, host: 'app.example.com', code: 'POST · json:id · p>block' });
    expect(recent[2]!.siteId).toBeUndefined();
  });

  it('gives one page at a time: where it starts, how many in all, and whether more follow', () => {
    // A minute apart: each its own row (close repeats are grouped, below).
    const many = Array.from({ length: 12 }, (_, i) => entry({ ts: now - i * 60_000, verdict: 'block', enforced: true, reason: 'mutating-method' }));
    const first = summarizeActivity(many, sites, now, 5, 0);
    expect(first).toMatchObject({ total: 12, offset: 0, more: true });
    expect(first.recent.map((r) => r.ts)).toEqual([now, now - 60_000, now - 120_000, now - 180_000, now - 240_000]);
    const last = summarizeActivity(many, sites, now, 5, 10);
    expect(last).toMatchObject({ total: 12, offset: 10, more: false });
    expect(last.recent).toHaveLength(2);
    // Past the end (refusals aged out between two pages): the last refusal's page, never an empty one.
    expect(summarizeActivity(many, sites, now, 5, 40)).toMatchObject({ offset: 11, more: false });
    expect(summarizeActivity([], sites, now, 5, 3)).toMatchObject({ total: 0, offset: 0, recent: [] });
  });

  it('groups the same refusal on the same site, stopped the same way, within seconds, into one row with a count', () => {
    const r = (ts: number, over: Partial<AuditEntry> = {}) => entry({ ts, verdict: 'block', enforced: true, reason: 'mutating-method', ...over });
    const b = (n: number) => ({ bodyPreview: `{"title":"${n}"}` }); // three different changes, not one sent again
    const log = [r(now, b(1)), r(now - 1_000, b(2)), r(now - 3_000, b(3)), r(now - 4_000, { url: 'https://app.example.com/x' }), r(now - 5_000), r(now - 60_000)];
    const rows = summarizeActivity(log, sites, now).recent;
    expect(rows.map((x) => [x.siteName, x.count ?? 1])).toEqual([['Linear', 3], ['App', 1], ['Linear', 1], ['Linear', 1]]);
    expect(summarizeActivity(log, sites, now)).toMatchObject({ total: 4, today: { refused: 6 } }); // today counts every refusal
  });
  it('folds a page retrying the same refused change every few seconds into one row, however long it goes on, as one change', () => {
    const r = (ts: number) => entry({ ts, verdict: 'block', enforced: true, reason: 'mutating-method' });
    const retries = Array.from({ length: 60 }, (_, i) => r(now - i * 3_500)); // 3.5 minutes of retries
    const later = r(now - 60 * 3_500 - 30_000); // half a minute after the run: a row of its own
    const rows = summarizeActivity([...retries, later], sites, now).recent;
    expect(rows.map((x) => x.count ?? 1)).toEqual([1, 1]);
  });
  // LinkedIn resends a refused message twice, 4 and 8 seconds apart, as it was: one message, one change.
  it('counts a request the site sent again as it was once, and a different one in the same run as another change', () => {
    const send = (ts: number, body: string) => entry({ ts, verdict: 'block', enforced: true, source: 'rule', reason: 'decoded-write',
      url: 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', bodyShape: 'li:msg:w[send]', bodyPreview: body });
    const linkedin = [...sites, site({ id: 'linkedin', name: 'LinkedIn', domains: ['linkedin.com'] })];
    const first = '{"message":{"body":{"text":"hi"}},"trackingId":"a"}';
    const rows = summarizeActivity([send(now, first), send(now - 8_000, first), send(now - 12_000, first)], linkedin, now).recent;
    expect(rows.map((x) => [x.what, x.count ?? 1])).toEqual([['Send', 1]]);
    const two = summarizeActivity([send(now, '{"trackingId":"b"}'), send(now - 4_000, first), send(now - 8_000, first)], linkedin, now).recent;
    expect(two.map((x) => [x.what, x.count ?? 1])).toEqual([['Send', 2]]);
  });
  it('shows as many as asked, within bounds, and says when the log holds more', () => {
    const many = Array.from({ length: 150 }, (_, i) => entry({ ts: now - i * 60_000, verdict: 'block', enforced: true, reason: 'mutating-method' }));
    expect(summarizeActivity(many, sites, now).recent).toHaveLength(20);
    expect(summarizeActivity(many, sites, now).more).toBe(true);
    expect(summarizeActivity(many, sites, now, 5).recent).toHaveLength(5);
    expect(summarizeActivity(many, sites, now, 1000).recent).toHaveLength(ACTIVITY_MAX);
    expect(summarizeActivity(many, sites, now, 0).recent).toHaveLength(20);
    expect(summarizeActivity([], sites, now)).toEqual({ today: { refused: 0, judged: 0, seen: 0 }, recent: [], more: false, total: 0, offset: 0 });
  });

  it('names a host it cannot parse by nothing rather than throwing', () => {
    const { recent } = summarizeActivity([entry({ url: 'not a url', verdict: 'block', enforced: true })], sites, now);
    expect(recent[0]!.host).toBe('');
  });
});

describe('live connections kept closed', () => {
  const socket = (ts: number) => entry({ ts, method: 'GET', url: 'wss://linear.app/sync', resourceType: 'websocket', verdict: 'block', enforced: true, source: 'dnr', reason: 'websocket' });
  // One write refused, its socket refused again and again around it (a site reopening it every second or two).
  const log: AuditEntry[] = [
    socket(now - 1_000), socket(now - 2_000),
    entry({ ts: now - 3_000, verdict: 'block', enforced: true, source: 'rule', reason: 'decoded-write', bodyShape: 'gql:mutation:IssueUpdate' }),
    socket(now - 4_000), socket(now - 30_000), socket(now - 90_000),
  ];

  it('are not counted among the refused writes', () => {
    expect(summarizeActivity(log, sites, now).today.refused).toBe(1);
  });
  it('are one quiet row per site, at the newest of them, beside the write', () => {
    const { recent, total } = summarizeActivity(log, sites, now);
    expect(total).toBe(2);
    expect(recent[0]).toMatchObject({ socket: true, siteName: 'Linear', what: "Linear's live connections kept closed", count: 5, by: 'Live connection' });
    expect(recent[1]).toMatchObject({ what: 'Issue update' });
    expect(recent[1]?.socket).toBeUndefined();
  });
});
