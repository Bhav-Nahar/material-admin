'use strict';

/**
 * studio3d.js — the studio shot as an actual 3D render.
 *
 * The 2D compositor in imageComposer.js FAKES light: gradients painted onto a texture
 * to imply a highlight, a blurred ellipse to imply a shadow. It gets remarkably close,
 * and for the four diagram templates it is exactly the right tool. The hero shot is
 * the one that has to read as a photograph, and that is where painting light by hand
 * has a ceiling.
 *
 * So this builds a real scene — a slab with real thickness, a floor, a back wall, two
 * rectangular lights, a camera with a real focal length — and lets a renderer work out
 * the shading. Roughness becomes a property of the material rather than a look, which
 * is why a matte and a polished tile can differ here and cannot there.
 *
 * WHY A BROWSER: three.js needs WebGL and Node has no graphics context. Chrome has
 * one (SwiftShader in software when there is no GPU), so the scene renders inside a
 * headless Chrome and the canvas comes back as a PNG.
 *
 * ponytail: puppeteer-core plus whatever Chrome is already installed, NOT the full
 * `puppeteer` package — that downloads its own ~300MB Chromium, and a machine running
 * this service has a browser already. Set CHROME_PATH when it is somewhere unusual.
 * The cost of that choice is that a missing Chrome is a runtime error rather than an
 * install-time one, so resolveChrome below says exactly what to do about it.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { studioGround, bodyColour, parseSizeLabel } = require('./imageComposer');

// three's package.json "exports" hides build/, so require.resolve cannot reach it —
// resolve the package root through a subpath it does export, and walk up from there.
const THREE_DIR = path.dirname(path.dirname(require.resolve('three')));
const SCENE = path.join(__dirname, 'studio-scene.html');

// Where Chrome usually lives. CHROME_PATH wins over all of them.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function resolveChrome() {
  const found = CHROME_CANDIDATES.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  if (found) return found;
  const err = new Error(
    'no Chrome found for the 3D studio render. Set CHROME_PATH to a Chrome or Chromium ' +
      `binary (looked in: ${CHROME_CANDIDATES.join(', ')}). The 2D templates need none of this.`,
  );
  err.code = 'no_chrome';
  throw err;
}

/**
 * Defaults, every one of them measured off the benchmark's hero shot rather than
 * chosen. The camera numbers in particular are not taste:
 *
 *   its tile foreshortens to 0.819, so the angle between the face's normal and the
 *   camera is acos(0.819) = 35 degrees. That is turnDeg PLUS camAzimuthDeg, which is
 *   why they are 13 and 22 and not any other pair summing to 35.
 */
/**
 * Finish -> roughness. The one property that genuinely varies per product, and the
 * one a 2D composite cannot express at all: it decides whether the surface scatters
 * light or mirrors it. Keys are the values `custom.finish` already carries.
 */
const ROUGHNESS = {
  matte: 0.62,
  'carving matte': 0.62,
  'glue matte': 0.62,
  texture: 0.66,
  suede: 0.55,
  satin: 0.42,
  glossy: 0.25,
  'high gloss': 0.12,
  polished: 0.12,
};
const DEFAULT_ROUGHNESS = ROUGHNESS.matte;

const roughnessFor = (finish) =>
  ROUGHNESS[String(finish || '').trim().toLowerCase()] ?? DEFAULT_ROUGHNESS;

/**
 * Calibrated, not chosen. Rendering against the benchmark's hero shot and measuring
 * texture contrast and mean brightness on the tile face:
 *
 *   aces  key 1.4  contrast 1.97  mean 152     ACES trades contrast for brightness
 *   aces  key 2.8  contrast 1.32  mean 208     ...and keeps trading, the wrong way
 *   none  key 3.4  contrast 2.46  mean 215     <- reference is 3.18 / 219
 *   none  key 4.2  contrast 2.70  mean 236     too bright
 *   none  key 5.0  contrast 1.36  mean 253     76% of the face blown out
 *
 * ACES is a FILM curve: it rolls highlights off for a cinematic look, which flattens
 * exactly the texture this image exists to sell. With it off, contrast climbs with
 * exposure until the face clips, and key 3.4 lands on the reference's own brightness
 * with nothing blown. The other intensities are held as ratios of the key so the
 * lighting stays balanced if it is ever moved.
 *
 * The camera numbers are geometry, not taste: the reference foreshortens to 0.819, so
 * the angle between the face's normal and the camera is acos(0.819) = 35 degrees —
 * which is turnDeg PLUS camAzimuthDeg, and why they are 13 and 22.
 */
const KEY = 3.4;

// How much of the frame the unit's widest projected extent should occupy, and the
// foreshortening that 35 degrees of turn produces. Both measured off the reference.
const FRAME_FILL = 0.8;
const FORESHORTEN = 0.819;

const DEFAULTS = {
  size: 1600,
  widthMm: 600,
  heightMm: 600,
  thicknessMm: 9,
  roughness: DEFAULT_ROUGHNESS,
  wall: '#e8d9ae',
  body: '#d8d2c4',
  turnDeg: 13,
  leanDeg: -1.5,
  keyIntensity: KEY,
  fillIntensity: KEY * 0.4,
  sunIntensity: KEY * 0.3,
  ambIntensity: KEY * 0.16,
  shadowSoftness: 14,
  exposure: 1,
  toneMapping: 'none',
  fov: 18, // long lens: a short one splays the verticals
  camAzimuthDeg: 22,
  camDistance: 2.45,
  camHeight: 0.44,
  targetY: 0.3,
};

const NUMERIC = new Set(
  Object.entries(DEFAULTS).filter(([, v]) => typeof v === 'number').map(([k]) => k),
);

/* ── one browser, reused ───────────────────────────────────────────────────────
   Launching Chrome costs about a second, and this endpoint exists to be called over
   and over while someone tunes the lighting. The instance is kept until it dies or
   the process does. */
let browserPromise = null;

async function getBrowser() {
  const puppeteer = require('puppeteer-core');
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.connected) return b;
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    executablePath: resolveChrome(),
    headless: true,
    args: [
      '--headless=new',
      // WebGL with no GPU: ANGLE over SwiftShader, Chrome's software renderer.
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const b = await browserPromise;
  b.on('disconnected', () => { browserPromise = null; });
  return b;
}

async function closeBrowser() {
  const b = await (browserPromise || Promise.resolve(null)).catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});

  const s = await (serverPromise || Promise.resolve(null)).catch(() => null);
  serverPromise = null;
  if (s) await new Promise((r) => s.server.close(r));
}

/* ── a loopback server for the scene ──────────────────────────────────────────
   A file:// page has origin 'null', and Chrome refuses to let a null origin import
   file:// modules — measured: "Access to script ... from origin 'null' has been
   blocked by CORS policy". There is a Chrome flag for it, but a two-file static
   server on 127.0.0.1 needs no flag, no temp files and no cross-origin rules at all,
   and `http` is already in Node.

   Bound to an ephemeral port on loopback only, started with the browser and closed
   with it. It serves exactly two things: the scene, and three's own modules. */
const http = require('http');

let serverPromise = null;

const MIME = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8' };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);

    if (url === '/' || url === '/scene.html') {
      const html = fs.readFileSync(SCENE, 'utf8').replaceAll('__THREE__', '/three');
      // no-store, because the URL never changes: Chrome will happily serve a cached
      // scene for the life of the browser, so an edit to studio-scene.html silently
      // does nothing and the render is a lie about the current code.
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (url.startsWith('/three/')) {
      // Confined to the three package: resolve, then verify the result is still
      // inside it, so a "..'" in the path cannot reach the rest of the disk.
      const file = path.resolve(THREE_DIR, '.' + url.slice('/three'.length));
      if (file.startsWith(THREE_DIR + path.sep) && fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(file));
      }
    }

    res.writeHead(404).end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function getServer() {
  serverPromise ||= startServer();
  return serverPromise;
}

/**
 * Strips a uniform border off a swatch.
 *
 * A supplier photo often arrives with white margins — a scan, a screenshot, a shot on
 * a light table. Mapped onto the tile face those margins become bright stripes down
 * the left and right of the product, which is exactly what they look like: the
 * renderer faithfully showing what it was given. Reported from a real render, and
 * reproducible by padding a clean swatch.
 *
 * Refuses to trim more than TRIM_MAX_LOSS of the area, because a genuinely pale,
 * genuinely uniform tile is a legitimate product and cropping most of it away would
 * be a far worse failure than a stripe.
 */
const TRIM_MAX_LOSS = 0.35;

async function trimBorder(b64) {
  const src = Buffer.from(b64, 'base64');
  const before = await sharp(src).metadata();
  try {
    const { data, info } = await sharp(src)
      .trim({ threshold: 12 })
      .toBuffer({ resolveWithObject: true });
    const kept = (info.width * info.height) / (before.width * before.height);
    if (kept < 1 - TRIM_MAX_LOSS) return { b64, trimmed: false };
    if (kept > 0.999) return { b64, trimmed: false };
    return { b64: data.toString('base64'), trimmed: true, from: `${before.width}x${before.height}`, to: `${info.width}x${info.height}` };
  } catch {
    // trim throws when the whole image is one colour. Nothing to do about that here.
    return { b64, trimmed: false };
  }
}

/**
 * @param {string} b64   flat, square-on swatch
 * @param {object} opts  any DEFAULTS key; unknown keys are ignored
 * @returns {Promise<{image:string, ms:number, renderer:string, config:object}>}
 */
async function renderStudio3d(b64, opts = {}) {
  if (!b64) {
    const err = new Error('photo (base64) is required');
    err.code = 'no_photo';
    throw err;
  }

  const cfg = { ...DEFAULTS };

  /* ── everything derivable comes from the product, not from a control ────────
     Size, thickness and finish are already fields on the product; wall and body
     colours are derived the same way the 2D studio shot derives them, so the two
     render the same tile against the same ground. What is left to pass is nothing,
     which is the point — a hero shot should not need an operator to light it. */
  const dims = parseSizeLabel(opts.sizeLabel);
  if (dims) {
    cfg.widthMm = dims.widthMm;
    cfg.heightMm = dims.heightMm;
  }
  if (opts.finish) cfg.roughness = roughnessFor(opts.finish);

  /* The camera is FRAMED to the unit, not fixed. A 1200 x 600 plank is twice as wide
     as the 600 square these numbers were calibrated on, and at a fixed distance it
     simply runs off both sides of the frame. So the distance is solved from the size:
     the tile's widest projected extent must fill FRAME_FILL of the frame, and frame
     height at distance d is 2*d*tan(fov/2). Height and look-at follow the unit too,
     so a tall format is not framed at a plank's eye level. */
  const wM = cfg.widthMm / 1000;
  const hM = cfg.heightMm / 1000;
  const extent = Math.max(wM * FORESHORTEN, hM);
  const halfFov = (cfg.fov * Math.PI) / 360;
  cfg.camDistance = Number((extent / (2 * FRAME_FILL * Math.tan(halfFov))).toFixed(3));
  cfg.camHeight = Number((hM * 0.733).toFixed(3));
  cfg.targetY = Number((hM * 0.5).toFixed(3));

  // Borders off FIRST, so the derived colours are read from the tile and not from a
  // white margin that would drag the whole palette pale.
  // OPT-IN. Trimming a uniform border removes the white stripes a padded photo puts
  // down the tile face, but it also re-crops the swatch, and the approved render did
  // not have it. Pass `trim: true` to switch it back on.
  const trim = opts.trim === true ? await trimBorder(b64) : { b64, trimmed: false };
  const photo = trim.b64;

  const [ground, edge] = await Promise.all([
    studioGround(photo, opts.bg),
    bodyColour(photo, opts.material),
  ]);
  cfg.wall = ground.wall;
  cfg.body = '#' + edge.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

  // Explicit overrides still win, so the knobs remain available to the API for tuning.
  for (const [k, v] of Object.entries(opts)) {
    if (v == null || v === '') continue;
    if (NUMERIC.has(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) cfg[k] = n;
    } else if (k in DEFAULTS) {
      cfg[k] = v;
    }
  }
  cfg.size = Math.max(400, Math.min(3000, Math.round(cfg.size)));

  const t0 = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 900 });
    await page.evaluateOnNewDocument(
      (c, tex) => { window.__CFG = { ...c, texture: tex }; },
      cfg,
      'data:image/jpeg;base64,' + photo,
    );
    const { port } = await getServer();
    await page.goto(`http://127.0.0.1:${port}/scene.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.__done === true || window.__error', { timeout: 60000 });

    const failed = await page.evaluate('window.__error || null');
    if (failed) {
      const err = new Error(`3D scene failed: ${failed}`);
      err.code = 'scene_failed';
      throw err;
    }

    const png = await page.evaluate('window.__png');
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });

    // Same finishing as the 2D templates, so the two are comparable rather than
    // differing because one of them happens to be encoded better.
    const image = (
      await sharp(Buffer.from(png.split(',')[1], 'base64'))
        .sharpen({ sigma: 0.7, m1: 0.6, m2: 2 })
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer()
    ).toString('base64');

    return {
      image,
      ms: Date.now() - t0,
      renderer,
      config: cfg,
      // Report only, never the trimmed pixels — the caller already has the image.
      trim: { trimmed: trim.trimmed, ...(trim.trimmed ? { from: trim.from, to: trim.to } : {}) },
    };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { renderStudio3d, closeBrowser, resolveChrome, roughnessFor, DEFAULTS, ROUGHNESS };
