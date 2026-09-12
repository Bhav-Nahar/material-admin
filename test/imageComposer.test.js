'use strict';

/**
 * The composites, checked at the only level worth checking without eyes on the
 * output: every template returns a decodable CANVAS × CANVAS JPEG, and the
 * geometry survives a NON-SQUARE size.
 *
 * That last one is the point of this file. Rotating a w × h rectangle 45° puts its
 * corners at offsets inside the bounding box that only coincide with the midpoints
 * of its sides when w === h — so a 600 × 600 fixture passes even with the vertex
 * maths wrong, and 1200 × 600 is what actually exercises it. Caught exactly that
 * way during development: the thickness edges floated off the slab.
 */

const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');

const {
  CANVAS,
  parseSizeLabel,
  addScaleReference,
  compositeRepeatPreview,
  compositeGroutGrid,
  compositeIsometric,
  compositeThickness,
  compositeStudio,
  studioGround,
  outputSize,
  buildTemplates,
} = require('../lib/productImages/imageComposer');

/**
 * A stand-in swatch, big enough that the SIZE CAP is not what is under test here.
 * outputSize refuses to stretch a face past 1.2:1, so a 400px fixture would cap the
 * output at 727 and every dimension assertion below would be measuring the cap.
 */
async function swatch(w = 1400, h = 1400) {
  const buf = await sharp({
    create: { width: w, height: h, channels: 3, background: '#cfcdc6' },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#cfcdc6"/>` +
            `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 3}" fill="#8d8a82"/></svg>`,
        ),
      },
    ])
    .jpeg()
    .toBuffer();
  return buf.toString('base64');
}

const meta = (b64) => sharp(Buffer.from(b64, 'base64')).metadata();

test('every template returns a CANVAS x CANVAS JPEG', async () => {
  const src = await swatch();
  const outs = {
    scale: await addScaleReference(src, '600 x 600 mm'),
    repeat: await compositeRepeatPreview(src, 3),
    grout: await compositeGroutGrid(src, { cols: 2 }),
    iso: await compositeIsometric(src, '600 x 600 mm', 9),
    thick: await compositeThickness(src, 9),
  };

  for (const [name, b64] of Object.entries(outs)) {
    const m = await meta(b64);
    assert.equal(m.format, 'jpeg', `${name} is not a JPEG`);
    assert.equal(m.width, CANVAS, `${name} width`);
    assert.equal(m.height, CANVAS, `${name} height`);
  }
});

test('output size is capped by what the source photo can fill', async () => {
  // The point of the cap: asking 2048 of a 640px swatch cannot produce a sharp 2048
  // image, only a soft one that costs four times the bytes. Measured on the
  // benchmark, whose own catalogue images are 600x600.
  const small = await swatch(640, 640);
  const capped = await outputSize(small, 2048);
  assert.ok(capped.capped, 'a 640px source should cap a 2048 request');
  assert.ok(capped.size < 2048 && capped.size >= 600, `got ${capped.size}`);

  const big = await outputSize(await swatch(2400, 2400), 2048);
  assert.equal(big.capped, false, 'a 2400px source should satisfy 2048');
  assert.equal(big.size, 2048);
});

test('a larger size actually produces a larger image, at every template', async () => {
  const src = await swatch(2400, 2400);
  const { images, size } = await buildTemplates(src, {
    sizeLabel: '600 x 600 mm',
    thicknessMm: 9,
    size: 1800,
  });
  assert.equal(size, 1800);
  for (const [id, b64] of Object.entries(images)) {
    const m = await meta(b64);
    assert.equal(m.width, 1800, `${id} width`);
    assert.equal(m.height, 1800, `${id} height`);
  }
});

test('the isometric holds its geometry for a non-square size', async () => {
  const src = await swatch();
  // 1200 x 600 — the case where the rotated corners are NOT at the bounding box
  // midpoints. A square would pass this even with the vertex maths wrong.
  const b64 = await compositeIsometric(src, '1200 x 600 mm', 9);
  const m = await meta(b64);
  assert.equal(m.width, CANVAS);
  assert.equal(m.height, CANVAS);

  // The dimension labels must name the parsed millimetres, both of them, and the
  // long side must not be reported as the short one.
  const dims = parseSizeLabel('1200 x 600 mm');
  assert.equal(dims.widthMm, 1200);
  assert.equal(dims.heightMm, 600);
});

test('a size label nothing can parse returns the render untouched, rather than throwing', async () => {
  const src = await swatch();
  // A product drafted without a size is legitimate — see productReadiness's
  // size_label gate, which warns rather than blocks for wallpaper. Losing the
  // image would be worse than shipping it without an overlay.
  assert.equal(await addScaleReference(src, 'made to order'), src);
  assert.equal(await compositeIsometric(src, '', 9), src);
  assert.equal(await compositeThickness(src, 0), src);
});

test('buildTemplates keeps the templates that work when one cannot be built', async () => {
  const src = await swatch();
  // No thickness and no size: isometric and thickness have nothing to draw, so they
  // pass the source through, while the two grids still composite.
  const { images, errors } = await buildTemplates(src, {});
  assert.deepEqual(errors, {}, 'a missing field is not an error');

  for (const id of ['grout_grid', 'repeat_preview']) {
    const m = await meta(images[id]);
    assert.equal(m.width, CANVAS, `${id} did not composite`);
  }
});

test('the grout grid puts the ground colour between the cells, not over them', async () => {
  const src = await swatch();
  const b64 = await compositeGroutGrid(src, { cols: 2, groutPx: 20, groutColour: '#000000' });
  const { width } = await meta(b64);

  // Sample the exact centre — with an even cell count that is the middle of the
  // grout cross, so it must be the ground colour and not swatch pixels.
  const { data } = await sharp(Buffer.from(b64, 'base64'))
    .extract({ left: Math.round(width / 2) - 2, top: Math.round(width / 2) - 2, width: 4, height: 4 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const brightest = Math.max(...data);
  assert.ok(brightest < 40, `grout centre should be near-black, got max channel ${brightest}`);
});

/** A flat swatch of one colour, for testing the ground derivation. */
async function solid(hexColour) {
  const buf = await sharp({ create: { width: 200, height: 200, channels: 3, background: hexColour } })
    .jpeg()
    .toBuffer();
  return buf.toString('base64');
}

const luma = (hexColour) => {
  const n = parseInt(hexColour.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('the studio ground stays light for every tile colour', async () => {
  // The invariant the catalogue depends on: whatever the tile, the ground is a pale
  // tint. A dark ground on one product would break a collection page full of them.
  for (const c of ['#ffffff', '#f2efe8', '#8d8a82', '#3b2f26', '#000000', '#1e4fa8', '#2f6b4f']) {
    const g = await studioGround(await solid(c));
    assert.ok(luma(g.wall) > 0.6, `${c} produced a wall at luma ${luma(g.wall).toFixed(2)}`);
    assert.ok(luma(g.floor) > 0.6, `${c} produced a floor at luma ${luma(g.floor).toFixed(2)}`);
  }
});

test('a pale tile gets a darker ground than a dark tile does', async () => {
  // The contrast rule. A white tile on the brightest possible wall is the bug this
  // exists to stop — the alabaster swatch vanished into a fixed cream.
  const pale = await studioGround(await solid('#f6f4ef'));
  const dark = await studioGround(await solid('#3b2f26'));
  assert.ok(
    luma(pale.wall) < luma(dark.wall),
    `pale tile wall (${luma(pale.wall).toFixed(2)}) should be darker than dark tile wall (${luma(dark.wall).toFixed(2)})`,
  );
});

test('an explicit bg overrides the derivation entirely', async () => {
  const g = await studioGround(await solid('#3b2f26'), '#ecdcae');
  assert.equal(g.wall, '#ecdcae');
});

test('the studio shot renders for a plank as well as a square', async () => {
  const src = await swatch();
  for (const size of ['600 x 600 mm', '1200 x 600 mm', '8 ft x 4 ft']) {
    const m = await meta(await compositeStudio(src, { sizeLabel: size, thicknessMm: 9 }));
    assert.equal(m.width, CANVAS, size);
    assert.equal(m.height, CANVAS, size);
  }
});

/* ── the 3D studio shot ──────────────────────────────────────────────────────
   No render here: that needs a Chrome, and a unit suite must not depend on a
   browser being installed. What IS worth locking is the calibration — the finish
   mapping and the lighting constants were measured against the benchmark, and a
   silent edit to them is exactly the kind of change that degrades every hero image
   in the catalogue without failing anything. */
const { roughnessFor, DEFAULTS: S3D, ROUGHNESS } = require('../lib/productImages/studio3d');

test('finish maps to roughness, and an unknown finish falls back to matte', () => {
  assert.ok(roughnessFor('High Gloss') < roughnessFor('Matte'), 'gloss must scatter less than matte');
  assert.equal(roughnessFor('  MATTE '), ROUGHNESS.matte, 'case and padding are not significant');
  assert.equal(roughnessFor('Brushed Unobtainium'), ROUGHNESS.matte, 'unknown finish falls back');
  assert.equal(roughnessFor(undefined), ROUGHNESS.matte);
});

test('the studio lighting stays on its calibrated settings', () => {
  // Measured: ACES traded texture contrast away as it brightened (1.97 -> 1.32), and
  // above key 4.2 the face blew out (76% of it at key 5). key 3.4 with tone mapping
  // OFF landed on the reference's own brightness with nothing clipped.
  assert.equal(S3D.toneMapping, 'none', 'ACES rolls off the texture this shot exists to sell');
  assert.ok(S3D.keyIntensity > 3 && S3D.keyIntensity < 4.2, `key ${S3D.keyIntensity} is outside the calibrated band`);
  assert.ok(Math.abs(S3D.fillIntensity / S3D.keyIntensity - 0.4) < 0.01, 'fill is held as a ratio of key');
  assert.ok(Math.abs(S3D.sunIntensity / S3D.keyIntensity - 0.3) < 0.01, 'shadow light is held as a ratio of key');
});

test('the camera reproduces the measured foreshortening', () => {
  // The reference foreshortens to 0.819, so the face's normal sits acos(0.819) = 35
  // degrees off the camera. That total is what matters, not either angle alone.
  const total = S3D.turnDeg + S3D.camAzimuthDeg;
  assert.ok(Math.abs(total - 35) < 1.5, `turn + azimuth = ${total}, should be ~35`);
  assert.ok(S3D.fov <= 22, 'a short lens splays the verticals; this wants a long one');
});
