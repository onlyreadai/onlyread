# Privacy policy for the OnlyRead extension

_Last updated: 2026-11-02_

This policy covers the OnlyRead browser extension, published by OnlyRead AI (In Formation) ("we"), which also
operates the OnlyRead Pro service. OnlyRead refuses state-changing requests on the websites you choose to guard.

The extension can classify uncertain requests in one of two ways, chosen when you install it and changeable in
the settings:

- **Your own key (BYOK):** the extension sends classification requests only to the AI provider you configure,
  under that provider's own privacy policy. We receive nothing from them. Only a support report you choose to send
  reaches us (section 3).
- **OnlyRead Pro (an optional hosted service, free or paid):** uncertain requests are sent to the OnlyRead Pro
  service instead. That service has its own privacy policy, which describes what it
  receives and keeps: the [OnlyRead Pro privacy policy](https://onlyread.ai/privacy). Nothing is
  sent to OnlyRead Pro unless you sign in to it. Signing up, plans and any payment happen on the OnlyRead Pro
  website, never in the extension, and are covered by that policy.

If you sign in to OnlyRead Pro, the extension also asks your Pro account, about once a minute and when you open the
popup or the settings page, whether you chose there which sites are guarded (section 1a). With that check, and when
it shows your account, it sends a short description of this browser so your account page can list your browsers:
the operating system (macOS, Windows, Linux, ChromeOS or other), how many sites this browser guards (a number, not
which ones), the extension's version, and, if an AI agent named itself on the setup page, which agent (Grok Bot,
ChatGPT, Claude, Comet, Cowork or Codex) and the name it gave this browser. It sends nothing about your browsing.

So that a change you make on your Pro account reaches this browser in seconds rather than at its next check, the
extension also subscribes, while you are signed in, to push messages through Chrome's own push service (operated by
Google), and gives your Pro account that subscription: an address at the push service and the keys to reach it. The
account then sends an empty message when what this browser guards changes, and the extension asks the account as
above. No content is ever pushed. The subscription is dropped when you sign out.

## 1. What stays on your device

Stored in the extension's local storage. The extension does not send any of it anywhere, except what sections 2
and 3 describe (the description of a single request for classification, and the support reports you choose to send):

- your settings (guarded sites, mode, appearance), your settings PIN as a salted hash if you set one, and, in BYOK
  mode, your API key, which goes only to that provider, to authenticate your requests,
- a log of up to 2,000 recent decisions on guarded sites (method, URL, verdict, what decided it, the judge's
  score, the request's shape and a body preview of at most 2 KB),
- a log of up to 5,000 recent requests on guarded sites while OnlyRead is guarding (time, method, URL with
  secret-named query values removed, request type and the page that started it),
- a verdict cache keyed by request shape,
- if you are signed in to Pro: the sign-in tokens, and the list of sites your account guards (section 1a),
- if an AI agent used the setup page: the agent's name and the name it gave this browser.

Held in memory for each guarded tab, and dropped when the tab closes: the last few interface actions in it (for
example "click on a button named Send"). A copy stays with each logged decision it triggered.

On OnlyRead Pro's setup page (`/agent-setup`), the extension tells that page, inside your browser, its version, the
names of the sites it guards, its mode and whether you are signed in to Pro, so your agent can read them. The page
does not send them anywhere. A setup link you make on your account page carries a one-time code that signs the
browser it is used in in to your account. It works once, within ten minutes, and only the code's hash is stored.

### 1a. Guarded sites managed from your Pro account

While you use OnlyRead Pro, the sites you guard are kept on your Pro account: a list every browser signed in to it
guards and, once the account has more than one browser, a list for each browser alone. You change them on the account
page or in the extension (its settings page and popup). When you sign in, the sites this browser guarded on its own
move to your account. A site you add or remove in the extension is applied in this browser at once and sent to your
account (the site's address or built-in id, its name, and which list), through the settings lock for a removal. If
the account cannot be reached the change waits on your device and is sent later. While you are signed in, the
extension fetches the lists with the account check above and keeps them with its settings, in local storage. When you
sign out, or the account ends, the extension keeps guarding the same sites on its own. The lists stay on the account
until you change them and are deleted with your account. With your own API key instead of Pro, the sites you guard
stay in this browser and are never sent.

Your Pro account page can show this browser's activity and protection settings. The extension shows its own page
inside the account page, only there, and only when this browser is signed in to that account. The website cannot read
what that part shows, and none of it is sent to the service.

### 1b. Site icons

To show an icon beside a site, the extension's pages load, in this order: the icon the OnlyRead Pro service keeps
for a site on your account's list, or the icon a built-in site's profile names (from that site's own servers),
then Chrome's own favicon cache, and, if neither loads, Google's favicon service (www.google.com/s2/favicons), which
then learns the site's host name. When you add a site in this browser, the extension fetches the site's home page
and icon from the site itself, without your cookies, to name it. The OnlyRead Pro service fetches the icon of a
site on an account's list once, from the site itself, and keeps a copy keyed by its host name and shared between
accounts, dropped once no account lists the site any more.

### 1c. What you type into sensitive fields

Held in memory only, never stored or transmitted: what you type into password, one-time-code and
payment-card fields on guarded sites, kept for at most ten minutes so it can be removed from any request
description before it is sent for classification (section 2). It is forgotten when the tab closes.

Most requests never leave your device for classification: rules, per-site decoders and the verdict
cache settle them locally.

## 2. What is sent for classification

Only for requests on sites you guard that nothing local can classify, the extension sends a description
of that one request to the provider you chose (your AI provider in BYOK mode, OnlyRead Pro when
it is your judge):

- method, host, path and path template, the names of query parameters and, for a request that can change data or a
  parameter that names the operation, their short values (for example `?action=delete`), with secret-named values, token-like values and anything you
  typed into a password, one-time-code or payment-card field removed,
- the request's type (for example a form or a script request), the content type, the structure of the body, and a
  preview of the body limited to 2 KB with long text values truncated,
- the last interface action that triggered it (type, element, visible name).

**Never sent:** cookies, request headers, page content, responses, your browsing on sites you did not
guard, or passwords you type. The body preview can contain personal data from the page you are on (for
example an email subject or a search term).

## 3. Support reports you choose to send

From the settings page you can report a refusal you think was a mistake. Nothing is sent until you click
Send to Support, and the dialog shows the report exactly as it will go. A report carries:

- the refusal you picked and, if you leave them ticked, the other refusals from the same tab within ten
  seconds of it: for each one its time, method and address (secret-named query values and token-like runs
  masked, other query values kept), its verdict and what decided it (the source, the reason, and the judge's
  model, score and sentence), its fingerprint, content type, body shape and body preview (as the log keeps it:
  already redacted, at most 2 KB; a compressed or binary body goes as "[binary body, not shown]"), and the
  three interface actions nearest to it (type, element, role and visible name),
- the extension's version and build, its mode, when it protects, the judge provider, the read-tracking
  setting and the ids of the guarded sites,
- the browser's user agent,
- your note, and an email address only if you type one.

In what comes from the page (the fingerprint, body shape, body preview, judge's sentence and clicked names),
your note and the user agent, a character that cannot be stored, such as a null or half an emoji, goes as "�".

It goes to the OnlyRead Pro service whichever judge you use: with your Pro sign-in if you are signed in, so
support can see the account, and anonymously otherwise. The body preview can contain personal data from the
page you were on, as in section 2. What the service keeps is described in its privacy policy.

## 4. Your choices

Choose when OnlyRead protects, which sites it guards and which judge it uses, or switch it off, from the
settings page. While an AI agent is working in the browser, a change that lowers protection waits until the
agent finishes, and a settings PIN, if you set one, is asked for first. Removing the extension deletes
everything it stored on your device (section 1). A site list on your Pro account stays there until you
change it or delete the account (section 1a). If you are signed in to Pro when you remove the extension, Chrome
opens an OnlyRead Pro page that signs this browser out of your account.

## 5. No tracking

The extension contains no analytics, no telemetry and no advertising. The only descriptions of your browser it
sends are the one above, to your own OnlyRead Pro account while you are signed in to it, and the one in a support
report you choose to send (section 3). Besides the destinations this policy describes (your AI provider, the
OnlyRead Pro service, Chrome's push service while you are signed in to Pro, the sites you guard or add, and the site
icons in section 1b), the extension makes no network requests.

The use of information received from the extension complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including its Limited Use requirements.

## 6. Permissions

The extension asks Chrome for access to all sites because you can guard any site. It inspects requests only on
the sites you guard. It uses Chrome's debugger API to hold a guarded tab's requests until they are decided, which is
why Chrome shows its "started debugging this browser" banner while it does. Its content script runs on every page,
but records interface actions and what you type into sensitive fields only on sites you guard.

## 7. Changes to this policy

When the extension's handling of data changes, we update this policy and the date at the top, and say so in the
release notes.

## 8. Contact

privacy@onlyread.ai, or https://github.com/onlyreadai/onlyread/issues for anything that is not private.
