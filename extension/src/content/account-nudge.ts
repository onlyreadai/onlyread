// The OnlyRead Pro account page's word that the account changed (the cloud repo's app/account/nudge.ts): passed to the
// background, which asks for the account's lists at once when it comes from the configured service's pages
// (messages.ts accountChanged). Only a message the page posted to itself, of exactly this shape, top frame only; it
// carries nothing but that something changed.
export function installAccountNudge(): void {
  if (window !== window.top) return;
  // The other way: the background saved a change to the account from this browser (a site added in the popup), and
  // the account page shows it at once. Passed to the page only, as "something changed", nothing more.
  // Likewise a sign-in or sign-out here: the page's Browsers list asks again which browser this is.
  chrome.runtime.onMessage.addListener((m: { type?: unknown }) => {
    if (m?.type === 'account-lists-changed' || m?.type === 'this-browser-changed') window.postMessage({ source: 'onlyread-extension', type: m.type }, location.origin);
  });
  addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data as { source?: unknown; type?: unknown; account?: unknown } | null;
    if (d?.source !== 'onlyread-pro') return;
    if (d.type === 'account-changed') ask({ type: 'page:account-changed' });
    // Signed out of the account page in this browser: the extension signs out too, if it is signed in to that account
    // (messages.ts webSignedOut checks the page and the account).
    if (d.type === 'signed-out' && typeof d.account === 'string') void chrome.runtime.sendMessage({ type: 'page:signed-out', account: d.account }).catch(() => {});
    // Which row of the account page's Browsers list is this browser (the background answers the account's own page only).
    if (d.type === 'which-browser' && typeof d.account === 'string') whichBrowser(d.account);
  });
  // The page's "Try the demo" (`data-onlyread-demo`, with the account it names in `data-account`): only a click the
  // browser marks trusted counts, so the page's own script cannot open windows with it.
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const account = e.target.closest('[data-onlyread-demo]')?.getAttribute('data-account');
    if (account) ask({ type: 'page:open-demo', account });
  }, true);
}

function ask(msg: { type: string; account?: string }): void {
  try { void chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension reloaded */ }
}

function whichBrowser(account: string): void {
  const reply = (r: { ok?: boolean; family?: string; reason?: string } | undefined) =>
    // `demo`: this extension opens the demo from the page's "Try the demo" (below), so the page may show it.
    window.postMessage({ source: 'onlyread-extension', type: 'this-browser', ...(r?.ok && r.family ? { family: r.family, demo: true } : { reason: r?.reason ?? 'unavailable' }) }, location.origin);
  try { void chrome.runtime.sendMessage({ type: 'page:which-browser', account }).then(reply, () => reply(undefined)); } catch { reply(undefined); }
}
