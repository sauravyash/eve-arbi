// Home page readouts: EVE time and how fresh each market scan is. No DOM, so tests can run them.

const pad = (n) => String(n).padStart(2, '0');

/** EVE time is UTC: "HH:MM:SS". */
export function eveTime(date) {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** "just now", "45m ago", "2h ago", "3d ago". */
export function ago(ms, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * A scan's status (scanClient(kind).status(), or null if it couldn't be read), as the home page shows it.
 * state: scanned | running | none | error. chip: the hero chip's note. row: a tool row's label ('' hides it).
 */
export function describeScan(st, now = Date.now()) {
  if (!st) return { state: 'error', chip: 'unavailable', row: '' };
  if (st.state === 'running' || st.state === 'computing') return { state: 'running', chip: 'scanning now', row: 'Scanning now' };
  const at = st.result?.finishedAt;
  if (!at) return { state: 'none', chip: st.state === 'error' ? 'last scan failed' : 'not yet', row: 'Needs a scan' };
  return { state: 'scanned', chip: ago(at, now), row: `Scanned · ${ago(at, now)}` };
}
