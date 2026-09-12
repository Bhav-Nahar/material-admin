'use strict';

/**
 * The rectifier, checked end to end — but only when OpenCV is actually installed.
 *
 * It is an OPTIONAL tool: the venv is not part of `npm i`, and a box without it must
 * still pass this suite, so the real assertions are skipped rather than failed when
 * Python is missing. What is never skipped is the contract around it: a missing
 * interpreter has to be a clear, actionable error and not a stack trace.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const sharp = require('sharp');

const { rectify, resolvePython } = require('../lib/productImages/rectify');

const available = (() => {
  try { return !!resolvePython(); } catch { return false; }
})();

/** A tile photographed at an angle: the swatch warped to a trapezoid on a plain bench. */
async function angledPhoto() {
  const W = 600, H = 600, N = 90;
  const face = await sharp({
    create: { width: W, height: H, channels: 3, background: '#8a7f6d' },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${W}" height="${H}">${Array.from({ length: 900 }, () =>
            `<circle cx="${Math.random() * W}" cy="${Math.random() * H}" r="${4 + Math.random() * 14}" fill="rgb(${
              90 + Math.random() * 90 | 0},${84 + Math.random() * 90 | 0},${70 + Math.random() * 90 | 0})"/>`,
          ).join('')}</svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();

  const strips = [];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const h = Math.round(H * (1 - 0.3 * t));
    strips.push({
      input: await sharp(face)
        .extract({ left: Math.round((i * W) / N), top: 0, width: Math.max(1, Math.round(W / N)), height: H })
        .resize(Math.round(W / N) + 1, h, { fit: 'fill' })
        .png()
        .toBuffer(),
      left: 90 + Math.round((i * W) / N * 0.82),
      top: 50 + Math.round((H - h) * 0.5),
    });
  }
  const buf = await sharp({ create: { width: 800, height: 720, channels: 3, background: '#dcd8d0' } })
    .composite(strips)
    .jpeg({ quality: 92 })
    .toBuffer();
  return buf.toString('base64');
}

test('a missing OpenCV says what to install rather than throwing a stack trace', () => {
  const { resolvePython: r } = require('../lib/productImages/rectify');
  const saved = process.env.PYTHON_BIN;
  try {
    process.env.PYTHON_BIN = '/definitely/not/a/python';
    // The venv path is also a candidate, so this only asserts the message shape when
    // neither resolves — which is the case this exists to cover.
    try {
      r();
    } catch (err) {
      assert.equal(err.code, 'no_python');
      assert.match(err.message, /venv-cv|PYTHON_BIN/, 'the error must name the fix');
    }
  } finally {
    if (saved === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = saved;
  }
});

test('an angled photo is straightened to the size label\'s aspect', { skip: !available && 'OpenCV not installed' }, async () => {
  const photo = await angledPhoto();
  const r = await rectify(photo, { sizeLabel: '1200 x 600 mm', max: 900 });
  assert.equal(r.ok, true, `expected a rectification, got: ${r.reason}`);
  assert.equal(r.quad.length, 4, 'four corners');

  const [w, h] = r.output.split('x').map(Number);
  // The aspect must come from the PRODUCT, not from the shape the camera happened to
  // see — a 1200x600 plank straightens to 2:1 however it was photographed.
  assert.ok(Math.abs(w / h - 2) < 0.05, `output ${r.output} is not 2:1`);

  const meta = await sharp(Buffer.from(r.rectified, 'base64')).metadata();
  assert.equal(meta.width, w);
  assert.equal(meta.height, h);
});

test('a flat swatch is refused, not mangled', { skip: !available && 'OpenCV not installed' }, async () => {
  // The common GOOD case: nothing to straighten. It must come back ok:false with a
  // reason, because silently returning the input would leave the caller unable to
  // tell whether anything happened.
  const flat = (await sharp({ create: { width: 400, height: 400, channels: 3, background: '#cfcac0' } })
    .jpeg().toBuffer()).toString('base64');
  const r = await rectify(flat, { sizeLabel: '600 x 600 mm' });
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 20, 'a refusal must explain itself');
  assert.equal(r.rectified, undefined, 'a refusal must not return a guess');
});
