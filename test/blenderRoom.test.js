'use strict';

/**
 * The parts of the Cycles engine that can be checked without a renderer.
 *
 * Deliberately no render here. A path-traced interior is minutes and needs Blender on
 * the box, so the geometry and finish assertions live where they can actually run —
 * `npm run blender:selfcheck`, inside Blender's own Python. What is left for Node is
 * the argument handling, and the swatch preparation that Node owns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const blenderRoom = require('../lib/productImages/blenderRoom');

test('a request is validated before the box is checked for a renderer', () => {
  // Both of these must fail on the request, not on whether Blender is installed —
  // otherwise the error sends someone off to install a renderer they did not need.
  assert.throws(() => blenderRoom.enqueue({}), (e) => e.code === 'no_photo');
  assert.throws(
    () => blenderRoom.enqueue({ swatch: 'x', shots: ['not_a_shot'] }),
    (e) => e.code === 'bad_shots',
  );
});

test('the swatch is inset and squared before it reaches Blender', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'md-swatch-test-'));
  try {
    // A tile with a deliberate red frame, standing in for the sliver of studio
    // backdrop a loose rectify quad leaves behind. If the inset does not remove it,
    // that colour ends up in the grout of every joint on the floor.
    //
    // The frame is 1% of the width because that is what the inset promises to cover —
    // 1.5%, and no more. A sliver wider than that is a badly marked quad, and the
    // answer there is to mark it again, not to keep trimming the texture away.
    const size = 600;
    const frame = Math.round(size * 0.01);
    const png = await sharp({
      create: { width: size, height: size, channels: 3, background: '#ff0000' },
    })
      .composite([{
        input: await sharp({
          create: {
            width: size - frame * 2, height: size - frame * 2,
            channels: 3, background: '#cccccc',
          },
        }).png().toBuffer(),
        left: frame,
        top: frame,
      }])
      .png()
      .toBuffer();

    const { path: out, source } = await blenderRoom.prepareSwatch(png.toString('base64'), dir);
    assert.equal(source, '600x600');
    assert.ok(fs.existsSync(out));

    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 2048, 'resized square, for Cycles texture memory');
    assert.equal(meta.height, 2048);

    // No red anywhere near the edge any more.
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => data.subarray((y * info.width + x) * info.channels).slice(0, 3);
    for (const [x, y] of [[2, 2], [info.width - 3, 2], [2, info.height - 3], [1024, 1]]) {
      const [r, , b] = at(x, y);
      assert.ok(r - b < 40, `edge pixel at ${x},${y} still carries the backdrop: ${[...at(x, y)]}`);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('every shot has a sample count, and the grazing one is the most expensive', () => {
  for (const shot of blenderRoom.SHOTS) {
    assert.ok(blenderRoom.SAMPLES[shot] > 0, `${shot} has no sample count`);
  }
  // Not a style preference: a grazing specular lobe is the slowest thing here to
  // converge, and one flat sample count for the pack either wastes minutes on the
  // macro or leaves the shot that sells the finish noisy.
  assert.ok(
    blenderRoom.SAMPLES.sheen_grazing > blenderRoom.SAMPLES.hero_wide,
    'sheen_grazing must not be sampled below hero_wide',
  );
  assert.ok(blenderRoom.SAMPLES.hero_wide > blenderRoom.SAMPLES.macro_detail);
});

test('unknown room templates name what is actually available', () => {
  assert.throws(
    () => blenderRoom.enqueue({ swatch: 'x', roomTemplate: 'no_such_room' }),
    (e) => e.code === 'no_template' || e.code === 'no_blender',
  );
});
