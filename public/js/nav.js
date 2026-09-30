// Section pages: each tool (Hub arbitrage, Market watch, Contracts) is split into one page per
// section, linked by a `.subnav` bar under the settings. The pages of a tool share its settings, so
// moving between them keeps the query string (url-state.js): a shared link's view carries over.

/** Wires the section bar: links keep the view's settings, and keys 1–9 jump to a section. */
export function mountSectionNav(bar = document.querySelector('.subnav')) {
  if (!bar) return;
  const links = [...bar.querySelectorAll('a[href]')];
  for (const a of links) a.dataset.page = a.getAttribute('href');
  // Settings change while you're on a page, so each link picks up the query string as it's used.
  const sync = (a) => { a.href = a.dataset.page + location.search; };
  for (const ev of ['pointerdown', 'focusin']) bar.addEventListener(ev, (e) => { const a = e.target.closest('a[href]'); if (a) sync(a); });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    const a = links[Number(e.key) - 1];
    if (a && a.getAttribute('aria-current') !== 'page') { sync(a); location.href = a.href; }
  });
}

/** Opens another section page of the same tool, keeping its settings and adding `params`. */
export function openSection(page, params = {}) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  const qs = q.toString();
  location.href = `${page}${qs ? `?${qs}` : ''}`;
}

/** Sends links to a tool's old single-page URL (market.html?tab=orders) to its section page. */
export function redirectTab(pages, fallback) {
  const q = new URLSearchParams(location.search);
  const page = pages[q.get('tab')] || fallback;
  q.delete('tab');
  const qs = q.toString();
  location.replace(`${page}${qs ? `?${qs}` : ''}${location.hash}`);
}
