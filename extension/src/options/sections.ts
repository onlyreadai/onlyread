// The settings page's frame: the sidebar of topics (highlights the section at the top of the window, scrolls to one on
// click), the entrance, and the numbers that count up. Nothing here knows about settings.

export const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scroll a section into view, smoothly unless motion is reduced. */
export function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/** The sidebar: the last section whose top has passed near the top of the window is marked; at the very bottom, the
 *  last one. A click scrolls to its section and puts its id in the address bar without jumping. */
export function installSidebar(nav: HTMLElement): void {
  const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  const targets = links.map((a) => document.getElementById(a.getAttribute('href')!.slice(1)));
  const mark = () => {
    let cur = 0;
    targets.forEach((t, i) => { if (t && t.getBoundingClientRect().top <= 140) cur = i; });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = targets.length - 1;
    links.forEach((a, i) => {
      a.classList.toggle('on', i === cur);
      if (i === cur) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  };
  addEventListener('scroll', mark, { passive: true });
  addEventListener('resize', mark, { passive: true });
  links.forEach((a, i) => {
    a.addEventListener('click', (ev) => {
      const t = targets[i];
      if (!t) return;
      ev.preventDefault();
      t.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      history.replaceState(null, '', a.getAttribute('href'));
    });
  });
  mark();
}

const shown = new WeakMap<HTMLElement, number>();
/** Clear a count and reset its cached value so it can be set again later. */
export function clearCount(el: HTMLElement): void {
  shown.delete(el);
  el.textContent = '';
}

/** Set a count; the first time, it counts up from zero (an ease-out over 0.9 s), unless motion is reduced. */
export function setCount(el: HTMLElement, value: number): void {
  const before = shown.get(el);
  shown.set(el, value);
  if (before === value) return;
  if (before !== undefined || value === 0 || reducedMotion()) { el.textContent = value.toLocaleString(); return; }
  const t0 = performance.now();
  const step = (t: number) => {
    if (shown.get(el) !== value) return; // a newer value took over
    const k = Math.min(1, (t - t0) / 900);
    el.textContent = Math.round(value * (1 - (1 - k) ** 3)).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Show the Activity badge only when there are refused writes today. */
export function setActivityCount(el: HTMLElement, value: number): void {
  el.textContent = value > 0 ? String(value) : '';
}
