// Proxy for a Wanderer mapper's connections (public/js/shortcuts.js), shared by server.js and the
// Cloudflare Worker. Wanderer sends no CORS headers, so the page can't call it directly.
//
// GET /api/wanderer/connections?url=https://wanderer.example&map=<slug>, header X-Wanderer-Token
// → Wanderer's JSON. The token is only forwarded, never stored. Only public https hosts and the
// two connections paths are reachable (wandererUrls), and redirects aren't followed.

import { wandererUrls } from './public/js/wormholes.js';

/** @returns {Promise<{status: number, body: string}>} body is JSON text */
export async function wandererConnections(params, token, userAgent) {
  const err = (status, error) => ({ status, body: JSON.stringify({ error }) });
  const urls = wandererUrls(params.get('url'), params.get('map'));
  if (!urls) return err(400, 'Use the https:// address of a Wanderer site and a map slug (letters, digits, - or _)');
  if (!token || token.length > 512 || /[\r\n]/.test(token)) return err(400, 'Missing Wanderer map API token');
  for (const [i, url] of urls.entries()) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': userAgent },
        redirect: 'manual', signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return err(502, `no answer (${e.message})`);
    }
    if (res.status === 404 && i < urls.length - 1) continue;   // older Wanderer: try the other path
    if (res.status === 401 || res.status === 403) return err(res.status, 'the token was refused for this map');
    if (!res.ok) return err(502, `HTTP ${res.status}`);
    const text = await res.text();
    try { JSON.parse(text); } catch { return err(502, 'the site sent something other than JSON; check the address'); }
    return { status: 200, body: text };
  }
  return err(404, 'map not found on that site');
}
