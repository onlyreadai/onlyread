// OnlyRead Pro (subscription mode): the signed-in client, the account shown in the UI, and sign-in.
import { setProRefusal } from './pro-refusal';
import { type AgentName, browserNameOf, isAgentName } from '../shared/agent-setup';
import type { CloudAccount, CloudStatus, Policy } from '../shared/types';
import { CloudClient, CloudError, browserPlatform, pkceChallenge, randomToken, signInUrl, uninstallUrl, type BrowserInfo, type Tokens } from './judge/cloud';
import { releaseAgentBrowser } from './agent-browser';
import { ownRemove, ownSet } from './owned-storage';
import { RELEASE_SERVICE_URL, devMockServiceUrl, devServiceLocal } from './policy';
import { guardedSiteIds } from './sites';
import { S, system } from './state';

// The tokens are written as the background's own (owned-storage.ts): dropping them in an agent's browser is a lowering
// an outside write must not make.
const tokenStore = {
  async get(): Promise<Tokens | undefined> {
    const { cloudTokens } = await chrome.storage.local.get('cloudTokens');
    return cloudTokens && typeof cloudTokens === 'object' ? (cloudTokens as Tokens) : undefined;
  },
  async set(t: Tokens | undefined): Promise<void> {
    if (t) await ownSet({ cloudTokens: t });
    else await ownRemove('cloudTokens');
    applyUninstallUrl(t);
    if (!t) for (const fn of signedOutHooks) fn();
  },
};

function applyUninstallUrl(t: Tokens | undefined): void {
  try {
    void Promise.resolve(chrome.runtime.setUninstallURL?.(uninstallUrl(S.policy.cloud.serviceUrl, t))).catch(() => {});
  } catch { /* not in this browser */ }
}

/** At startup: the uninstall page for the sign-in kept in storage. */
export async function refreshUninstallUrl(): Promise<void> {
  applyUninstallUrl(await tokenStore.get());
}
/** Told whenever the sign-in ends, however it ended: signed out here, or by the service (the account page signed this
 *  browser out, its sign-in ran out). */
const signedOutHooks: (() => void)[] = [];
export function whenSignedOut(fn: () => void): void { signedOutHooks.push(fn); }
let clientRef: CloudClient | undefined;
let account: CloudAccount | undefined;
let accountAt = 0;
let lastError: CloudStatus['lastError'];

/** Set when the service refused a refresh and the tokens were dropped (a revoked sign-in), kept in storage until the
 *  next sign-in, so the popup and the settings page say why Pro stopped rather than only "not signed in";
 *  otherwise a sign-in lost overnight would leave nothing in the log or the UI saying so. */
const REFUSED_KEY = 'cloudRefreshRefusedAt';
function refreshRefused(): void {
  system('cloud:refresh-refused signed out');
  // Signed out from the account page: an agent's browser is released (agent-browser.ts).
  void releaseAgentBrowser('signed out by the account').catch(() => {});
  void chrome.storage.local.set({ [REFUSED_KEY]: Date.now() }).catch(() => {});
}
async function refusedAt(): Promise<number | undefined> {
  try { const v = (await chrome.storage.local.get(REFUSED_KEY))[REFUSED_KEY]; return typeof v === 'number' ? v : undefined; } catch { return undefined; }
}
const ACCOUNT_TTL_MS = 5 * 60_000;

/** How many times this worker has signed in. cloud-sync.ts keys the site list's ETag by it: tokens can be lost outside
 *  a sync (a 401 on classify or /v1/me), and a sign-in to another account whose list is at the same version would then read a
 *  304 as "unchanged", and the first account's list would stay in force, shown as the second's. */
let signIns = 0;
export function signInGeneration(): number { return signIns; }

/** The AI agent that said it runs this browser (the agent-setup page, messages.ts setupAgent), kept in storage. */
const AGENT_KEY = 'agentName';
const NAME_KEY = 'browserName';
let agentName: AgentName | undefined;
let browserName: string | undefined;
void chrome.storage.local.get([AGENT_KEY, NAME_KEY]).then((r) => {
  if (isAgentName(r[AGENT_KEY])) agentName = r[AGENT_KEY];
  browserName = browserNameOf(r[NAME_KEY]);
}).catch(() => {});

/** Notes the agent, and the name it gave this browser, and tells the service at once when signed in (the account
 *  page then shows the mark, and the name unless the person named the browser there). */
export async function setAgentName(agent: AgentName, name?: string): Promise<void> {
  agentName = agent;
  browserName = browserNameOf(name) ?? browserName;
  await chrome.storage.local.set({ [AGENT_KEY]: agent, ...(browserName ? { [NAME_KEY]: browserName } : {}) });
  system(`agent-setup:agent ${agent}`);
  if (await cloudClient().signedIn()) await cloudStatus(true);
}

/** This browser for GET /v1/me: its platform, the sites it guards now (enabled, this browser's and the account's), the
 *  extension's version, and the agent that said it runs it. */
function thisBrowser(): BrowserInfo {
  return { platform: browserPlatform(navigator as Navigator & { userAgentData?: { platform?: string } }), sites: guardedSiteIds(S.policy).length, version: chrome.runtime.getManifest().version, ...(agentName ? { agent: agentName } : {}), ...(browserName ? { name: browserName } : {}) };
}

export function cloudClient(p: Policy = S.policy): CloudClient {
  if (!clientRef || clientRef.serviceUrl !== p.cloud.serviceUrl.replace(/\/$/, '')) {
    // A judged request used one of the account's requests: the next look at the account fetches it again.
    clientRef = new CloudClient({ serviceUrl: p.cloud.serviceUrl, store: tokenStore, onRefreshRefused: refreshRefused, browser: thisBrowser, onJudged: () => { accountAt = 0; } });
    account = undefined;
    accountAt = 0;
  }
  return clientRef;
}

/** Account and last error for the UI; refetches the account when stale or when asked. */
export async function cloudStatus(refresh = false): Promise<CloudStatus> {
  const c = cloudClient();
  const signedIn = await c.signedIn();
  if (!signedIn) account = undefined;
  else if (refresh || !account || Date.now() - accountAt > ACCOUNT_TTL_MS) {
    try {
      account = await c.me();
      accountAt = Date.now();
    } catch (err) {
      if (err instanceof CloudError) lastError = { code: err.code, at: Date.now(), ...(err.serverMessage ? { message: err.serverMessage } : {}) };
    }
  }
  const nowSignedIn = await c.signedIn();
  const refused = nowSignedIn ? undefined : await refusedAt();
  return { provider: S.policy.judge.provider, serviceUrl: S.policy.cloud.serviceUrl, signedIn: nowSignedIn, account, lastError, ...(refused ? { signedOutAt: refused } : {}) };
}

export function onCloudResult(err: CloudError | null): void {
  setProRefusal(err?.serverMessage);
  if (!err) { lastError = undefined; return; }
  lastError = { code: err.code, at: Date.now(), ...(err.serverMessage ? { message: err.serverMessage } : {}) };
  // Subscription or quota changed server-side: refresh the account so the UI shows why.
  if (err.code === 'subscription_inactive' || err.code === 'credits_exhausted' || err.code === 'limit_reached') accountAt = 0;
}

/** Sign-in happens in the page that asked (the setup window or the settings tab), the way extensions usually sign in
 *  through their website: the tab goes to the
 *  service's sign-in page, the service sends it to its done page with a one-time code, the content script hands the
 *  code over (messages.ts proSignInCode, from that page's top frame only), and the tab goes back. The PKCE verifier and
 *  the state wait in session storage, tied to the tab, for SIGN_IN_TTL_MS. */
const PENDING_KEY = 'cloudSignInPending';
export const SIGN_IN_TTL_MS = 10 * 60_000;
interface PendingSignIn { state: string; verifier: string; redirect: string; tabId: number; back: string; at: number }

/** The address the code is bound to, the one chrome.identity.getRedirectURL('cloud') gives: the service reads the
 *  extension's ID from it. Nothing is ever loaded from it. */
export function signInRedirect(): string {
  return `https://${chrome.runtime.id}.chromiumapp.org/cloud`;
}

/** Starts a sign-in in tab `tabId`, which returns to `back` when it ends; the sign-in page's address, on `serviceUrl`. */
export async function startSignIn(tabId: number, back: string, serviceUrl = S.policy.cloud.serviceUrl): Promise<string> {
  const pending: PendingSignIn = { state: randomToken(16), verifier: randomToken(32), redirect: signInRedirect(), tabId, back, at: Date.now() };
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
  return signInUrl(serviceUrl, pending.redirect, pending.state, await pkceChallenge(pending.verifier));
}

/** Whether anything answers at `url` within a second and a half: any HTTP answer counts, only no answer does not. */
export async function serviceAnswers(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try { await fetchImpl(url, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

/** The service a sign-in should go to instead of `p`'s, or undefined to keep it. A development build made for the local
 *  mock (no ONLYREAD_SERVICE_URL, policy.ts devServiceLocal) defaults to it on the dev sink's host; when
 *  the mock is not running, its sign-in page cannot be reached ("This site can't be reached"), so the sign-in falls back
 *  to the real Pro service. Only such a build on the mock's own default address falls back: a release, a build made for
 *  another service, an address set by hand and a running mock (the e2e suites) keep theirs. */
export async function signInFallback(p: Pick<Policy, 'cloud' | 'devSink'>, answers: (url: string) => Promise<boolean> = serviceAnswers): Promise<string | undefined> {
  const mock = devMockServiceUrl(p.devSink);
  if (!devServiceLocal() || !mock || p.cloud.serviceUrl.replace(/\/$/, '') !== mock || mock === RELEASE_SERVICE_URL) return undefined;
  return (await answers(mock)) ? undefined : RELEASE_SERVICE_URL;
}

/** The sign-in waiting for its code, if one is and it has not expired (left in place). */
export async function pendingSignIn(now = Date.now()): Promise<PendingSignIn | undefined> {
  const p = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as PendingSignIn | undefined;
  return p && now - p.at <= SIGN_IN_TTL_MS ? p : undefined;
}

/** The sign-in this tab started with this state, taken (it is good once); undefined if none, or if it expired. */
export async function takeSignIn(state: string, tabId: number): Promise<PendingSignIn | undefined> {
  const p = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] as PendingSignIn | undefined;
  if (!p || p.state !== state || p.tabId !== tabId) return undefined;
  await chrome.storage.session.remove(PENDING_KEY);
  return Date.now() - p.at <= SIGN_IN_TTL_MS ? p : undefined;
}

/** Exchanges the code for this browser's tokens. Throws CloudError. */
export async function finishSignIn(code: string, p: PendingSignIn): Promise<CloudStatus> {
  await cloudClient().exchangeCode(code, p.verifier, p.redirect);
  return signedIn('cloud:signed-in');
}

/** Signs in with a setup link's one-time code (the agent-setup page, messages.ts setupApply). Throws CloudError. */
export async function signInWithSetupLink(code: string): Promise<CloudStatus> {
  await cloudClient().redeemSetupLink(code);
  return signedIn('cloud:signed-in by setup link');
}

async function signedIn(note: string): Promise<CloudStatus> {
  signIns++;
  lastError = undefined;
  await chrome.storage.local.remove(REFUSED_KEY).catch(() => {});
  system(note);
  // The judge becomes Pro and an own key is deleted by the caller, through the lock (messages.ts enterPro).
  return cloudStatus(true);
}

export async function cloudSignOut(): Promise<CloudStatus> {
  await cloudClient().signOut();
  account = undefined;
  lastError = undefined;
  await chrome.storage.local.remove(REFUSED_KEY).catch(() => {});
  system('cloud:signed-out');
  return cloudStatus(false);
}
