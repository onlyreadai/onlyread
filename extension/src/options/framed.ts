// The settings page framed on the OnlyRead Pro account page (content/account-frames.ts): options.html?framed=1#<section>
// shows that one section, with no header, sidebar or footer, at the frame's width. It shows anything only when the page
// framing it is the configured Pro service (`location.ancestorOrigins`, which a page cannot set); anywhere else, or
// opened on its own, it stays blank. It tells that page its height, and when a dialog opens (a report, the PIN), so
// the page can scroll it into view.

import { applyTheme, normalizeTheme, type Theme } from '../shared/theme';

const FRAMEABLE = new Set(['activity', 'security']);

/** The account page's light or dark choice, as the frame was opened with it (content/account-frames.ts `theme`):
 *  framed, the section looks like the page around it, whatever this extension's own setting is. */
export function framedTheme(): Theme {
  return normalizeTheme(new URLSearchParams(location.search).get('theme'));
}

/** The section asked for when the page is opened framed (options.html?framed=1#activity), or undefined. */
export function framedSection(): string | undefined {
  if (new URLSearchParams(location.search).get('framed') !== '1') return undefined;
  const s = location.hash.slice(1);
  return FRAMEABLE.has(s) ? s : 'activity';
}

/** Hidden until the framing page is known (framed.css rules in options.html: `html.framed body` stays invisible). */
export function enterFramed(section: string): void {
  document.documentElement.classList.add('framed');
  document.getElementById(section)?.classList.add('framed-target');
  // The page's light or dark, now and as it switches (content/account-frames.ts sends it on every load of the frame
  // and on every switch). Listened for from the start, before the framing page is known: the look alone, and the page
  // stays blank anyway unless the framing page is the service's (allowFrame).
  addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const d = e.data as { source?: unknown; theme?: unknown } | null;
    if (d?.source === 'onlyread-page' && d.theme !== undefined) applyTheme(normalizeTheme(d.theme));
  });
}

/** Whether `ancestors` is exactly the Pro service's page: one ancestor, the service's origin. */
export function framedByService(ancestors: ArrayLike<string>, serviceUrl: string): boolean {
  let origin: string;
  try { origin = new URL(serviceUrl).origin; } catch { return false; }
  return ancestors.length === 1 && ancestors[0] === origin;
}

/** Shown once the framing page is the service's; else the page is emptied and stays blank. */
export function allowFrame(serviceUrl: string): boolean {
  if (!framedByService(location.ancestorOrigins, serviceUrl)) {
    document.body.replaceChildren();
    return false;
  }
  const origin = new URL(serviceUrl).origin;
  document.documentElement.classList.add('framed-ok');
  const post = (msg: Record<string, unknown>) => window.parent.postMessage({ source: 'onlyread-frame', ...msg }, origin);
  // The content's own height: the document's is never less than the frame's, so it could only grow.
  const page = document.querySelector<HTMLElement>('.page') ?? document.body;
  const report = () => post({ height: Math.ceil(page.getBoundingClientRect().height) });
  new ResizeObserver(report).observe(page);
  report();
  // A dialog opened in the frame is drawn near the frame's top (framed.css): the page scrolls the frame into view.
  for (const d of document.querySelectorAll('dialog')) {
    new MutationObserver(() => { if (d.open) post({ dialog: true }); }).observe(d, { attributes: true, attributeFilter: ['open'] });
  }
  return true;
}
