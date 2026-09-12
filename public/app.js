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
    look: ['Woodgrain', 'Solid colour', 'Fluted', 'Stone-look'],
    material: ['Acrylic', 'ASA', 'PVC', 'PETG', 'WPC Fibre'],
    finish: ['Texture', 'High Gloss', 'Suede', 'Matte', 'Glossy'],
  },
  Wallpaper: {
    look: ['Floral', 'Geometric', 'Tropical', 'Plain', 'Mural'],
    material: ['Non-woven', 'PVC', 'Canvas', 'Handmade', 'Soft Feel'],
    finish: [],
  },
};
function fillVocab() {
  const v = VOCAB[$('c-category').value] || {};
  for (const k of ['look', 'material', 'finish']) {
    $('l-' + k).innerHTML = (v[k] || []).map((x) => `<option value="${x}">`).join('');
  }
}
$('c-category').onchange = fillVocab;
fillVocab();

/* ── create product ───────────────────────────────────────────────── */
function createBody() {
  return {
    category: $('c-category').value,
    sku: str('c-sku'), series: str('c-series'), colourName: str('c-colourName'),
    colourFamily: list('c-colourFamily'),
    look: str('c-look'), material: str('c-material'), finish: str('c-finish'),
    surface: list('c-surface'), pattern: str('c-pattern'), useCases: list('c-useCases'),
    slipRating: str('c-slipRating'), applications: list('c-applications'),
    designVariants: num('c-designVariants'),
    price: num('c-price'), priceUnit: str('c-priceUnit'), sizeLabel: str('c-sizeLabel'),
    thicknessMm: num('c-thicknessMm'), packUnit: str('c-packUnit'),
    piecesPerPack: num('c-piecesPerPack'), coveragePerPack: num('c-coveragePerPack'),
    samplePrice: num('c-samplePrice'),
    installCaveats: lines('c-installCaveats'),
    title: str('c-title'),
    status: $('c-active').checked ? 'ACTIVE' : 'DRAFT',
  };
}

function renderDerived(el, d, product) {
  const rows = [
    ['Derived title', d.title],
    ['Meta title', `${d.seoTitle} <span class="hint">${d.seoTitle.length} chars</span>`],
    ['Meta description', `${d.seoDescription} <span class="hint">${d.seoDescription.length} chars</span>`],
    ['Keywords', (d.keywords || []).slice(0, 10).join(' · ')],
  ];
  if (product) {
    rows.unshift(['Created', `<span class="pill ok">${product.status}</span> <code>${product.handle}</code>`]);
  }
  el.innerHTML = `<dl class="derived">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')}</dl>`;
}

function renderWarnings(el, warnings) {
  if (!warnings || !warnings.length) return;
  el.insertAdjacentHTML('beforeend',
    `<div class="note warn"><strong>Check these:</strong><br>${warnings.join('<br>')}</div>`);
}

$('c-preview').onclick = () => busy($('c-preview'), async () => {
  const r = await api('/api/products/create', { method: 'POST', body: createBody() });
  if (!show('c-msg', 'c-out', r)) { $('c-apply').disabled = true; return; }
  renderDerived($('c-derived'), r.json.derived);
  renderWarnings($('c-derived'), r.json.warnings);
  $('c-apply').disabled = false;
  $('c-msg').textContent = 'previewed — nothing written';
});

$('c-apply').onclick = () => busy($('c-apply'), async () => {
  const r = await api('/api/products/create?apply=1', { method: 'POST', body: createBody() });
  if (!show('c-msg', 'c-out', r)) return;
  renderDerived($('c-derived'), r.json.derived, r.json.product);
  renderWarnings($('c-derived'), r.json.warnings);
  $('c-apply').disabled = true;
  $('c-msg').textContent = 'created';
  $('s-handle').value = r.json.product.handle;
  $('i-product').value = r.json.product.id.split('/').pop();
});

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
};

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
      size: num('t-outsize'),
      cols: Number($('t-cols').value),
      repeats: Number($('t-cols').value),
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
