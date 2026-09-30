// Builds public/wormhole-types.json: every wormhole type (the signature code, e.g. Q063) →
// [leads to, max stable time h, max stable mass kg, max jump mass kg], from DaOpa's wormhole
// database (https://www.ellatha.com/eve/wormholelist.asp and one detail page per type).
// The pages use it to say where a hole goes and how long it can live (public/js/wormholes.js
// whInfo). K162, the exit side of every hole, is left out: its numbers belong to the other end.
// The file is committed (unlike public/data/, built from the SDE), so the site never has to scrape
// the fan site; rebuild it when CCP adds or changes wormhole types.
//
//   node scripts/build-wormholes.js

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.ellatha.com/eve/';
const LIST_URL = `${BASE}wormholelist.asp`;
const detailUrl = (code) => `${BASE}wormholelistview.asp?key=Wormhole+${code}`;
const PAUSE_MS = 250;   // between detail pages, to go easy on a fan site

export const WORMHOLES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'wormhole-types.json');

const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** "Leads into dangerous w-space system | Class 5" → "C5"; "Leads into 0.0 system" → "null-sec"; … */
export function shortLeads(s) {
  const t = String(s || '').trim();
  let m;
  if ((m = /Class (\d+)/i.exec(t))) return `C${m[1]}`;
  if ((m = /drifter w-space system \| (\w+)/i.exec(t))) return `Drifter (${m[1]})`;
  if (/hi-sec/i.test(t)) return 'high-sec';
  if (/low-sec/i.test(t)) return 'low-sec';
  if (/0\.0|null/i.test(t)) return 'null-sec';
  if (/Thera/i.test(t)) return 'Thera';
  if (/Triglavian|Pochven/i.test(t)) return 'Pochven';
  return t.replace(/^Leads (into|to) /i, '').replace(/ system$/i, '') || null;
}

/** The list page → [{code, leads, hours}] */
export function parseList(html) {
  const out = [];
  const row = /wormholelistview\.asp\?key=Wormhole\+(\w+)"[^]*?<\/td>\s*<td[^>]*>([^]*?)<\/td>\s*<td[^>]*>([^]*?)<\/td>/g;
  for (const [, code, leads, hours] of String(html).matchAll(row)) {
    out.push({ code: code.toUpperCase(), leads: text(leads), hours: Number(text(hours).replace(/\s*h$/, '')) });
  }
  return out;
}

/** A detail page → {hours, mass, jump, regen} (kg; null when missing) */
export function parseDetail(html) {
  const t = text(html);
  const num = (label) => {
    const m = new RegExp(`${label}\\s*:\\s*([\\d,.]+)`, 'i').exec(t);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  return { hours: num('Max Stable Time'), mass: num('Max Stable Mass'), jump: num('Max Jump Mass'), regen: num('Max Mass Regeneration') };
}

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'eve-arbi static data build (github.com/sauravyash/eve-arbi)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export async function buildWormholes({ outFile = WORMHOLES_FILE, log = console.log } = {}) {
  log(`Building wormhole types from ${LIST_URL}…`);
  const list = parseList(await get(LIST_URL)).filter(w => w.code !== 'K162');
  if (list.length < 50) throw new Error(`only ${list.length} wormhole types on the list page; has its layout changed?`);
  const out = {};
  for (const w of list) {
    let d = {};
    // A page now and then comes back without its numbers (a busy server); try it once more.
    for (let tries = 0; tries < 2 && !d.mass; tries++) {
      try { d = parseDetail(await get(detailUrl(w.code))); } catch (e) { d = {}; log(`  ${w.code}: ${e.message}`); }
    }
    if (!d.mass) log(`  ${w.code}: no masses on its page (list data only)`);
    out[w.code] = [shortLeads(w.leads), d.hours || w.hours || null, d.mass || null, d.jump || null];
    await new Promise(r => setTimeout(r, PAUSE_MS));
  }
  await mkdir(path.dirname(outFile), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(outFile, json);
  log(`Wormholes: ${Object.keys(out).length} types → ${path.relative(process.cwd(), outFile)} (${Math.round(json.length / 1024)} KB)`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWormholes().catch(e => {
    console.error(`Wormhole data build failed: ${e.message}`);
    process.exit(1);
  });
}
