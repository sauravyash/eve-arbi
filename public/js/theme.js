// Light/dark theme. Loaded as a classic script in <head> so the theme is set before first paint.
// An explicit choice is remembered; otherwise the OS preference is followed (and tracked live).
(() => {
  const KEY = 'eve-arbi:theme';
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: light)');
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch {}

  const apply = (theme) => {
    if (root.dataset.theme !== theme) {
      root.dataset.theme = theme;
      dispatchEvent(new Event('themechange')); // canvases (star map) repaint
    }
    const btn = document.getElementById('themeBtn');
    if (btn) {
      const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  };
  const current = () => (stored === 'light' || stored === 'dark' ? stored : media.matches ? 'light' : 'dark');

  apply(current());
  media.addEventListener('change', () => { if (!stored) apply(current()); });
  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      stored = root.dataset.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(KEY, stored); } catch {}
      apply(stored);
    });
  });
})();
