import type { Codec } from './types';

// ---- LinkedIn "flagship-web" client: POST /flagship-web/rsc-action/actions/server-request, JSON body
//   {"requestId": "com.linkedin.sdui.<…>", "serverRequest": {…}, …}
// One endpoint multiplexes page-data reads (fetch*/get*/search*, …Badge, …Typeahead, …Nba) and every
// write (reactions.create/delete, comments.createComment, sharing.CreatePost, update.saveState/deletePost,
// profile.saveProfileIntroForm, mynetwork.addaMarkNotificationsSeen, …). The key shape is identical for
// all of them, so the requestId VALUE decides. Write-biased: only a requestId matching an observed read
// pattern is a read; everything else, and any unreadable body, is a write. Namespaces and a "Request"
// suffix are NOT read signals (updateSearchHistoryRequest, addaMarkNotificationsSeen are writes).
const LI_READ_VERB = /^(fetch|get|load|list|search)/i;
const LI_READ_SUFFIX = /(Badge|BadgeRequest|Typeahead|TypeaheadRequest|Nba|NbaRequest|NBA)$/;
// Full ids of reads whose names carry no read verb (reads in the UI, which enforce would otherwise refuse).
const LI_READ_EXACT = new Set([
  'feedUpdateControlMenuRequest',
  'com.linkedin.sdui.search.requests.lazyLoadedActionsRequest',   // action buttons for search results (actionSlots by member id)
  'com.linkedin.sdui.requests.search.batchClassicSnippetRequest', // result snippets (memberProfileIds + searchQuery)
  'com.linkedin.sdui.search.requests.globalTypeaheadSubmitAction', // Enter in the header search box: runs the search and navigates to results
  'com.linkedin.sdui.requests.feed.actorPreviewCard',             // a member's preview card in the feed, sent as the feed loads
  'com.linkedin.sdui.requests.feed.orgPreviewCard',               // a company's preview card, sent when the pointer rests on its name
  'com.linkedin.sdui.jobseeker.requests.jobSearchBoxLegoRequest', // the Jobs page's search box, loaded as the page opens
  'com.linkedin.sdui.requests.comments.deferredCommentBox',       // a post's comment input, loaded when Like or the comment icon opens its comments
  'com.linkedin.sdui.pages.messagePage',                          // a company page's message box, opened by its Message button (mailbox and page ids only; Send is a separate write)
]);

// LinkedIn's own error toast, rendered by the server from its text ("There was an issue sending your message, please try
// again."), sent after a refused send. Its body carries free text, so it is a read only in exactly the shape LinkedIn
// sends: every payload in it holds the toast's text and nothing else, and the text is a toast's length. Refused, the
// toast never shows, and the page's own reason for the failure is lost.
const LI_TOAST = 'com.linkedin.sdui.requests.profile.interopShowToast';
const TOAST_MAX = 300;

function isToastPayload(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const p = (args as { payload?: unknown }).payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const keys = Object.keys(p);
  const text = (p as { errorToast?: unknown }).errorToast;
  return keys.length === 1 && keys[0] === 'errorToast' && typeof text === 'string' && text.length <= TOAST_MAX;
}

/** The toast's body as LinkedIn sends it: its payload, and the copy of it some bodies repeat at the top level. */
function isOwnToast(o: { serverRequest?: unknown; requestedArguments?: unknown }): boolean {
  const server = o.serverRequest as { requestedArguments?: unknown } | undefined;
  return isToastPayload(server?.requestedArguments) && (o.requestedArguments === undefined || isToastPayload(o.requestedArguments));
}
function linkedinRsc(body: string): string {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return 'li:rsc:w[unparseable]'; }
  const o = j && typeof j === 'object' && !Array.isArray(j) ? (j as { requestId?: unknown; serverRequest?: { requestId?: unknown }; requestedArguments?: unknown }) : undefined;
  const rid = o?.requestId;
  if (typeof rid !== 'string' || !rid) return 'li:rsc:w[unknown]';
  // The two ids were identical in every observed body. A body whose inner id differs from the outer one is
  // not a read the client sends; refuse it rather than trust whichever the server happens to honour.
  const inner = o?.serverRequest && typeof o.serverRequest === 'object' ? o.serverRequest.requestId : undefined;
  if (inner !== undefined && inner !== rid) return 'li:rsc:w[mismatch]';
  const segs = rid.split('.');
  const last = segs[segs.length - 1] ?? rid;
  if (rid === LI_TOAST && o && isOwnToast(o)) return 'li:rsc:r';
  if (LI_READ_EXACT.has(rid) || LI_READ_VERB.test(last) || LI_READ_SUFFIX.test(last)) return 'li:rsc:r';
  return `li:rsc:w[${segs.slice(-2).join('.')}]`;
}

export const linkedin: Codec = {
  id: 'linkedin-rsc',
  writePrefixes: ['li:rsc:w'],
  matches: (host, template) => host === 'www.linkedin.com' && template.endsWith('/flagship-web/rsc-action/actions/server-request'),
  decode: linkedinRsc,
};

// ---- LinkedIn messaging badge: POST /voyager/api/voyagerMessagingDashMessagingBadge?action=markAllMessagesAsSeen,
//   {"until": <ms>}. Sent as messaging opens: clears the unread-messages badge up to that time. Only that body is the
//   badge cleared (a read-tracking write, listed in the site's readTrackingShapes); any other body is unknown.
function linkedinMessagingBadge(body: string): string {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return 'li:msgbadge:w[unparseable]'; }
  const o = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  const keys = o ? Object.keys(o) : [];
  return keys.length === 1 && keys[0] === 'until' && Number.isFinite(o!.until) ? 'li:msgbadge:w[seen]' : 'li:msgbadge:w[unknown]';
}

export const linkedinBadge: Codec = {
  id: 'linkedin-messaging-badge',
  writePrefixes: ['li:msgbadge:w'],
  matches: (host, template) => host === 'www.linkedin.com' && template === '/voyager/api/voyagerMessagingDashMessagingBadge',
  decode: linkedinMessagingBadge,
};

// ---- LinkedIn messaging: POST /voyager/api/voyagerMessagingDashMessenger{Messages,Conversations,MessageDeliveryAcknowledgements}.
// The operation is the query's `action` (none for a partial update by id); the body confirms it. Writes: send
// (createMessage), react (reactWithEmoji), recall (unsend), edit (a message's `$set` of its body). Read-tracking, listed
// in the site's readTrackingShapes: typing (the "is typing" signal), read (a conversation marked read, and nothing else in
// the update), delivered (delivery acknowledgements). Anything else on these endpoints is unknown, a write.
const LI_MSG = '/voyager/api/voyagerMessagingDashMessenger';
const DELIVERY_KEYS = new Set(['clientConsumedAt', 'clientId', 'deliveryMechanism', 'messageUrns']);
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const keysAre = (o: Obj, ...k: string[]) => Object.keys(o).length === k.length && k.every((x) => x in o);

/** Every entity of a conversation update sets `read: true` and nothing else. */
function onlyMarksRead(o: Obj): boolean {
  if (!keysAre(o, 'entities') || !isObj(o.entities)) return false;
  const entities = Object.values(o.entities);
  return entities.length > 0 && entities.every((e) => isObj(e) && keysAre(e, 'patch') && isObj(e.patch) && keysAre(e.patch, '$set')
    && isObj(e.patch.$set) && keysAre(e.patch.$set, 'read') && e.patch.$set.read === true);
}

function messagingOp(path: string, action: string | null, o: Obj): string {
  const kind = path.slice(LI_MSG.length).split('/')[0];
  if (kind === 'Messages' && action === 'createMessage' && 'message' in o) return 'send';
  if (kind === 'Messages' && action === 'reactWithEmoji') return 'react';
  if (kind === 'Messages' && action === 'recall') return 'recall';
  if (kind === 'Messages' && action === null && keysAre(o, 'patch')) return 'edit';
  if (kind === 'Conversations' && action === 'typing' && keysAre(o, 'conversationUrn')) return 'typing';
  if (kind === 'Conversations' && action === null && onlyMarksRead(o)) return 'read';
  if (kind === 'MessageDeliveryAcknowledgements' && action === 'sendDeliveryAcknowledgement' && Object.keys(o).every((k) => DELIVERY_KEYS.has(k))) return 'delivered';
  return 'unknown';
}

/** LinkedIn resends a refused message twice, 4 and 8 seconds apart, as it was but for this flag (false, then true). */
const RESEND_FLAG = /"dedupeByClientGeneratedToken"\s*:\s*(true|false)/g;

export const linkedinMessaging: Codec = {
  id: 'linkedin-messaging',
  writePrefixes: ['li:msg:w'],
  resend: (body) => body.replace(RESEND_FLAG, '"dedupeByClientGeneratedToken":-'),
  matches: (host, template) => host === 'www.linkedin.com' && template.startsWith(LI_MSG),
  decode: (body, { template, query }) => {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return 'li:msg:w[unparseable]'; }
    // A repeated action is unknown: servers differ on whether the first or the last one wins (queryDiscriminators).
    if (!isObj(j) || query.getAll('action').length > 1) return 'li:msg:w[unknown]';
    return `li:msg:w[${messagingOp(template, query.get('action'), j)}]`;
  },
};
