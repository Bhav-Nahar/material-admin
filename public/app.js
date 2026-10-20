/* material-admin UI — vanilla, no build step. Same idiom as glassquickdev's admin,
   a fraction of the size, because it only drives endpoints that exist. */

const $ = (id) => document.getElementById(id);
const secret = () => localStorage.getItem('cronSecret') || '';

/** Comma-separated field → array. Empty in, empty array out (never [""]). */
const list = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
const num = (id) => ($(id).value === '' ? undefined : Number($(id).value));
const str = (id) => $(id).value.trim() || undefined;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(secret() ? { 'x-cron-secret': secret() } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json };
}

/** One place for "it failed, say why" — an error swallowed into a spinner is the worst outcome. */
function show(msgId, outId, { ok, status, json }) {
  const msg = $(msgId), out = $(outId);
  if (out) { out.hidden = false; out.textContent = JSON.stringify(json, null, 2); }
  msg.className = 'msg ' + (ok ? 'ok' : 'bad');
  msg.textContent = ok ? '' : `HTTP ${status} — ${json?.error || json?.message || 'failed'}`;
  return ok;
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

/* ── image viewer ─────────────────────────────────────────────────────────── */
// Opens FIT to the window; clicking the image toggles 1:1, which is the only way
// to judge whether a render is actually sharp at its stated resolution.
function zoom(src, label) {
  const box = $('zoom');
  const img = $('zoom-img');
  img.src = src;
  img.className = 'fit';
  $('zoom-label').textContent = `${label} · click the image for 1:1 · Esc to close`;
  box.hidden = false;
}

$('zoom-img').onclick = (e) => {
  e.stopPropagation();
  $('zoom-img').classList.toggle('fit');
};
$('zoom').onclick = () => { $('zoom').hidden = true; };
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('zoom').hidden) $('zoom').hidden = true;
});

/* ── nav ──────────────────────────────────────────────────────────── */
function route() {
  const id = (location.hash || '#create').slice(1);
  document.querySelectorAll('main section').forEach((s) => s.classList.toggle('on', s.id === id));
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.hash === '#' + id));
}
addEventListener('hashchange', route);
route();

/* ── health ───────────────────────────────────────────────────────── */
api('/health').then(({ json }) => {
  const ok = json?.status === 'ok';
  $('health').innerHTML = `<span class="pill ${ok ? 'ok' : 'bad'}">${json?.status || 'down'}</span> mongo ${json?.mongo || '?'}`;
});

/* ── settings ─────────────────────────────────────────────────────── */
$('x-secret').value = secret();
$('x-save').onclick = () => {
  localStorage.setItem('cronSecret', $('x-secret').value.trim());
  $('x-msg').className = 'msg ok';
  $('x-msg').textContent = 'saved to this browser';
};

/* ── vocabulary hints on the create form ──────────────────────────── */
// Populated from the scene/keyword data the service already exposes, so the
// datalists cannot drift from what the validator accepts.
const VOCAB = {
  Tiles: {
    look: ['Marble', 'Cement', 'Wood', 'Terrazzo', 'Zellige', 'Stone', 'Fabric', 'Metallic'],
    material: ['Vitrified', 'Ceramic', 'Porcelain', 'Full-body Vitrified', 'Glass'],
    finish: ['Matte', 'Glossy', 'High Gloss', 'Carving Matte', 'Glue Matte'],
  },
  Laminates: {
    look: ['Woodgrain', 'Solid colour', 'Fluted', 'Stone-look', 'Leather', 'Fabric', 'Marble'],
    material: ['Acrylic', 'ASA', 'PVC', 'PETG', 'WPC Fibre'],
    finish: ['Texture', 'High Gloss', 'Suede', 'Matte', 'Glossy'],
  },
  Wallpaper: {
    look: ['Floral', 'Geometric', 'Tropical', 'Plain', 'Mural'],
    material: ['Non-woven', 'PVC', 'Canvas', 'Handmade', 'Soft Feel'],
    finish: [],
  },
  Stone: {
    look: ['Marble', 'Granite', 'Quartz', 'Onyx', 'Travertine'],
    material: ['Natural stone', 'Quartz', 'Sintered stone'],
    finish: ['Polished', 'Honed', 'Leathered', 'Flamed'],
  },
  Panels: {
    look: ['Fluted', 'Leather', 'Woodgrain', 'Stone-look', 'Marble', 'Fabric', 'Solid colour'],
    material: ['PVC', 'WPC', 'Charcoal', 'PU', 'MDF', 'Acrylic'],
    finish: ['Matte', 'Textured', 'Glossy', 'High Gloss', 'Suede'],
  },
};
// "Where to use" choices: the category's rooms from the keyword bank first, then the
// places a surface goes whatever it is. Ticked, not typed — one spelling per place,
// so the storefront's filters do not split "TV Unit" from "Tv unit".
const WHERE = {
  Tiles: ['Bathroom', 'Kitchen', 'Living room', 'Bedroom', 'Balcony', 'Outdoor'],
  Laminates: ['Wardrobe', 'Kitchen shutters', 'Wall panelling'],
  Wallpaper: ['Bedroom', 'Living room', "Children's room"],
  Panels: ['Living room', 'Bedroom', 'Office', 'Hotel', 'Restaurant'],
  Stone: ['Kitchen countertop', 'Vanity top', 'Wall cladding', 'Flooring'],
};
const WHERE_ANY = ['TV Unit', 'Kitchen', 'Wardrobe', 'Bathroom', 'Ceiling', 'Feature wall', 'Furniture', 'Commercial'];
const PACK_DEFAULT = { Tiles: 'box', Laminates: 'sheet', Wallpaper: 'roll', Panels: 'piece', Stone: 'slab' };
// Broad colour groups for "shop by colour". Each has the shade words that imply it, so
// typing "Olive Green" or "Walnut" ticks the group without anyone choosing it.
const FAMILIES = {
  White: /white|ivory|snow|pearl/i, Beige: /beige|cream|sand|ivory|almond|linen/i,
  Grey: /gr[ae]y|slate|ash|silver|charcoal|stone|cement/i, Black: /black|jet|onyx|ebony|charcoal/i,
  Brown: /brown|walnut|oak|teak|wenge|chocolate|coffee|mocha|tan|chestnut|maple|honey/i,
  Green: /green|olive|sage|emerald|mint|moss/i, Blue: /blue|navy|teal|aqua|indigo|denim/i,
  Red: /red|maroon|wine|burgundy|cherry/i, Pink: /pink|rose|blush/i, Yellow: /yellow|mustard|lemon/i,
  Orange: /orange|terracotta|rust|copper|peach/i, Gold: /gold|brass|champagne/i, Multicolour: /multi/i,
};

/** A row of tick-chips. Keeps whatever was ticked that still exists. */
function chips(id, values, checked = []) {
  const keep = new Set([...checked, ...picked(id)]);
  $(id).innerHTML = [...new Set(values)].map((v) =>
    `<label><input type="checkbox" value="${v}"${keep.has(v) ? ' checked' : ''}>${v}</label>`).join('');
}
const picked = (id) => [...$(id).querySelectorAll('input:checked')].map((i) => i.value);

function fillVocab() {
  const cat = $('c-category').value;
  const v = VOCAB[cat] || {};
  for (const k of ['look', 'material', 'finish']) {
    $('l-' + k).innerHTML = (v[k] || []).map((x) => `<option value="${x}">`).join('');
  }
  chips('c-where', [...(WHERE[cat] || []), ...WHERE_ANY]);
  $('c-packUnit').value = PACK_DEFAULT[cat] || 'piece';
  renderPicks();
}

/* ── tap-to-pick: Look / Finish / Material, and feature suggestions ── */
// One value per field: a chip sets the input beside it, the input is the "Other"
// box, and whichever was last touched wins. Same field ids as before, so nothing
// downstream (createBody, autosave) needed to change.
function renderPicks() {
  const v = VOCAB[$('c-category').value] || {};
  document.querySelectorAll('.chips.pick').forEach((box) => {
    const input = $(box.dataset.for);
    const key = box.dataset.for.replace('c-', '');
    box.innerHTML = (v[key] || []).map((x) => `<button type="button" data-v="${x}">${x}</button>`).join('');
    const mark = () => box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === input.value.trim()));
    box.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      input.value = input.value.trim() === b.dataset.v ? '' : b.dataset.v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    input.oninput = mark;
    mark();
  });
  markFeatures();
}

const FEATURE_SUGGESTIONS = [
  'Water Resistant', 'Termite Proof', 'Scratch Resistant', 'Easy to Install', 'Light Weight',
  'Fire Retardant', 'UV Resistant', 'Easy to Clean', 'Flexible', 'Eco-friendly', 'Long Lasting', 'Stain Resistant',
];
const featureBoxes = () => [...document.querySelectorAll('.c-feature')];
function markFeatures() {
  const have = new Set(featureBoxes().map((i) => i.value.trim().toLowerCase()));
  $('c-feature-picks').innerHTML = FEATURE_SUGGESTIONS.map((f) =>
    `<button type="button" data-v="${f}" class="${have.has(f.toLowerCase()) ? 'on' : ''}">${f}</button>`).join('');
}
$('c-feature-picks').onclick = (e) => {
  const f = e.target.closest('button')?.dataset.v;
  if (!f) return;
  const boxes = featureBoxes();
  const existing = boxes.find((i) => i.value.trim().toLowerCase() === f.toLowerCase());
  const empty = boxes.find((i) => !i.value.trim());
  if (existing) existing.value = '';
  else if (empty) empty.value = f;
  else return stepMsg('bad', 'Four features already — clear one to add another');
  empty?.dispatchEvent(new Event('input', { bubbles: true }));
  existing?.dispatchEvent(new Event('input', { bubbles: true }));
};
featureBoxes().forEach((i) => i.addEventListener('input', markFeatures));
chips('c-family', Object.keys(FAMILIES));
function autoFamily() {
  const names = colours.map(colourName).join(' ');
  chips('c-family', Object.keys(FAMILIES), Object.keys(FAMILIES).filter((f) => FAMILIES[f].test(names)));
}
$('c-category').onchange = fillVocab;
fillVocab();

/* ── create product ───────────────────────────────────────────────── */
// Photos are staged in Shopify the moment they are chosen, so Create only sends
// URLs. Each image: { src (data URL, for the thumb and the shots), url (staged),
// role, status: 'up' | 'ok' | 'err', shot (true when generated here) }.
const colours = [];
let colourSeq = 0;

const readDataUrl = (file) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = () => fail(r.error);
  r.readAsDataURL(file);
});

async function stage(c, im) {
  im.status = 'up';
  renderThumbs(c);
  const r = await api('/api/products/images/stage', { method: 'POST', body: { data: im.src, filename: im.name || 'image.jpg' } });
  Object.assign(im, r.ok ? { url: r.json.url, status: 'ok' } : { status: 'err', err: r.json?.error || `HTTP ${r.status}` });
  renderThumbs(c);
}

function renderThumbs(c) {
  c.el.querySelector('.thumbs').innerHTML = c.images.map((im, i) => `
    <figure class="${im.status}">
      <img src="${im.src}" data-i="${i}" alt="">
      <figcaption>${i === 0 ? '<b>main</b> · ' : ''}${im.status === 'up' ? 'uploading…' : im.status === 'err' ? im.err : im.role || (im.extra ? 'extra' : 'photo')}</figcaption>
      ${i && !im.extra && !im.shot ? `<button data-main="${i}" title="make main image">★</button>` : ''}<button data-del="${i}" title="remove">✕</button>
    </figure>`).join('');
}

/**
 * A colour's two pickers and its thumbnail strip. Order within a colour is fixed:
 *   photos (the first is the main image AND the swatch the shots are made from)
 *   → generated shots → extras (room / installation shots: shown, never the swatch)
 */
const firstOf = (c, test) => { const i = c.images.findIndex(test); return i < 0 ? c.images.length : i; };

function wirePhotos(c) {
  c.el.querySelectorAll('input[type=file]').forEach((input) => {
    const isExtra = input.dataset.kind === 'extra';
    input.onchange = async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      const added = await Promise.all(files.map(async (f) => ({ src: await readDataUrl(f), name: f.name, extra: isExtra })));
      if (isExtra) c.images.push(...added);
      else c.images.splice(firstOf(c, (im) => im.shot || im.extra), 0, ...added);
      await Promise.all(added.map((im) => stage(c, im)));
      if (!isExtra) {
        try { await makeShots(c); } catch (err) { say('bad', err.message); }
      }
    };
  });
  c.el.querySelector('.thumbs').onclick = (e) => {
    const { del, main, i } = e.target.dataset;
    if (del != null) c.images.splice(Number(del), 1);
    else if (main != null) c.images.unshift(...c.images.splice(Number(main), 1));
    else if (i != null) return zoom(c.images[i].src, c.images[i].role || 'photo');
    else return;
    renderThumbs(c);
  };
}

function addColour() {
  const c = { id: ++colourSeq, images: [], el: document.createElement('div') };
  c.el.className = 'colour';
  c.el.innerHTML = `
    <div class="head">
      <input type="text" class="c-colour-name" placeholder="Colour name — e.g. Walnut">
      <label style="margin:0">Photos <input type="file" accept="image/jpeg,image/png,image/webp" multiple style="width:auto"></label>
      <label style="margin:0">+ Extra images <input type="file" data-kind="extra" accept="image/jpeg,image/png,image/webp" multiple style="width:auto"></label>
      <button class="rm">Remove colour</button>
    </div>
    <div class="thumbs"></div>`;
  wirePhotos(c);
  c.el.querySelector('.c-colour-name').onchange = autoFamily;
  c.el.querySelector('.rm').onclick = () => {
    colours.splice(colours.indexOf(c), 1);
    c.el.remove();
  };
  colours.push(c);
  $('c-colours').append(c.el);
}

/**
 * Sq ft one pack covers, in the browser, so ₹/sq ft and the pack price can fill each
 * other as you type. The same rule productCreate applies on the server: a typed
 * coverage wins, else pieces × the size (no unit and small numbers = feet, "8X4").
 */
const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, ft: 304.8, feet: 304.8 };
function packSqFt(tr) {
  const typed = nval(tr, '.s-cover');
  if (typed > 0) return typed;
  const m = val(tr, '.s-size').match(/(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in|feet|ft)?\s*[x×X*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in|feet|ft)?/i);
  if (!m) return 0;
  const [w, h] = [Number(m[1]), Number(m[3])];
  const k = UNIT_MM[(m[4] || m[2] || (Math.max(w, h) <= 20 ? 'ft' : 'mm')).toLowerCase()] || 1;
  return Math.round((nval(tr, '.s-pieces') || 1) * w * k * h * k / 92903.04 * 10) / 10;
}

function addSize() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="s-size" placeholder="8X4 or 2440 x 1220 mm"></td>
    <td><input class="s-rate" type="number" step="0.01" placeholder="47"></td>
    <td><input class="s-price" type="number" placeholder="1500"></td>
    <td><input class="s-mrp" type="number" placeholder="2100"></td>
    <td><input class="s-pieces" type="number" placeholder="1"></td>
    <td><input class="s-cover" type="number" step="0.01" placeholder="auto"></td>
    <td><button title="remove">✕</button></td>`;
  // Whichever price was typed last drives the other. Pack prices are whole rupees,
  // as the server rounds them; the rate shown is that rounded price ÷ coverage.
  let lead = 'price';
  const sync = () => {
    const cover = packSqFt(tr);
    tr.querySelector('.s-cover').placeholder = cover ? `${cover} (auto)` : 'auto';
    if (!cover) return;
    if (lead === 'rate' && nval(tr, '.s-rate') > 0) {
      tr.querySelector('.s-price').value = Math.round(nval(tr, '.s-rate') * cover);
    } else if (lead === 'price' && nval(tr, '.s-price') > 0) {
      tr.querySelector('.s-rate').value = (nval(tr, '.s-price') / cover).toFixed(2);
    }
  };
  tr.querySelector('.s-rate').oninput = () => { lead = 'rate'; sync(); };
  tr.querySelector('.s-price').oninput = () => { lead = 'price'; sync(); };
  for (const cls of ['.s-size', '.s-pieces', '.s-cover']) tr.querySelector(cls).oninput = sync;
  tr.querySelector('button').onclick = () => tr.remove();
  $('c-sizes').querySelector('tbody').append(tr);
}

$('c-add-size').onclick = addSize;
$('c-add-colour').onclick = addColour;
addSize();
addColour();

const val = (el, sel) => el.querySelector(sel).value.trim();
const nval = (el, sel) => (val(el, sel) === '' ? undefined : Number(val(el, sel)));
const features = () => [...document.querySelectorAll('.c-feature')].map((i) => i.value.trim()).filter(Boolean);
const colourName = (c) => c.el.querySelector('.c-colour-name').value.trim();
const sizeRows = () => [...$('c-sizes').querySelectorAll('tbody tr')].filter((tr) => val(tr, '.s-size') || val(tr, '.s-price'));
/* ── SKU: CATEGORY-PRODUCT-SIZE-COLOUR-FINISH ───────────────────────── */
// e.g. LAM-LTHR01-8X4-OLVGRN-MAT. Short codes: readable on a label or an invoice.
const CAT_CODE = { Panels: 'PNL', Laminates: 'LAM', Tiles: 'TIL', Wallpaper: 'WAL', Stone: 'STN' };
const FINISH_CODE = {
  matte: 'MAT', matt: 'MAT', glossy: 'GLS', gloss: 'GLS', 'high gloss': 'HGL', textured: 'TEX', texture: 'TEX',
  suede: 'SUD', satin: 'SAT', polished: 'POL', honed: 'HON', leathered: 'LTH', velvet: 'VLV', metallic: 'MTL',
  'carving matte': 'CMT', 'glue matte': 'GMT', flamed: 'FLM',
};
const letters = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim();
// First letter + the consonants after it: OLIVE -> OLV, CARRARA -> CRR, CHARCOAL -> CHRCL.
const squeeze = (w, n) => (w[0] + w.slice(1).replace(/[AEIOU]/g, '')).slice(0, n);
function colourCode(name) {
  const words = letters(name).split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].length <= 6 ? words[0] : squeeze(words[0], 6);
  return words.map((w) => squeeze(w, 3)).join('').slice(0, 9);
}
const finishCode = (f) => FINISH_CODE[String(f || '').trim().toLowerCase()] || (f ? squeeze(letters(f).replace(/\s+/g, ''), 3) : '');
// "2440 x 1220 mm" -> 2440X1220, "8 ft x 4 ft" -> 8X4.
const sizeCode = (s) => String(s || '').toUpperCase().replace(/×/g, 'X').replace(/\b(MM|CM|M|FT|FEET|IN|INCH)\b/g, '').replace(/[^0-9X.]/g, '');
function skuFor(size, colour) {
  return [CAT_CODE[$('c-category').value], letters(str('c-sku')).replace(/\s+/g, ''), sizeCode(size), colour && colourCode(colour), finishCode(str('c-finish'))]
    .filter(Boolean).join('-');
}
function showSkuExample() {
  const size = sizeRows().map((tr) => val(tr, '.s-size'))[0] || '8X4';
  const colour = colours.map(colourName).find(Boolean) || 'Olive Green';
  $('c-sku-eg').textContent = str('c-sku') ? skuFor(size, colour) : `${CAT_CODE[$('c-category').value]}-YOURCODE-…`;
}
$('create').addEventListener('input', showSkuExample);
$('create').addEventListener('change', showSkuExample);

function createBody() {
  const sizes = sizeRows().map((tr, i) => ({
    i, sizeLabel: val(tr, '.s-size') || undefined, price: nval(tr, '.s-price'),
    compareAtPrice: nval(tr, '.s-mrp'), piecesPerPack: nval(tr, '.s-pieces'), coveragePerPack: nval(tr, '.s-cover'),
  }));
  const named = colours.filter(colourName);
  const variants = (sizes.length ? sizes : [{ i: 0 }]).flatMap((s) =>
    (named.length ? named : [null]).map((c) => ({
      ...s, i: undefined,
      colour: c ? colourName(c) : undefined,
      sku: str('c-sku') ? skuFor(s.sizeLabel, c && colourName(c)) : undefined,
      quantity: num('c-quantity'),
    })));
  // Two colours can shorten to the same code ("Dark Green" / "Dark Grain"): number the
  // repeats rather than send Shopify two variants with one SKU.
  const seen = {};
  for (const v of variants) {
    if (!v.sku) continue;
    seen[v.sku] = (seen[v.sku] || 0) + 1;
    if (seen[v.sku] > 1) v.sku += `-${seen[v.sku]}`;
  }
  // A blank-named colour is the single-colour case: its photos belong to everyone.
  const images = [
    ...colours.flatMap((c) => c.images.filter((im) => im.url)
      .map((im, j) => ({
        url: im.url,
        role: im.role || (j ? `photo ${j + 1}` : 'main photo'),
        colour: named.length ? colourName(c) || undefined : undefined,
        // Set on size drawings only: that image belongs to this colour's variants of that size.
        size: im.size,
      }))),
  ];
  return {
    category: $('c-category').value, title: str('c-title'),
    // The code alone, for the title and URL -- the full SKUs are per variant.
    productCode: str('c-sku') ? letters(str('c-sku')).replace(/\s+/g, '') : undefined,
    finish: str('c-finish'), look: str('c-look'), material: str('c-material'),
    thicknessMm: num('c-thicknessMm'), applications: [...picked('c-where'), ...list('c-where-other')],
    flexibility: str('c-flexibility'), colourFamily: picked('c-family'),
    features: features(), installCaveats: lines('c-installCaveats'),
    series: str('c-series'), surface: list('c-surface'), pattern: str('c-pattern'),
    useCases: list('c-useCases'), slipRating: str('c-slipRating'),
    designVariants: num('c-designVariants'), samplePrice: num('c-samplePrice'),
    packUnit: str('c-packUnit'), // price_unit: always the category's — see applyPriceUnit
    descriptionHtml: str('c-description'),
    installationGuide: str('c-installationGuide'), careMaintenance: str('c-careMaintenance'),
    variants, images,
  };
}

/**
 * Images made from a colour's main photo, by the flat templates — no model call, a
 * second or two each. Made as soon as photos are added, and remade on Preview only
 * when the main photo, the chosen kinds or the attributes drawn on them have changed.
 */
const SHOT_KINDS = {
  studio: 'studio shot', thickness: 'thickness detail', features: 'features',
  isometric: 'size & dimensions', grout_grid: 'laid pattern', repeat_preview: 'pattern repeat',
};
chips('c-shot-kinds', Object.keys(SHOT_KINDS), ['studio', 'thickness', 'features', 'isometric']);
$('c-shot-kinds').querySelectorAll('label').forEach((l) => {
  l.lastChild.textContent = SHOT_KINDS[l.querySelector('input').value];
});

async function makeShots(c) {
  const photo = c.images.find((im) => !im.shot && !im.extra);
  const picks = picked('c-shot-kinds');
  const kinds = picks.filter((id) => id !== 'isometric');
  // Size drawings: one per SIZE, in THIS colour (user, 2026-10-19) -- Blue's 8X4 drawing shows
  // the blue panel. Each is sent with its colour AND its size, and the server links it to that
  // colour's variants of that size only (galleryFor), so 10X4 / Blue shows Blue's 10X4 drawing.
  const sizes = picks.includes('isometric')
    ? [...new Set(sizeRows().map((tr) => val(tr, '.s-size')).filter(Boolean))]
    : [];
  const key = photo && JSON.stringify([photo.src.length, photo.src.slice(-64), picks, features(), num('c-thicknessMm'), sizes, $('c-category').value]);
  if (c.shotKey === key) return;
  c.images = c.images.filter((im) => !im.shot);
  c.shotKey = key;
  renderThumbs(c);
  if (!photo || (!kinds.length && !sizes.length)) return;
  say('', `making images for ${colourName(c) || 'your photos'}…`);
  const ask = (only, sizeLabel) => api('/api/products/images/templates', {
    method: 'POST',
    body: {
      photo: photo.src.split(',')[1], size: 2048, features: features(), sizeLabel,
      thicknessMm: num('c-thicknessMm'), category: $('c-category').value, only,
    },
  });
  const [main, ...bySize] = await Promise.all([
    kinds.length ? ask(kinds, sizes[0]) : null,
    ...sizes.map((sz) => ask(['isometric'], sz)),
  ]);
  if (main && !main.ok) throw new Error(`images for ${colourName(c) || 'photos'}: ${main.json?.error || main.status}`);
  const made = main?.json?.images || {};
  const shots = [
    ...kinds.filter((id) => made[id])
      .map((id) => ({ src: `data:image/jpeg;base64,${made[id]}`, role: SHOT_KINDS[id], shot: true, name: `${id}.jpg` })),
    ...sizes.map((sz, i) => [sz, bySize[i]?.json?.images?.isometric]).filter(([, b64]) => b64)
      .map(([sz, b64]) => ({ src: `data:image/jpeg;base64,${b64}`, role: `size & dimensions – ${sz}`, size: sz, shot: true, name: 'size.jpg' })),
  ];
  c.images.splice(firstOf(c, (im) => im.extra), 0, ...shots);
  // Say which image could not be made, rather than leaving a colour quietly one short.
  const failed = [
    ...kinds.filter((id) => !made[id] && !(id === 'features' && !features().length)).map((id) => SHOT_KINDS[id]),
    ...sizes.filter((sz, i) => !bySize[i]?.json?.images?.isometric).map((sz) => `size drawing ${sz}`),
  ];
  say(failed.length ? 'bad' : '', failed.length
    ? `Couldn't make ${failed.join(', ')} for ${colourName(c) || 'this colour'} — try another main photo`
    : '');
  await Promise.all(shots.map((im) => stage(c, im)));
}

function renderDerived(el, d, extra = []) {
  const rows = [
    ...extra,
    ['Title', d.title],
    ['Meta title', `${d.seoTitle} <span class="hint">${d.seoTitle.length} chars</span>`],
    ['Meta description', `${d.seoDescription} <span class="hint">${d.seoDescription.length} chars</span>`],
  ];
  el.innerHTML = `<dl class="derived">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function renderWarnings(el, warnings) {
  if (!warnings || !warnings.length) return;
  el.insertAdjacentHTML('beforeend', `<div class="note warn"><strong>Check these:</strong><br>${warnings.join('<br>')}</div>`);
}

// Status goes to the Review line AND the wizard's own line, so a message raised while
// on another step ("making images…") is seen where the person is.
const say = (cls, text) => {
  for (const id of ['c-msg', 'c-step-msg']) { $(id).className = 'msg ' + cls; $(id).textContent = text; }
};

$('c-describe').onclick = () => busy($('c-describe'), async () => {
  $('c-describe-msg').className = 'msg'; $('c-describe-msg').textContent = 'writing…';
  const b = createBody();
  const r = await api('/api/products/describe', {
    method: 'POST',
    body: { ...b, sizes: b.variants.map((v) => v.sizeLabel).filter(Boolean), colours: [...new Set(b.variants.map((v) => v.colour).filter(Boolean))] },
  });
  if (!r.ok) { $('c-describe-msg').className = 'msg bad'; $('c-describe-msg').textContent = r.json?.error || `HTTP ${r.status}`; return; }
  $('c-description').value = r.json.copy.descriptionHtml;
  $('c-installationGuide').value = r.json.copy.installationGuide || '';
  $('c-careMaintenance').value = r.json.copy.careMaintenance || '';
  $('c-describe-msg').className = 'msg ok'; $('c-describe-msg').textContent = 'drafted — edit freely; installation and care text were written too';
});

$('c-preview').onclick = () => busy($('c-preview'), async () => {
  $('c-apply').disabled = true;
  try {
    say('', 'building shots…');
    for (const c of colours) await makeShots(c);
  } catch (err) { return say('bad', err.message); }
  const all = colours.flatMap((c) => c.images);
  if (all.some((im) => im.status === 'up')) return say('bad', 'photos are still uploading — try again in a moment');
  if (all.some((im) => im.status === 'err')) return say('bad', 'some photos failed to upload — remove them (✕) or re-add');
  if (!all.length) return say('bad', 'add at least one photo');

  const body = createBody();
  const r = await api('/api/products/create', { method: 'POST', body });
  if (!show('c-msg', 'c-out', r)) return;
  $('c-out').hidden = true;
  const vs = r.json.productSet.variants.length;
  // Per variant: what Shopify will get, including the coverage worked out from the size.
  const variantRows = r.json.productSet.variants.map((v) => {
    const cover = Number(v.metafields.find((m) => m.key === 'coverage_per_pack')?.value) || 0;
    return `<tr><td>${(v.optionValues || []).map((o) => o.name).join(' / ') || 'Default'}</td><td>${v.sku || ''}</td>
      <td class="num">₹${v.price}</td><td class="num">${cover ? `${cover} sq ft` : '—'}</td>
      <td class="num">${cover ? `₹${(v.price / cover).toFixed(1)}` : '—'}</td></tr>`;
  }).join('');
  renderDerived($('c-derived'), r.json.derived, [
    ['Will create', `${vs} variant${vs > 1 ? 's' : ''} · ${body.images.length} images, every one with alt text
      <table><tr><th>Variant</th><th>SKU</th><th>Price</th><th>Covers</th><th>₹ / sq ft</th></tr>${variantRows}</table>`],
    ['Alt text, e.g.', r.json.productSet.files?.[0]?.alt],
  ]);
  renderWarnings($('c-derived'), r.json.warnings);
  $('c-apply').disabled = false;
  say('ok', 'previewed — nothing written yet');
});

$('c-apply').onclick = () => busy($('c-apply'), async () => {
  say('', 'creating…');
  const r = await api('/api/products/create?apply=1', { method: 'POST', body: createBody() });
  if (!show('c-msg', 'c-out', r)) return;
  $('c-out').hidden = true;
  const p = r.json.product;
  renderDerived($('c-derived'), r.json.derived, [
    ['Created', `<span class="pill warn">${p.status}</span> <code>${p.handle}</code> ·
      <a href="${r.json.adminUrl}" target="_blank">open in Shopify</a>
      ${p.onlineStorePreviewUrl ? `· <a href="${p.onlineStorePreviewUrl}" target="_blank">preview on store</a>` : ''}`],
    ['Publish', `<button id="c-publish" class="primary">Publish to Online Store</button> <span id="c-pub-msg" class="msg"></span>`],
  ]);
  renderWarnings($('c-derived'), r.json.warnings);
  $('c-publish').onclick = () => busy($('c-publish'), async () => {
    const pr = await api(`/api/products/${p.id.split('/').pop()}/publish`, { method: 'POST', body: {} });
    $('c-pub-msg').className = 'msg ' + (pr.ok ? 'ok' : 'bad');
    $('c-pub-msg').innerHTML = pr.ok
      ? 'live ✓'
      : `${pr.json?.error || pr.status}${(pr.json?.gates || []).map((g) => `<br>· ${g.message || g.key || JSON.stringify(g)}`).join('')}`;
  });
  $('c-apply').disabled = true;
  say('ok', 'created as draft');
  $('s-handle').value = p.handle;
  $('i-product').value = p.id.split('/').pop();
});

/* ── wizard: one step at a time ──────────────────────────────────── */
// The six .step blocks in index.html; the bar is built from their titles. Next checks
// only what that step needs, in plain words; the bar lets anyone jump anywhere, and
// Create still runs every server-side check whatever route was taken to it.
const steps = [...document.querySelectorAll('#create .step')];
let stepAt = 0;
const stepMsg = (cls, text) => { $('c-step-msg').className = 'msg ' + cls; $('c-step-msg').textContent = text; };

async function stepProblem(i) {
  if (i === 0) {
    if (!str('c-sku')) return 'Add a product code — it makes every SKU unique (e.g. LTHR01)';
    const prefix = `${CAT_CODE[$('c-category').value]}-${letters(str('c-sku')).replace(/\s+/g, '')}-`;
    const r = await api(`/api/products/sku-taken?prefix=${encodeURIComponent(prefix)}`);
    const t = r.json?.taken?.[0];
    if (t) return `${prefix}… is already used by “${t.product.slice(0, 50)}” — pick another product code`;
  }
  if (i === 3) {
    const rows = sizeRows();
    if (!rows.length) return 'Add at least one size with its price';
    const unpriced = rows.find((tr) => !(nval(tr, '.s-price') > 0));
    if (unpriced) return `Add a price for ${val(unpriced, '.s-size') || 'every size'}`;
  }
  if (i === 4) {
    const imgs = colours.flatMap((c) => c.images);
    if (colours.length > 1 && colours.some((c) => !colourName(c))) return 'Name every colour — or remove the empty one';
    if (!imgs.length) return 'Add at least one photo';
    if (imgs.some((im) => im.status === 'up')) return 'Photos are still uploading — one moment';
    if (imgs.some((im) => im.status === 'err')) return 'A photo failed to upload — remove it (✕) and add it again';
  }
  return null;
}

function go(i) {
  stepAt = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((el, n) => el.classList.toggle('on', n === stepAt));
  $('c-steps').innerHTML = steps.map((el, n) =>
    `<li data-n="${n}" class="${n === stepAt ? 'on' : n < stepAt ? 'done' : ''}">${el.dataset.title}</li>`).join('');
  $('c-back').disabled = stepAt === 0;
  $('c-next').hidden = stepAt === steps.length - 1;
  stepMsg('', '');
  // Arriving at Review builds the preview — the step exists to show what will be created.
  if (stepAt === steps.length - 1) $('c-preview').click();
  saveDraft();
}
$('c-steps').onclick = (e) => { const n = e.target.closest('li')?.dataset.n; if (n != null) go(Number(n)); };
$('c-back').onclick = () => go(stepAt - 1);
$('c-next').onclick = () => busy($('c-next'), async () => {
  const problem = await stepProblem(stepAt);
  if (problem) return stepMsg('bad', problem);
  go(stepAt + 1);
});

/* ── start from a similar product ───────────────────────────────────── */
let similarTimer;
let similarFound = [];
$('c-similar').oninput = () => {
  clearTimeout(similarTimer);
  similarTimer = setTimeout(async () => {
    const q = $('c-similar').value.trim();
    if (q.length < 2) { $('c-similar-list').innerHTML = ''; return; }
    const r = await api(`/api/products/similar?q=${encodeURIComponent(q)}`);
    similarFound = r.json?.products || [];
    $('c-similar-list').innerHTML = similarFound.length
      ? similarFound.map((p, i) => `<button type="button" data-i="${i}" title="${p.title.replace(/"/g, '&quot;')}">
          ${p.image ? `<img src="${p.image}&width=80" alt="">` : ''}<span>${p.title}</span></button>`).join('')
      : '<span class="hint">No match — try another word</span>';
  }, 300);
};
$('c-similar-list').onclick = (e) => {
  const p = similarFound[e.target.closest('button')?.dataset.i];
  if (!p) return;
  applyFields(p.fields);
  $('c-similar-list').innerHTML = `<span class="msg ok" style="margin:0">Copied from “${p.title.slice(0, 60)}” — check each step, then add your colours &amp; photos.</span>`;
  saveDraft();
};

/** Fill the form from a field bag — a similar product's, or a saved draft's. */
function applyFields(f) {
  const set = (id, v) => { if (v != null && $(id)) $(id).value = Array.isArray(v) ? v.join('\n') : v; };
  if (f.category && [...$('c-category').options].some((o) => o.value === f.category)) {
    $('c-category').value = f.category;
    fillVocab();
  }
  ['look', 'finish', 'material', 'thicknessMm', 'flexibility', 'series', 'pattern', 'slipRating',
    'installCaveats', 'careMaintenance', 'installationGuide', 'packUnit'].forEach((k) => set('c-' + k, f[k]));
  set('c-surface', (f.surface || []).join(', '));
  set('c-useCases', (f.useCases || []).join(', '));
  featureBoxes().forEach((box, i) => { box.value = (f.features || [])[i] || ''; });
  const known = [...$('c-where').querySelectorAll('input')].map((i) => i.value);
  $('c-where').querySelectorAll('input').forEach((i) => { i.checked = (f.applications || []).includes(i.value); });
  set('c-where-other', (f.applications || []).filter((a) => !known.includes(a)).join(', '));
  if (f.sizes?.length) {
    $('c-sizes').querySelector('tbody').innerHTML = '';
    for (const z of f.sizes) {
      addSize();
      const tr = [...$('c-sizes').querySelectorAll('tbody tr')].pop();
      tr.querySelector('.s-size').value = z.sizeLabel || '';
      tr.querySelector('.s-mrp').value = z.compareAtPrice || '';
      tr.querySelector('.s-pieces').value = z.piecesPerPack || '';
      tr.querySelector('.s-price').value = z.price || '';
      tr.querySelector('.s-price').dispatchEvent(new Event('input')); // fills ₹/sq ft
    }
  }
  renderPicks();
}

/* ── autosave ───────────────────────────────────────────────────────── */
// Typed fields only, in this browser. Photos are not kept: they are megabytes each,
// and the staged uploads they point at expire anyway.
const DRAFT_KEY = 'material-admin:add-product-draft';
let saveTimer;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const fields = {};
    document.querySelectorAll('#create [id^="c-"]').forEach((el) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'file' && el.id !== 'c-similar') fields[el.id] = el.value;
    });
    const draft = {
      step: stepAt, fields,
      features: featureBoxes().map((i) => i.value),
      where: picked('c-where'), family: picked('c-family'), shots: picked('c-shot-kinds'),
      sizes: [...$('c-sizes').querySelectorAll('tbody tr')].map((tr) =>
        ['.s-size', '.s-rate', '.s-price', '.s-mrp', '.s-pieces', '.s-cover'].map((c) => tr.querySelector(c).value)),
      colours: colours.map(colourName),
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { return; }
    $('c-saved').textContent = 'Draft saved · photos aren’t kept';
  }, 400);
}
$('create').addEventListener('input', saveDraft);
$('create').addEventListener('change', saveDraft);

function restoreDraft() {
  let d;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { d = null; }
  if (!d) return null;
  if (d.fields['c-category']) { $('c-category').value = d.fields['c-category']; fillVocab(); }
  for (const [id, v] of Object.entries(d.fields)) if ($(id) && id !== 'c-category') $(id).value = v;
  featureBoxes().forEach((box, i) => { box.value = d.features?.[i] || ''; });
  for (const [id, vals] of [['c-where', d.where], ['c-family', d.family], ['c-shot-kinds', d.shots]]) {
    $(id).querySelectorAll('input').forEach((i) => { i.checked = (vals || []).includes(i.value); });
  }
  if (d.sizes?.length) {
    $('c-sizes').querySelector('tbody').innerHTML = '';
    for (const row of d.sizes) {
      addSize();
      const tr = [...$('c-sizes').querySelectorAll('tbody tr')].pop();
      ['.s-size', '.s-rate', '.s-price', '.s-mrp', '.s-pieces', '.s-cover'].forEach((c, i) => { tr.querySelector(c).value = row[i] || ''; });
    }
  }
  while (colours.length < (d.colours?.length || 0)) addColour();
  (d.colours || []).forEach((name, i) => { colours[i].el.querySelector('.c-colour-name').value = name; });
  renderPicks();
  // Photos are not in the draft, so never resume past the step that takes them.
  stepAt = Math.min(d.step || 0, 4);
  return 'Draft restored — add the photos again';
}

$('c-reset').onclick = () => {
  const b = $('c-reset');
  if (b.dataset.armed) {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
    location.reload();
    return;
  }
  b.dataset.armed = '1';
  b.textContent = 'Sure? Click again';
  setTimeout(() => { delete b.dataset.armed; b.textContent = 'Start over'; }, 3000);
};

const restored = restoreDraft();
go(stepAt);
if (restored) stepMsg('ok', restored);
showSkuExample();

/* ── SEO audit ────────────────────────────────────────────────────── */
const band = (s) => (s >= 80 ? 'ok' : s >= 50 ? 'warn' : 'bad');

$('a-run').onclick = () => busy($('a-run'), async () => {
  const r = await api(`/api/seo/audit?kind=${$('a-kind').value}`);
  if (!show('a-msg', null, r)) return;
  const d = r.json;
  $('a-summary').innerHTML = `<div class="note">Scanned <strong>${d.scanned}</strong>,
    average score <strong>${d.averageScore}</strong> —
    ${Object.entries(d.byReadiness).map(([k, v]) => `${v} ${k}`).join(', ')}</div>`;

  const rows = [...d.results].sort((a, b) => a.score - b.score);
  $('a-table').innerHTML = `<table>
    <tr><th class="num">Score</th><th>Handle</th><th>Readiness</th><th>Missing</th></tr>
    ${rows.map((x) => `<tr class="click" data-h="${x.handle}">
      <td class="num"><span class="pill ${band(x.score)}">${x.score}</span></td>
      <td><code>${x.handle}</code></td>
      <td>${x.readiness}</td>
      <td class="hint">${(x.issues || []).map((i) => i.label || i.id).join(', ')}</td>
    </tr>`).join('')}</table>`;

  $('a-table').querySelectorAll('tr.click').forEach((tr) => {
    tr.onclick = () => { $('s-handle').value = tr.dataset.h; location.hash = '#seo'; };
  });
});

/* ── SEO copy ─────────────────────────────────────────────────────── */
$('s-gen').onclick = () => busy($('s-gen'), async () => {
  const r = await api('/api/seo/generate', {
    method: 'POST',
    body: { handle: $('s-handle').value.trim(), kind: $('s-kind').value, ai: $('s-ai').checked },
  });
  if (!show('s-msg', 's-out', r)) { $('s-apply').disabled = true; return; }
  const c = r.json.copy;
  renderDerived($('s-derived'), {
    title: c.derivedTitle, seoTitle: c.seoTitle, seoDescription: c.seoDescription, keywords: c.keywords,
  });
  $('s-apply').disabled = false;
  $('s-msg').textContent = `source: ${c.source}${r.json.llmConfigured ? '' : ' — no model key set'}`;
});

$('s-apply').onclick = () => busy($('s-apply'), async () => {
  const r = await api('/api/seo/apply', {
    method: 'POST',
    body: { handle: $('s-handle').value.trim(), kind: $('s-kind').value, ai: $('s-ai').checked },
  });
  if (show('s-msg', 's-out', r)) $('s-msg').textContent = 'applied to Shopify';
});

/* ── images ───────────────────────────────────────────────────────── */
api('/api/products/images/scenes').then(({ json }) => {
  if (!json) return;
  const byCat = json.categories || {};
  const meta = Object.fromEntries((json.scenes || []).map((s) => [s.id, s]));
  const draw = () => {
    const ids = byCat[$('i-category').value.toLowerCase()] || byCat.default || [];
    $('i-scenes').innerHTML = `<h3>Scenes for this category</h3>` + ids.map((id) => `
      <label style="display:block;margin:3px 0">
        <input type="checkbox" class="scene" value="${id}" checked style="width:auto">
        ${meta[id]?.label || id}
        ${meta[id]?.composited ? '<span class="pill off">needs sharp</span>' : ''}
        <span class="hint">${(meta[id]?.hint || '').slice(0, 90)}…</span>
      </label>`).join('');
  };
  $('i-category').onchange = draw;
  draw();
});

const asBase64 = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  // strip the data: prefix — the pipeline wants raw base64
  fr.onload = () => res(String(fr.result).split(',')[1]);
  fr.onerror = rej;
  fr.readAsDataURL(file);
});

$('i-run').onclick = () => busy($('i-run'), async () => {
  const files = [...$('i-files').files];
  if (!files.length) {
    $('i-msg').className = 'msg bad';
    $('i-msg').textContent = 'pick at least one supplier photo';
    return;
  }
  $('i-msg').className = 'msg';
  $('i-msg').textContent = 'generating — this takes minutes, one model call per scene…';
  const r = await api('/api/products/images/generate', {
    method: 'POST',
    body: {
      productId: $('i-product').value.trim(),
      category: $('i-category').value,
      productImages: await Promise.all(files.map(asBase64)),
      selectedScenes: [...document.querySelectorAll('.scene:checked')].map((c) => c.value),
    },
  });
  if (show('i-msg', 'i-out', r)) $('i-msg').textContent = 'done';
});

/* ── templates ────────────────────────────────────────────────────── */
// Every image derivable from one flat swatch. No model call, so this is a
// round-trip of milliseconds and the button need not warn about waiting.
const TPL_LABELS = {
  isometric: 'Size shot — isometric + dimensions',
  thickness: 'Thickness callout',
  grout_grid: 'Laid floor — with grout',
  repeat_preview: 'Pattern repeat — seams shown',
  scale_reference: 'Scale bar overlay',
  features: 'Features — zoom + callouts',
};

$('t-feat-on').onchange = () => { $('t-feat').hidden = !$('t-feat-on').checked; };

$('t-run').onclick = () => busy($('t-run'), async () => {
  const photo = await swatchB64('t-file');
  if (!photo) {
    $('t-msg').className = 'msg bad';
    $('t-msg').textContent = 'pick a swatch photo, or rectify one in Rectify a photo';
    return;
  }
  $('t-msg').className = 'msg';
  $('t-msg').textContent = 'compositing…';

  const r = await api('/api/products/images/templates', {
    method: 'POST',
    body: {
      photo,
      sizeLabel: $('t-size').value.trim(),
      thicknessMm: num('t-thick'),
      material: $('t-material').value,
      category: $('t-category').value,
      size: num('t-outsize'),
      cols: Number($('t-cols').value),
      repeats: Number($('t-cols').value),
      features: $('t-feat-on').checked
        ? [...document.querySelectorAll('.t-feat-in')].map((i) => i.value.trim()).filter(Boolean)
        : [],
    },
  });
  if (!show('t-msg', 't-out', r)) return;

  const { images = {}, errors = {}, ms, size, requested, capped, source } = r.json;
  // Filename carries the spec, so a folder of these is still readable next week.
  const slug = ($('t-size').value.trim() || 'unsized').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  // No <a href="data:..."> to open the full size: browsers BLOCK top-level
  // navigation to data: URLs, so that link could only ever do nothing. (A download
  // from a data: URL is still allowed, which is why the one below works.) The
  // viewer is an in-page overlay instead — no navigation, nothing to block.
  $('t-out-imgs').innerHTML = Object.entries(images).map(([id, b64]) => {
    const href = `data:image/jpeg;base64,${b64}`;
    return `
    <figure>
      <img src="${href}" alt="${TPL_LABELS[id] || id}" data-full="${href}"
           title="click to inspect at full size">
      <figcaption>
        <span>${TPL_LABELS[id] || id}</span>
        <a class="dl" href="${href}" download="${id}-${slug}.jpg">Download</a>
      </figcaption>
    </figure>`;
  }).join('');

  $('t-out-imgs').querySelectorAll('img[data-full]').forEach((im) => {
    im.onclick = () => zoom(im.dataset.full, `${size}px`);
  });

  const failed = Object.keys(errors);
  $('t-msg').className = 'msg ' + (failed.length ? 'bad' : 'ok');
  $('t-msg').textContent = `${Object.keys(images).length} built at ${size}px in ${ms} ms · $0.00`
    + (failed.length ? ` — failed: ${failed.map((k) => `${k} (${errors[k]})`).join(', ')}` : '');

  // The cap is about the PHOTO, so say that rather than showing a smaller image
  // and letting it look like the templates got worse.
  $('t-derived').innerHTML = (rectified ? '' : '') + (capped
    ? `<div class="note warn">Rendered at <strong>${size}px</strong>, not the ${requested}px you asked for —
       your photo is ${source}. Upscaling past that adds bytes, not detail.
       For ${requested}px output, supply a swatch of about
       ${Math.ceil(requested * 0.66 / 1.2)}px or more.</div>`
    : `<div class="note">Rendered at <strong>${size}px</strong> from a ${source} photo.</div>`);
  // The JSON dump is base64 payloads here; the images above are the readable form.
  $('t-out').hidden = true;
});

/* ── studio shot, 3D ──────────────────────────────────────────────────────── */
// One control. Size, thickness, material and the derived colours all come from the
// fields above, because a hero shot should not need an operator to light it — the
// lighting and camera are calibrated in lib/productImages/studio3d.js and fixed.
api('/api/products/images/studio3d').then(({ json }) => {
  if (!json?.finishes) return;
  $('s3-finish').innerHTML = json.finishes
    .map((f) => `<option${f === json.defaultFinish ? ' selected' : ''}>${f}</option>`).join('');
});

$('s3-run').onclick = () => busy($('s3-run'), async () => {
  const photo = await swatchB64('t-file');
  if (!photo) {
    $('s3-msg').className = 'msg bad';
    $('s3-msg').textContent = 'pick a swatch photo above, or rectify one in Rectify a photo';
    return;
  }
  $('s3-msg').className = 'msg';
  $('s3-msg').textContent = 'rendering — a few seconds; the first call also starts the browser…';

  const r = await api('/api/products/images/studio3d', {
    method: 'POST',
    body: {
      photo,
      sizeLabel: str('t-size'),
      thicknessMm: num('t-thick'),
      material: $('t-material').value,
      finish: $('s3-finish').value,
      size: num('t-outsize'),
    },
  });
  if (!show('s3-msg', null, r)) return;

  const href = `data:image/jpeg;base64,${r.json.image}`;
  const slug = (str('t-size') || 'unsized').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const c = r.json.config;
  $('s3-out-img').innerHTML = `
    <figure style="grid-column:span 2">
      <img src="${href}" alt="3D studio render" data-full="${href}" title="click to inspect at full size">
      <figcaption>
        <span>3D render · ${c.size}px · roughness ${c.roughness}</span>
        <a class="dl" href="${href}" download="studio3d-${slug}.jpg">Download</a>
      </figcaption>
    </figure>`;
  $('s3-out-img').querySelector('img').onclick = (e) => zoom(e.target.dataset.full, `${c.size}px`);
  $('s3-msg').className = 'msg ok';
  $('s3-msg').textContent = `rendered in ${r.json.ms} ms · $0.00`;
});

/* ── templates 2: rectify (OpenCV) ────────────────────────────────────────── */
// A rectified swatch, once accepted, becomes the source for the template sections —
// so the fix flows forward instead of being a thing you download and re-upload.
let rectified = null;

function showRectifiedBanner() {
  $('t-derived').innerHTML = rectified
    ? `<div class="note"><strong>Using the rectified swatch</strong> from Rectify a photo
       (${rectified.output}). <a href="#" id="t-clear">Use the file input instead</a>.</div>`
    : '';
  const clear = $('t-clear');
  if (clear) clear.onclick = (e) => { e.preventDefault(); rectified = null; showRectifiedBanner(); };
}

/** The swatch the template sections should use: a rectified one wins over the file. */
async function swatchB64(fileEl) {
  if (rectified) return rectified.b64;
  const f = $(fileEl).files[0];
  return f ? asBase64(f) : null;
}

$('x-run').onclick = () => busy($('x-run'), async () => {
  const file = $('x-file').files[0];
  if (!file) {
    $('x-msg').className = 'msg bad';
    $('x-msg').textContent = 'pick a photo';
    return;
  }
  $('x-msg').className = 'msg';
  $('x-msg').textContent = 'finding the tile…';
  $('x-use').disabled = true;

  const r = await api('/api/products/images/rectify', {
    method: 'POST',
    body: { photo: await asBase64(file), sizeLabel: str('x-size'), max: num('x-max') },
  });
  if (!show('x-msg', null, r)) return;

  const d = r.json;
  const panel = (label, b64, span) => b64 ? `
    <figure${span ? ' style="grid-column:span 2"' : ''}>
      <img src="data:image/png;base64,${b64}" alt="${label}" data-full="data:image/png;base64,${b64}"
           title="click to inspect at full size">
      <figcaption><span>${label}</span></figcaption>
    </figure>` : '';

  $('x-out').innerHTML = panel(`detected corners · confidence ${d.confidence ?? '—'}`, d.overlay)
    + panel(`rectified · ${d.output || ''}`, d.rectified);
  $('x-out').querySelectorAll('img[data-full]').forEach((im) => {
    im.onclick = () => zoom(im.dataset.full, d.output || d.source || '');
  });

  // A refusal is a real answer, not a failure — an already-flat photo lands here.
  $('x-note').innerHTML = d.ok
    ? `<div class="note">Straightened <strong>${d.source}</strong> →
       <strong>${d.output}</strong> in ${d.ms} ms. Check the corners on the left before using it.</div>`
    : `<div class="note warn"><strong>Not rectified.</strong> ${d.reason}</div>`;

  $('x-use').disabled = !d.ok;
  if (d.ok) {
    rectified = { b64: d.rectified, output: d.output };
    $('x-msg').className = 'msg ok';
    $('x-msg').textContent = `${d.source} → ${d.output} · ${d.ms} ms · $0.00`;
  } else {
    rectified = null;
    $('x-msg').className = 'msg';
    $('x-msg').textContent = 'nothing changed — see below';
  }
});

$('x-use').onclick = () => {
  if (!rectified) return;
  showRectifiedBanner();
  location.hash = '#templates';
  $('x-msg').className = 'msg ok';
  $('x-msg').textContent = 'the template sections will use this swatch';
};

/* ── templates 4: the Cycles PDP pack ─────────────────────────────────────────
   A render is a job, so this polls. Every other endpoint in this admin answers in
   one round trip; this one queues and hands back an id, because three path-traced
   shots is minutes and no proxy holds a request open that long. */
const POLL_MS = 2000;

/* The room list comes from the server, because the server is what can see the folder.
   Populated on load rather than behind the engine-check button: a selector that is
   empty until you press something else looks broken, and the first render silently
   used the default. */
const GREYBOX = 'greybox_kitchen';

async function loadRooms() {
  const r = await api('/api/products/images/room-blender');
  const sel = $('p-room');
  const note = $('p-room-note');
  const rooms = (r.ok && r.json?.templates) || [];

  if (!rooms.length) {
    sel.innerHTML = '<option value="">— none —</option>';
    note.textContent = r.status === 404
      ? 'the server predates the room renderer — restart it'
      : 'drop a .blend in lib/productImages/templates/, or run npm run blender:bootstrap';
    return;
  }

  const keep = sel.value;
  sel.innerHTML = rooms.map((t) =>
    `<option value="${t}">${t}${t === GREYBOX ? ' (calibration)' : ''}</option>`).join('');
  // Prefer a real room over the grey box: the grey box exists to verify metrics, and
  // defaulting to it means the first render anyone does is of nothing.
  sel.value = rooms.includes(keep) ? keep : (rooms.find((t) => t !== GREYBOX) || rooms[0]);
  note.textContent = `${rooms.length} room${rooms.length > 1 ? 's' : ''} found`;
}

$('p-rooms-refresh').onclick = () => busy($('p-rooms-refresh'), loadRooms);
loadRooms();

$('p-status').onclick = () => busy($('p-status'), async () => {
  const r = await api('/api/products/images/room-blender');
  const d = r.json || {};
  $('p-engine').className = 'msg bad';

  // THREE DIFFERENT FAILURES, and the first cut reported all of them as "no Blender
  // on this box". A 404 means the SERVER is old — this endpoint was added after it
  // booted — and saying "no Blender" to that sends whoever reads it off to install a
  // renderer that is already there. Which is exactly what happened.
  if (r.status === 404) {
    $('p-engine').textContent =
      'this server does not have the endpoint — it booted before the room renderer existed. Restart it.';
    return;
  }
  if (!r.ok) {
    $('p-engine').textContent = `HTTP ${r.status} — ${d.error || 'the status check failed'}`;
    return;
  }
  if (!d.blender) {
    $('p-engine').textContent = d.reason || 'no Blender found — set BLENDER_PATH';
    return;
  }

  $('p-engine').className = 'msg ok';
  $('p-engine').textContent =
    `${d.blender.split('/').pop()} · ${d.gpu?.usable ? 'GPU' : 'CPU'} (${d.gpu?.why})`;
  // The check also re-reads the folder, so it doubles as the refresh.
  await loadRooms();
});

/** Both buttons, because either one starting a render must stop the other. Only
    p-run was disabled before, so a second click on Quick look queued a duplicate
    that then sat behind the first at a concurrency of one. */
const bothBusy = (fn) => busy($('p-run'), () => busy($('p-cheap'), fn));

const renderPack = (resolution, samples) => bothBusy(async () => {
  const swatch = await swatchB64('p-file');
  if (!swatch || !$('p-room').value) {
    $('p-msg').className = 'msg bad';
    $('p-msg').textContent = !$('p-room').value
      ? 'no room scene — drop a .blend in templates/ and press Refresh'
      : 'pick a swatch, or rectify one in Rectify a photo';
    return;
  }
  $('p-msg').className = 'msg';
  $('p-msg').textContent = 'queueing…';
  $('p-out').innerHTML = '';

  const q = await api('/api/products/images/room-blender', {
    method: 'POST',
    body: {
      swatch,
      roomTemplate: $('p-room').value || undefined,
      lighting: num('p-lighting'),
      hero: $('p-hero').value,
      exposure: num('p-exposure'),
      sizeLabel: str('p-size'),
      finish: $('p-finish').value,
      pattern: $('p-pattern').value,
      groutMm: num('p-grout'),
      groutColor: $('p-grout-col').value,
      resolution: resolution ?? num('p-res'),
      samples,
    },
  });
  if (!show('p-msg', null, q)) return;

  const id = q.json.id;
  const started = Date.now();

  // Poll without the images. Only the reply that finds it done is worth 20MB of
  // base64, and at a 2s cadence asking for them every time would be absurd.
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = await api(`/api/products/images/room-blender/${id}`);
    if (!s.ok) {
      $('p-msg').className = 'msg bad';
      // A 404 mid-poll means the SERVER restarted and lost its job registry, which
      // under `npm run dev` happens on any file edit. "no such render job" sounds
      // like the id was wrong; it was not.
      $('p-msg').textContent = s.status === 404
        ? 'the server restarted and lost this job — renders are held in memory. Queue it again.'
        : `HTTP ${s.status} — ${s.json?.error || 'the poll failed'}`;
      return;
    }
    const d = s.json;
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (d.state === 'queued' || d.state === 'rendering') {
      $('p-msg').className = 'msg';
      $('p-msg').textContent = d.state === 'queued'
        ? `queued${d.ahead ? ` — ${d.ahead} render${d.ahead > 1 ? 's' : ''} ahead of it` : ''} · ${secs}s`
        : `rendering${d.current ? ' · ' + d.current : ''} · ${secs}s`
          + `${d.device ? ' · ' + d.device : ''}`;
      continue;
    }
    if (d.state === 'failed') {
      $('p-msg').className = 'msg bad';
      $('p-msg').textContent = `${d.code}: ${d.reason}`;
      return;
    }

    const full = await api(`/api/products/images/room-blender/${id}?images=1`);
    if (!show('p-msg', null, full)) return;
    const f = full.json;
    $('p-out').innerHTML = Object.entries(f.images).map(([shot, uri]) => `
      <figure${shot === 'hero_wide' ? ' style="grid-column:span 2"' : ''}>
        <img src="${uri}" alt="${shot}" data-full="${uri}" title="click to inspect at full size">
        <figcaption><span>${shot.replace(/_/g, ' ')}</span>
          <a class="dl" href="${uri}" download="${shot}.jpg">Download</a>
        </figcaption>
      </figure>`).join('');
    $('p-out').querySelectorAll('img[data-full]').forEach((im) => {
      im.onclick = () => zoom(im.dataset.full, `${f.shots.length} shots`);
    });
    $('p-msg').className = 'msg ok';
    const lit = num('p-lighting');
    $('p-msg').textContent = `${$('p-room').value} · ${(f.ms / 1000).toFixed(1)}s · `
      + `${f.device} · ${f.tiles} tiles${lit && lit !== 1 ? ` · lighting x${lit}` : ''} · $0.00`;
    return;
  }
});

$('p-run').onclick = () => renderPack();
// The tuning loop. Resolution is quadratic and samples linear, so a quick look at
// 768px and 48 samples is roughly 25x faster than the real thing and tells you
// everything about framing, tile scale and grout before you commit minutes to it.
$('p-cheap').onclick = () => renderPack(768, 48);

/* ── signals ──────────────────────────────────────────────────────── */
const runSignals = (path, btn) => busy($(btn), async () => {
  const r = await api(`${path}${path.includes('?') ? '&' : '?'}days=${$('g-days').value || 28}`,
    { method: path.includes('sync') ? 'POST' : 'GET' });
  show('g-msg', 'g-out', r);
});
$('g-preview').onclick = () => runSignals('/api/signals/preview', 'g-preview');
$('g-sync').onclick = () => {
  if (!confirm('This writes relevance scores and tags to every active product. Continue?')) return;
  runSignals('/api/signals/sync?apply=1', 'g-sync');
};

/* ── marketing ────────────────────────────────────────────────────── */
$('m-load').onclick = () => busy($('m-load'), async () => {
  const r = await api('/api/marketing/journeys');
  if (!show('m-msg', null, r)) return;
  const d = r.json;
  $('m-channels').innerHTML = `<h3>Channels</h3>` + Object.entries(d.channels || {})
    .map(([k, v]) => `<div><span class="pill ${/^off/.test(v) ? 'off' : 'ok'}">${k}</span> <span class="hint">${v}</span></div>`)
    .join('');

  $('m-list').innerHTML = `<h3>Journeys</h3><table>
    <tr><th>Journey</th><th>State</th><th>Anchor</th><th>Delay</th><th></th></tr>
    ${(d.journeys || []).map((j) => `<tr>
      <td><strong>${j.label}</strong><br><code>${j.id}</code></td>
      <td>${j.enabled ? '<span class="pill ok">on</span>' : `<span class="pill off">off</span>`}
          ${j.blockedBy ? `<div class="hint">${j.blockedBy}</div>` : ''}</td>
      <td class="hint">${j.anchor || ''}</td>
      <td class="hint">${j.delayHours != null ? j.delayHours + 'h' : ''}</td>
      <td><button data-j="${j.id}">Run</button></td>
    </tr>`).join('')}</table>`;

  $('m-list').querySelectorAll('button[data-j]').forEach((b) => {
    b.onclick = () => busy(b, async () => {
      const r2 = await api(`/api/marketing/cron/${b.dataset.j}`, { method: 'POST' });
      show('m-msg', 'm-out', r2);
    });
  });
});

/* ── ads ──────────────────────────────────────────────────────────── */
$('d-preview').onclick = () => busy($('d-preview'), async () => {
  // Identity fields nest under `user`, click ids under `attribution`. Flat ones are
  // rejected by the server on purpose — they used to be silently dropped.
  const payload = {
    event: $('d-event').value,
    orderId: str('d-orderId'),
    value: num('d-value'),
    currency: 'INR',
    user: { email: str('d-email'), phone: str('d-phone') },
    attribution: { fbclid: str('d-fbclid'), firstSeen: Math.floor(Date.now() / 1000) },
    clientIp: '49.36.1.2',
    clientUserAgent: navigator.userAgent,
  };
  const r = await api('/api/ads/events/preview?payload=' + encodeURIComponent(JSON.stringify(payload)));
  if (show('d-msg', 'd-out', r)) {
    const u = r.json.data.user_data;
    $('d-msg').className = 'msg ok';
    $('d-msg').textContent = `hashed: ${Object.keys(u).filter((k) => Array.isArray(u[k])).join(', ') || 'none'} · dedupe: ${r.json.dedupe}`;
  }
});

/* ── routes ───────────────────────────────────────────────────────── */
api('/routes.json').then(({ json }) => {
  if (!json) return;
  $('r-table').innerHTML = `<table><tr><th>Method</th><th>Path</th><th>Needs</th></tr>
    ${json.routes.map((r) => `<tr>
      <td><code>${r.method}</code></td>
      <td>${r.method === 'GET' && !r.secret && !r.path.includes(':')
        ? `<a href="${r.path}">${r.path}</a>` : r.path}</td>
      <td class="hint">${r.secret ? 'x-cron-secret' : r.method !== 'GET' ? 'body' : ''}</td>
    </tr>`).join('')}</table>`;
});

/* ── PDF images ───────────────────────────────────────────────────── */
$('pi-run').onclick = () => busy($('pi-run'), async () => {
  const file = $('pi-file').files[0];
  $('pi-zip').hidden = true;
  $('pi-out').innerHTML = '';
  if (!file) { $('pi-msg').className = 'msg bad'; $('pi-msg').textContent = 'pick a PDF'; return; }
  $('pi-msg').className = 'msg';
  $('pi-msg').textContent = `extracting from ${file.name}…`;

  // The PDF itself as the body, not base64 JSON — the route's parser takes raw bytes.
  const res = await fetch(`/api/pdf/images?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: file });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  if (!show('pi-msg', null, { ok: res.ok, status: res.status, json })) return;

  const base = `/api/pdf/images/${json.job}/`;
  const mb = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const card = (im) => `
    <figure data-file="${im.file}"${im.decor ? ' class="decor"' : ''}>
      <img src="${base}${im.file}?thumb=1" data-full="${base}${im.file}" alt="${im.file}" loading="lazy" title="click to view full quality">
      <figcaption>
        <span>${im.kind === 'swatch' ? `swatch · <code>${im.colour}</code>` : `${im.width}×${im.height}${im.transparent ? ' · transparent' : ''}`}
          · ${mb(im.bytes)}${im.decor ? ` · <em>${im.decor}</em>` : ''}</span>
        <a class="dl" href="${base}${im.file}?dl=1">download</a>
      </figcaption>
    </figure>`;

  // Every page, empty ones included: the page render beside its items, with a box on
  // everything that was extracted. Something on the page without a box was missed.
  const byPage = Map.groupBy(json.images, (im) => im.page);
  const decorFile = new Set(json.images.filter((i) => i.decor).map((i) => i.file));
  const pct = (v) => (v * 100).toFixed(2) + '%';
  $('pi-out').innerHTML = json.pages.map(({ page, preview, boxes }) => {
    const ims = byPage.get(page) || [];
    return `
    <div class="pi-page">
      <h3>Page ${page} <span class="hint">${ims.filter((i) => !i.decor).length} items</span></h3>
      <div class="pi-row">
        <div class="pi-src" title="click for the full page">
          <img src="${base}${preview}?thumb=1" data-full="${base}${preview}" alt="page ${page}" loading="lazy">
          ${boxes.map((b) => `<i data-file="${b.file}"${decorFile.has(b.file) ? ' class="bx-decor"' : ''}
            style="left:${pct(b.x)};top:${pct(b.y)};width:${pct(b.w)};height:${pct(b.h)}"></i>`).join('')}
        </div>
        ${ims.length ? `<div class="tpl-grid">${ims.map(card).join('')}</div>`
          : '<p class="hint">Nothing extracted from this page — if it shows a product, the rules missed it.</p>'}
      </div>
    </div>`;
  }).join('');
  $('pi-out').querySelectorAll('img').forEach((img) => { img.onclick = () => zoom(img.dataset.full, img.alt); });
  // Hover an item → its box lights up on the page render.
  const light = (f, on) => $('pi-out').querySelectorAll(`[data-file="${f}"]`).forEach((el) => el.classList.toggle('lit', on));
  $('pi-out').querySelectorAll('[data-file]').forEach((el) => {
    el.onmouseenter = () => light(el.dataset.file, true);
    el.onmouseleave = () => light(el.dataset.file, false);
  });
  showDecor();

  const count = (k) => json.images.filter((i) => i.kind === k && !i.decor).length;
  const decor = json.images.filter((i) => i.decor).length;
  $('pi-zip').hidden = !json.images.length;
  // Saved as "<pdf name>.zip"; inside, one folder of that name with a folder per page.
  $('pi-zip').onclick = () => { location.href = `${base}all.zip?dl=${encodeURIComponent(file.name.replace(/\.pdf$/i, ''))}`; };
  $('pi-msg').className = 'msg ok';
  $('pi-msg').textContent = `${count('photo')} photos + ${count('swatch')} swatches from ${json.pageCount} pages`
    + `${decor ? ` · ${decor} decoration hidden` : ''} · ${(json.ms / 1000).toFixed(1)} s`;
});

// Decoration is hidden, not dropped: the rules guess, and a wrong guess must be recoverable.
function showDecor() {
  const on = $('pi-decor').checked;
  document.querySelectorAll('#pi-out .decor').forEach((f) => { f.hidden = !on; });
}
$('pi-decor').onchange = showDecor;
