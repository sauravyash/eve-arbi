// Keyboard use for a search box's results list: Up/Down move a highlight through the list's buttons
// (focus stays in the box, so typing carries on) and Enter clicks the highlighted one. With nothing
// highlighted, Enter falls through to the box's own handler. Bind before that handler.

export function bindListKeys(input, box) {
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    const items = [...box.querySelectorAll('button')];
    if (!items.length) return;
    const at = items.findIndex(b => b.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown'
        ? (at + 1) % items.length
        : (at <= 0 ? items.length : at) - 1;
      items[at]?.classList.remove('active');
      items[next].classList.add('active');
      items[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      items[at].click();
    }
  });
}
