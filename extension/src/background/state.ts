// The service worker's shared state: one object the background modules read and update, so the wiring in
// index.ts, the message handlers and the guard logic all see the same policy, judges and fail-closed flag.
import type { AuditEntry, Policy, SettingsLock } from '../shared/types';
import type { StoredPin } from './protection';
import type { Secrets } from '../shared/providers';
import type { Judge } from './judge/types';
import { RulesOnlyJudge } from './judge/rules-only';
import { defaultPolicy } from './policy';
import { guardedSiteIds } from './sites';
import * as audit from './audit';
import * as dbg from './debugger';
import * as sink from './sink';
import { lockPin } from './lock-state';

export const S = {
  policy: defaultPolicy() as Policy,
  /** Why each dynamic rule exists, by rule id (for the DNR logger and `rules:list`). */
  ruleReasons: new Map<number, string>(),
  judge: new RulesOnlyJudge() as Judge,
  reviewJudge: undefined as Judge | undefined,
  /** Why the own-key judge cannot run, surfaced in status; cleared when it can. */
  judgeProblem: undefined as string | undefined,
  /** The person agreed to what the AI judge is sent (consent.ts); without it no judge runs. */
  judgeConsent: false,
  /** The global fail-closed rule is installed: nothing non-GET reaches a guarded site. */
  failClosed: false,
  /** Session rule installed: non-GET requests from no tab are refused. */
  workerOrigin: false,
  /** Session rule installed: non-GET requests from extension pages in a tab are refused. */
  extensionPageRule: false,
  /** Hosts whose worker requests the debugger holds and judges, so the rule above lets them past (guard.ts). */
  workerHosts: [] as string[],
  // attachWhen='agent-session': true only while an agent session is active, either detected (a tab another
  // debugger is attached to, see agent-detect.ts) or declared by the harness (session:set). Persisted in
  // storage.session so a service-worker restart mid-session does not silently go dormant.
  agentSession: false,
  /** This browser belongs to an AI agent (agent-browser.ts): set up with a setup link, locked as if one always worked. */
  agentBrowser: false,
  declaredSession: false,
  agentTabs: new Set<number>(),
  /** Until when an entered settings PIN keeps weakening changes allowed (ms since epoch). */
  pinUnlockedUntil: 0,
};

/** Whether the debugger should be attached and rules installed right now (Off, session gating included). */
export function attachmentOn(): boolean {
  return dbg.attachmentActive(S.policy.attachWhen, S.agentSession, S.policy.enabled);
}

export function system(reason: string, tabId = -1): void {
  const entry: AuditEntry = { kind: 'system', ts: Date.now(), tabId, method: '-', url: '-', verdict: 'allow', source: 'system', reason, mode: S.policy.mode, enforced: false };
  void audit.record(entry);
  sink.send('system', entry);
}

export async function getSecrets(): Promise<Secrets> {
  const { secrets } = await chrome.storage.local.get('secrets');
  return typeof secrets === 'object' && secrets !== null ? (secrets as Secrets) : {};
}

/** The PIN record the lock checks against (lock-state.ts: the background's copy, stricter of it and storage). */
export function storedPin(): Promise<StoredPin | undefined> {
  return lockPin();
}

/** An AI agent is at work here: a session OnlyRead detects, or a browser that belongs to an agent (agent-browser.ts),
 *  whose computer-use agent no debugger shows. */
export function agentAtWork(): boolean {
  return S.agentSession || S.agentBrowser;
}

/** What stops protection being lowered right now (protection.ts lockFor): an agent at work, a PIN not entered.
 *  Read by the settings messages and by the Pro account's site list (cloud-sync.ts) alike. */
export async function settingsLock(): Promise<SettingsLock> {
  const pinUnlocked = Date.now() < S.pinUnlockedUntil;
  return { agent: agentAtWork(), agentBrowser: S.agentBrowser, pinSet: Boolean(await storedPin()), pinUnlocked, ...(pinUnlocked ? { pinUnlockedUntil: S.pinUnlockedUntil } : {}) };
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** Enabled site ids, verified and custom, from the lists in force (the Pro account's while it manages them). */
export function enabledSiteIds(p: Policy = S.policy): string[] {
  return guardedSiteIds(p);
}
