// Mirrors a page's settings in the query string, so any view can be bookmarked or shared.
//
// `fields` lists the settings paths to mirror; each path is also its query parameter
// (e.g. `flag`, `scan.minProfit`). An entry may be `[path, allowed]`, where `allowed` is an
// array of accepted values or a predicate; anything else in the URL is ignored.
//
// Values are typed by their default: booleans travel as 1/0, numbers (and null defaults) as
// numbers, everything else as text. Only values that differ from the defaults are written.
// A URL carrying any mirrored parameter describes the whole view: the ones it leaves out
// take their defaults, not this browser's saved values. Other parameters are left alone.

const getPath = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
function setPath(o, path, v) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((x, k) => (x[k] ||= {}), o)[last] = v;
}
const entry = (f) => (Array.isArray(f) ? f : [f, null]);

function decode(raw, def) {
  if (typeof def === 'boolean') return raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : undefined;
  if (typeof def === 'number' || def === null) {
    const n = Number(raw);
    return raw.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }
  return raw;
}
const encode = (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : v == null ? '' : String(v));
const accepts = (allowed, v) => !allowed || (typeof allowed === 'function' ? allowed(v) : allowed.includes(v));

/** Applies the URL's parameters to `settings`. Returns false (and changes nothing) when it has none of them. */
export function readUrl(settings, defaults, fields, search = globalThis.location?.search ?? '') {
  const q = new URLSearchParams(search);
  if (!fields.some(f => q.has(entry(f)[0]))) return false;
  for (const f of fields) {
    const [path, allowed] = entry(f);
    const def = getPath(defaults, path);
    const v = q.has(path) ? decode(q.get(path), def) : undefined;
    setPath(settings, path, v !== undefined && accepts(allowed, v) ? v : structuredClone(def));
  }
  return true;
}

/** The query string (without `?`) for `settings`, keeping any unrelated parameters from `search`. */
export function queryFor(settings, defaults, fields, search = '') {
  const q = new URLSearchParams(search);
  for (const f of fields) {
    const [path] = entry(f);
    const v = encode(getPath(settings, path));
    if (v === encode(getPath(defaults, path))) q.delete(path); else q.set(path, v);
  }
  return q.toString();
}

/** Rewrites the address bar to match `settings` without adding a history entry. */
export function writeUrl(settings, defaults, fields) {
  const qs = queryFor(settings, defaults, fields, location.search);
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, '', url);
}
