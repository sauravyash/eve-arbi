// "Fit" button beside a Cargo m³ field: paste an EFT fitting, get the fitted cargo hold (see
// fitting.js). Applying it types the number into the field and fires `input`, so each page's own
// binding saves it. The last fitting and skill level are remembered per browser.

import { loadFit, fittedCargo } from './fitting.js';

const KEYS = { text: 'fit.text', skill: 'fit.skill' };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const m3 = (v) => `${Math.round(v).toLocaleString()} m³`;
const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage disabled */ } };

// ESI answers the odd lookup with a 5xx (or the connection drops): try twice more before giving up.
const RETRIES = [500, 1500];
async function esiGet(path) {
  for (let k = 0; ; k++) {
    let err;
    try {
      const r = await fetch(`/api/esi/${path}`);
      if (r.ok) return await r.json();
      err = new Error(`ESI ${path}: HTTP ${r.status}`);
      if (r.status < 500) throw err;
    } catch (e) { err = e; if (/HTTP 4\d\d$/.test(e.message)) throw e; }
    if (k >= RETRIES.length) throw err;
    await new Promise(res => setTimeout(res, RETRIES[k]));
  }
}
const esiCache = new Map();
function esi(path) {
  if (!esiCache.has(path)) esiCache.set(path, esiGet(path).catch(e => { esiCache.delete(path); throw e; }));
  return esiCache.get(path);
}

/**
 * @param {HTMLInputElement} input                 the Cargo m³ field
 * @param {object} o
 * @param {() => Record<string, Array>|null} o.types   types.json once loaded
 * @param {HTMLInputElement} [o.shipInput]         a ship field to fill too (fires `change` first)
 */
export function mountFitButton(input, { types, shipInput }) {
  const wrap = document.createElement('span');
  wrap.className = 'with-fit';
  input.replaceWith(wrap);
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost fit-btn', textContent: 'Fit…',
    title: 'Work out the cargo hold from a fitting: expanders, rigs and hull skill' });
  wrap.append(input, btn);
  const sync = () => { btn.disabled = input.disabled; };
  new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['disabled'] });
  sync();

  const dlg = document.createElement('dialog');
  dlg.className = 'fit-dialog';
  dlg.innerHTML = `<form method="dialog">
    <h3>Cargo from a fitting</h3>
    <p class="hint">In game, open the fitting window, press Ctrl+C (or Copy to clipboard), and paste here.</p>
    <textarea rows="12" spellcheck="false" placeholder="[Iteron Mark V, My hauler]&#10;Expanded Cargohold II&#10;…&#10;Medium Cargohold Optimization I"></textarea>
    <label class="fit-skill"><span>Hull skill level</span>
      <select>${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
    <p class="fit-out" role="status" aria-live="polite"></p>
    <div class="fit-actions">
      <button class="btn small ghost" value="cancel">Cancel</button>
      <button class="btn small primary" value="apply" disabled>Use this cargo</button>
    </div>
  </form>`;
  document.body.append(dlg);
  const [area, skillSel, out, apply] = ['textarea', 'select', '.fit-out', '[value=apply]'].map(s => dlg.querySelector(s));
  const skillName = dlg.querySelector('.fit-skill span');
  area.value = get(KEYS.text, '');
  skillSel.value = get(KEYS.skill, '5');

  let fit = null, result = null, seq = 0;
  function show() {
    result = fit && fittedCargo({ ...fit, skill: Number(skillSel.value) });
    skillName.textContent = fit?.skill ? `${fit.skill} level` : 'Hull skill level';
    apply.disabled = !result;
    if (!result) return;
    const parts = [`${m3(fit.base)} hull`,
      fit.hullBonus ? `+${fit.hullBonus * Number(skillSel.value)}% skill` : null,
      result.expanders ? `${result.expanders} expander${result.expanders > 1 ? 's' : ''}` : null,
      result.rigs ? `${result.rigs} rig${result.rigs > 1 ? 's' : ''}` : null].filter(Boolean);
    out.className = 'fit-out';
    out.innerHTML = `<b>${esc(fit.ship)}</b>: ${esc(parts.join(' · '))} → <b class="up">${m3(result.m3)}</b>`
      + (fit.unknown.length ? `<small>Not found (ignored): ${esc([...new Set(fit.unknown)].join(', '))}</small>` : '')
      + (fit.failed?.length ? `<small>Couldn't look up, so not counted (try again in a moment): ${esc([...new Set(fit.failed)].join(', '))}</small>` : '');
  }
  async function update() {
    const n = ++seq, text = area.value;
    put(KEYS.text, text);
    fit = null; show();
    if (!text.trim()) { out.textContent = ''; return; }
    const t = types();
    if (!t) { out.textContent = 'Item names are still loading…'; return; }
    out.className = 'fit-out'; out.textContent = 'Looking up the modules…';
    try {
      const f = await loadFit(text, { types: t, esi });
      if (n === seq) { fit = f; show(); }
    } catch (e) {
      if (n === seq) { out.className = 'fit-out err'; out.textContent = e.message; }
    }
  }
  let timer;
  area.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(update, 300); });
  skillSel.addEventListener('change', () => { put(KEYS.skill, skillSel.value); show(); });
  btn.addEventListener('click', () => { dlg.showModal(); update(); });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'apply' || !result || input.disabled) return;
    if (shipInput && !shipInput.disabled) { shipInput.value = fit.ship; shipInput.dispatchEvent(new Event('change', { bubbles: true })); }
    input.value = String(Math.floor(result.m3));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
