const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildPrompt,
  buildLockedSpecBlock,
  makeScene,
  normaliseCategory,
  getScenesForCategory,
  SCENE_CONFIG,
  SCENE_METADATA,
  COMPOSITED_SCENES,
} = require('../lib/productImages/promptBuilder');

const TILE_SPEC = {
  product_type: 'floor tile',
  material: 'Vitrified',
  finish: 'Matte',
  look: 'Wood',
  colour: 'Nordic Honey',
  texture_description: 'Fine timber grain with a low-sheen matte face.',
  thickness_mm: 9,
  size: '1200 x 200 mm',
  surface: 'Floor',
  application: ['Living room', 'Bedroom', 'Kitchen'],
};

// ─── Category resolution ─────────────────────────────────────────────────────

test('normaliseCategory maps the live categories, however they are spelled', () => {
  for (const input of ['Tiles', 'tiles', 'tile', 'Wall Tiles', 'floor-tiles']) {
    assert.equal(normaliseCategory(input), 'tiles', input);
  }
  for (const input of ['Laminates', 'laminate', 'Decorative Laminates']) {
    assert.equal(normaliseCategory(input), 'laminates', input);
  }
  for (const input of ['Wallpaper', 'Wallpapers', 'wall paper']) {
    assert.equal(normaliseCategory(input), 'wallpaper', input);
  }
});

test('"Wall Tiles" is tiles, not wallpaper — substring order matters', () => {
  assert.equal(normaliseCategory('Wall Tiles'), 'tiles');
});

test('unknown and empty categories fall back to default, never throw', () => {
  for (const input of ['Stone', 'Wood', 'Hardware', '', null, undefined, 42]) {
    assert.equal(normaliseCategory(input), 'default');
  }
});

// ─── Scene resolution ────────────────────────────────────────────────────────

test('each live category resolves to its own scene list', () => {
  assert.deepEqual(getScenesForCategory('Tiles'), SCENE_CONFIG.tiles);
  assert.deepEqual(getScenesForCategory('Laminates'), SCENE_CONFIG.laminates);
  assert.deepEqual(getScenesForCategory('Wallpaper'), SCENE_CONFIG.wallpaper);
});

test('categories declared but empty get the default set', () => {
  assert.deepEqual(getScenesForCategory('Stone'), SCENE_CONFIG.default);
  assert.deepEqual(getScenesForCategory(undefined), SCENE_CONFIG.default);
});

test('selectedScenes override the category default', () => {
  assert.deepEqual(getScenesForCategory('Tiles', ['swatch_closeup']), ['swatch_closeup']);
});

test('an empty selectedScenes array falls through to the default, not to nothing', () => {
  assert.deepEqual(getScenesForCategory('Tiles', []), SCENE_CONFIG.tiles);
  assert.deepEqual(getScenesForCategory('Tiles', null), SCENE_CONFIG.tiles);
});

test('the brief\'s required scenes exist for each category', () => {
  for (const id of ['bathroom_floor_wall', 'kitchen_backsplash', 'living_room_floor', 'outdoor_balcony']) {
    assert.ok(SCENE_CONFIG.tiles.includes(id), `tiles missing ${id}`);
  }
  for (const id of ['wardrobe_shutter', 'kitchen_shutter', 'wall_panelling']) {
    assert.ok(SCENE_CONFIG.laminates.includes(id), `laminates missing ${id}`);
  }
  for (const id of ['bedroom_feature_wall', 'living_room_wall', 'childrens_room']) {
    assert.ok(SCENE_CONFIG.wallpaper.includes(id), `wallpaper missing ${id}`);
  }
  // The category-agnostic swatch shot belongs to every category.
  for (const scenes of Object.values(SCENE_CONFIG)) {
    assert.ok(scenes.includes('swatch_closeup'));
  }
});

test('every configured scene has metadata — a typo would silently degrade', () => {
  for (const [category, scenes] of Object.entries(SCENE_CONFIG)) {
    for (const id of scenes) {
      assert.ok(SCENE_METADATA[id], `${category} references unknown scene ${id}`);
      assert.ok(SCENE_METADATA[id].label, `${id} has no label`);
      assert.ok(SCENE_METADATA[id].prompt_hint, `${id} has no prompt_hint`);
      assert.ok(SCENE_METADATA[id].style, `${id} has no style`);
    }
  }
});

test('composited scenes are real scenes', () => {
  for (const id of COMPOSITED_SCENES) assert.ok(SCENE_METADATA[id], `${id} is not a scene`);
});

test('no glass scene survived the port', () => {
  const ids = Object.keys(SCENE_METADATA).join(' ');
  for (const word of ['mirror', 'led', 'shower', 'railing', 'partition', 'nameplate', 'measurement']) {
    assert.ok(!ids.includes(word), `scene id contains "${word}"`);
  }
});

// ─── makeScene ───────────────────────────────────────────────────────────────

test('makeScene returns label, style and hint for a known scene', () => {
  const scene = makeScene('kitchen_backsplash');
  assert.equal(scene.id, 'kitchen_backsplash');
  assert.equal(scene.label, 'Kitchen Backsplash');
  assert.equal(scene.style, 'room');
  assert.match(scene.prompt_hint, /backsplash/i);
});

test('makeScene degrades for an unknown scene rather than throwing', () => {
  const scene = makeScene('some_new_scene');
  assert.equal(scene.label, 'some new scene');
  assert.equal(scene.style, 'room');
});

// ─── Locked spec block ───────────────────────────────────────────────────────

test('the locked block carries every Material spec field', () => {
  const block = buildLockedSpecBlock(TILE_SPEC, { category: 'Tiles' });
  for (const value of ['floor tile', 'Vitrified', 'Matte', 'Wood', 'Nordic Honey', 'Floor', '9 mm']) {
    assert.ok(block.includes(value), `missing ${value}`);
  }
  assert.match(block, /Living room, Bedroom, Kitchen/);
  assert.match(block, /timber grain/);
});

test('unknown and empty fields are omitted, not printed as "unknown"', () => {
  const block = buildLockedSpecBlock(
    { product_type: 'wallpaper roll', material: 'Non-woven', finish: 'unknown', look: '', colour: 'Sage' },
    { category: 'Wallpaper' },
  );
  assert.ok(!block.includes('unknown'));
  assert.ok(block.includes('Non-woven') && block.includes('Sage'));
});

test('zero thickness is omitted — wallpaper has no thickness facet', () => {
  const block = buildLockedSpecBlock({ ...TILE_SPEC, thickness_mm: 0 }, { category: 'Wallpaper' });
  assert.ok(!block.includes('Thickness'));
});

test('the size is locked and a variant size overrides the base size', () => {
  const base = buildLockedSpecBlock(TILE_SPEC, { category: 'Tiles' });
  assert.match(base, /Exact unit size: 1200 x 200 mm — do not alter/);

  const variant = buildLockedSpecBlock(TILE_SPEC, { category: 'Tiles', sizeValue: '600 × 600 mm' });
  assert.ok(variant.includes('600 × 600 mm'));
  assert.ok(!variant.includes('1200 x 200 mm'));
});

test('an unknown size states no size at all rather than inventing one', () => {
  const block = buildLockedSpecBlock({ ...TILE_SPEC, size: 'unknown' }, { category: 'Tiles' });
  assert.ok(!block.includes('Exact unit size'));
});

test('metafield values arriving as Shopify { value } wrappers are unwrapped', () => {
  const block = buildLockedSpecBlock(
    { ...TILE_SPEC, finish: { value: 'Glossy' }, application: { value: ['Bathroom'] } },
    { category: 'Tiles' },
  );
  assert.ok(block.includes('Finish: Glossy'));
  assert.ok(block.includes('Bathroom'));
  assert.ok(!block.includes('[object Object]'));
});

test('each category gets its own realism constraint', () => {
  assert.match(buildLockedSpecBlock(TILE_SPEC, { category: 'Tiles' }), /grout/i);
  assert.match(buildLockedSpecBlock(TILE_SPEC, { category: 'Laminates' }), /grain or pattern direction/i);
  assert.match(buildLockedSpecBlock(TILE_SPEC, { category: 'Wallpaper' }), /pattern repeat/i);
  // An unmapped category still gets a constraint rather than none.
  assert.match(buildLockedSpecBlock(TILE_SPEC, { category: 'Stone' }), /Reproduce the surface texture/i);
});

// ─── Full prompt assembly ────────────────────────────────────────────────────

test('buildPrompt joins the locked spec block and the scene block', () => {
  const prompt = buildPrompt(TILE_SPEC, makeScene('living_room_floor'), { category: 'Tiles' });
  assert.ok(prompt.startsWith('PRODUCT REFERENCE'));
  assert.ok(prompt.includes('Scene: '));
  assert.ok(prompt.includes('Nordic Honey'));
  assert.match(prompt, /Professional interior photography/);
});

test('every prompt forbids text and dimension arrows on the image', () => {
  for (const id of Object.keys(SCENE_METADATA)) {
    const prompt = buildPrompt(TILE_SPEC, makeScene(id), { category: 'Tiles' });
    assert.match(prompt, /Do not add any text, labels, watermarks, dimension arrows/, id);
  }
});

test('scene families produce genuinely different photography direction', () => {
  const styleOf = (id) => buildPrompt(TILE_SPEC, makeScene(id), { category: 'Tiles' }).split('Scene: ')[1];
  const swatch = styleOf('swatch_closeup');
  const room = styleOf('living_room_floor');
  const outdoor = styleOf('outdoor_balcony');
  const joinery = styleOf('wardrobe_shutter');

  assert.match(swatch, /Flat-lay macro/);
  assert.match(room, /Professional interior photography/);
  assert.match(outdoor, /Architectural photography in natural daylight/);
  assert.match(joinery, /fitted joinery/);
  assert.equal(new Set([swatch, room, outdoor, joinery]).size, 4);
});

test('the repeat preview asks for something actually tileable', () => {
  const prompt = buildPrompt(TILE_SPEC, makeScene('repeat_preview'), { category: 'Wallpaper' });
  assert.match(prompt, /seamlessly/);
  assert.match(prompt, /no vignette/);
});

test('every scene builds a non-trivial prompt for every category', () => {
  for (const category of ['Tiles', 'Laminates', 'Wallpaper', 'Stone']) {
    for (const id of getScenesForCategory(category)) {
      const prompt = buildPrompt(TILE_SPEC, makeScene(id), { category });
      assert.ok(prompt.length > 400, `${category}/${id} prompt too short`);
      assert.ok(!prompt.includes('undefined'), `${category}/${id} prompt contains "undefined"`);
    }
  }
});

test('prompt building is pure — no env, no network, same input same output', () => {
  const once = buildPrompt(TILE_SPEC, makeScene('bathroom_floor_wall'), { category: 'Tiles' });
  const twice = buildPrompt(TILE_SPEC, makeScene('bathroom_floor_wall'), { category: 'Tiles' });
  assert.equal(once, twice);
});
