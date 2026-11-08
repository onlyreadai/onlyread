import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, Policy, RequestRecord } from '../shared/types';
import type { Decision } from './decision';

// The request path with its neighbours replaced: decide() returns what each test asks for, and the
// audit log, the dev sink, the debugger and the unguarded-tab rule are recorded instead of run.
const h = vi.hoisted(() => ({
  decision: undefined as Decision | undefined,
  audit: [] as AuditEntry[],
  sink: [] as { kind: string; payload: Record<string, unknown> }[],
  attach: vi.fn(async () => true),
  lost: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));
vi.mock('./decision', async (orig) => ({ ...(await orig<typeof import('./decision')>()), decide: vi.fn(async () => h.decision!) }));
vi.mock('./audit', () => ({ record: async (e: AuditEntry) => { h.audit.push(e); } }));
vi.mock('./sink', () => ({ send: (kind: string, payload: Record<string, unknown>) => { h.sink.push({ kind, payload }); }, ownOrigin: () => 'chrome-extension://onlyread' }));
vi.mock('./debugger', async (orig) => ({ ...(await orig<typeof import('./debugger')>()), attach: h.attach }));
vi.mock('./guard', () => ({ unguarded: { lost: h.lost, remove: h.remove, tabs: () => [] }, closing: { list: () => [] } }));

const { onDecisionError, onPaused, onWebRequestError, onDetach } = await import('./interception');
const { attachCommitted } = await import('./debugger');
const { S } = await import('./state');
const { decide } = await import('./decision');
const { defaultPolicy, normalizePolicy } = await import('./policy');

const sendMessage = vi.fn(async () => undefined);
const reload = vi.fn(async () => undefined);
const tabsGet = vi.fn(async (id: number) => ({ id, url: 'https://app.example.com/' }));

function policy(mode: 'monitor' | 'enforce', patch: Partial<Policy> = {}): Policy {
  const p = normalizePolicy({ ...defaultPolicy(), enabled: true, mode, customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }], ...patch });
  return p;
}
function rec(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    ts: 1, tabId: 7, requestId: 'req-1', method: 'POST', url: 'https://app.example.com/api/items', host: 'app.example.com',
    path: '/api/items', queryKeys: [], contentType: 'application/json', resourceType: 'Fetch', hasBody: true,
    bodyPreview: '{"title":"x"}', bodyShape: 'json:title', fingerprint: 'POST app.example.com/api/items json:title', lastUiActions: [],
    ...over,
  };
}
const refuse: Decision = { verdict: 'block', action: 'fail', source: 'jev', reason: 'p>block', pWrite: 0.97 };
const pass: Decision = { verdict: 'allow', action: 'continue', source: 'jev', reason: 'p<allow', pWrite: 0.04 };

beforeEach(() => {
  h.audit.length = 0; h.sink.length = 0; h.attach.mockClear(); h.lost.mockClear(); h.remove.mockClear();
  sendMessage.mockClear(); reload.mockClear(); tabsGet.mockClear(); vi.mocked(decide).mockClear();
  vi.stubGlobal('chrome', { tabs: { sendMessage, reload, get: tabsGet }, debugger: { sendCommand: vi.fn(async () => ({})) } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('onPaused: a request on a guarded tab', () => {
  it('lets requests to other hosts through without judging them', async () => {
    S.policy = policy('enforce');
    expect(await onPaused(rec({ host: 'other.example.org', url: 'https://other.example.org/x' }))).toBe('continue');
    expect(decide).not.toHaveBeenCalled();
    expect(h.audit).toEqual([]);
  });

  it('in enforce, refuses a write: fails the request, records it as enforced and shows the in-page notice', async () => {
    S.policy = policy('enforce'); h.decision = refuse;
    expect(await onPaused(rec())).toBe('fail');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ kind: 'decision', verdict: 'block', enforced: true, mode: 'enforce', reason: 'p>block', fingerprint: 'POST app.example.com/api/items json:title' });
    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'onlyread:blocked', shape: 'json:title', reason: 'p>block', path: '/api/items', site: 'App', request: 'POST https://app.example.com/api/items', sig: expect.stringMatching(/^[0-9a-f]+$/) }); // a development build (vitest) names the request
  });

  // The notice counts a request the page sends again as it was once (content/actions.ts): the same request, the same key.
  it('names the refused request to the notice by a key, the same for a request sent again as it was', async () => {
    S.policy = policy('enforce'); h.decision = refuse;
    await onPaused(rec({ requestId: 'r-1' }));
    await onPaused(rec({ requestId: 'r-2', ts: 9 }));
    await onPaused(rec({ requestId: 'r-3', bodyPreview: '{"title":"y"}' }));
    const sigs = (sendMessage.mock.calls as unknown as [number, { sig: string }][]).map(([, m]) => m.sig);
    expect(sigs[0]).toBe(sigs[1]);
    expect(sigs[2]).not.toBe(sigs[0]);
  });

  // LinkedIn resends a refused message as it was but for one flag (false, then true): the same message, the same key.
  it('names a site\'s resend by the same key when its codec says what only marks the resend', async () => {
    S.policy = policy('enforce', { customSites: [{ id: 'www.linkedin.com', name: 'LinkedIn', domains: ['www.linkedin.com'], enabled: true }] }); h.decision = refuse;
    const url = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage';
    const send = (text: string, resent: boolean) => rec({ host: 'www.linkedin.com', url, path: '/voyager/api/voyagerMessagingDashMessengerMessages',
      bodyPreview: `{"message":{"body":{"text":"${text}"}},"trackingId":"t-${text}","dedupeByClientGeneratedToken":${resent}}`, bodyShape: 'li:msg:w[send]' });
    await onPaused(send('hi', false));
    await onPaused(send('hi', true));
    await onPaused(send('ho', false));
    expect(h.audit[0]!.retryKey).toBe(h.audit[1]!.retryKey);
    expect(h.audit[2]!.retryKey).not.toBe(h.audit[0]!.retryKey);
  });

  it('in enforce, answers with a rollback-triggering refusal on hosts whose site asks for it', async () => {
    S.policy = policy('enforce'); S.policy.effective.rejectDomains = ['app.example.com']; h.decision = refuse;
    expect(await onPaused(rec())).toBe('reject');
  });

  it('in monitor, records the same refusal but lets the request through, with no notice', async () => {
    S.policy = policy('monitor'); h.decision = refuse;
    expect(await onPaused(rec())).toBe('continue');
    expect(h.audit[0]).toMatchObject({ verdict: 'block', enforced: false, mode: 'monitor' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets an allowed request through in enforce', async () => {
    S.policy = policy('enforce'); h.decision = pass;
    expect(await onPaused(rec())).toBe('continue');
    expect(h.audit[0]).toMatchObject({ verdict: 'allow', enforced: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a write from a worker (no tab) without trying to show a notice', async () => {
    S.policy = policy('enforce'); h.decision = refuse;
    expect(await onPaused(rec({ tabId: -1 }))).toBe('fail');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends the dev sink the full body when the preview was truncated, and keeps it out of the audit log', async () => {
    S.policy = policy('enforce'); h.decision = pass;
    await onPaused(rec({ bodyFull: '{"title":"a much longer body"}' }));
    expect(h.sink[0]?.payload.bodyFull).toBe('{"title":"a much longer body"}');
    expect(h.audit[0]).not.toHaveProperty('bodyFull');
  });

  it('reloads the tab after a refusal when the policy asks for it', async () => {
    vi.useFakeTimers();
    S.policy = policy('enforce', { onRefusedMutation: 'reload' }); h.decision = refuse;
    await onPaused(rec());
    await vi.runAllTimersAsync();
    expect(reload).toHaveBeenCalledWith(7);
  });
});

describe('onWebRequestError: blocks by the declarative rules', () => {
  const err = (over: Partial<{ requestId: string; url: string; method: string; tabId: number; type: string; error: string; initiator: string }> = {}) => ({
    requestId: 'net-1', url: 'https://app.example.com/api/items', method: 'PUT', tabId: 7, type: 'xmlhttprequest', error: 'net::ERR_BLOCKED_BY_CLIENT', ...over,
  });

  it('records a block that one of OnlyRead\'s rules made', () => {
    S.policy = policy('enforce');
    onWebRequestError(err());
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ source: 'dnr', verdict: 'block', enforced: true, method: 'PUT' });
  });

  // A PUT never reaches the debugger (LinkedIn's settings save the language by PUT): without the notice the page's
  // own error looked like a network fault.
  it('shows the in-page notice for a write refused by rule, as for the debugger\'s refusals', () => {
    S.policy = policy('enforce');
    onWebRequestError(err());
    expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'onlyread:blocked', reason: 'mutating-method', path: '/api/items', site: 'App', sig: expect.any(String) }));
  });

  it('shows no notice for a refusal with no tab, or one of the cover rules that refuse reads too', () => {
    S.policy = policy('enforce');
    S.failClosed = true;
    try {
      onWebRequestError(err({ method: 'POST' }));
      expect(h.audit[0]).toMatchObject({ reason: 'fail-closed:debugger-detached' });
    } finally {
      S.failClosed = false;
    }
    onWebRequestError(err({ tabId: -1 }));
    expect(h.audit).toHaveLength(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores ordinary network errors, other hosts, and blocks no OnlyRead rule explains', () => {
    S.policy = policy('enforce');
    onWebRequestError(err({ error: 'net::ERR_CONNECTION_RESET' }));
    onWebRequestError(err({ url: 'https://other.example.org/x' }));
    onWebRequestError(err({ method: 'GET', url: 'https://app.example.com/feed' })); // e.g. an ad blocker
    expect(h.audit).toEqual([]);
  });

  // The debugger's refusals carry the Fetch interception id and webRequest its own, so a dedup by
  // id could never match. A request the debugger refused is still logged once: the rules apply before the Fetch pause,
  // so no rule explains a request that reached the debugger, and webRequest's error for it is dropped as not ours.
  it('does not count a request twice when the debugger already refused it', async () => {
    S.policy = policy('enforce'); h.decision = refuse;
    await onPaused(rec({ requestId: 'interception-job-2.0' }));
    h.audit.length = 0;
    onWebRequestError(err({ requestId: '18', method: 'POST' }));
    expect(h.audit).toEqual([]);
  });

  // The extension's own requests (its judge, Pro, the dev sink) are never a page's refusal; logged, the dev sink's
  // refused POST would be sent to the sink again, each refusal breeding the next.
  it('ignores a block of the extension\'s own request', () => {
    S.policy = policy('enforce');
    onWebRequestError(err({ initiator: 'chrome-extension://onlyread', tabId: -1 }));
    expect(h.audit).toEqual([]);
    expect(h.sink).toEqual([]);
  });

  // With the extension-page rules installed, a refused POST from the popup (no tab) to a guarded host is
  // logged as the extension page's; the background's own, to its services, still never is.
  it('records the popup\'s refused POST to a guarded host, never the background\'s to its own services', () => {
    S.policy = policy('enforce');
    S.policy.cloud.serviceUrl = 'https://app.example.com/cloud';
    S.extensionPageRule = true;
    try {
      onWebRequestError(err({ initiator: 'chrome-extension://onlyread', tabId: -1, method: 'POST', url: 'https://app.example.com/v1/classify' }));
      expect(h.audit).toEqual([]);
      S.policy.cloud.serviceUrl = 'https://pro.example.net';
      onWebRequestError(err({ initiator: 'chrome-extension://onlyread', tabId: -1, method: 'POST' }));
      expect(h.audit).toHaveLength(1);
      expect(h.audit[0]).toMatchObject({ source: 'dnr', reason: 'extension-page', method: 'POST', tabId: -1 });
    } finally {
      S.extensionPageRule = false;
    }
  });
});

describe('onDecisionError: the decision path threw before a decision', () => {
  const paused = { requestId: 'i-9', frameId: 'f', resourceType: 'XHR', request: { url: 'https://app.example.com/api/items', method: 'POST', headers: {} } };
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('in monitor, continues the request and logs a decision-error', () => {
    S.policy = policy('monitor');
    expect(onDecisionError(7, paused, new Error('odd body'))).toBe('continue');
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ kind: 'decision', verdict: 'block', enforced: false, mode: 'monitor', method: 'POST', url: 'https://app.example.com/api/items', reason: 'decision-error:odd body', requestId: 'i-9' });
    expect(h.sink[0]?.kind).toBe('decision');
  });

  it('in enforce, fails closed and logs it, with the error text cut short', () => {
    S.policy = policy('enforce');
    expect(onDecisionError(7, paused, new Error('x'.repeat(400)))).toBe('fail');
    expect(h.audit[0]).toMatchObject({ verdict: 'block', enforced: true, mode: 'enforce' });
    expect(h.audit[0]!.reason.length).toBe('decision-error:'.length + 160);
  });
});

describe('onDetach: the debugger lost a tab', () => {
  // Attached all the time, so a lost tab matters (in agent-session mode with no session nothing is attached).
  const attached = () => policy('enforce', { attachWhen: 'always' });
  afterEach(async () => { await attachCommitted(7, 'https://app.example.com/'); });

  // The person's Cancel on the infobar is a lost session like any other, so
  // protection holds and the bar comes back; switching protection off is the way to be rid of it.
  it('after the person cancels the debugger: the tab is fenced by rule and attached again once it settles', async () => {
    vi.useFakeTimers();
    S.policy = attached();
    onDetach(7, 'canceled_by_user');
    expect(h.lost).toHaveBeenCalledWith(7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.attach).toHaveBeenCalledWith(7, 'https://app.example.com/');
    expect(h.remove).toHaveBeenCalledWith([7]);
    expect(h.audit.map((e) => e.reason)).toContain('debugger-detached:canceled_by_user');
  });

  // Any other loss (older Chromes reported `replaced_with_devtools`): the same.
  it('covers the tab with its own rule and reattaches it once it settles', async () => {
    vi.useFakeTimers();
    S.policy = attached();
    onDetach(7, 'replaced_with_devtools');
    expect(h.lost).toHaveBeenCalledWith(7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.attach).toHaveBeenCalledWith(7, 'https://app.example.com/');
    expect(h.remove).toHaveBeenCalledWith([7]);
  });

  it('keeps the rule when reattaching fails', async () => {
    vi.useFakeTimers();
    S.policy = attached(); h.attach.mockResolvedValueOnce(false);
    onDetach(7, 'replaced_with_devtools');
    expect(h.lost).toHaveBeenCalledWith(7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.attach).toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('drops the rule when the tab is gone by the time it would reattach', async () => {
    vi.useFakeTimers();
    S.policy = attached(); tabsGet.mockResolvedValueOnce(undefined as never);
    onDetach(7, 'replaced_with_devtools');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.attach).not.toHaveBeenCalled();
    expect(h.remove).toHaveBeenCalledWith([7]);
  });

  it('does nothing for a closed tab', () => {
    S.policy = attached();
    onDetach(7, 'target_closed');
    expect(h.lost).not.toHaveBeenCalled();
  });

  it('does nothing while dormant (agent-session mode with no session): the detach is expected', () => {
    S.policy = policy('enforce', { attachWhen: 'agent-session' }); S.agentSession = false;
    onDetach(7, 'canceled_by_user');
    expect(h.lost).not.toHaveBeenCalled();
  });
});
