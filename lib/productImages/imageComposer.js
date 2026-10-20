/**
 * imageComposer.js — post-processing overlays for generated surface imagery.
 *
 * Ported from glassquickdev/functions/generateProductImages/imageComposer.js.
 *
 * Composites for real: `sharp` (libvips) is a dependency as of this change, and the
 * entry points at the bottom of the file return finished base64 JPEGs.
 *
 * Every template here is built from ONE flat swatch and costs NO model call. That
 * is the point of the file — the benchmark's size shot, thickness shot and laid-floor
 * grid are all fixed geometry over the merchant's own photo, so paying an image model
 * per SKU to approximate them is paying for a worse version of arithmetic.
 *
 * ponytail: DROPPED from the source, deliberately —
 *   • addMeasurementAnnotations() — inch/cm dimension arrows drawn around a
 *     mirror. A mirror is bought at one exact cut size, so the arrows ARE the
 *     product spec. Tiles, laminates and wallpaper are bought by area from a
 *     short list of stock formats; an arrow saying "1200 mm" round one tile
 *     tells a buyer nothing they cannot read off the size chip. Replaced by
 *     scaleReferenceSvg(), which answers the question a surface buyer actually
 *     asks — how big is one unit against something I know.
 *   • compositeColourGrid() — the same mirror rendered in N frame colours and
 *     tiled into one image. That is glass merchandising: one product, many
 *     finishes, one SKU. Material-Metafield-Research.html §13 records that the
 *     benchmark ships one product per colourway (per-colour SKU suffixes
 *     TL 04961 B/C/D/E/F/G), so a colour grid would be a grid of other
 *     products. Replaced by repeatPreviewSvg(), which tiles ONE swatch to show
 *     how the pattern repeats across a wall — the surface-specific question,
 *     and the one wallpaper buyers get wrong most often.
 *   • addWatermark() — burned "Glassquick" into every image. Not ported: not
 *     Material's brand, and Shopify serves its own CDN transforms if a
 *     watermark is ever wanted.
 */

const path = require('path');
const sharp = require('sharp');
const opentype = require('opentype.js');

const CANVAS = 900; // matches the source's output standard

const UNIT_MM = { mm: 1, cm: 10, m: 1000, inch: 25.4, in: 25.4, feet: 304.8, ft: 304.8 };

// ─── Size parsing ─────────────────────────────────────────────────────────────

/**
 * Parses a Material size label into millimetres.
 *
 * The source only handled bare inches ("18x24") because mirrors are sold that
 * way. Material's labels carry their unit and it differs per category — tiles in
 * mm ("1200 x 600 mm"), laminates in feet ("8 ft x 4 ft"), wallpaper as roll
 * dimensions in mm (research §5–§7). A trailing unit applies to both numbers.
 *
 * @returns {{width:number,height:number,unit:string,widthMm:number,heightMm:number}|null}
 */
function parseSizeLabel(sizeValue) {
  if (!sizeValue) return null;
  const m = String(sizeValue).match(
    /(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in|feet|ft)?\s*[x×X*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|inch|in|feet|ft)?/i,
  );
  if (!m) return null;

  const width = parseFloat(m[1]);
  const height = parseFloat(m[3]);
  // Trailing unit wins — "1200 x 600 mm" states it once, at the end. No unit at all
  // reads as feet when both sides are small ("8X4" is an 8 ft x 4 ft sheet; no panel
  // is 8 mm across), and as mm otherwise ("600x600").
  const unit = String(m[4] || m[2] || (Math.max(width, height) <= 20 ? 'ft' : 'mm')).toLowerCase();
  const factor = UNIT_MM[unit] || 1;

  return {
    width,
    height,
    unit,
    widthMm: Math.round(width * factor),
    heightMm: Math.round(height * factor),
  };
}

/** Human label for an overlay: "1200 × 600 mm (4.0 × 2.0 ft)". */
function sizeLabelText(dims) {
  if (!dims) return '';
  const ft = (mm) => (mm / 304.8).toFixed(1);
  return `${dims.widthMm} × ${dims.heightMm} mm  (${ft(dims.widthMm)} × ${ft(dims.heightMm)} ft)`;
}

// ─── Scale reference overlay ──────────────────────────────────────────────────

/**
 * A ruler bar plus a dimension caption, sized to the real unit.
 *
 * The bar is drawn to the SAME scale as the unit in frame, so a 300 mm tile and a
 * 1200 mm plank get visibly different bars — that is the whole point. Assumes the
 * product occupies the middle 70% of the canvas, which the `scale` style anchor
 * in promptBuilder asks the model for.
 *
 * @returns {string} SVG fragment in CANVAS coordinates; wrap with svgBuf
 */
function scaleReferenceSvg(dims) {
  const label = sizeLabelText(dims);
  const INK = '#1a1a1a';
  const PROD_L = Math.round(CANVAS * 0.15);
  const PROD_R = Math.round(CANVAS * 0.85);
  const y = CANVAS - 76;
  const pxPerMm = (PROD_R - PROD_L) / (dims?.widthMm || 1000);

  // A round metric interval that lands between 1/8 and 1/2 of the unit width.
  const STEPS = [10, 25, 50, 100, 250, 500, 1000];
  const step = STEPS.find((s) => s * pxPerMm > (PROD_R - PROD_L) / 8) || 1000;
  const ticks = [];
  for (let mm = 0; mm <= (dims?.widthMm || 0); mm += step) {
    const x = PROD_L + mm * pxPerMm;
    if (x > PROD_R) break;
    ticks.push(`<line x1="${x.toFixed(1)}" y1="${y - 7}" x2="${x.toFixed(1)}" y2="${y + 7}" stroke="${INK}" stroke-width="2"/>`);
  }

  return `
  <rect x="0" y="${CANVAS - 116}" width="${CANVAS}" height="116" fill="#ffffff" opacity="0.92"/>
  <line x1="${PROD_L}" y1="${y}" x2="${PROD_R}" y2="${y}" stroke="${INK}" stroke-width="2"/>
  ${ticks.join('\n  ')}
  ${textSvg(label, { x: CANVAS / 2, y: y - 22, size: 22, weight: 'Medium', anchor: 'middle', fill: INK })}
  ${textSvg(`scale bar: ${step} mm per division`, { x: CANVAS / 2, y: y + 32, size: 14, weight: 'Medium', anchor: 'middle', fill: '#666666' })}`;
}

// ─── Repeat / tiling preview ──────────────────────────────────────────────────

/**
 * Grid layout for the repeat preview. Kept from the source's gridLayout(), minus
 * the label strip — every cell here is the same swatch, so there is nothing to
 * label. Repeat count is chosen so the pattern reads without turning to mush.
 */
function repeatLayout(repeats = 3, c = CANVAS) {
  const n = Math.max(2, Math.min(6, Math.round(repeats)));
  const cell = Math.floor(c / n);
  return { cols: n, rows: n, cellW: cell, cellH: cell, canvas: c };
}

/** Seam guides over the tiled grid, so a mismatched repeat is obvious rather than flattering. */
function repeatPreviewSvg(layout, c = CANVAS) {
  const lines = [];
  for (let i = 1; i < layout.cols; i++) {
    const x = i * layout.cellW;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${c}" stroke="#ffffff" stroke-width="1" opacity="0.25"/>`);
  }
  for (let r = 1; r < layout.rows; r++) {
    const y = r * layout.cellH;
    lines.push(`<line x1="0" y1="${y}" x2="${c}" y2="${y}" stroke="#ffffff" stroke-width="1" opacity="0.25"/>`);
  }
  // Drawn in canvas pixels, not viewBox units — the layout above is already resolved.
  return `<svg width="${c}" height="${c}" xmlns="http://www.w3.org/2000/svg">\n  ${lines.join('\n  ')}\n</svg>`;
}

// ─── Entry points ────────────────────────────────────────────────────────────
//
// sharp (libvips) is now a dependency, so the four below actually composite.
// Every one takes base64 in and returns base64 out, so they drop straight into
// the pipeline's existing composite() step with no call-site change.

const INK = '#1a1a1a';

const decode = (b64) => Buffer.from(b64, 'base64');

/**
 * An overlay, at output resolution but addressed in CANVAS coordinates.
 *
 * The viewBox is the whole trick behind rendering at any size: every coordinate,
 * stroke width and font size in this file stays written in 900-space, and SVG scales
 * it losslessly to whatever `c` is. Only RASTER layers need their own arithmetic —
 * see `scaled` in each composite.
 */
const svgBuf = (body, c = CANVAS) =>
  Buffer.from(
    `<svg width="${c}" height="${c}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
  );

const blank = (bg = '#ffffff', c = CANVAS) =>
  sharp({ create: { width: c, height: c, channels: 3, background: bg } });

/**
 * Encode a finished composite.
 *
 * The sharpen has to run on the COMPOSITED result, which means re-opening the
 * pixels: sharp applies `sharpen` to the base image before overlays are drawn, and
 * every composite here starts from a blank fill — so chaining .sharpen() onto the
 * pipeline sharpens a flat colour and changes nothing. Measured exactly that way.
 *
 * Why sharpen at all: every template ends in a downscale (a warp strip, a rotate, a
 * grid cell), and downscaling always costs high-frequency detail. A light unsharp
 * mask is the standard remedy and the texture IS the product here.
 *
 * Raw rather than PNG for the round trip — a PNG encode of a 2048² canvas costs more
 * than the sharpen it exists to enable.
 */
async function asJpeg(pipe) {
  const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
  dither(data);
  const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .sharpen({ sigma: 0.7, m1: 0.6, m2: 2 })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return out.toString('base64');
}

// Amplitude in 8-bit levels. Big enough to straddle a band boundary, small enough that
// no single pixel is distinguishable — measured banding steps are 3-4 levels.
const DITHER = 2.2;

/**
 * Breaks up 8-bit banding, in place.
 *
 * These grounds are wide, low-contrast gradients, and librsvg rasterises them to 8
 * bits: measured across the studio wall, 1600px of gradient held just NINE distinct
 * values, with one flat band 693px wide. That is plainly visible as stripes, and no
 * amount of resampling quality touches it — the intermediate levels do not exist.
 *
 * Adding sub-level noise randomises where each band boundary falls, so the eye
 * integrates it back into a continuous ramp. It is what every image pipeline does at
 * a bit-depth reduction, and a photographed studio sweep has sensor grain doing the
 * same job — so it reads as more photographic, not less.
 *
 * ponytail: white noise, not blue noise or an ordered matrix. Blue noise is visually
 * better at the same amplitude and needs a precomputed tile; at 2 levels on a
 * photographic ground there is nothing left to see. Revisit if a flat brand colour
 * ever needs dithering, where structure in the noise would show.
 */
function dither(buf) {
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] + (Math.random() - 0.5) * 2 * DITHER;
    buf[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

// The largest share of the canvas any template gives the face (the studio shot).
const FACE_SHARE = 0.66;
// How far past 1:1 the face may be stretched before it is just a bigger blur.
const MAX_UPSCALE = 1.2;
const MIN_SIZE = 600;
const MAX_SIZE = 4000;

/**
 * How large this photo can honestly be rendered.
 *
 * Asking for 2048 from a 640px swatch does not produce a sharp 2048 image, it
 * produces a soft one that costs four times the bytes — the detail is not in the
 * file. So the requested size is capped by what the source can actually fill, and
 * the cap is REPORTED rather than applied silently: a capped render is a message
 * about the supplier photo, and the only fix for it is a better photo.
 *
 * Measured on the benchmark: its own catalogue images are 600x600, and the swatch
 * behind them is 639x600 — which is why 900 was already at the ceiling here.
 *
 * @returns {{size:number, requested:number, capped:boolean, source:string}}
 */
async function outputSize(b64, requested = CANVAS) {
  const want = Math.round(Number(requested) || CANVAS);
  const { width = 0, height = 0 } = await sharp(decode(b64)).metadata();
  const src = Math.min(width, height) || CANVAS;
  const cap = Math.floor((src * MAX_UPSCALE) / FACE_SHARE);
  const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.min(want, cap)));
  return { size, requested: want, capped: size < want, source: `${width}x${height}` };
}

/* ── body colour, shared by every template that shows a cut edge ────────────── */

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const hexOf = (rgb) => '#' + rgb.map((n) => clamp255(n).toString(16).padStart(2, '0')).join('');
const scaleRgb = (rgb, k) => rgb.map((n) => n * k);
const mixRgb = (a, b, t) => a.map((n, i) => n * (1 - t) + b[i] * t);

/** A warm pale grey — what a fired porcelain body actually looks like. */
const PORCELAIN_BODY = [214, 208, 196];

/**
 * The colour of the tile's BODY, which is not the colour of its face.
 *
 * A GLAZED tile (Vitrified, Ceramic, Porcelain) has a pale body whatever the glaze
 * shows — the benchmark's own 9 mm vitrified shot has a warm grey edge under a
 * speckled face — so sampling the face would be wrong for most of the catalogue.
 * Only "Full-body Vitrified" carries its colour through, and only that gets an edge
 * derived from the face.
 *
 * Mixed WITH the face rather than replacing it, so a dark tile still gets a slightly
 * warmer body than a white one and the two never look like unrelated materials
 * bolted together.
 */
async function bodyColour(b64, material) {
  const { channels } = await sharp(decode(b64)).stats();
  const face = channels.slice(0, 3).map((c) => c.mean);
  return /full[\s-]?body/i.test(String(material || ''))
    ? scaleRgb(face, 0.78)
    : mixRgb(face, PORCELAIN_BODY, 0.78);
}

/**
 * Burns a scale bar onto a generated single-unit shot.
 *
 * The render is normalised to CANVAS first — the model does not always return
 * exactly 900×900, and an overlay drawn at 900 on an 1024 image lands short.
 *
 * @param {string} b64  base64 JPEG from imagenClient
 * @param {string} size Material size label, e.g. "1200 x 600 mm"
 * @returns {Promise<string>} base64 JPEG
 */
async function addScaleReference(b64, sizeLabel, { size } = {}) {
  const dims = parseSizeLabel(sizeLabel);
  if (!dims) return b64; // nothing to draw a bar against — pass the render through
  const { size: C } = await outputSize(b64, size);
  return asJpeg(
    sharp(decode(b64))
      .resize(C, C, { fit: 'cover' })
      .composite([{ input: svgBuf(scaleReferenceSvg(dims), C) }]),
  );
}

/**
 * Tiles one swatch into an N×N repeat preview.
 * @param {string} b64      base64 JPEG of a single repeat unit
 * @param {number} repeats  tiles per side, 2–6
 * @returns {Promise<string>} base64 JPEG
 */
async function compositeRepeatPreview(b64, repeats, { size } = {}) {
  const { size: C } = await outputSize(b64, size);
  const layout = repeatLayout(repeats, C);
  const cell = await sharp(decode(b64))
    .resize(layout.cellW, layout.cellH, { fit: 'cover' })
    .png()
    .toBuffer();

  const places = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      places.push({ input: cell, left: c * layout.cellW, top: r * layout.cellH });
    }
  }
  return asJpeg(
    blank('#111111', C).composite([...places, { input: Buffer.from(repeatPreviewSvg(layout, C)) }]),
  );
}

/**
 * A grid of one swatch with GROUT between the cells, as a tile buyer sees a laid floor.
 *
 * Distinct from compositeRepeatPreview, which butts the cells against each other
 * and draws hairline seams — that answers "does the pattern repeat cleanly?" for
 * wallpaper. This answers "what does it look like laid?" for tiles, where the
 * grout line is a real gap of a real width.
 *
 * The grout is not drawn: the cells are pasted `groutPx` apart over a dark ground,
 * and the ground showing through IS the grout.
 *
 * @param {string} b64
 * @param {object} [opts]
 * @param {number} [opts.cols=2]      cells per side, 2–6
 * @param {number} [opts.groutPx=6]
 * @param {string} [opts.groutColour='#111111']
 */
async function compositeGroutGrid(b64, { cols = 2, groutPx = 6, groutColour = '#111111', size } = {}) {
  const { size: C } = await outputSize(b64, size);
  const n = Math.max(2, Math.min(6, Math.round(cols)));
  const grout = Math.max(1, Math.round((groutPx * C) / CANVAS));
  const cell = Math.round((C - grout * (n - 1)) / n);
  const tile = await sharp(decode(b64)).resize(cell, cell, { fit: 'cover' }).png().toBuffer();

  const places = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      places.push({ input: tile, left: c * (cell + grout), top: r * (cell + grout) });
    }
  }
  return asJpeg(blank(groutColour, C).composite(places));
}

/**
 * The size shot: one unit drawn isometrically with a dimension arrow on each edge.
 *
 * This is the image the scale bar was a flat substitute for, and it is the one a
 * surface buyer reads first — the benchmark ships it on every SKU. Built from the
 * swatch, so it costs no model call at all.
 *
 * Geometry note: rotating a w×h rectangle 45° sends (x,y) to ((x−y)/√2, (x+y)/√2),
 * which puts the four corners at the offsets below INSIDE the bounding box — not at
 * the midpoints of its sides. For a square they coincide, so a square is not a
 * sufficient test of this function; the unit test uses 1200×600 for that reason.
 *
 * @param {string} b64   base64 JPEG of a flat, square-on swatch
 * @param {string} size  Material size label
 * @param {number} [thicknessMm]  drives the visible edge depth; omitted draws a hairline
 */
/**
 * Sheets are bought and talked about in FEET ("8 by 4"); tiles, stone and wallpaper in mm
 * ("600 by 600"). So laminates and panels get feet on the drawing and mm in the caption,
 * the rest the other way round (user, 2026-10-19) -- 600 mm as "1.97 ft" helps nobody.
 */
const FEET_CATEGORIES = /laminate|panel/i;
const ft = (mm) => String(Math.round((mm / 304.8) * 10) / 10).replace(/\.0$/, '');

async function compositeIsometric(b64, sizeLabel, thicknessMm, { size, category } = {}) {
  const dims = parseSizeLabel(sizeLabel);
  if (!dims) return b64;
  const feet = FEET_CATEGORIES.test(String(category || ''));
  const edgeLabel = (mm) => (feet ? `${ft(mm)} ft` : `${mm} mm`);

  const { size: C } = await outputSize(b64, size);
  const k = C / CANVAS;
  const px = (v) => Math.max(1, Math.round(v * k)); // 900-space -> output pixels

  const LONG = 520;
  const fw = LONG;
  const fh = Math.max(1, Math.round(LONG * (dims.heightMm / dims.widthMm)));

  // Rasterised at OUTPUT scale so the face is not resampled twice.
  const face = await sharp(decode(b64))
    .resize(px(fw), px(fh), { fit: 'cover' })
    .rotate(45, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const meta = await sharp(face).metadata();
  const D = Math.round(meta.width / k); // back to 900-space for the geometry below
  const preH = Math.round(meta.height / k);
  const H = Math.round(preH / 2);
  const squashed = await sharp(face).resize(px(D), px(H), { fit: 'fill' }).png().toBuffer();

  const sq = H / preH;
  const s2 = Math.SQRT2;
  const x = Math.round((CANVAS - D) / 2);
  const y = Math.round((CANVAS - H) / 2) - 40;

  const T = [x + fh / s2, y];
  const R = [x + D, y + (fw / s2) * sq];
  const B = [x + fw / s2, y + preH * sq];
  const L = [x, y + (fh / s2) * sq];

  const edge = thicknessMm > 0 ? Math.max(8, Math.round(thicknessMm * 1.6)) : 3;

  // A dimension line offset perpendicular from an edge — trigonometry only, so it
  // holds for any aspect ratio without a second set of hardcoded coordinates.
  const dim = (from, to, text) => {
    const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
    const len = Math.hypot(dx, dy) || 1;
    const [nx, ny] = [dy / len, -dx / len];
    const off = 58;
    const tick = 9;
    const [ax, ay] = [from[0] + nx * off, from[1] + ny * off];
    const [bx, by] = [to[0] + nx * off, to[1] + ny * off];
    const [mx, my] = [(ax + bx) / 2, (ay + by) / 2 - 12];
    const deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    return `
      <line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${INK}" stroke-width="2"/>
      <line x1="${ax - nx * tick}" y1="${ay - ny * tick}" x2="${ax + nx * tick}" y2="${ay + ny * tick}" stroke="${INK}" stroke-width="2"/>
      <line x1="${bx - nx * tick}" y1="${by - ny * tick}" x2="${bx + nx * tick}" y2="${by + ny * tick}" stroke="${INK}" stroke-width="2"/>
      <g transform="rotate(${deg} ${mx} ${my})">
        ${textSvg(text, { x: mx, y: my, size: 28, weight: 'Bold', anchor: 'middle', fill: INK, halo: 6 })}
      </g>`;
  };

  // Two edge faces at different tones: the left one catches light, the right one is
  // in shade. Same slab, and the tonal split is what makes it read as solid.
  const behind = svgBuf(`
    <polygon points="${L[0]},${L[1]} ${B[0]},${B[1]} ${B[0]},${B[1] + edge} ${L[0]},${L[1] + edge}" fill="#d5cfc3"/>
    <polygon points="${B[0]},${B[1]} ${R[0]},${R[1]} ${R[0]},${R[1] + edge} ${B[0]},${B[1] + edge}" fill="#b3aa9a"/>
    <line x1="${L[0]}" y1="${L[1] + edge}" x2="${B[0]}" y2="${B[1] + edge}" stroke="#9c9384" stroke-width="1.5"/>
    <line x1="${B[0]}" y1="${B[1] + edge}" x2="${R[0]}" y2="${R[1] + edge}" stroke="#9c9384" stroke-width="1.5"/>`, C);

  const front = svgBuf(`
    ${dim(L, T, edgeLabel(dims.heightMm))}
    ${dim(T, R, edgeLabel(dims.widthMm))}
    <line x1="${L[0]}" y1="${L[1]}" x2="${T[0]}" y2="${T[1]}" stroke="#ffffff" stroke-width="1.5" opacity="0.55"/>
    <line x1="${T[0]}" y1="${T[1]}" x2="${R[0]}" y2="${R[1]}" stroke="#ffffff" stroke-width="1.5" opacity="0.55"/>
    ${textSvg(`one unit · ${
      feet ? `${ft(dims.widthMm)} × ${ft(dims.heightMm)} ft  (${dims.widthMm} × ${dims.heightMm} mm)` : sizeLabelText(dims)
    }${thicknessMm > 0 ? ` · ${thicknessMm} mm thick` : ''}`, {
      x: CANVAS / 2, y: CANVAS - 40, size: 24, weight: 'Medium', anchor: 'middle', fill: '#666666',
    })}`, C);

  const shadow = await sharp(
    svgBuf(
      `<ellipse cx="${B[0]}" cy="${B[1] + edge + 16}" rx="${D * 0.36}" ry="20"
                fill="#000000" opacity="0.22"/>`,
      C,
    ),
  )
    .blur(18 * k)
    .png()
    .toBuffer();

  return asJpeg(
    blank('#ffffff', C).composite([
      { input: shadow },
      { input: behind },
      { input: squashed, left: px(x), top: px(y) },
      { input: front },
    ]),
  );
}

/**
 * The thickness shot: a CORNER of the slab, close up, with the cut edge measured.
 *
 * Framed the way the benchmark frames it, and the framing is most of the quality: the
 * tile bleeds off the top and both sides, so the edge is a big readable band and there
 * is no dead space. Showing the whole slab from further back — which this did before —
 * reads as a diagram rather than a photograph.
 *
 * The near CORNER is the other half. Depth turning a corner is what sells thickness;
 * one straight edge does not, however correctly it is drawn. Both edge faces come out
 * of the same 45-degree rotation compositeIsometric uses, just scaled past the canvas
 * and cropped to the corner.
 *
 * ponytail: affine, so parallel edges stay parallel — the benchmark's shot has true
 * converging perspective and this does not. Closing that needs a per-scanline warp over
 * raw pixels (libvips has no homography), which is ~40 lines for the last 20% of the
 * effect. The corner crop plus the layered edge is the cheap 80%; revisit if the flat
 * projection actually reads wrong on a real PDP.
 *
 * @param {string} b64          flat, square-on swatch
 * @param {number} thicknessMm
 * @param {object} [opts]
 * @param {string} [opts.sizeLabel]  drives the face aspect; square when absent
 * @param {string} [opts.material]   `custom.material`. A GLAZED tile (Vitrified,
 *   Ceramic, Porcelain) has a PALE body whatever the glaze looks like — the benchmark's
 *   own 9 mm vitrified shot has a warm grey edge under a speckled face, so sampling the
 *   face would be wrong for most of the catalogue. Only "Full-body Vitrified" carries
 *   its colour through, and only that gets an edge derived from the face.
 */
async function compositeThickness(b64, thicknessMm, { sizeLabel, material, size } = {}) {
  const mm = Number(thicknessMm);
  if (!(mm > 0)) return b64;

  const { size: C } = await outputSize(b64, size);
  const k = C / CANVAS;
  const px = (v) => Math.max(1, Math.round(v * k));

  const dims = parseSizeLabel(sizeLabel);
  const ratio = dims ? dims.heightMm / dims.widthMm : 1;

  // Deliberately larger than the canvas: what does not fit is the bleed.
  const LONG = 1500;
  const fw = LONG;
  const fh = Math.max(1, Math.round(LONG * ratio));

  const face = await sharp(decode(b64))
    .resize(px(fw), px(fh), { fit: 'cover' })
    .rotate(45, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const fm = await sharp(face).metadata();
  const D = Math.round(fm.width / k); // back to 900-space
  const preH = Math.round(fm.height / k);
  const H = Math.round(preH / 2);
  const squashed = await sharp(face).resize(px(D), px(H), { fit: 'fill' }).png().toBuffer();

  // Corner vertices in the squashed image's own coordinates.
  const s2 = Math.SQRT2;
  const sq = H / preH;
  const bImg = [fw / s2, preH * sq]; // the near corner: bottom vertex
  const lImg = [0, (fh / s2) * sq];
  const rImg = [D, (fw / s2) * sq];

  // Where that corner should land on the canvas. Left of centre and low, so the two
  // edge faces run off both sides and there is room beneath for the callout.
  const TARGET = [370, 610];
  const cropL = Math.max(0, Math.round(bImg[0] - TARGET[0]));
  const cropT = Math.max(0, Math.round(bImg[1] - TARGET[1]));
  const cropW = Math.min(CANVAS, D - cropL);
  const cropH = Math.min(CANVAS, H - cropT);

  const toCanvas = ([cx, cy]) => [cx - cropL, cy - cropT];
  const B = toCanvas(bImg);
  const L = toCanvas(lImg); // off-canvas left, by design
  const R = toCanvas(rImg); // off-canvas right, by design

  // Raster crop, so in output pixels; the vertices above stay in 900-space.
  // Clamped to the raster: left and width are each rounded separately, so with some photo
  // sizes their sum lands 1px past the edge and libvips refuses the whole crop ("bad extract
  // area") -- which silently dropped the thickness shot for one colour of SK0102 (2026-10-19).
  const rw = px(D);
  const rh = px(H);
  const rcLeft = Math.min(px(cropL), rw - 1);
  const rcTop = Math.min(px(cropT), rh - 1);
  const rc = {
    left: rcLeft,
    top: rcTop,
    width: Math.min(px(cropW), rw - rcLeft),
    height: Math.min(px(cropH), rh - rcTop),
  };
  const cropped = await sharp(squashed).extract(rc).png().toBuffer();

  /* ── lighting on the face, clipped to the face ─────────────────────────────
     blend 'atop' paints only where the destination is already opaque, so the
     gradient lands on the tile and not on the white ground around it. Without a
     falloff the face reads as flat artwork rather than a lit surface. */
  const lit = await sharp(cropped)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${rc.width}" height="${rc.height}" xmlns="http://www.w3.org/2000/svg">
             <defs><linearGradient id="l" x1="0.1" y1="0" x2="0.75" y2="1">
               <stop offset="0" stop-color="#ffffff" stop-opacity="0.30"/>
               <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.04"/>
               <stop offset="1" stop-color="#000000" stop-opacity="0.14"/>
             </linearGradient></defs>
             <rect width="${rc.width}" height="${rc.height}" fill="url(#l)"/>
           </svg>`,
        ),
        blend: 'atop',
      },
    ])
    .png()
    .toBuffer();

  const base = await bodyColour(b64, material);

  const depth = Math.max(28, Math.min(104, Math.round(mm * 6)));
  const lipH = Math.max(3, Math.round(depth * 0.13));
  const chamH = Math.max(3, Math.round(depth * 0.16));

  /**
   * One edge face, as three stacked bands: the glaze lip catching light at the top,
   * the body, then a chamfer in shadow at the bottom. A single flat band is what made
   * this look printed on; a real cut edge has those three.
   *
   * `k` shades the whole face — the left one is lit, the right one is turned away.
   */
  const edgeFace = (from, to, shade) => {
    const band = (top, h, tint) => {
      const y0from = from[1] + top;
      const y0to = to[1] + top;
      return `<polygon points="${from[0]},${y0from} ${to[0]},${y0to} ${to[0]},${y0to + h} ${from[0]},${y0from + h}"
               fill="${hexOf(scaleRgb(base, shade * tint))}"/>`;
    };
    return [
      band(0, lipH, 1.16),
      band(lipH, depth - lipH - chamH, 1.0),
      band(depth - chamH, chamH, 0.8),
      // The join between glaze and body, which is a visible line on a real tile.
      `<line x1="${from[0]}" y1="${from[1] + lipH}" x2="${to[0]}" y2="${to[1] + lipH}"
             stroke="${hexOf(scaleRgb(base, shade * 0.72))}" stroke-width="1.2" opacity="0.8"/>`,
    ].join('\n');
  };

  const edges = svgBuf(`
    ${edgeFace(L, B, 1.04)}
    ${edgeFace(B, R, 0.86)}
    <line x1="${L[0]}" y1="${L[1]}" x2="${B[0]}" y2="${B[1]}" stroke="#ffffff" stroke-width="1.2" opacity="0.4"/>
    <line x1="${B[0]}" y1="${B[1]}" x2="${R[0]}" y2="${R[1]}" stroke="#ffffff" stroke-width="1.2" opacity="0.25"/>`, C);

  const shadow = await sharp(
    svgBuf(`<ellipse cx="${B[0] + 60}" cy="${B[1] + depth + 20}" rx="330" ry="24"
              fill="#000000" opacity="0.26"/>`, C),
  )
    .blur(18 * k)
    .png()
    .toBuffer();

  /* ── the callout ──────────────────────────────────────────────────────────── */
  // The bracket measures the LEFT edge face where it actually sits, rather than
  // floating near it: the band's top follows the L→B line, so the bracket is placed
  // on that line at its own x. A bracket that does not touch the thing it measures
  // is decoration.
  const bx = Math.round(B[0] * 0.6);
  const slope = (B[1] - L[1]) / (B[0] - L[0] || 1);
  const bTop = L[1] + slope * (bx - L[0]);

  const halo = (tx, ty, size, weight, text) =>
    textSvg(text, { x: tx, y: ty, size, weight: weight >= 700 ? 'Bold' : 'SemiBold', anchor: 'end', fill: INK, halo: 6 });

  const front = svgBuf(`
    <line x1="${bx}" y1="${bTop}" x2="${bx}" y2="${bTop + depth}" stroke="${INK}" stroke-width="3"/>
    <line x1="${bx - 13}" y1="${bTop}" x2="${bx + 13}" y2="${bTop}" stroke="${INK}" stroke-width="3"/>
    <line x1="${bx - 13}" y1="${bTop + depth}" x2="${bx + 13}" y2="${bTop + depth}" stroke="${INK}" stroke-width="3"/>
    ${halo(bx - 26, bTop + depth / 2 - 6, 22, 600, 'Thickness')}
    ${halo(bx - 26, bTop + depth / 2 + 28, 34, 700, `${mm} mm`)}`, C);

  return asJpeg(
    blank('#ffffff', C).composite([
      { input: shadow },
      { input: edges },
      { input: lit, left: 0, top: 0 },
      { input: front },
    ]),
  );
}

/* ── the studio ground, derived from the tile ────────────────────────────────── */

function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6
    : max === g ? ((b - r) / d + 2) / 6
    : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0) => {
    const t = (t0 + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

// The band the wall is allowed to live in. Narrow ON PURPOSE — see studioGround.
// Tuned against the benchmark's own cream (#ecdcae), which is HSL(0.12, 0.62, 0.80):
// a first pass at sat 0.16 / L up to 0.92 was washed out to near-white and lost the
// warmth entirely. A studio sweep is a SATURATED pale colour, not a grey.
// Sampled off the reference: its wall is HSL(~0.09, 0.41, 0.64) and its lit corner
// panel HSL(~0.09, 0.62, 0.82). Both earlier passes were too LIGHT and too
// desaturated — 0.36/0.86 rendered a pale grey where the set is a mid cream.
const WALL_MIN_L = 0.6;
const WALL_MAX_L = 0.78;
const WALL_SAT = 0.42;
// Where a greyscale tile's background takes its hue from: a warm cream, because a
// neutral grey ground makes a white tile look like a missing image.
const NEUTRAL_HUE = 0.11;

/**
 * A studio ground that suits THIS tile without breaking the catalogue.
 *
 * The tension: one fixed cream keeps a collection page coherent, which is why the
 * benchmark uses one — but a pale tile then nearly vanishes into it, which is exactly
 * what happened to the white alabaster swatch. Free per-product colour fixes the
 * contrast and destroys the coherence: forty products against forty backgrounds reads
 * as a broken grid, not a catalogue.
 *
 * So the hue comes from the tile and everything else is clamped: saturation pinned
 * low, lightness confined to a 0.72–0.92 band, and pushed DOWN as the tile gets
 * lighter so the unit always separates from its ground. Every background is a pale
 * tint of its own product, and any two sit together on a collection page.
 *
 * @param {string} b64
 * @param {string} [override]  a fixed wall colour; the derivation is skipped entirely
 */
async function studioGround(b64, override) {
  const { channels } = await sharp(decode(b64)).stats();
  const face = channels.slice(0, 3).map((c) => c.mean / 255);
  const [h, s, l] = rgbToHsl(face);

  const hue = s < 0.05 ? NEUTRAL_HUE : h;
  // The contrast rule: a tile up to ~0.62 lightness sits on the brightest wall; past
  // that the wall darkens with it, so the gap never closes.
  const wallL = Math.max(WALL_MIN_L, Math.min(WALL_MAX_L, 0.82 - Math.max(0, l - 0.62) * 0.6));

  const at = (sat, light) => hexOf(hslToRgb([hue, sat, light]).map((n) => n * 255));

  if (override) {
    return { wall: override, floor: override, floorNear: override, line: override, glow: override, junction: override, pool: '#fffaea', shadow: '#6d5a33', wallL };
  }
  return {
    wall: at(WALL_SAT, wallL),
    // A DIFFUSE GLOW from the lower right, not a wall panel. Profiling a row above
    // the tile gives a flat 200-205 the whole way across with no step anywhere; the
    // bright region only appears further down (203 at y=2% rising to 242 at y=45%).
    // An earlier pass read one sample at x=96%/y=18%, concluded "room corner", and
    // drew a hard vertical seam that is not in the reference at all.
    glow: at(WALL_SAT * 1.6, Math.min(0.9, wallL + 0.19)),
    // The wall darkens towards the floor — 201 at the top against 175 just above the
    // junction. Ambient occlusion, and the thing that stops the set feeling weightless.
    junction: at(WALL_SAT * 1.15, Math.max(0.3, wallL - 0.12)),
    // The floor is lighter than the wall, which is what a lit sweep looks like and
    // what gives the horizon its edge without drawing a hard line for it.
    floor: at(WALL_SAT * 1.2, Math.min(0.88, wallL + 0.11)),
    line: at(WALL_SAT * 1.3, wallL - 0.1),
    floorNear: at(WALL_SAT * 1.35, Math.min(0.9, wallL + 0.125)),
    pool: at(WALL_SAT * 0.45, 0.94),
    shadow: at(WALL_SAT * 1.6, Math.max(0.2, wallL - 0.48)),
    wallL,
  };
}

/* ── perspective, the only way libvips will give it to you ───────────────────
   A tile standing on a floor is a TRAPEZOID: the near edge is taller than the far
   one and its verticals stay vertical. Affine cannot make that shape — it maps
   rectangles to parallelograms, so parallel stays parallel — and libvips has no
   homography operation.

   So the plane is sliced into N vertical strips and each is resized to its own
   height and offset, which is exactly a trapezoid once they are laid side by side.
   Verticals staying vertical is what makes the cheap version correct here rather
   than merely close: for a plane rotated about the vertical axis only, a per-column
   scale IS the perspective transform.

   ponytail: N=48 strips, each one a sharp resize. ~50ms and visually seamless at
   900px (strips are 12px wide and overlap by 1). A smooth per-pixel warp would need
   raw pixel access; revisit only if output above ~2000px shows banding. */
/**
 * Catmull-Rom, four taps. Bilinear was measured SOFTER than the sharp resizes this
 * replaced (studio energy 7.03 -> 6.37): a linear filter has no negative lobes, so it
 * cannot hold an edge the way lanczos does. Cubic gets the sharpness back while
 * keeping the exact per-column geometry that made the rewrite worth doing.
 */
const cubic = (p0, p1, p2, p3, f) =>
  p1 +
  0.5 *
    f *
    (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));

/**
 * Warps a face into a trapezoid: one column at a time, in raw pixels.
 *
 * Was 48 sharp resizes, one per vertical strip. That quantised the column height into
 * 48 steps — measured at 4.6px per step on a 1600px canvas, a visible staircase along
 * the sloping edges that reads as softness. Raising the strip count fixed the geometry
 * and made it unusably slow: 420 strips is 420 resize-plus-PNG-encode round trips.
 *
 * So the resampling happens here instead, which gives EVERY output column its own
 * exact height — sub-pixel, no staircase — in a single pass over the pixels. Box
 * average horizontally (the face is always being reduced, so neighbouring source
 * columns must be averaged or it aliases) and bilinear vertically.
 *
 * Verticals stay vertical for a plane rotated about the vertical axis only, so a
 * per-column vertical scale IS the exact perspective transform, not an approximation.
 *
 * @returns {{data:Buffer, info:{width,height,channels}, top:number}}
 */
async function warpTrapezoid(faceBuf, { outW, hNear, hFar, topNear, topFar }) {
  const { data: src, info } = await sharp(faceBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: fw, height: fh } = info;
  const CH = 4;

  const bTop = Math.floor(Math.min(topNear, topFar));
  const bBot = Math.ceil(Math.max(topNear + hNear, topFar + hFar));
  const outH = Math.max(1, bBot - bTop);
  const out = Buffer.alloc(outW * outH * CH, 0);

  for (let x = 0; x < outW; x++) {
    const t = (x + 0.5) / outW;
    const h = hNear + (hFar - hNear) * t;
    const top = topNear + (topFar - topNear) * t;

    // One source column per output column: the horizontal reduction already happened
    // in sharp, with lanczos. Box-averaging it here as well measured softer than the
    // strip version it replaced — lanczos holds an edge that a box filter cannot.
    const sx = Math.min(fw - 1, x);

    const yStart = Math.max(0, Math.round(top) - bTop);
    const yEnd = Math.min(outH, Math.round(top + h) - bTop);

    for (let y = yStart; y < yEnd; y++) {
      // Where this output row sits down the column, mapped back to source rows.
      const v = ((y + bTop - top) / h) * (fh - 1);
      const y1 = Math.max(0, Math.min(fh - 1, Math.floor(v)));
      const fy = v - y1;
      const y0 = Math.max(0, y1 - 1);
      const y2 = Math.min(fh - 1, y1 + 1);
      const y3 = Math.min(fh - 1, y1 + 2);

      const o0 = (y0 * fw + sx) * CH;
      const o1 = (y1 * fw + sx) * CH;
      const o2 = (y2 * fw + sx) * CH;
      const o3 = (y3 * fw + sx) * CH;
      const o = (y * outW + x) * CH;
      out[o] = clamp255(cubic(src[o0], src[o1], src[o2], src[o3], fy));
      out[o + 1] = clamp255(cubic(src[o0 + 1], src[o1 + 1], src[o2 + 1], src[o3 + 1], fy));
      out[o + 2] = clamp255(cubic(src[o0 + 2], src[o1 + 2], src[o2 + 2], src[o3 + 2], fy));
      out[o + 3] = clamp255(cubic(src[o0 + 3], src[o1 + 3], src[o2 + 3], src[o3 + 3], fy));
    }
  }

  return { data: out, info: { width: outW, height: outH, channels: CH }, top: bTop };
}

/**
 * The studio shot: one unit standing on a seamless floor, lit from above.
 *
 * The benchmark's hero image, and the one that has to look like a photograph rather
 * than a diagram — it is the first thing on the PDP. Everything in it is fixed except
 * the face and the body colour, so it costs no model call:
 *
 *   the ground     a warm cream wall and floor with a light pool, drawn in SVG
 *   the tile       the swatch warped to a trapezoid (see warpTrapezoid)
 *   the near edge  a tapered sliver in the body colour, so thickness reads
 *   the shadow     a broad soft pool plus a tight contact line at the base
 *
 * @param {string} b64
 * @param {object} [opts]
 * @param {string} [opts.sizeLabel]   face aspect; square when absent
 * @param {number} [opts.thicknessMm] width of the visible near edge
 * @param {string} [opts.material]    glazed vs full-body — see bodyColour
 * @param {string} [opts.bg]          fixed wall colour; omit to derive it — see studioGround
 */
async function compositeStudio(b64, { sizeLabel, thicknessMm, material, bg, size } = {}) {
  const { size: C } = await outputSize(b64, size);
  const k = C / CANVAS;
  const px = (v) => Math.max(1, Math.round(v * k));
  const dims = parseSizeLabel(sizeLabel);
  const ratio = dims ? dims.heightMm / dims.widthMm : 1;

  // The standing tile, in canvas coordinates. Near edge on the LEFT and taller, so
  // the unit recedes to the right — the benchmark's angle, and it leaves the open
  // side of the frame for the floor light.
  /* ── the pose ──────────────────────────────────────────────────────────────
     Measured off the benchmark's hero shot rather than guessed, because the first
     pass looked pasted on and the numbers say exactly why: the tile was 71% of the
     frame instead of 82%, and its base sat EXACTLY on the horizon line.

     That last one is the whole illusion. A floor recedes towards the viewer, so a
     tile standing on it has its near corner IN FRONT of the wall/floor junction —
     7.5% of the frame in front, in the reference. Base on the horizon reads as a
     sticker on the seam, however correct the perspective above it is. */
  // Extracted from the reference by masking its tile silhouette and reading the
  // longest contiguous run per column, then fitting the two sloping edges:
  //   xNear 0.173  width 0.657  nearH 0.802  base 0.878  far/near 0.830
  // The earlier numbers were read off the image by eye and had the unit 0.03 too
  // far left and 0.02 too tall.
  const BASE_Y = Math.round(CANVAS * 0.878);
  const FLOOR = Math.round(CANVAS * 0.817);
  const X_NEAR = Math.round(CANVAS * 0.173);
  const FORESHORTEN = 0.819; // measured width / measured near height
  const FAR_SCALE = 0.83;
  const TOP_SHIFT = 0.593;

  // Fitted rather than fixed, so a plank and a tall format both stay in frame.
  const BUDGET_W = Math.round(CANVAS * 0.657);
  const BUDGET_H = Math.round(CANVAS * 0.802);
  const trueW = Math.min(BUDGET_W / FORESHORTEN, BUDGET_H / ratio);

  const outW = Math.round(trueW * FORESHORTEN);
  const hNear = Math.round(trueW * ratio);
  const hFar = Math.round(hNear * FAR_SCALE);
  const baseY = BASE_Y;
  const topNear = baseY - hNear;
  const topFar = topNear + Math.round((hNear - hFar) * TOP_SHIFT);
  const xNear = X_NEAR;

  // Source at the OUTPUT size, so each strip is close to 1:1 and nothing is resampled
  // twice. Rendering at 900 wide and then squeezing every strip from 18px to 13px
  // was visibly softening the face — the texture is the product, so it has to survive.
  // No supersampling, measured. Both axes land at their target size here, so sharp's
  // lanczos does the whole reduction once; warpTrapezoid then rescales each column
  // vertically by between 0.83 and 1.0, which is near enough to identity that there is
  // nothing to supersample FOR. Rendering the face 1.6x tall first and letting the warp
  // pull it back down measured worse (studio 8.32 vs 9.01) — it is an upscale followed
  // by a downscale, and each one costs detail.
  const fw = px(outW);
  const fh = px(hNear);
  const flat = await sharp(decode(b64)).resize(fw, fh, { fit: 'cover' }).png().toBuffer();

  // Warped in OUTPUT pixels — the raster layer is the one place the resolved size
  // has to be threaded all the way through.
  const warp = await warpTrapezoid(flat, {
    outW: px(outW),
    hNear: px(hNear),
    hFar: px(hFar),
    topNear: px(topNear),
    topFar: px(topFar),
  });

  const tileW = warp.info.width;
  const bboxH = warp.info.height;
  const bboxTop = warp.top;
  const tile = await sharp(warp.data, { raw: warp.info }).png().toBuffer();

  // Shade the face: brighter at the near edge, falling off as it turns away. Clipped
  // to the tile by `atop`, which paints only over already-opaque pixels.
  const litTile = await sharp(tile)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${tileW}" height="${bboxH}" xmlns="http://www.w3.org/2000/svg">
             <defs>
               <linearGradient id="g" x1="0" y1="0" x2="1" y2="0.25">
                 <stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/>
                 <stop offset="0.4" stop-color="#ffffff" stop-opacity="0.0"/>
                 <stop offset="1" stop-color="#ffffff" stop-opacity="0.09"/>
               </linearGradient>
               <!-- The softbox, reflected. A studio light is a large rectangle, so what
                    it leaves on a surface is a broad soft band, never a hot spot. Faint
                    enough for a matte tile, and the main cue that this is a lit OBJECT
                    rather than a texture pasted onto a background. -->
               <linearGradient id="gloss" x1="0.05" y1="0" x2="0.75" y2="1">
                 <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
                 <stop offset="0.26" stop-color="#ffffff" stop-opacity="0.085"/>
                 <stop offset="0.42" stop-color="#ffffff" stop-opacity="0.02"/>
                 <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
               </linearGradient>
               <!-- Grazing angles reflect more, so the far edge picks up light the
                    face-on part does not. -->
               <linearGradient id="fresnel" x1="0.82" y1="0" x2="1" y2="0">
                 <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
                 <stop offset="1" stop-color="#ffffff" stop-opacity="0.13"/>
               </linearGradient>
             </defs>
             <rect width="${tileW}" height="${bboxH}" fill="url(#g)"/>
             <rect width="${tileW}" height="${bboxH}" fill="url(#gloss)"/>
             <rect width="${tileW}" height="${bboxH}" fill="url(#fresnel)"/>
           </svg>`,
        ),
        blend: 'atop',
      },
    ])
    .png()
    .toBuffer();

  /* ── the ground ───────────────────────────────────────────────────────────── */
  const g = await studioGround(b64, bg);
  const ground = svgBuf(`
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0" stop-color="${g.wall}" stop-opacity="0.74"/>
        <stop offset="0.55" stop-color="${g.wall}"/>
        <stop offset="1" stop-color="${g.wall}" stop-opacity="0.9"/>
      </linearGradient>
      <radialGradient id="pool" cx="0.78" cy="0.94" r="0.5">
        <stop offset="0" stop-color="${g.pool}" stop-opacity="0.85"/>
        <stop offset="1" stop-color="${g.pool}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${g.floor}"/>
        <stop offset="1" stop-color="${g.floorNear}"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.99" cy="0.55" r="0.62">
        <stop offset="0" stop-color="${g.glow}" stop-opacity="1"/>
        <stop offset="0.45" stop-color="${g.glow}" stop-opacity="0.5"/>
        <stop offset="1" stop-color="${g.glow}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="junction" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${g.junction}" stop-opacity="0"/>
        <stop offset="1" stop-color="${g.junction}" stop-opacity="0.75"/>
      </linearGradient>
    </defs>
    <rect width="${CANVAS}" height="${FLOOR}" fill="${g.wall}"/>
    <rect width="${CANVAS}" height="${FLOOR}" fill="url(#glow)"/>
    <rect y="${FLOOR - 210}" width="${CANVAS}" height="210" fill="url(#junction)"/>
    <rect y="${FLOOR}" width="${CANVAS}" height="${CANVAS - FLOOR}" fill="url(#floor)"/>
    <rect width="${CANVAS}" height="${CANVAS}" fill="url(#pool)"/>
    <line x1="0" y1="${FLOOR}" x2="${CANVAS}" y2="${FLOOR}" stroke="${g.junction}" stroke-width="1.5" opacity="0.4"/>`, C);

  /* ── the near edge, and the shadow it sits in ─────────────────────────────── */
  const base = await bodyColour(b64, material);
  const mm = Number(thicknessMm) || 0;
  // ~1 px per mm at this zoom would be invisible, so the sliver is exaggerated the
  // way the benchmark's is — thickness has to READ, and 9 mm on a 600 mm tile is
  // under 2% of the width.
  const depth = mm > 0 ? Math.max(8, Math.min(26, Math.round(mm * 1.4))) : 0;

  // Graded across its width — lit where it meets the face, falling into shadow at the
  // back. A flat fill read as a black border on the dark full-body marble.
  const edge = depth
    ? `<defs><linearGradient id="ed" x1="1" y1="0" x2="0" y2="0">
         <stop offset="0" stop-color="${hexOf(scaleRgb(base, 1.1))}"/>
         <stop offset="1" stop-color="${hexOf(scaleRgb(base, 0.72))}"/>
       </linearGradient></defs>
       <polygon points="${xNear},${topNear} ${xNear},${baseY}
                        ${xNear - depth},${baseY - 7} ${xNear - depth},${topNear + 9}"
                fill="url(#ed)"/>
       <line x1="${xNear}" y1="${topNear}" x2="${xNear}" y2="${baseY}"
             stroke="${hexOf(scaleRgb(base, 1.2))}" stroke-width="1" opacity="0.7"/>`
    : '';

  // A hairline round the silhouette. The warped strips leave a soft, faintly stepped
  // boundary; the reference's edges are crisp, and an unresolved edge is the fastest
  // way for a composite to read as fake.
  // A tile has a chamfer round its glazed face, and that chamfer is what the eye reads
  // as a solid object: lit along the top and near edges where it faces the light, dark
  // along the bottom where it turns away. One uniform outline — which is what this was
  // — reads as a sticker cut out of the background.
  const outline = svgBuf(`
    <line x1="${xNear}" y1="${topNear}" x2="${xNear + outW}" y2="${topFar}"
          stroke="#ffffff" stroke-width="1.6" opacity="0.5"/>
    <line x1="${xNear}" y1="${topNear}" x2="${xNear}" y2="${baseY}"
          stroke="#ffffff" stroke-width="1.4" opacity="0.34"/>
    <line x1="${xNear + outW}" y1="${topFar}" x2="${xNear + outW}" y2="${topFar + hFar}"
          stroke="${g.junction}" stroke-width="1.2" opacity="0.42"/>
    <line x1="${xNear}" y1="${baseY}" x2="${xNear + outW}" y2="${topFar + hFar}"
          stroke="${g.junction}" stroke-width="1.4" opacity="0.5"/>`, C);

  // Two shadows, blurred together: the pool the unit stands in, and the one it throws
  // back onto the wall. Offset left and slightly up, as a light source above and to
  // the right of camera would put it.
  const wallShadow = await sharp(
    svgBuf(`
      <polygon points="${xNear - 54},${topNear + 26} ${xNear + outW * 0.5},${topFar + 34}
                       ${xNear + outW * 0.5},${baseY - 10} ${xNear - 54},${baseY + 6}"
               fill="${g.shadow}" opacity="0.22"/>`, C),
  )
    .blur(34 * k)
    .png()
    .toBuffer();

  /* ── what actually sits under the tile ────────────────────────────────────
     Measured off the reference rather than assumed. Sampling a column just below
     the base gives 217 213 213 212 213 214 213 — FLAT. There is no reflected image
     on that floor at all; the only feature is a 3px contact line dropping to ~112
     before the tone returns to the floor's own.

     ponytail: a mirrored reflection used to live here and has been deleted. A
     polished-floor mirror is the studio trope, but this set does not have one, and
     a 1:1 vertical flip is not what a receding floor plane would reflect anyway —
     it read as a detached copy of the tile hanging below it. */
  const shadow = await sharp(
    svgBuf(`
      <ellipse cx="${xNear + outW * 0.40}" cy="${baseY + 24}" rx="${outW * 0.66}" ry="30"
               fill="${g.shadow}" opacity="0.26"/>`, C),
  )
    .blur(30 * k)
    .png()
    .toBuffer();

  // Separate pass, barely blurred: the line where the unit meets the floor. Blurred
  // together with the pool above it, this smeared into a grey haze instead of
  // reading as contact.
  // Contact hardening. A shadow is darkest and sharpest exactly where the object meets
  // the ground and loses both with distance; one blur radius for the whole shadow is
  // the clearest tell that a composite was not photographed. Three passes: a wide soft
  // pool, a mid skirt, and a tight dark line at the contact itself.
  const contact = await sharp(
    svgBuf(`
      <polygon points="${xNear - depth},${baseY - 3} ${xNear + outW},${topFar + hFar - 3}
                       ${xNear + outW},${topFar + hFar + 5} ${xNear - depth},${baseY + 7}"
               fill="${g.shadow}" opacity="0.92"/>`, C),
  )
    .blur(2 * k)
    .png()
    .toBuffer();

  const nearShadow = await sharp(
    svgBuf(`
      <polygon points="${xNear - depth},${baseY} ${xNear + outW},${topFar + hFar}
                       ${xNear + outW},${topFar + hFar + 26} ${xNear - depth},${baseY + 34}"
               fill="${g.shadow}" opacity="0.4"/>`, C),
  )
    .blur(11 * k)
    .png()
    .toBuffer();

  return asJpeg(
    blank(g.wall, C).composite([
      { input: ground },
      { input: wallShadow },
      { input: shadow },
      { input: nearShadow },
      { input: contact },
      { input: svgBuf(edge, C) },
      { input: litTile, left: px(xNear), top: bboxTop },
      { input: outline },
    ]),
  );
}

/* ── features: upright panel + zoom loupe + 3–4 callouts, on white ────────── */

// Line icons in a 48-unit box, stroked in the card ink. Picked by keyword off the
// label the merchant types, so the form is just text boxes.
// ponytail: keyword match, first hit wins. Add an explicit icon picker only if
// labels start landing on the wrong icon.
const FEATURE_ICONS = [
  [/uv|sun|yellow|fade/i, '<circle cx="24" cy="24" r="8"/><path d="M24 6v6M24 36v6M6 24h6M36 24h6M11.3 11.3l4.2 4.2M32.5 32.5l4.2 4.2M11.3 36.7l4.2-4.2M32.5 15.5l4.2-4.2"/>'],
  [/water|moist|damp|wet/i, '<path d="M24 7C24 7 12 21 12 29a12 12 0 0 0 24 0C36 21 24 7 24 7z"/><path d="M18 30a6 6 0 0 0 6 6"/>'],
  [/fire|flame|heat/i, '<path d="M24 6c2 7 10 11 10 21a10 10 0 0 1-20 0c0-6 4-8 4-13 3 3 3 6 3 8 2-4 3-10 3-16z"/>'],
  [/rust|corros/i, '<path d="M24 6l14 5v11c0 10-6 17-14 20-8-3-14-10-14-20V11z"/><path d="M17 17l14 14M31 17L17 31"/>'],
  [/warrant|guarant|year/i, '<circle cx="24" cy="20" r="11"/><path d="M18 29l-4 13 10-5 10 5-4-13"/><path d="M19.5 20l3 3 6-6"/>'],
  [/light|weight/i, '<path d="M36 8C20 10 12 22 12 38c12-2 22-12 24-30z"/><path d="M12 38l14-16M18 30h8M21 26l-1-6"/>'],
  [/durab|strong|strength|impact|tough|crack/i, '<path d="M24 6l14 5v11c0 10-6 17-14 20-8-3-14-10-14-20V11z"/><path d="M18 24l4 4 8-8"/>'],
  [/scratch|stain|clean|maint/i, '<path d="M24 8l3.5 9.5L37 21l-9.5 3.5L24 34l-3.5-9.5L11 21l9.5-3.5z"/><path d="M37 32l1.5 3.5L42 37l-3.5 1.5L37 42l-1.5-3.5L32 37l3.5-1.5z"/>'],
  [/termite|borer|insect|bug/i, '<ellipse cx="24" cy="27" rx="7" ry="10"/><circle cx="24" cy="14" r="4"/><path d="M17 22l-7-4M17 28h-8M17 34l-7 4M31 22l7-4M31 28h8M31 34l7 4M22 10l-3-4M26 10l3-4"/>'],
  [/vertical|horizontal|install|appl|fit/i, '<path d="M24 8v32M17 15l7-7 7 7M17 33l7 7 7-7"/>'],
  [/flex|bend/i, '<path d="M8 34c8 0 8-20 16-20s8 20 16 20"/>'],
];
const FALLBACK_ICON = '<circle cx="24" cy="24" r="15"/><path d="M17 24l5 5 9-10"/>';
const iconFor = (label) => (FEATURE_ICONS.find(([re]) => re.test(label)) || [, FALLBACK_ICON])[1];

/** "10 years warranty" → "10 Years Warranty"; leaves "UV" and "PVC" alone. */
const titleCase = (s) => s.replace(/(^|[\s(/-])([a-z])/g, (_, p, c) => p + c.toUpperCase());

const FEAT_INK = '#2f2a25';   // warm charcoal: softer than black on white
const FEAT_LINE = '#e4ded6';  // hairlines and card border
const FEAT_TINT = '#f6f2ed';  // icon discs
const LOUPE_ZOOM = 2.2;       // detail magnification over the panel face
const LOUPE_MAX_UPSCALE = 1.25; // past this the loupe shows blur, so zoom gives way

const fonts = {};
const brandFont = (weight) =>
  (fonts[weight] ||= opentype.loadSync(path.join(__dirname, 'fonts', `BaiJamjuree-${weight}.ttf`)));

/**
 * Brand-font text as SVG outlines, in canvas units, word-wrapped to `width`.
 *
 * Outlines, not <text>: librsvg and sharp's text input both resolve fonts through the
 * OS, which does not have Bai Jamjuree and silently substitutes Helvetica (measured:
 * pixel-identical output). Paths need no font at render time, so this looks the same
 * on every machine and scales losslessly with the viewBox.
 *
 * `y` is the first baseline, or with `middle` the visual centre of the whole block. Every
 * template's text goes through here (2026-10-19), so all of them are in the brand font.
 */
function textSvg(
  str,
  { x, y, size, weight = 'SemiBold', width = Infinity, anchor = 'start', middle = false, fill = FEAT_INK, halo = 0 },
) {
  const f = brandFont(weight);
  const adv = (t) => f.getAdvanceWidth(t, size);
  const lines = [];
  for (const word of String(str).trim().split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last && adv(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const lineH = size * 1.2;
  const capH = (f.tables.os2.sCapHeight / f.unitsPerEm) * size;
  const y0 = middle ? y - ((lines.length - 1) * lineH) / 2 + capH / 2 : y;
  return lines
    .map((l, i) => {
      const lx = anchor === 'middle' ? x - adv(l) / 2 : anchor === 'end' ? x - adv(l) : x;
      const d = f.getPath(l, lx, y0 + i * lineH, size).toPathData(2);
      // `halo`: a white keyline under the glyphs, so a label stays legible over the material.
      const under = halo ? `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${halo}" stroke-linejoin="round"/>` : '';
      return `${under}<path d="${d}" fill="${fill}"/>`;
    })
    .join('');
}

/**
 * The features shot: the swatch as ONE upright, front-on panel on plain white, a
 * magnified detail circle cut from the ORIGINAL swatch pixels, a card of 3–4
 * features with auto-picked icons, and a thickness badge.
 *
 * Always upright: a sheet is stood on its short edge whatever order the size label
 * names its sides in ("2400 x 1200" and "1200 x 2400" are the same sheet).
 *
 * @param {string[]} features  3–4 short labels, e.g. "Anti-Yellow & UV Resistant"
 */
async function compositeFeatures(b64, { features = [], sizeLabel, thicknessMm, material, size } = {}) {
  const items = features.map((f) => titleCase(String(f || '').trim())).filter(Boolean).slice(0, 4);
  if (!items.length) throw new Error('features: give at least one feature label');

  const { size: C } = await outputSize(b64, size);
  const k = C / CANVAS;
  const px = (v) => Math.round(v * k);

  /* panel geometry, canvas units */
  const dims = parseSizeLabel(sizeLabel);
  const ratio = dims ? Math.max(dims.widthMm, dims.heightMm) / Math.min(dims.widthMm, dims.heightMm) : 2;
  const PH = Math.min(660, 360 * ratio);
  const PW = PH / ratio;
  const PX = 60 + (340 - PW) / 2; // centred in the left column
  const PY = 820 - PH;

  const fw = px(PW);
  const fh = px(PH);
  const face = await sharp(decode(b64)).resize(fw, fh, { fit: 'cover', kernel: 'lanczos3' }).png().toBuffer();

  /* loupe: crop from the source at LOUPE_ZOOM over the face, unless that would
     upscale the source past LOUPE_MAX_UPSCALE — then zoom less, stay sharp */
  const R = 100;
  const D = px(2 * R);
  const { width: sw, height: sh } = await sharp(decode(b64)).metadata();
  const faceScale = Math.max(fw / sw, fh / sh); // source px -> face px under `cover`
  const side = Math.min(sw, sh, Math.round(Math.max(D / (faceScale * LOUPE_ZOOM), D / LOUPE_MAX_UPSCALE)));
  const disc = await sharp(decode(b64))
    .extract({ left: Math.round((sw - side) / 2), top: Math.round((sh - side) / 2), width: side, height: side })
    .resize(D, D, { kernel: 'lanczos3' })
    .ensureAlpha()
    .composite([{
      input: Buffer.from(`<svg width="${D}" height="${D}" xmlns="http://www.w3.org/2000/svg"><circle cx="${D / 2}" cy="${D / 2}" r="${D / 2}"/></svg>`),
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();
  const lx = PX + PW - 14;
  const ly = PY + 64;

  /* depth: a sliver of body colour down the right edge, and two soft shadows */
  const body = hexOf(scaleRgb(await bodyColour(b64, material), 0.92));
  const edge = Math.max(3, Math.min(10, (Number(thicknessMm) || 2) * 1.2));
  const shadows = await sharp(svgBuf(`
      <rect x="${PX + 18}" y="${PY + 22}" width="${PW + edge}" height="${PH - 10}" fill="#000" opacity="0.16"/>
      <circle cx="${lx + 8}" cy="${ly + 14}" r="${R}" fill="#000" opacity="0.18"/>`, C))
    .blur(Math.max(0.3, 22 * k)).png().toBuffer();
  const contact = await sharp(svgBuf(`
      <ellipse cx="${PX + PW / 2 + 6}" cy="${PY + PH + 2}" rx="${PW / 2 + 18}" ry="7" fill="#000" opacity="0.28"/>`, C))
    .blur(Math.max(0.3, 5 * k)).png().toBuffer();

  /* right column */
  const X0 = 530, X1 = 860;
  const rowH = 118;
  const cardH = items.length * rowH + 16;
  const titleY = PY + PH / 2 - (cardH + 70) / 2 + 30;
  const cardTop = titleY + 30;
  const rowY = (i) => cardTop + 8 + i * rowH + rowH / 2;
  const rows = items.map((label, i) => {
    const y = rowY(i);
    return `
      <circle cx="${X0 + 60}" cy="${y}" r="34" fill="${FEAT_TINT}"/>
      <g transform="translate(${X0 + 60 - 18},${y - 18}) scale(0.75)" fill="none" stroke="${FEAT_INK}"
         stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${iconFor(label)}</g>
      ${i < items.length - 1 ? `<line x1="${X0 + 26}" x2="${X1 - 26}" y1="${y + rowH / 2}" y2="${y + rowH / 2}"
         stroke="${FEAT_LINE}" stroke-width="1.2"/>` : ''}`;
  }).join('');

  const mm = Number(thicknessMm) || 0;
  const badge = mm > 0 ? `
    <rect x="40" y="40" width="150" height="82" rx="14" fill="#ffffff" stroke="${FEAT_INK}" stroke-width="2"/>` : '';

  const text = [
    textSvg('Features', { x: X0 + 6, y: titleY, size: 36, weight: 'Bold' }),
    ...items.map((label, i) =>
      textSvg(label, { x: X0 + 116, y: rowY(i), size: 23, width: X1 - X0 - 142, middle: true })),
    ...(mm > 0 ? [
      textSvg(`${mm}mm`, { x: 115, y: 82, size: 32, weight: 'Bold', anchor: 'middle' }),
      textSvg('Thickness', { x: 115, y: 106, size: 18, weight: 'Medium', anchor: 'middle' }),
    ] : []),
  ].join('');

  const under = svgBuf(`
    <rect x="${PX + PW}" y="${PY}" width="${edge}" height="${PH}" fill="${body}"/>`, C);
  const over = svgBuf(`
    <circle cx="${lx}" cy="${ly}" r="${R}" fill="none" stroke="#ffffff" stroke-width="6"/>
    <circle cx="${lx}" cy="${ly}" r="${R + 3}" fill="none" stroke="${FEAT_LINE}" stroke-width="1.2"/>
    ${badge}
    <rect x="${X0}" y="${cardTop}" width="${X1 - X0}" height="${cardH}" rx="20"
          fill="#ffffff" stroke="${FEAT_LINE}" stroke-width="1.6"/>
    ${rows}
    ${text}`, C);

  return asJpeg(
    blank('#ffffff', C).composite([
      { input: shadows },
      { input: contact },
      { input: under },
      { input: face, left: px(PX), top: px(PY) },
      { input: disc, left: px(lx - R), top: px(ly - R) },
      { input: over },
    ]),
  );
}
/**
 * Every template that can be built from ONE flat swatch, with no model call.
 *
 * Returned keyed by template id with base64 values, plus `errors` for any that
 * failed — one bad template must not lose the others, the same contract
 * pipeline.js uses per scene.
 *
 * ponytail: runs the four in parallel and keeps them all in memory. Four 900×900
 * JPEGs is a couple of MB; a batch over a whole catalogue wants a queue and a
 * stream to Shopify instead, which is the caller's job, not this function's.
 */
async function buildTemplates(b64, { sizeLabel, thicknessMm, material, size, repeats = 3, cols = 2, features, category, only } = {}) {
  // Resolved ONCE, so every template in the set comes back the same dimensions —
  // a gallery of mismatched sizes is worse than a gallery of small ones.
  const resolved = await outputSize(b64, size);
  const { size: px } = resolved;

  const jobs = {
    grout_grid: () => compositeGroutGrid(b64, { cols, size: px }),
    repeat_preview: () => compositeRepeatPreview(b64, repeats, { size: px }),
    isometric: () => compositeIsometric(b64, sizeLabel, thicknessMm, { size: px, category }),
    thickness: () => compositeThickness(b64, thicknessMm, { sizeLabel, material, size: px }),
    studio: () => compositeStudio(b64, { sizeLabel, thicknessMm, material, size: px }),
    ...(features?.length
      ? { features: () => compositeFeatures(b64, { features, sizeLabel, thicknessMm, material, size: px }) }
      : {}),
    // scale_reference is deliberately NOT here. It draws a ruler across whatever it
    // is given, which only means something over a shot containing ONE unit with
    // visible edges — a generated single-unit render, which is what pipeline.js
    // still calls it for. Over a flat full-frame swatch there is no unit boundary to
    // measure against, so the bar spans a texture and states a width the image does
    // not show: worse than no overlay, because it looks authoritative. compositeIsometric
    // answers the same question properly, by putting the numbers on real edges.
  };

  const images = {};
  const errors = {};
  await Promise.all(
    // `only`: build just these ids -- the add-product form asks for one size drawing per size
    // and should not pay for five other templates each time.
    Object.entries(jobs).filter(([id]) => !only || only.includes(id)).map(async ([id, run]) => {
      try {
        images[id] = await run();
      } catch (err) {
        errors[id] = err.message;
      }
    }),
  );
  return { images, errors, ...resolved };
}

module.exports = {
  CANVAS,
  parseSizeLabel,
  sizeLabelText,
  scaleReferenceSvg,
  repeatLayout,
  repeatPreviewSvg,
  addScaleReference,
  compositeRepeatPreview,
  compositeGroutGrid,
  compositeIsometric,
  compositeThickness,
  compositeStudio,
  compositeFeatures,
  outputSize,
  bodyColour,
  studioGround,
  buildTemplates,
};
