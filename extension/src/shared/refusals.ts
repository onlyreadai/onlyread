// Refusals in words, shared by the in-page notice (content/actions.ts) and the settings page's Activity section
// (background/activity.ts). The reason codes come from decision.ts, the judge stage and the DNR layer; none of them
// is shown to a person by default (codes sit behind "Details").
import type { AuditEntry } from './types';

const OPAQUE_OP = /^(unknown|unparseable|mismatch|-|\^.*|\d+|0x[0-9a-f]+)$/;

/** Sentence case from a code name: "useCometUFICreateCommentMutation" → "Create comment". */
function words(raw: string): string | undefined {
  const bare = raw.replace(/^(Comet|use|UFI)+/g, '').replace(/(Mutation|Request|Action|Query)$/g, '').replace(/[_-]+/g, ' ');
  const spaced = bare.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : undefined;
}

/** A readable name for the operation a decoded body shape names, or undefined when the shape names none:
 *  `fb:gql:w[useCometUFICreateCommentMutation]` → "Create comment", `gql:mutation:UserSettingsUpdate` → "User settings
 *  update", `li:rsc:w[sharing.CreatePost]` → "Create post". Codes that say nothing to a person (`unknown`, Gmail's
 *  `^i` labels, a count) give undefined. */
export function operationName(shape = ''): string | undefined {
  if (shape.startsWith('whatsapp:')) return whatsappName(shape);
  const op = /:w\[([^\]]+)\]$/.exec(shape)?.[1] ?? /^gql:[a-z]+:([^:]+)$/.exec(shape)?.[1];
  if (!op) return undefined;
  const first = op.split(',')[0]!.split(':').pop()!.split('.').pop()!;
  return OPAQUE_OP.test(first) ? undefined : words(first);
}

/** WhatsApp's stanzas (inpage/wap.ts shapes) by what a person did. A message stanza carries sends, reactions, edits,
 *  pins and deletes alike; its type and edit mark tell them apart. */
const WHATSAPP_NAMES: Record<string, string> = {
  'message:w[reaction]': 'Reaction',
  'iq:w[app-state]': 'Chat setting (star, archive, pin, mute or mark read)',
  'iq:w[w:g2]': 'Group change',
  'iq:w[privacy]': 'Privacy setting',
  'iq:w[w:profile:picture]': 'Profile photo',
  'iq:w[status]': 'About text',
  'iq:w[blocklist]': 'Block list',
  'call:w[call]': 'Call',
  'chatstate:w[composing]': 'Typing indicator',
  'chatstate:w[paused]': 'Typing indicator',
  'frame:w[unvetted]': 'Unchecked message on the connection',
};
const WHATSAPP_EDITS: Record<string, string> = { edit1: 'Edit message', edit2: 'Pin message', edit3: 'Pin message', edit7: 'Delete for everyone', edit8: 'Delete for everyone' };

function whatsappName(shape: string): string | undefined {
  const key = shape.slice('whatsapp:'.length);
  if (WHATSAPP_NAMES[key]) return WHATSAPP_NAMES[key];
  if (key.startsWith('receipt:w[')) return 'Read receipt';
  const msg = /^message:w\[([\w-]+)(?::(edit\d+))?\]$/.exec(key);
  if (msg) return (msg[2] && WHATSAPP_EDITS[msg[2]]) || (msg[1] === 'text' ? 'Send message' : `Send ${msg[1]}`);
  return undefined;
}

/** Names one request by its method, address and body, so a site resending the same refused request (LinkedIn resends a
 *  message twice, 4 and 8 seconds apart) counts once: in the Activity list (background/activity.ts) and the in-page
 *  notice (content/actions.ts). A short hash, so the notice is never sent the address or the body. */
export function retryKey(method: string, url: string, body = ''): string {
  let h = 0x811c9dc5;
  for (const ch of `${method} ${url}\n${body}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}

/** Why a request could not be checked, when that is the only reason it was stopped: the judge failed or timed out,
 *  or OnlyRead Pro could not answer (signed out, inactive, used up, unreachable). Undefined for a real refusal. */
export type CheckFailure = 'pro-signed-out' | 'pro-inactive' | 'pro-credits' | 'pro-limit' | 'pro-unreachable' | 'judge-timeout' | 'judge-error';

const PRO_FAILURES: Record<string, CheckFailure> = {
  not_signed_in: 'pro-signed-out',
  subscription_inactive: 'pro-inactive',
  credits_exhausted: 'pro-credits',
  limit_reached: 'pro-limit',
  unavailable: 'pro-unreachable',
  bad_response: 'pro-unreachable',
};

export function checkFailure(reason = ''): CheckFailure | undefined {
  const pro = /^judge-error:cloud:([a-z_]+)/.exec(reason)?.[1];
  if (pro) return PRO_FAILURES[pro] ?? 'pro-unreachable';
  if (reason.startsWith('judge-timeout') || /llm-timeout/.test(reason)) return 'judge-timeout';
  if (reason.startsWith('judge-error') || reason.startsWith('decision-error') || /llm-error/.test(reason)) return 'judge-error';
  return undefined;
}

const CHECK_CAUSE: Record<CheckFailure, string> = {
  'pro-signed-out': "OnlyRead Pro is signed out and couldn't check it",
  'pro-inactive': "the OnlyRead Pro subscription is inactive, so it couldn't be checked",
  'pro-credits': "your free OnlyRead Pro requests are used up, so it couldn't be checked",
  'pro-limit': "this month's OnlyRead Pro usage is used up, so it couldn't be checked",
  'pro-unreachable': "OnlyRead Pro couldn't be reached to check it",
  'judge-timeout': "the AI judge didn't answer in time",
  'judge-error': "the AI judge couldn't check it",
};

/** "1 request was stopped because OnlyRead Pro is signed out and couldn't check it. Some of the page may not load." */
export function checkFailureLine(kind: CheckFailure, count: number, explain?: string): string {
  const n = count === 1 ? '1 request was' : `${count} requests were`;
  // OnlyRead Pro's own words for refusing to check it (its plan) say why in place of ours.
  if (explain && kind.startsWith('pro-')) return `${n} stopped: ${explain} Some of the page may not load.`;
  return `${n} stopped because ${CHECK_CAUSE[kind]}. Some of the page may not load.`;
}

/** The one fixing action a check failure has in the page: only a Pro sign-in can be fixed from there. */
export function checkFailureAction(kind: CheckFailure | undefined): 'signin' | undefined {
  return kind === 'pro-signed-out' ? 'signin' : undefined;
}

/** One line per stopped change in the notice: "Stopped a change: Create comment." or "Stopped a change on Linear." */
export function stoppedLine(shape: string | undefined, site: string): string {
  const op = operationName(shape);
  return op ? `Stopped a change: ${op}.` : `Stopped a change on ${site}.`;
}

/** How long the in-page notice stays (longer while the pointer is on it): content/actions.ts, and the demo's step 2,
 *  which lasts as long as the notice does (content/demo-coach.ts). */
export const NOTICE_MS = 8000;

/** The notice's title: what was kept read-only, on which site. */
export function noticeTitle(site: string): string {
  return `OnlyRead kept ${site} read-only`;
}

const RULE_REASONS = new Set(['mutating-method', 'post-navigation', 'blocked-get-path', 'upload', 'worker-origin', 'websocket', 'opaque-binary']);
const JUDGES = new Set(['jev', 'llm', 'cloud']);

/** What stopped a refused request, in words for the Activity list, and whether a judge decided it (shown in the
 *  accent). The judge's score is not shown. */
export function stoppedBy(e: Pick<AuditEntry, 'source' | 'reason' | 'pWrite'>): { text: string; judge: boolean } {
  const failure = checkFailure(e.reason);
  if (failure) return { text: failure.startsWith('pro-') ? "Pro couldn't check it" : "The AI judge couldn't check it", judge: false };
  if (e.source === 'cache') return { text: 'Tested list', judge: false };
  if (e.reason === 'decoded-write') return { text: 'Decoded as a write', judge: false };
  if (JUDGES.has(e.source)) {
    if (e.reason.startsWith('review-band') && /no-review|unavailable|block$/.test(e.reason)) return { text: 'AI judge, unsure', judge: true };
    return { text: 'AI judge', judge: true };
  }
  if (e.source === 'rules-only' || e.reason.startsWith('review-band')) return { text: 'No AI judge set up', judge: false };
  if (RULE_REASONS.has(e.reason) || e.source === 'dnr' || e.source === 'rule') return { text: 'Stopped by rule', judge: false };
  return { text: 'Stopped', judge: false };
}

/** "Just now", "2 min ago", "3 h ago", "Yesterday", "Oct 12". */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= midnight) return `${h} h ago`;
  if (ts >= midnight - 86_400_000) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
