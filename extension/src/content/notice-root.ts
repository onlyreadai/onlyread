// The refusal notice's shadow root (actions.ts makes it). The demo's coach card (demo-coach.ts), whose own root is
// closed, finds the notice through here to frame it, and closes it when the demo's step 2 is over.

let root: ShadowRoot | null = null;
let hide: () => void = () => {};

export function setNoticeRoot(r: ShadowRoot, hideNotice: () => void): void { root = r; hide = hideNotice; }

/** Closes the notice now, hovered or with its details open. */
export function closeNotice(): void { hide(); }

/** The notice's box while it shows. */
export function noticeBox(): HTMLElement | null {
  const box = root?.querySelector<HTMLElement>('.box');
  return box && box.getBoundingClientRect().width > 0 ? box : null;
}

/** The site toast the notice frames (actions.ts), as the coach's layers over the page need it: the notice cuts a window
 *  over the toast, and the demo's card and backdrop sit between the notice and the page, so they cut the same one, or
 *  the window shows them instead of the toast. Null when the notice frames none. */
export interface FramedToast { rect: DOMRect; radius: number }
let toastListener: ((t: FramedToast | null) => void) | null = null;

/** The coach listens while it frames the notice; null to stop. */
export function onToastFramed(f: ((t: FramedToast | null) => void) | null): void { toastListener = f; }

/** The notice placed its frame around a toast (every frame while it moves), or took it away. */
export function toastFramed(t: FramedToast | null): void { toastListener?.(t); }
