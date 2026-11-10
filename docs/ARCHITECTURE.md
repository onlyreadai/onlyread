# OnlyRead architecture and developer reference

Read-only enforcement for a browser-using AI agent. A Chrome MV3 extension that runs in the person's own
Chrome profile, attaches while an AI agent is working (or all the time, by choice) and refuses requests that
would change state on the guarded sites, plus a harness that measures how much it catches.

## Develop

```sh
npm install
npm run build          # bundles extension/src → extension/dist
npm run typecheck
npm test               # unit tests (vitest)
npm run e2e            # Playwright, runs on Playwright's Chromium (npx playwright install chromium once)
npm run fixture        # target app on http://localhost:4173 for manual sessions
```

Load the extension in Chrome: `chrome://extensions` → Developer mode → Load
unpacked → select the `extension/` folder. Google Chrome 137+ ignores the
`--load-extension` flag, so the UI route is the only one for real Chrome.

Policy lives in `extension/policy/default.json`. The settings page changes the parts a person can set. In a
development build the harness can replace it or change any field (`ctl.py policy <file>`, `ctl.py set <key> <json>`).
No site is guarded by default: the e2e helpers add the fixture's host as a custom site, and `ctl.py site-add
localhost` does the same for a manual session.

## How it decides

Every request in an attached tab is paused through the debugger Fetch domain and run
through: hard rules (mutating methods, uploads, telemetry, safe GETs) → verdict cache →
judge (Jev, then the review model for what Jev cannot settle, `judge/stage.ts`). The verdict cache holds label verdicts only (a verified
site's labels from its recorded test sessions). A judge's verdict is never saved, and is reused only for an exact
repeat of the same request within two minutes (`repeats.ts`: same method and full URL, fingerprint, byte-identical
body and triggering actions, held in memory, cleared when the policy or the judge changes, and an answer from a timeout or
an error is not kept). The judge decides every distinct request that reaches it. Cache keys are fingerprints: method, host, path template, the body's shape and, for a
request that can change state, its whole query (ids folded to `{id}`, odd values `?`). Keys a verified
site's reviewed schema (`apps/<app>/query-schema.json`) lists as volatile for an endpoint, such as
tokens and counters, are folded to `{v}`. A key that can select the operation is never listed. A
fingerprint with an unknown part (`=?`) never reuses a label allow either. Changing what fingerprints
tell apart bumps `CACHE_FORMAT` (cache.ts), which drops stored verdicts and re-imports the sites'. At every start, any switched-on site's shipped label missing from the cache is put back, and
clearing the cache puts them straight back too, so a cleared cache never leaves a site with no labels and every one
of its requests going to the judge. `monitor` mode logs the decision and lets
everything through, and `enforce` mode fails blocked requests. That holds when the decision path itself throws (a URL
that does not parse, a redactor on an odd body, the cache layer): enforce fails the request closed, monitor lets it
through, and both log it as a `decision-error` decision. A paused
request to a host outside the guarded sites (the debugger holds every tab under `attachScope: all-tabs`) continues
before its body is read or fingerprinted. PUT/PATCH/DELETE, POST page
loads (a form submit or a posted navigation, `main_frame`/`sub_frame`), WebSocket upgrades
and listed side-effecting GETs are also blocked by static declarativeNetRequest rules that
hold even without a debugger. The extension declares the host-scoped DNR permission
(`declarativeNetRequestWithHostAccess`, as Claude in Chrome does): the rules apply on the hosts it
already reaches through `<all_urls>`, and it avoids the separate "block content on any page" install
warning that the broad `declarativeNetRequest` permission adds. DNR-layer blocks are logged from `webRequest.onErrorOccurred` (a
client-blocked request on a guarded host, with its reason recomputed from the same rule conditions),
not from the dev-only `onRuleMatchedDebug`, so they appear in the audit in packed builds too and cover
the unattached-origin blocks that the debugger never sees.

Dev builds send every decision to the dev sink (`devSink`, the fixture's `/__audit`), and `harness/ctl.py` drives
the loaded extension from the command line (mode, sites, single policy fields, cache and audit), so a real Chrome
profile can be measured without opening the extension's pages.

### What counts as a write

Labels for the recorded endpoints, and the judge question, follow these rules:

| Case | Label |
|---|---|
| Signing in (credentials, sign-in steps, SSO callbacks, code-for-session exchanges) | read, tag `signin` |
| Signing out (no blocked GET path refuses it) | read, tag `signout` |
| Silent session or token refresh | read, tag `session-refresh` |
| Creating an account (registration, sign-up, a sign-in that creates one) | write, tag `creates-account` |
| State kept only for the browsing session (wizard and quote steps, chosen ZIP, map/view state, options before submitting) | read |
| Saving a search or filter to recent history, by the search itself or a separate request | read |
| Creating a share or invite record | write |
| A request the server rejected or that failed | by what it tried to do |
| Marking read or seen, read receipts, saved drafts, view preferences (policy) | write |
| Tracking events sent as GraphQL mutations (page views, impressions) | telemetry |
| Carts and baskets, including booking carts held in the session, even for guests | write |
| A chosen store or location ("My store", delivery store) | write |
| Saved progress and autosaves (survey progress, form autosave, unsent drafts) | write |
| A write-type request that changed nothing this time (no-op update, empty cleanup) | by the operation: write |
| Consent and privacy choices (cookie banner, CCPA flags) | read |
| Actions that send something outside the site (password-reset email, alerts, notify-me) | write |
| Device and permission state reports (push permission, notification status) | telemetry |

### Editor guard (`editorGuard`, per site)

Some apps push content writes over a channel the extension cannot inspect: Linear's sync WebSocket
carries collaborative description edits as well as the live updates you want. Blocking the socket
kills updates, and allowing it leaks edits. The per-site `editorGuard` is the middle ground: the socket is
allowed for updates, and the content script locks the site's rich-text editors (forces
`contenteditable=false`, re-forces it when the editor re-asserts it, swallows editing input at the
capture phase, and catches editors that mount lazily), so a content edit is never authored. Clicking a
locked editor shows the read-only notice, while selecting and copying still work. It applies only while
enforcing and attached, and when it stops each element gets its `contenteditable` back as it was (a read-only
ProseMirror view, which the selector also matches, does not come out editable). It is defense-in-depth for the UI path, not a network guarantee: code-driven
writes can still bypass it. Linear ships with it on.

### SharedWorkers on guarded sites

A SharedWorker belongs to no tab, so the debugger's per-tab auto-attach never holds it, and Chrome's network rules do
not refuse the sockets it opens: a page's and a dedicated worker's socket to a guarded host is refused, a
SharedWorker's opens (`e2e/shared-worker.spec.ts`). Telegram Web runs its whole connection in one. Guarded, its writes
went out unseen. Two layers close it (`shared-workers.ts`): every guarded page loses `SharedWorker` before its first
line (registered through the debugger for each document), so the site falls back to dedicated workers, which the tab's
session holds and the rules cover. And while enforcing, a SharedWorker of a guarded site that runs anyway (started
before protection) is closed every two seconds and the tabs on its host reloaded. Workers a debugger is attached to are
left alone (a tab's own worker is attached from its first line). A site with no fallback stops working while guarded.

### Stanza guard (`socketGuard`, per site)

WhatsApp Web sends every read and every write over one socket, `wss://web.whatsapp.com/ws/chat`, encrypted twice:
TLS, then the Noise protocol inside the page. Neither the network layer nor a proxy can tell a read from a send on it,
and blocking it stops the page at "Connecting to WhatsApp". The page itself encrypts each frame with the browser's
AES-GCM (`SubtleCrypto.encrypt`), and there the frame is still one readable stanza (WhatsApp's binary XML).

A site with `socketGuard` gets `inpage/whatsapp-socket.ts` from the debugger: in its page, for every document it loads
(`Page.addScriptToEvaluateOnNewDocument`), and in its workers as they start (WhatsApp can move the socket into one).
It wraps two prototypes:

- `SubtleCrypto.encrypt`: the stanza is decoded and named (`inpage/wap.ts`), synchronously so frames keep their order.
  Messages (send, reaction, edit, pin, delete), app-state changes (star, archive, pin, mute, mark read), group,
  privacy and profile changes, and calls are writes. Queries, acknowledgements, delivery receipts, presence, the
  keepalive and logging this browser out (`md` `remove-companion-device`, `whatsapp:iq:r[md:signout]`) are reads. Read receipts and the typing indicator are read-tracking. Anything else is a write. A write in
  enforce mode is encrypted as a keepalive ping instead: the Noise counter stays in step, the server answers the ping
  and never sees the write, and the page shows the message as pending, then failed (a red mark, and it is not resent).
- `WebSocket.send` on the chat socket: past the Noise handshake, every frame must be one the guard encrypted. The
  handshake is the socket's first two sends at most (the WA header with ClientHello, then ClientFinish, sent before
  the transport keys exist), and ends early at the first vetted frame. A frame past it that is not vetted (encrypted
  elsewhere, or one the hook could not read as a stanza) closes the socket in enforce mode, and WhatsApp reconnects
  through the guard, and monitor mode reports it and sends it. A send that is not bytes (a string or a Blob) counts as
  unvetted, and an unvetted frame is reported once per socket. The window is two sends whatever the handshake: a
  shorter one (a resumed handshake with a single send) leaves room for one unvetted frame before the first vetted one,
  and within the window a send that mixes vetted and unvetted frames goes as well.

Refusals reach the background through a binding (`Runtime.addBinding`) and are logged and shown like any other.
The socket stays blocked by the site's rule. A session rule lets it through only in the tabs where the guard is in
place (page and workers), so a failed injection leaves the site stopped, not unguarded. "In place" is checked, not
assumed: in the page after each injection, and again whenever the tab loads a new document, its socket refused until
the guard is seen in it (the script registered for new documents runs only with the Page domain enabled). The guard lives in the page:
an agent that runs code in the page could undo it, and a WhatsApp that encrypted its frames somewhere else (in
WebAssembly, say) would leave every frame unvetted, which closes the socket at its third send: it fails closed.

### What the content script does on a page

The content script is present on every http(s) frame (a site switched on later is covered without a reload), but
it acts only on what the background tells it per host: at `document_start` it asks `guard:config`, and the
background pushes `onlyread:config` to every web tab when the policy or the session changes (`guard.ts
guardConfig`). The answer carries `guarded` (a guarded site while protection is attached, in either mode), which
alone switches on the reporting of clicks, Enter, submits and typed secrets, `editorGuard` and `holdClose` (enforce
only), and `uploadsOff` (a guarded site, enforcing, `uploads: false`), which disables file inputs, ones added later
too, and swallows a click on one with a notice saying why. Monitor refuses nothing, uploads included: a read pass
needs the upload request sent so it can be labeled. On any other site, or with protection Off or dormant, the script
sends nothing and changes nothing in the page, and when the answer changes it gives back the inputs it disabled
(never one the page had disabled itself).

### How a block is delivered (`blockResponse`)

`fail` (default) drops a blocked request at the network layer. Local-first sync engines (Linear, Gmail)
read that as "offline" and keep the optimistic change, queuing it to retry, so the change lingers
locally and can even flush once enforcement is lifted. `reject` instead answers a CDP-handled block with
a well-formed refusal (a GraphQL `errors` body at HTTP 200 for GraphQL, otherwise a 403), echoing CORS
headers so the browser keeps the response. A GraphQL client treats that as a rejection and rolls the
optimistic change back without retrying. Per-site (like websockets): a site profile sets `blockResponse: reject`, and others follow the global default. Linear is scoped to reject, while Gmail and Calendar stay on fail. Default off. Verified on the fixture and validated live on Linear (a blocked GraphQL mutation returns the rollback
body, no network error). DNR-layer blocks (mutating methods, page loads) stay network errors either way.

### Protection state (Off / Monitor / Enforce)

The settings page's protection switch sets `enabled`. Off means nothing is attached, no rules are installed,
and the debugger banner is gone. On, `mode` decides what happens to a write: **Enforce** refuses writes to
guarded sites. **Monitor** logs every decision and refuses nothing, and exists for measurement: a development
build shows its switch in the Security section, a release build has no control for it. **When to protect**
(`attachWhen`, below) governs timing for both modes. The switch is also only available once an AI judge is
set (Pro signed in, or a key that works): without one, protection is off and cannot be turned on. Set from
the control channel with `ctl.py guard --enabled true|false --mode monitor|enforce --attach always|agent-session`.

Note: Monitor still blocks the deterministic DNR-layer writes (PUT/PATCH/DELETE, POST page loads,
blocked GET paths, websockets). It does not fail the gray-zone codec/judge writes, it only logs them.
Off is the state that intercepts nothing.

### When the debugger attaches (`attachWhen`)

`agent-session` (the default) attaches, and installs the rules, only while an agent session is active.
A session is **detected**: browser agents such as Claude in Chrome drive a tab through Chrome's
debugger, and `chrome.debugger.getTargets()` reports every tab a debugger is attached to. Every 100 ms
(`AGENT_POLL_MS`, `agent-detect.ts`) OnlyRead looks for a tab with a debugger it did not attach, and the first one starts the
session, and it ends when the last such tab closes. The look is a Chrome API call, which also keeps the
service worker awake. The harness can still declare a session (`ctl.py session start|end`), and a session is
active if either source says so. State lives in `storage.session`, so a worker restart mid-session stays
attached.

Starting a session installs the fail-closed rule first, attaches to every guarded tab, then lifts it. A settings
change that attaches afresh in enforce (protection switched on, Always with no session, a wider scope, a new guarded
domain under target-tabs, or with everything guarded a host no longer allowed or exempt) does the same
(`guard.ts closesAttachGap`), so no gray-zone POST goes out unjudged between the rules landing and the tabs being
held.
Setup commands have time limits (`sendWithin`): a background tab Chrome has paused can hold a CDP
command indefinitely. Tested with Claude in Chrome on Linear: a page opened by the agent
does not start a session (navigation does not attach a debugger). Its first screenshot does, within the
next poll, and a priority change was then refused (`gql:mutation:IssueUpdate`) and absent after reload.
Closing the agent tab ended the session and detached everything.

A tab OnlyRead already holds cannot show up this way: the targets list reports a tab as attached
whoever holds it. Two checks cover that. When OnlyRead attaches to a tab that already has a debugger on it
(an agent opens a tab and navigates it, which is how Claude in Chrome works), the tab is an agent tab
from the start. And before a session ends, OnlyRead looks at each tab it holds: it refuses the tab's
POSTs and other non-GET requests by rule (the unguarded-tab rule: every POST, reads sent as POSTs included, such as a
Linear GraphQL query, which fails for that moment), waits until no request of the tab is paused (Chrome applies network rules before the
debugger pauses a request, so a paused request would go out unjudged on detach), lets go, looks, and
attaches again (`foreignDebuggerOn`). An agent that closes its first tab and carries on in another keeps
the session.

An agent tab stops counting after `AGENT_IDLE_MS` (10 seconds) with no agent seen on it: seen in the targets
list while OnlyRead does not hold the tab, or found by the same look, made on the agent tabs OnlyRead holds every
5 seconds (`AGENT_PROBE_MS`, 15 on a page with a socket guard, whose look re-arms the guard in each of its workers,
and put off while a request of the tab is being decided). Without the limit, an agent that finished and left its
tabs open would keep the session on (protection attached, Chrome's banner up, the settings locked) with nothing
working. Claude in Chrome attaches its debugger for an action and lets go about twenty seconds after its last one,
so a session ends about half a minute after the agent's last action. A longer pause ends the session mid-task, and
the agent's next action starts a new one: OnlyRead looks for agent tabs every 100 ms (`AGENT_POLL_MS`), and a
session start puts in the rule refusing every non-GET request to the guarded sites before it attaches, so an action
in that moment is refused, not let through. The status card's Agent fact names the site of the tab
holding the session (`Status.agentWhere`).

Known gaps: requests a page makes before the agent's first debugger action (the page load itself, and
anything the page sends on its own) are not guarded, an agent whose very first debugger action is itself
a write races the poll, and a realtime socket the page opened while dormant stays open (reload the tab).
DevTools or another debugging extension also count as an agent, which errs toward protecting.

`always` keeps the debugger attached whenever a guarded site is open, so Chrome's "started debugging this
browser" banner is persistent, so the settings page asks for confirmation before switching to it.

Cancel on Chrome's infobar (a detach with reason `canceled_by_user`) detaches every held tab at once. It is treated
like any other lost session: each tab is fenced by the unguarded-tab rule (every POST and other non-GET refused,
reads sent as POSTs included, GETs pass, nothing judged) and attached again after a second, so the bar comes back.
The alternative, respecting the Cancel and leaving the tabs fenced until they navigate, leaves every open guarded
tab half-working after one click. Protection therefore holds. A person who wants the bar gone switches
protection off or to "During agent sessions", through the settings and their lock.
Under "During agent sessions", a Cancel also looks for an agent at once (`onBannerCancel`): with no agent's debugger
on any agent tab, the session ends there instead of after `AGENT_IDLE_MS`, and the tabs are not attached again. With
one there (an agent at work, or one whose debugger has not let go yet), the session holds and the bar comes back.

### Protecting OnlyRead's own settings (`protection.ts`)

An agent working in the browser must not be able to switch OnlyRead off. Three layers:

- **Only OnlyRead's own pages change settings.** The message listener checks the sender
  (`messageAllowed`): the popup, options and setup pages may send anything. The content script, which runs
  inside web pages, may send only `ui:action`, `secret:typed`, `page:closing`, `guard:config` and `settings:open`, plus the few
  messages OnlyRead Pro's own pages need (it does not read the policy: what it needs per host comes in the `guard:config` answer), and other extensions nothing. Agents such as Claude in Chrome also refuse to open
  `chrome-extension://` pages. The judge's API key is stored by the background too (`secrets:key`), so
  replacing or removing it goes through the lock below. A policy written into storage around the
  background (by another extension context, or a debugger driving OnlyRead's own pages) is put back when it
  lowers protection while the lock holds, and whenever it does not validate: the background only writes valid
  policies, so an invalid one is never its own. The
  background tells its own writes apart by a random nonce written in the same `set` call as the policy
  (`policyNonce`), never by content: `chrome.storage` returns objects with sorted keys, and fires no change
  for a write equal to what is stored, so a content comparison cannot tell them apart (it would let an outside
  write of a policy the background had once written pass as its own). A pending nonce is consumed by its own
  event. A stored one is of no use to an outside writer. The same holds for every other stored key that holds up
  protection (`owned-storage.ts`, `protection.ts storageLowering`): the settings PIN, the judge's keys, the
  wrong-PIN count and the Pro sign-in. An outside write that removes or changes the PIN, replaces or removes a key,
  lowers the count, or drops the Pro sign-in of a browser set up for an agent is put back while the lock holds, and
  logged. A first key or a sign-in is not a lowering. Own
  removals cannot carry the nonce, so each key removed is marked for a few seconds instead. Each key is judged by the
  state before the change, and a key the background has written since is left as it is. The lock does not read the PIN
  or the wrong-PIN count from storage alone (`lock-state.ts`): it keeps its own copy, read at startup, set by own writes
  and by an outside write only once its check lets it stand, and reads the stricter of the copy and storage. So a
  removal or a reset followed at once by a lowering or a PIN try cannot slip in before the change event is checked.
  The handlers that read the lock also wait for a pending
  check, which covers a worker woken by the write itself. The content script's messages do not wait. What an agent's
  setup keeps for its Undo is guarded too: a record written from outside is removed, erasing one is not a lowering. Policy changes are applied one at a time, in order, and only after startup has
  finished, so a change written while `start()` reads the stored policy is not overwritten by what it read.
- **Agent-session lock.** While an agent session is active, every change that lowers protection is refused,
  for the person too, until the agent finishes: protection off, monitor mode, "Always" back to "During agent
  sessions", a site switched off or removed, uploads, WebSockets, read-tracking, the review band, the judge,
  the Pro service URL, holding only the guarded sites' own tabs, replacing or removing the judge's key, and
  clearing the tested verdicts, the activity log or the request log (`weakeningChanges`,
  `WEAKENING_ACTIONS`). A change from the Pro account's site list goes through the same checks and lock. Setting a first PIN is refused too, so an agent cannot set one the person does not
  know. Raising protection is never locked. Agent tabs are watched in
  both attach modes for this. In "Always" mode OnlyRead attaches to a guarded tab when its page loads,
  usually before an agent's first action on it, so an agent that only drives guarded tabs is not seen
  (Claude in Chrome on x.com is not). It is seen as soon as it holds any other tab or
  attaches to a tab first. Writes are refused in this mode all the same. What is missing is the lock. With
  "Always", set a PIN: it holds whether or not a session is seen. A periodic look at each held tab
  (`foreignDebuggerOn`, a few tens of ms with every POST of the tab refused, reads included) would close it, which is deliberately not done.
- **Settings PIN (optional).** Set in the settings page's Security section. With a PIN, the
  same changes ask for it first, between sessions too. An entered PIN unlocks for two minutes. It is stored
  as a salted PBKDF2-SHA-256 hash (310,000 rounds) in `storage.local` (`settingsPin`). It stops an agent that
  does not know it, and the rounds make a read copy of storage worth something, though resisting a storage
  reader is not the threat model. An older hash of one SHA-256 round still verifies and is
  replaced on the next right entry. Changing or removing it needs the current PIN, and removing
  it is refused during an agent session. After five wrong PINs each further try waits longer (30 s,
  doubling, at most an hour). The count lives in `storage.local` (`pinFailures`), so a service-worker restart
  (an extension reload, a crash, Chrome reclaiming an idle worker) hands out no fresh budget. Tries run one at
  a time (unlock, remove, and change with the current PIN), each counted before its PIN is compared, so tries sent
  all at once cannot all pass the wait check before the first is counted, and one cut short has still used a try.
  A try that takes over 30 s fails and lets the next run (a match it reaches later unlocks nothing and clears nothing),
  and a stored PIN asking for more than ten times the usual PBKDF2 rounds matches no PIN, so neither a hung storage
  call nor a planted hash can stop every try behind it.

A refusal travels as an error starting `locked:agent:` or `locked:pin:`, and the pages show the sentence after
it, and the settings page asks for the PIN and retries. Store builds also drop the dev sink and the control
channel (`devSink: null`), so nothing outside the extension can drive it. What no extension can prevent is
switching it off in `chrome://extensions`. Only Chrome's enterprise policy can.

### After a refusal, and on a mode switch

Two behaviours keep a guarded app usable. On a monitor↔enforce switch the extension reloads every
attached tab, because a mode change can leave the app's mutation pipeline half-configured (Calendar
wedges otherwise). After a refused write, `onRefusedMutation` decides what happens to the tab:
`notice` (default) shows only the in-page notice, `reload` reloads the tab to abandon its in-memory
queue, and `discard` clears the origin's IndexedDB/Cache/service workers first, then reloads, for
sync-engine apps that persist their queue. Recovery is capped (at most three times a minute per tab,
with a cooldown) so a page that re-issues the write on load cannot cause a reload loop. Past the cap
it falls back to the notice. The knob is policy-only (set from the dev control channel), and the settings
page has no control for it.

A PUT is refused by rule on every guarded site, with one exception per site: `readPutPaths` names exact paths where a
PUT is a read (LinkedIn's `/realtime/realtimeFrontendSubscriptions`, which subscribes the page to live updates. With it
refused, new messages and receipts stop arriving). An allow rule at priority 150 lets that path's PUT through, above
the mutating-method rule (100) and below the fail-closed and cover rules (200, 250), so a tab the debugger does not
hold keeps it refused, and the decision allows it by the same list (reason `read-put`) on that site's hosts alone.

Read-tracking writes, ones that only record that the user looked at something or arranged their own
view (read receipts, view preferences, filters, sort, UI flags), can be allowed without weakening the
judge: `allowReadTracking` (default on) gates a curated per-site `readTrackingShapes` list, matched by
exact decoded shape and allowed with reason `read-tracking`. On by default lets an agent browse naturally (an
opened chat is marked read, a badge clears). Off is strict, and they are refused like any write. An operation whose
name does both read-tracking and a real write is never allowed by name. The few a shape cannot name exactly are
recognised by their address or body instead (`background/read-tracking.ts`), each check exact and failing closed: X's
`PutClientEducationFlag` (X runs the operation its queryId names, so the queryId must be one recorded for it and the
body's the address's, and the
body holds only that and `variables` of `flag` alone), Linear's `NotificationUpdate` whose input is `readAt` alone (the
same mutation archives and snoozes), its body only `operationName`, `query` and `variables` and its query parsed and
held to the one form Linear sends (one operation, the `notificationUpdate` field alone, its `input` variable and an
`id`, plain fields selected: no alias, fragment, directive, comment or second field), neither with a query string
(a GraphQL server may read the operation from it), and a Gmail sync write
whose every operation only adds reading signals (`^o`, `^io_lr`, `^io_lr30s`, `^eclicks_msg`) and removes the unread
and unseen marks (`^u`, `^us`). A Gmail batch with a star, archive, trash, label, draft or reply in it is refused whole. The settings page's Sites section has the switch ("Allow read
tracking"). Switching it on lowers protection, so the settings lock refuses it during an agent session.


### Writes hidden in GET links, and the first navigation of a fresh origin

Some apps apply a change with a plain link: Calendar's RSVP Yes/No/Maybe in an invitation mail is
`GET calendar.google.com/calendar/event?action=RESPOND&rst=1|2|3`. Method rules treat GET as safe,
and such links open a new tab whose first main-frame request goes out before the debugger attaches
(attachment happens on `webNavigation.onCommitted`). Both are covered by `blockedGetPaths`: the
patterns compile to declarativeNetRequest rules (GET on `main_frame`, `sub_frame`, `xmlhttprequest`,
`ping`, `other` for the guarded domains), which hold with no debugger attached. The POST counterpart,
a form that posts into a fresh origin, is closed by the `post-navigation` DNR rule: every POST page
load on a guarded domain is refused. Consequence: SAML/OIDC callbacks that POST into a guarded app
origin fail while the site is guarded. Sign in with the site switched off, then switch it on.
## What is stored, and what happens when storing fails

Everything lives in `chrome.storage.local`, within its 10 MB (the extension does not ask for `unlimitedStorage`).
Each store that grows has a share, together 6.5 MB, so the rest (policy, secrets, tokens) always has room:

- the decision log (`audit.ts`): the newest 2,000 entries and at most 3 MB (2,000 entries of the largest previews measured 4.8 MB, so with those the oldest go first), kept in chunks of 100 under
  `audit.<id>` with the chunk order under `auditIndex`, so an append rewrites one small key. A refusal is written at once, since a
  worker shutdown can follow any moment. Everything else goes with the next write, at most every 500 ms, so a
  busy page costs one write per window. Measured on a probe: an append to a full log of 2 KB previews writes
  240 KB in one write (the newest chunk plus the oldest, trimmed) where one array would write 4.8 MB per entry, and
  100 entries in one window take one write of 480 KB. The e2e helpers read the chunks back
  (`storedAudit`).
- the request log (`observer.ts`): 5,000 observations and at most 1.5 MB (a release observation is about 300 bytes), flushed every 500 ms. Its
  `webRequest` listeners are registered for every URL at the worker's top level (MV3) and narrowed to the
  guarded domains as soon as the policy is known, re-registered on every policy change and removed while no site
  is switched on. The request body is asked for only in a development build, where the harness reads it.
- the verdict cache (`cache.ts`): one key, rewritten once (or twice) for a burst of puts, so importing a site's
  labels is not one write per label. At most 5,000 verdicts and 2 MB: past that, the judge's allows go first, then
  the judge's blocks (a refused write that comes back is judged again), a site's tested verdicts last (restored on
  the next start), least recently seen first within each.
- the policy (with the Pro account's site list while it manages the sites, so it holds offline and across a
  restart), secrets, Pro tokens, the settings PIN and its failure count, and the theme.

A failed write never poisons the next one: a rejected `storage.set` does not leave the audit or cache write chains
rejected for the rest of the worker's life. Writes are retried with the next change, the request path does not
wait for cache bookkeeping (the cache's hit-count update), and the failure is reported (`storage-health.ts`) in
`status:get` as `storageProblem`, which the popup footer and the settings page show, and `storageBytes` says what the
store holds. Startup is best effort in the same way: a failure to restore the sites' verdicts is reported as
`startupProblem` and the rules, attachment and agent polling still come up. A failed *read* is not kept either
(a rejected first read kept for the worker's life would refuse every request a label would have answered and leave
`status:get` unable to answer): it is reported as
`could not be read`, the store answers as empty until the next call reads it again, and the cache refuses a put
meanwhile, so a fresh map is never written over verdicts it could not read. A stored policy that fails
validation is not silently replaced: the one value the check names is reset to its default and the rest kept
(`repairPolicy`, and `policyRepaired` names the field), a policy broken in more ways gives way to the defaults, and
either way the copy is kept under `policyBackup` with the error and `policyProblem` says so. The repaired policy
is written back once the guard is up, so the invalid copy does not survive to the next start. The notice stays
until the person changes a setting. The activity log holds what is recorded while it cannot be read (at most
500 entries, listed in the popup) and merges them in once a read succeeds, so a fresh log is never written over
one that could not be read. Clearing the verdict cache rejects when storage does, and the fingerprint-format
stamp waits for the clear. The storage reports themselves live in `storage.session`, one per store and operation, so a failed write
followed by a worker restart still shows in the popup (the unwritten entries are gone with the worker) and the
first read at the next start does not clear it, but a successful write does.

## Driving the extension from the harness (dev control channel)

With a policy whose `devSink` points at the fixture server on localhost, the background
polls `/__control/next` every two seconds and answers commands. `harness/ctl.py` sends them,
so a measurement session needs no options-page work after the first Load unpacked:

```sh
python3 harness/ctl.py status
python3 harness/ctl.py site calendar on                     # switch a built-in site on (off to switch it off)
python3 harness/ctl.py mode enforce
python3 harness/ctl.py secrets                              # keys from .env, never echoed
python3 harness/ctl.py cache-import apps/calendar/cache.json
python3 harness/ctl.py cache-clear | audit-clear | judge-test | policy-get
python3 harness/ctl.py reload                               # chrome.runtime.reload(): picks up a new build
```

Several Chrome profiles can run the extension at once: each copy polls with its own instance
id, the fixture keeps a queue per instance, and `ctl.py instances` lists them with a label
(mode, enabled sites, attached tabs). With one live instance the CLI addresses it
automatically. With several, set `ONLYREAD_INSTANCE=<id>`. The channel only activates for a localhost `devSink`. This repository is the dev build: `devSink`
defaults to `http://localhost:4173/__audit`, so a fresh Load unpacked on this machine is
controllable as soon as the fixture runs, and inert otherwise. Set it to `null` before publishing.

## Site names and icons

Nothing in the UI knows a particular site. A site's name and icon come from the site
itself, in this order:

1. what the page declares: `og:site_name`, `application-name`, or the web-app manifest
   name (the content script reads them on request), and the tab's favicon or the largest
   `<link rel=icon>` / apple-touch-icon.
2. the brand segment of the document title ("Plan - Google Docs" → Google Docs, "Google
   Calendar - Week of…" → Google Calendar), with e-mails, counts and long segments rejected.
3. the registrable host label, capitalised, and Chrome's own favicon cache (`/_favicon/`)
   for any host the browser has visited, then Google's public favicon service
   (`www.google.com/s2/favicons`, with the host name in the URL).

What was discovered when a site was added is stored with the site, so the marketplace
shows it without the tab open. Built-in profiles carry their own name and product icon.

## Branding

Source artwork lives in the website repo (`onlyreadai/website`, `branding/`). The extension ships the
exported icons in `extension/assets/`.

## Choosing where it works: sites

Two surfaces, the way Claude in Chrome splits them:

- **The popup** shows only the site you are on: its icon, whether it is guarded, a switch,
  or a "Guard this site" button for an unknown host. A footer says the protection state in one
  line (`popupFooter` in `shared/status-text.ts`), beside "Report a mistake".
- A site's card (popup and settings page) names what the guard does not cover ("Messenger is not guarded.", from
  `coverage.json` `outOfScope`). The tested lists themselves live in `apps/<app>/coverage.json` and are compiled into
  `apps/<app>/README.md` and `docs/SITES.md` by `harness/site/build_site.py`, not into the profile. Update them after a new run.
- **The settings page** (options) is a sidebar of topics beside one column of sections. The
  sidebar marks the section at the top of the window and scrolls to one on click, and becomes a horizontal strip on
  narrow windows. **Overview** is the status card: a heading, the protection switch, and three facts with colour only on the
  one that needs attention: Protection (on or off, always or during agent sessions), Agent (working now or none)
  and AI judge (own key and its provider, or Pro signed in, signed out, subscription inactive, usage used up,
  unreachable). Below them are at most one action row, the most important problem with its one button
  (`overviewAction` in `shared/status-text.ts`), and three counts for today (writes refused, requests judged of requests seen, guarded
  sites with "N from your account"), from `activity:get` (`background/activity.ts`, a summary of the activity log,
  so the page never pulls the whole log). **Sites** lists the Pro account's sites and this browser's apart (with Pro, the sites are the account's: removed and
  added here, and "Every browser" or "This browser only" once the account has two or more browsers), with
  a search box, each row's text actions behind a keyboard-accessible ⋯ menu, a tested site's "N reads · M writes
  tested" on the right and a significant exclusion ("Messenger is not guarded.") kept in view. **Activity** lists the
  most recent refusals (20, "Show more" for 100), newest first: the site, the operation's name when the body shape
  names one (`shared/refusals.ts operationName`, else "A change on <site>"), what stopped it in words ("Stopped by
  rule", "Tested list", "Decoded as a write", "AI judge, 0.94", "Pro couldn't check it") and when. Reads are not
  listed. **AI judge** holds the provider choice, the own-key form (OpenRouter or Vercel AI Gateway, one key drives
  both judges, plus an optional Anthropic key for the review model) and the Pro panel. **Security** holds when to protect (with the "Always" confirmation), the settings
  PIN, the agent lock (always on) and, in development builds, Monitor mode. Each Activity row has a report button for a
  refusal the person thinks was a mistake (below, "Support reports"). The Appearance choice (System / Light /
  Dark, stored in `chrome.storage.local.theme` and applied by the popup, the options page and the setup window through
  `data-theme` on `<html>`, see `extension/src/shared/theme.ts`) sits in the top bar. Labels are sentence case, and the
  motion (staggered entrance, the shield's pulse, counts that count up, spring switches, menus that pop) stops under
  `prefers-reduced-motion`. There is no raw policy editor and no full log in the UI. The harness (`ctl.py policy`,
  `ctl.py audit`) still exposes both.

`node scripts/shot-ui.mjs` renders both pages in Playwright Chromium for a visual check.

- **Built-in sites** ship with the extension as profiles (`extension/policy/sites/*.json`):
  domains, telemetry and blocked-path additions, decoded-write shapes and the tested
  verdicts labeled in `apps/<app>` (rebuild one with `harness/site/build_site.py <app> "<Name>"`).
  Switching a site on imports its verdicts and adds its domains to the rules. Switching it
  off stops guarding it. Today: Gmail, Google Calendar, Linear, LinkedIn, Facebook, X, Telegram, WhatsApp and
  Reddit.
- **This site.** On a host no profile covers, the popup offers "Guard this site", which adds
  a custom site (guarded by rules and the judge, with no codec or tested verdicts yet) that can be removed later.
- The mode (monitor / enforce) is global. The judge settings are in the settings page's AI judge section. The
  global telemetry and blocked-path lists ship with the extension (`extension/policy/default.json`) and have no UI.

The policy stores `sites` (built-in ids and their state), `customSites`, and a derived
`effective` block (the union the decision layer reads).
From the harness: `ctl.py sites`, `ctl.py site gmail on|off`, `ctl.py site-add <host>`,
`ctl.py site-remove <id>`.

### Guard every site (`guardsHost`)

The opposite of a site list: every host is guarded except the allowed ones. Hosts OnlyRead has no profile for are
judged like a custom site (reads pass, clear writes are refused, the rest goes to the AI judge), so their sign-ins and
searches keep working. A site OnlyRead does have a profile for gets its whole profile on its hosts, switched on or
not, as if it were on: its shipped labels, allow-lists (read tracking among them), block-lists, socket setting and
stanza guard, editor lock and block delivery (`sites.ts profiledSites`, `profileDomains`). Only the list itself stays
as set, and an allowed host stays unguarded, profile or not.

While every site is guarded, a site's switch in the popup says whether it is guarded and moves the allowed hosts, not
the site's own setting (`messages.ts setGuardAllSite`). Off allows the domains that are the site's alone, never a
shared parent like Calendar's `clients6.google.com` or a domain another site lives under (`sites.ts siteOwnDomains`),
and switches the site's own setting off, as a switched-on site stays guarded under an allowed host; in Pro mode it
takes the site off the account's lists instead, as the popup's own switch does there. A site that was on is
remembered (`guardAllOff`). On takes back only what off adds and the hosts under it, leaving any other allowed host as
set, and switches the site back on when off switched it off, or should it still be unguarded. The switch is fixed
where the Pro account (with an own key) or another switched-on site keeps the site guarded, where allowing it would
also allow another site (a custom `google.com` over Gmail), or where the host is under an address the site shares.

The blocked GET paths stay with the profiled sites, while a POST page
load is refused on every guarded host and the global socket default covers every guarded host but the sites that allow sockets and the allowed
hosts (`rules.ts leftOut`: naming the listed sites only would let an unlisted host's socket and a form posting into
a new tab through). An allowed host at or under a listed site is no exception for any rule, as `guardsHost` guards
it. The browser's own settings set it, and so can a Pro account, each with its own allowed hosts. A higher level is
never undone by a lower one: everything is guarded when any level says so, and a host is left unguarded only when
every level that guards everything allows it (`sites.ts guardAllInForce`). Every layer asks one question,
`decision.ts guardsHost`, and the DNR rules take `excludedRequestDomains` instead of a domain list (`rules.ts
guardedDomains`), never leaving out a parent of a listed site. OnlyRead's background requests (its judge, its Pro
service, the dev sink: POSTs and GETs with no tab) are left out by their initiator only where such a POST is refused, the
worker-origin session rule and the fail-closed rule's POST half (a rule with no domain list otherwise refuses the judge's
calls, and on a listed `localhost` the worker-origin rule would refuse the dev sink's POSTs, each logged refusal sent
and refused again). No other rule names an initiator: an extension page shares the background's, and a dynamic rule
cannot tell a tab from none, so exempting it there would let a driven settings page PUT and DELETE on a guarded host.
A session rule of its own refuses every non-GET an extension page in a
tab sends to a guarded host (`EXTENSION_PAGE_RULE_ID`, `excludedTabIds: [-1]`, enforce only), which also covers the
POSTs such a page could otherwise send. OnlyRead's pages never send one. The popup has no tab, so a second session rule
covers it (`EXTENSION_UNTABBED_RULE_ID`, `initiatorDomains` OnlyRead, `tabIds: [-1]`, enforce only): the
background shares its initiator and its lack of a tab, so the hosts of the background's own requests are left out by
name (`rules.ts backgroundHosts`: the Pro service, the dev sink, every BYOK provider's judge endpoints). A POST from the
popup to one of those hosts still passes. To any other guarded host it is refused and logged as `extension-page`. OnlyRead's Pro service
is never taken in (`exemptDomains`). Switching it off and allowing a host lower protection at any level, so both go
through the settings lock (`protection.ts`), as a change from the Pro account does.

## Refused writes: what the page sees

In enforce mode a refused request fails with a network error, and the content script shows
a small notice in the page, in its own shadow root with `role="status"`, so a tester or an agent can tell a policy
refusal from a real outage. It says what was protected in plain words: OnlyRead's icon (inline, as
the extension's files are not web-accessible), a title naming the site ("OnlyRead kept Linear read-only", the name
sent with `onlyread:blocked`), one line per stopped change ("Stopped a change: Create comment."), and apart from
those a line for requests stopped only because a check could not run ("1 request was stopped because OnlyRead Pro is
signed out and couldn't check it. Some of the page may not load."). Its buttons: "Sign in to Pro" when Pro is signed
out (the content script's `settings:open` opens the settings page at its AI judge section), "Details", which reveals
the internal codes (body shape and reason) and with them a report icon (a megaphone), which opens the report dialog on
the newest refusal (below, "Support reports"), and "Dismiss". The buttons that open the settings act on real input only. No code is in view by default. Sync-engine
apps keep refused mutations in a local queue: Gmail shows "Oops… the system encountered a
problem (#2014) - Retrying", Calendar "Saving…" or an error toast, and both warn on leave.
A real page reload (path or query change, not a `#hash` route change) discards the queue.
Gmail's queue is sequential, so a refused implicit write at its head (clearing the unseen
flag on inbox render, marking an opened message read) stops later writes from being sent.

`policy.allowedShapes` lists exact decoded shapes to tolerate anyway, e.g.
`["gmail:s:w[^us]", "gmail:s:w[^u]"]` to let Gmail mark messages seen and read. It is
empty by default: strict read-only. Any other refused write still shows the notice.
`harness/ctl.py notice-test <tabId>` sends a synthetic notice to verify the in-page path.

### Binary bodies

A request body of bytes rather than text (an encrypted protocol carried over HTTP, like Telegram's MTProto on
`/apiw1`) is refused by rule (`opaque-binary`) without asking a judge: no judge can tell a read from a write in it, and
an app that retries such a request in a loop would otherwise spend the whole judging allowance within minutes.
"Binary" is a body shape of `opaque` whose first 512 characters are more than a
tenth control or replacement characters. A site's tested verdicts still answer first, so LinkedIn's binary telemetry
beacons, which its labels allow, are unaffected, and the replays of every verified site pass unchanged.

## Per-app codecs

Some apps multiplex reads and writes through one endpoint with opaque bodies (Google's
`f.req` arrays). A codec at the fingerprint stage (one file per site in `extension/src/background/codecs/`, listed in
`CODECS`, each declaring its write prefixes and its own vectors file) turns those bodies into semantic
shapes: `gcal:sync:r` / `gcal:sync:w[event,set:defaultCalMode]` for Google Calendar,
`gtasks:sync:r` / `gtasks:sync:w[n]` for Tasks, `gmail:s:r` / `gmail:s:w[^k]` for Gmail's sync channel,
`li:rsc:r` / `li:rsc:w[<ns>.<op>]` for LinkedIn's flagship-web `server-request` (the key shape is the
same for every operation. The `requestId` *value* decides, write-biased: only names seen as reads pass,
and an inner id that differs from the outer one is `w[mismatch]`), `li:msgbadge:w[seen]` for LinkedIn's messaging
badge cleared (only its address and its `{"until"}` body, so the read-tracking list can name it),
`li:msg:w[send|react|recall|edit|typing|read|delivered]` for LinkedIn messaging (the query's `action` names the
operation and the body confirms it. A conversation update counts as `read` only when it sets `read: true` and nothing
else, and anything else on those endpoints is `w[unknown]`), `fb:gql:r` / `fb:gql:w[<Name>]` for
Facebook's Relay GraphQL (one form-encoded endpoint for every operation, where the `fb_api_req_friendly_name`
value decides: `*Query` is a read, anything else a write. Known limit: Facebook runs the `doc_id`, and the name is only
Facebook's own label, so a request built by hand with a write's `doc_id` and a `*Query` name passes as a read. Facebook's
page always sends a matching pair, so this needs an agent that writes raw requests itself). Policies list write prefixes in
`blockedShapes`. Those are blocked by rule before any judge or cache (`decoded-write`).
A codec that cannot classify a body reports it as a write (`w[unknown]`, `w[unparseable]`),
so decoded traffic fails closed. Codecs are built empirically from recorded sessions
(`apps/<app>/sessions`): capture full bodies with the triggering UI action, diff reads
against writes at fixed positions, accept only the read forms actually seen, and validate
against every recorded body before shipping.

## Requests from no tab (service and shared workers)

A site's service worker or shared worker is a separate target. webRequest reports its requests with
`tabId: -1`. A guarded tab's auto-attach hands the worker that serves it to OnlyRead (tested on the
fixture, x.com and Linear, also for a worker already running when the tab opened), and Fetch is enabled on
that session, so the worker's requests are paused and judged like the page's. A worker held by several
tabs pauses each request once per session. The first decision stands and the later pauses continue at
once. A worker no guarded tab holds (woken by a push or a sync with no tab open) is never paused. Facebook's worker
uploads Messenger's encrypted messages that way (`EBMinosUploadMessagesMutation`). The rule refuses those
uploads, but Messenger messages were still delivered in every test, so Messenger is out of the Facebook profile's scope. A site's `coverage.json` can list
such parts under `outOfScope`, and the options card shows them under "Out of scope". While enforcing, a session-scoped DNR rule (dynamic rules cannot use
`tabIds`) blocks POST/PUT/PATCH/DELETE and any non-standard method (DNR's `other`: WebDAV, QUERY, a custom verb,
as every cover rule does: fail-closed, worker-origin, unguarded and closing tabs) on every
guarded domain for `tabIds: [-1]`. The DNR log labels
those `worker-origin`. The rule lets past only the hosts whose every running worker OnlyRead holds
(`excludedInitiatorDomains`, `judgedWorkerHosts`), and the set is re-derived when a worker session comes or
goes, and every second while any host is let past, so a worker that starts unheld puts its host back
behind the rule. `harness/site/leak_check.py` reports "from no tab" orphans separately.

## Requests a closing page sends

A page can send requests as it closes: a `keepalive` fetch or a beacon from its `pagehide`, `visibilitychange`
or `unload` handler. Chrome sends them after the tab's debugger session has ended, so they are never paused:
on the fixture every such write reached the server, in enforce, while the same requests from a live page
were refused. A local-first app flushing its refused changes on close would get them through. Three
measures. First, on a guarded site while writes are refused, the content script stops the page's own close
handlers (its pagehide and visibilitychange listeners are registered at `document_start`, before any page script,
and stop the event. Its unload listener is there only while the close is held, since an unload listener makes a
page ineligible for the back/forward cache, so an unguarded page never carries one. Added from pagehide,
it comes too late on the fixture.)
Second, beacons (`ping`) to guarded sites are refused by rule at all times, except to the telemetry addresses the allow-lists
name (Facebook's `/ajax/bnzai`, which its story viewer sends as a beacon): one allow rule per address above the
refusal, the global list's on every guarded host and a site's on its domains (`rules.ts beaconTelemetryRegex`, never
broader than the list: a path must start with the address and end where the list's match must, `re:` and `?query` entries are left out). Third, the
content script reports `pagehide`, after which the tab's writes are refused by a session rule until a new
page commits or the tab is gone (`closing-tabs.ts`). The rule alone is too late for most requests (installing
it takes 10 to 45 ms). The first measure is what makes it hold (fixture: 0 of 60 escaped). Navigating away
on a guarded site therefore also skips the page's close handlers.

## Telemetry patterns

`telemetryAllow` (global and per site profile) is the only allow-list evaluated before the judge. The global list carries generic
logging paths and the fixed paths of widely used analytics vendors served from the site's own domain (Adobe Analytics
`/b/ss/`, Tealeaf `/TealeafTarget`), found on real sites in the Mind2Web recordings. The global rule lists ship with
the extension: allow-lists always come from the shipped version (a stored copy can neither keep a removed allowance nor
hide a new one), and block-lists are the shipped list plus any stored entries. A site profile's own allowances
(`telemetryAllow`, `allowedShapes`, `readTrackingShapes`) hold on that site's hosts alone (`EffectivePolicy.siteRules`):
pooled, Linear's `segment` or Facebook's `/ajax/presence/` would allow a POST on any other guarded host without a
judge. Block-lists (blocked GET paths, codec write prefixes) still pool, since they only block more.
The list is checked before the upload rule, so a logging endpoint that posts multipart bodies
(Facebook's `/ajax/bnzai`) can be allowed by URL while every other multipart body is still refused.
Three pattern forms, all matched against `host + path` without the scheme or the query
(an `endpoint?param` entry is an endpoint whose query carries `param`):
a plain string matches at URL token boundaries, and one with a path in it names an endpoint, so it
must end the path, a trailing `/` or a known file extension aside (`/collect` hits `/g/collect` and `/collect/`,
`/TealeafTarget` hits `/TealeafTarget.jsp`, never `/collect-payment` or `/api/analytics/dashboards/42/delete`.
a pattern ending in `/` is a prefix, `/b/ss/` for Adobe's report-suite paths). One without a path (`sentry`,
`google.internal.waa.v1.Waa`) may sit anywhere on token boundaries. A trailing `*` makes it a prefix with no after-boundary (`/to11y*` for
LinkedIn's obfuscated beacon stems). `re:<regex>` is a case-sensitive JavaScript regex, meant
to be anchored to the host (`re:^www\.linkedin\.com/(?=[^/?]*[A-Z])(?=[^/?]*[a-z])[A-Za-z0-9_-]{10,20}$`
fences LinkedIn's random-path gzip beacons and nothing lowercase like `/notifications`). An
invalid or empty regex is rejected when the policy loads and never matches at runtime. Every
pattern must be backed by labeled telemetry rows in the app's `labels.jsonl`.

A path pattern on the global list (the one that holds on every guarded host) must start the path, as the beacon rule
does, so a write whose last path segment is a global pattern (`/api/projects/42/analytics`, `/api/orders/7/collect`,
`/settings/telemetry`, `/admin/beacon`) is judged. A site's own list may still match deeper in that site's paths. Only the file extensions in `rules.ts TELEMETRY_PATH_END` may follow an
endpoint (`.jsp`, `.php`, `.json` and a few more), so an RPC verb suffix such as `/api/analytics.delete` is judged.

`ctl.py policy <file>` replaces the whole policy, including `mode` (an app policy file ships in monitor, so pass
`--mode enforce` to keep enforcing).

## Support reports

A refusal the person thinks was a mistake can be sent to OnlyRead support from the settings page's report dialog
(`options/report.ts`): opened from an Activity row's report button (a megaphone) on that refusal, or on the newest one
by the notice's report icon (shown with its details) and "Report a mistake" in the popup's footer (`options.html#report`). It shows the refusal
and the rest of its burst, ticked: the same tab's other refusals within 10 seconds of it (one click's write, the
app's retries, the analytics beacon after it, `support.ts supportBurst`), and takes a note ("What were you doing?") and an optional email for a reply, and "What is sent" shows the report exactly as
it will go. Nothing is sent until the person clicks Send to Support. A report carries the refusal's time, method and address, what decided it (source, reason, the judge's score and
sentence), its fingerprint, body shape and body preview, and the last clicks before it (type, element and visible
name only), plus the extension's version and build, mode, when it protects, the judge provider, read tracking and the
guarded site ids, and the browser's user agent (`background/support.ts`). Addresses are masked before they are shown:
secret-named query values and token-like runs in each path segment and query value. Body previews are the log's own,
already redacted when recorded (secret-named keys, token-like runs, card numbers, typed secrets) and at most 2 KB. A
body of bytes (gzip, an encrypted protocol: `decision.ts binaryBody`) goes as `[binary body, not shown]`, and in any
text the report carries from the log or the page (preview, fingerprint, body shape, judge's sentence, clicked names,
note, user agent) a NUL or half an emoji becomes U+FFFD, since the service's Postgres refuses both (`support.ts
storable`). It goes to `POST /v1/support` on `cloud.serviceUrl` whatever the judge provider: with the Pro sign-in when
there is one, so support sees the account, and anonymously otherwise (an expired sign-in is refreshed, and one the
service no longer knows is sent without, never signed out over a report). The answer is the report's number, shown to
the person. Too many reports from one place in an hour are refused (`rate_limited`).

## OnlyRead Pro

OnlyRead Pro is an optional subscription. Instead of the user's own key, requests nothing local can settle are
judged by OnlyRead's hosted service, which runs the same judge stage with the same decision rules, so a request gets
the same decision on Pro as on the user's own key. With Pro, the guarded sites are the account's: a list
for every browser signed in to it and one for each browser alone, changed on the account page or in the extension. A
change made in the extension applies at once, local first (kept in `policy.accountEdits`, laid over the lists it
belongs to, through the settings lock like any change), and is sent in order once the account can be reached. One the
account refuses (a removal made against a list changed elsewhere since) is undone, so the site is guarded again. A
browser's own sites move to the account when it signs in, and come back to it when it signs out or the account ends,
so leaving lowers nothing. A change from the account that lowers protection goes through the settings lock, with one
exception, in a browser that belongs to an agent: a change the person made on their account elsewhere applies there
while an agent works too (a settings PIN still holds it), since nothing in that browser can make one. Its own sites
stay its own. Pro can
also set up an AI agent's browser. A change on the
account reaches a signed-in browser within seconds: the service sends it an empty Web Push message (to the
subscription the extension's service worker made, `cloud-push.ts`), or the account page, open in the same browser,
tells the content script (`content/account-nudge.ts`). Either way the extension asks for its lists as its poll does,
through the same lock, so a push can never change what is guarded. The poll is the net under a lost push: every half
hour while this browser's push subscription is the one registered on the account, every five minutes when it is not
(`cloud-sync.ts managedPollDue`). Every failure
(signed out, subscription inactive, usage used up, service unreachable) refuses the request. There is no fallback to
a stored key. The two never mix: Pro is the judge only while the browser is signed in to Pro, and an own key only
while it is not. A finished sign-in makes Pro the judge, turns protection on and deletes the own key; an own key (a
provider, its key) is tested before anything is stored, and only one that passes becomes the judge and signs the
browser out of Pro (a failed test leaves the judge in force as it was); a mix left from before is settled at startup
(`messages.ts settleMode`). Protection is never left on with no judge to ask: after every applied change (settings,
keys, the sign-in) and at startup it goes off, through the lock, which may hold it until an agent finishes
(`messages.ts offWithoutJudge`). Each change of
judge goes through the settings lock, so a sign-in the lock would refuse does not start. One exception: the first AI
judge. With no judge, protection cannot be on, so setting one raises it; while no judge works in this browser and none
ever has (the first-judge record, which a judge at work writes and the lock keeps from being removed), choosing one (a
Pro sign-in, a provider, its key) passes an agent at work. A settings PIN still holds it. In the policy,
`judge.provider: "cloud"` selects Pro (`"byok"` selects the judges below), and
`cloud.serviceUrl` names the service: official builds point it at OnlyRead Pro, dev builds at a local mock of the
service served by the fixture. A dev build's settings page (Security, "Pro service") switches between the local mock
and production. The sign-in belongs to the service it was made on, so switching signs the browser out of the one it
leaves, and like any change of the service it is refused while an agent works. The service can word the account itself: its
account answer may say whether Pro is active and give the status, the usage line, the account button's label and an
offer to get Pro, and a refusal may carry a sentence saying why. The extension shows them as given and falls back to
its own wording when one is missing (`shared/cloud-ui.ts`).

## Judge providers

With your own key (BYOK) the judge runs on one of two gateways, both of which serve Jev and a review
model with a single key. The registry is `extension/src/shared/providers.ts`, and the choice is
`policy.judge.byok` (`{ id: "openrouter" | "vercel", model?: <review model> }`) and keys live in
`chrome.storage.local` under `secrets.keys.<provider>`, one per provider.

| | OpenRouter (default) | Vercel AI Gateway |
|---|---|---|
| Jev | `https://openrouter.ai/api/v1/systemone`, `typesafe/jev-1.13` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone`, `typesafe-ai/jev` (paid credits, the free tier answers 403) |
| Review model | Anthropic Messages at `https://openrouter.ai/api` | Anthropic Messages at `https://ai-gateway.vercel.sh` |

The review model defaults to `anthropic/claude-haiku-5.5` (recommended). Claude Sonnet 5 and Claude Haiku 4.5 are the
alternatives (`REVIEW_MODELS`). An Anthropic key can be saved beside the gateway's (`secrets.keys.anthropic`): a
Claude review model is then asked straight from Anthropic first, and from the gateway when Anthropic fails
(`judge/byok.ts anthropicReview`, since Anthropic does not serve Jev).

What the judges are asked is `judge/questions.ts`. Jev gets one question per request: the plain one, or, with read
tracking allowed, one that counts a request as a read when it clearly does nothing but record what the person saw
(a read receipt, a seen marker, a cleared badge, an impression, a prompt dismissed) and still as a write when it might
do more or its body does not show which. Measured on the labeled requests of six sites guarded as unverified
(`harness/judge/judge_eval.mts`, `EVAL_READ_TRACKING=on|off`): no write passed that the plain question does not pass
too. A question that simply called read tracking a read let opaque sync batches (Gmail's star, archive and send)
through. The review model always gets the plain question. A body that is binary or compressed (gzip starts with byte
`1f`, `decision.ts binaryBody`) goes to the review model even when Jev calls it a write, and for it alone the review
model's instructions describe analytics beacons (a compressed payload posted as text/plain to a path that names no
action is telemetry, not the click's change): LinkedIn's gzip `/li/tscp/sct` after a Like was refused as the Like.
Given for every request, that note let readable writes through. OnlyRead Pro asks the same questions and decides by the same stage, and the
extension sends the two flags (`readTracking`, `binary`) with each request.
What a judge sees (`judge/state.ts`, mirrored in `harness/lib/state.py`): method, host, path and its template,
query keys, content type, the body's shape and a preview (secrets redacted by field name, and token-like
values redacted by value whatever their field is called: CSRF and session tokens, UUIDs, hex and base64 ids,
JWTs, API keys, with strings and form values cut at 64 characters, 2 KB in all) and the user action that triggered
it.

The preview redactor (`previewBody` in `fingerprint.ts`) works in two layers. **Typed values first:** the
content script sends the value of every password, one-time-code and payment-card field on a guarded site as
it is typed (real input only, `isTrusted`). `typed-secrets.ts` holds it in memory only (ten minutes, at most 32
fields and 6 per tab, dropped when the tab closes) and `scrubKnown` removes it from the body in any encoding
(raw, URL-encoded once or twice, JSON-escaped, base64) before anything parses it. This catches secrets that
have no field name to find them by: Google's sign-in `f.req` positional arrays, an unnamed multipart part, an
OTP in an array. A value is removed only where it stands whole, never inside a longer word, and a value of
letters only is never removed: otherwise an agent told to type "delete" into a password field could hide that
word from the judge (a weak letters-only password then reaches the judge, the smaller harm). **Then by format:** JSON and form values (JSON nested inside form values or strings is parsed too) are
redacted by field name and by value, multipart bodies part by part (a secret-named part entirely, a file part
reduced to its size), and anything else (XML, inline GraphQL, broken JSON, plain text) by a named-secret scan
(`password: x`, `"otp":"x"`, `pwd=x`, `password="x"`, `<Password>x</Password>`). Card numbers written in groups
everywhere (plain digit runs are left alone: ids pass the Luhn check too). The fingerprint and the decoders
read the raw body, so redaction never changes a decision's key. `harness/lib/redaction_measure.mts` measures
it statically over the recorded sessions and the Mind2Web recordings, plus a planted suite of 18 sign-in
formats (it leaves 0 of the 18 planted secrets and 0 secret fields in the corpus bodies). The judge state has no
separate `operation` field (names pulled out of the full body): in all 2,023 recorded requests every such name is
already in the preview or the path, and on the 59 judged cases that had one, Jev's decisions were identical with and
without it. The question treats marking items as read or seen as a write, as the policy does.

`harness/judge/judge_eval.mts` runs every labeled non-GET request of the verified sites through the real
`decide()` with an empty cache, each labeled operation once, with the body recorded for it. With
`EVAL_SITE_MODE=custom` the same sites are guarded as sites a user added (no decoder, no site rules), an
optimistic estimate for sites nobody verified. Each labeled operation is scored once, on the first time it
appeared on its page. Jev alone (`jev:openrouter`, review model off), refuse bar 0.75 (at 0.85, six background
writes Jev scores 0.76 to 0.85 would need the review model, and the reads in that range,
Calendar's other-calendars list and a Gmail keepalive, are allowed by their sites'
tested verdicts), 239 operations (81 writes): verified mode passed 70% of reads and no write, with 44 left
uncertain. Custom mode passed 30% of reads and 1 write (a LinkedIn action call), with 121 (51%) left
uncertain, which is what the review model receives.
Tried and not adopted: timing context (seconds since the last user action, page load, repeats on the page),
given to Jev or combined with its score by a model fitted on four sites and tested on the fifth. At an
equal number of leaked writes it left as many requests uncertain as Jev alone. It only cut them (to about
20%) by letting 8 of 83 writes through, real ones included (a Gmail RSVP and thread action, Calendar
changes), because the writes Jev misses are the ones with no recent click.
Also tried and not adopted: seconds since the page loaded, given to Jev. As a bare field it
changed nothing. With a sentence explaining it, it cut second-judge calls by about 2 to 3 points but made Jev more
lenient on every request, writes included. Applied only to requests sent within 5 s of a load with no click
since, it no longer drifted elsewhere, but it saved about 5 calls of 239 and let a page-load setting write
through (Calendar's themePreference, 0.47 to 0.27) on a site treated as unverified: background writes made at
page load look exactly like fetches.
`rules-only` gives the floor with no AI.

Without a key the judge is rules-only and `status.judgeProblem` says what is missing, and every request
nothing can classify is refused. `ctl.py secrets` pushes `OPENROUTER_API_KEY` and `AI_GATEWAY_API_KEY`
from `.env` into the matching provider slots.

```sh
npx tsx harness/judge/judge_eval.mts "jev+openrouter:anthropic/claude-haiku-5.5"   # needs OPENROUTER_API_KEY; EVAL_REVIEW_THINKING=off for Haiku 5.5
EVAL_SITE_MODE=custom npx tsx harness/judge/judge_eval.mts jev:openrouter           # Jev alone, as if nobody verified the sites
python3 harness/judge/judge_jev.py …                                                  # offline Jev scorer
```

## Replay tests (CI)

`e2e/replay.spec.ts` replays the verified sites' real traffic against their real host names without the
real sites: the test browsers resolve every host to a local HTTPS server
(`fixtures/replay/server.ts`, self-signed certificate, `--host-resolver-rules`), so OnlyRead sees the
production hosts, paths, bodies, decoder and verdicts. Two browsers, one with the extension and one
without:

1. a status change from the unguarded browser lands, and the guarded browser reads it.
2. the same change from the guarded browser is refused and never reaches the server.
3. for each verified site (Linear, Gmail, Calendar, LinkedIn, Facebook, X), every labeled request in
   `apps/<site>/replay.jsonl` is sent from a page on the site's own origin in the guarded browser: no
   write may reach the server, and at least 99% of reads must (`READ_FLOOR` can lower it per site).

It runs with no AI key, so it proves the rules, decoder and verdicts alone. `replay.jsonl` is built from
the verification sessions by `python3 harness/site/replay_corpus.py <app>`: labels keep only a 200-character
body sample, which is not replayable. It replays only recordings whose fingerprint, recomputed with
today's decoders, equals their label's (labels made before a site's decoder existed can cover a shape
that mixed reads and writes), and replaces the owner's identifiers (`ONLYREAD_PRIVATE_IDS`) with neutral
stand-ins, since the file is committed. The test cannot see the site changing its app, or requests made by
the site's own code, service worker or sockets. The per-site enforce runs (`apps/<app>/README.md`) cover the
real sites. Telegram and WhatsApp, whose traffic is one socket, have no replay. Their guards are covered by
`e2e/telegram-guard.spec.ts` and `e2e/socket-guard.spec.ts`. `npm run e2e:replay` runs it locally, and CI runs it on
every push.

## Bundling for someone else

`python3 harness/bundle.py` builds a distribution zip (`bundles/onlyread-<version>.zip`) and restores the
dev build afterward. The distribution build sets `ONLYREAD_DIST=1`, which nulls the dev sink (so the
recipient's copy never polls localhost and the control channel is off) and minifies with no source
maps. It stages only the runtime files (manifest, HTML, `ui.css`, `dist/*.js`, `assets/`). Policy JSON is
compiled into the bundle. The recipient unzips and loads the `onlyread` folder via chrome://extensions ->
Developer mode -> Load unpacked. Until an AI judge is set, protection is off and cannot be turned on. With one it
enforces during agent sessions, with no site switched on yet.
On a fresh install with no key stored, the background opens `setup.html` in a small popup window
(`shouldPromptForKey`: reason `install` only, never on updates, dev reloads or restarts) that asks for the judge:
a Pro sign-in, or an OpenRouter or Vercel AI Gateway key (one key runs both judges), tested before it is
saved (the same test as the settings page), then stored in the same `secrets.keys` slot.
`python3 harness/ctl.py setup` opens it on demand. `python3 harness/ctl.py secrets-pull` copies the extension's
stored keys into `.env` (digests only in the output) so the harness never scores with a stale key, and `scripts/shot-ui.mjs` proves it opens in a fresh profile.

After the judge step (Pro signed in, or a key saved, with no "Later") the setup window offers a demo on a real site (`background/demo.ts`,
`setup/demo-steps.ts`, `content/demo-coach.ts`): the person picks a verified site they are signed in to (each with one
harmless write to try, `shared/demo-sites.ts`) and OnlyRead protects all the time for the demo, the site switched on, so
their own click is guarded as an agent's would be. A coach card on the site says what to try. The refused request that
the suggested change sends ends it (`DemoSite.catches`, per site: X's `FavoriteTweet`, a LinkedIn or Facebook reaction,
a Calendar event, Linear's `IssueUpdate`), not a write the page sends by itself as it loads (a read receipt, an unseen
flag cleared), nor a request stopped only because a check could not run. Each site's change is one its tested rules
refuse, so no AI judge is needed. Sites without such a change are not offered (Reddit has no recorded session, and Gmail's
star shares its request with the marks it sends by itself). Step 2
lasts as long as OnlyRead's notice stays, and at most the notice's own time: at the end of its timer the notice is closed
too (it stays open while hovered or with its details open) and the card goes. Then the settings it
changed go back (the site stays guarded), and a summary over the page shows what was stopped, what still worked and
what happens now. The site opens in the person's own browser window and the setup window closes, so the whole demo
plays out on the site. Every step can be skipped, and a demo left running ends after 15 minutes. Starting only raises protection.
Ending puts "during agent sessions" back: with an agent at work that guards just as "always" does, so the settings lock
lets it through then (a PIN still holds it); a mode the demo changed goes back through the lock as usual. The
coach card may only ask for the demo's state (answered on the demo's own site alone) and skip. Once the demo's write is
refused, the site's follow-ups (the app's retries, the beacon after the click) are logged but not added to the notice,
which shows the demo's one change (`demo.ts foldsIntoDemo`). The demo can be run
again at any time, on the same site or another: the summary's "Try another site" (under "Guard more sites", beside "Done") and the settings page's "Try the demo"
(Overview) open the setup window straight at the choice of site (`setup.html#demo`, where leaving is Close), or send
an open setup window there.

## Adding a system

The procedure, step by step, is in `CONTRIBUTING.md` under "Adding a site" (scaffold → monitor read pass → write battery → label/score/cache → codec if the
app multiplexes reads and writes → enforce battery with server-truth checks → coverage,
report, Verified profile). Start with `python3 harness/site/new_app.py <app> "<Name>" <domain>`.

## Measuring coverage (harness/)

```sh
node harness/site/record_fixture_session.mts <name> monitor   # scripted session in Chromium with NetLog
harness/chrome/launch.sh <name>                            # or a real Chrome agent profile with NetLog
python3 harness/site/sink_dump.py apps/<app>/sessions/<name> --domains app.example.com   # pull decisions from the dev sink
python3 harness/site/netlog.py apps/<app>/sessions/<name>/netlog.json
python3 harness/site/label.py sessions --labels apps/fixture/labels.jsonl        # then label every '?' row
python3 harness/site/compare.py sessions --labels apps/fixture/labels.jsonl      # coverage + miss buckets
python3 harness/lib/evaluate.py --labels apps/fixture/labels.jsonl --rules-only # judge thresholds from the rules alone
```


After an enforce battery, `python3 harness/site/leak_check.py apps/<app>/sessions/<name>` pairs the
observer's webRequest records with the decisions: a request that completed while its decision was
block is a leak, an orphan is traffic the interception layer never saw. It exits 1 on any leak.
