const test = require('node:test');
const assert = require('node:assert');

const kb = require('../lib/keywordBank');

test('the bank covers the categories a product can be created in, and no ghosts', () => {
  // Tiles, Laminates, Wallpaper are stocked; Panels is research-backed (§8, a
  // captured PLP) and Stone is a declared sketch. Wood and Hardware still get no
  // entry: research §9 records no benchmark for Hardware at all, and Wood's fields
  // are the same unconfirmed sketch with nothing waiting on them.
  assert.deepEqual(kb.CATEGORY_IDS, ['tiles', 'laminates', 'wallpaper', 'panels', 'stone']);
  assert.equal(kb.forCategory('wood'), null);
  assert.equal(kb.forCategory('hardware'), null);
});

test('adding stone does not let the tiles look value "Stone" steal a tile', () => {
  // The collision lib/keywordBank.js warned about, now live. productType IS the
  // category (research §10) and is matched first, so a tile stays a tile however its
  // title reads; the free-text fallback is tie-broken by declaration order, tiles
  // ahead of stone. What has no answer is a product with NO productType whose title
  // says "Stone Look Floor Tile" — singular, so "tiles" never appears — and that
  // resolved to null before stone existed rather than to tiles. Set productType.
  assert.equal(kb.resolveCategory({ productType: 'Tiles', title: 'Stone Look Floor Tile' }), 'tiles');
  assert.equal(kb.resolveCategory({ handle: 'stone-look-floor-tiles-tl-1' }), 'tiles');
  assert.equal(kb.resolveCategory({ productType: 'Stone' }), 'stone');
  assert.equal(kb.resolveCategory({ productType: 'Panels' }), 'panels');
});

test('no GlassQuick vocabulary survived the port', () => {
  const raw = JSON.stringify(kb.bank).toLowerCase();
  for (const word of ['glassquick', 'railing', 'nameplate', 'shower enclosure', 'defogger', 'pvd', 'toughened']) {
    assert.ok(!raw.includes(word), `bank still mentions "${word}"`);
  }
});

test('tiles attributes are the values recorded in research §5', () => {
  assert.deepEqual(kb.attributeValues('tiles', 'material'), [
    'Vitrified',
    'Ceramic',
    'Porcelain',
    'Full-body Vitrified',
    'Glass',
  ]);
  assert.deepEqual(kb.attributeValues('tiles', 'look'), [
    'Marble',
    'Cement',
    'Wood',
    'Terrazzo',
    'Zellige',
    'Stone',
    'Fabric',
    'Metallic',
  ]);
  assert.deepEqual(kb.attributeValues('tiles', 'slipRating'), ['R9', 'R10', 'R11', 'R12', 'R13']);
});

test('laminate finishes are per-category, not shared with tiles', () => {
  // Research §6: "Suede and Texture do not exist in tiles — the finish list must be
  // per-category." A single global finish list would be the bug.
  const laminate = kb.attributeValues('laminates', 'finish');
  const tiles = kb.attributeValues('tiles', 'finish');
  assert.deepEqual(laminate, ['Texture', 'High Gloss', 'Suede', 'Matte', 'Glossy']);
  assert.ok(laminate.includes('Suede') && !tiles.includes('Suede'));
  assert.ok(tiles.includes('Carving Matte') && !laminate.includes('Carving Matte'));
});

test('wallpaper carries no finish and no thickness', () => {
  // Research §7: wallpaper is the one category with neither facet.
  assert.deepEqual(kb.attributeValues('wallpaper', 'finish'), []);
  assert.deepEqual(kb.attributeValues('wallpaper', 'thicknessMm'), []);
  assert.deepEqual(kb.attributeValues('wallpaper', 'material'), [
    'Non-woven',
    'PVC',
    'Canvas',
    'Handmade',
    'Soft Feel',
  ]);
  assert.deepEqual(kb.attributeValues('wallpaper', 'pattern'), [
    'Plain & textured',
    'Floral',
    'Geometric',
    'Mural',
  ]);
});

test('each category names the unit its price is quoted in', () => {
  // Research §3: "Unit differs per category" — tiles per sq ft, laminates per sheet,
  // panels per piece ("a third pricing model", §8). productCreate REJECTS a price
  // unit that contradicts these, so every category must carry one.
  assert.equal(kb.forCategory('tiles').priceUnit, 'Sq. Ft.');
  assert.equal(kb.forCategory('laminates').priceUnit, 'Sheet');
  assert.equal(kb.forCategory('wallpaper').priceUnit, 'Sq. Ft.');
  assert.equal(kb.forCategory('panels').priceUnit, 'Piece');
  assert.equal(kb.forCategory('stone').priceUnit, 'Sq. Ft.');
  for (const id of kb.CATEGORY_IDS) assert.ok(kb.forCategory(id).priceUnit, `${id} has no priceUnit`);
});

test('panel attributes are the values recorded in research §8', () => {
  // "Charcoal dominates" — 3,508 of the values read off their PLP.
  assert.deepEqual(kb.attributeValues('panels', 'material'), ['Charcoal', 'PVC', 'PU', 'MDF', 'WPC']);
  assert.deepEqual(kb.attributeValues('panels', 'finish'), ['Texture', 'Matte', 'Velvet', 'Glossy', 'Metallic']);
  assert.ok(kb.isKnownValue('panels', 'material', 'charcoal'));
  // Stone is a sketch and says so, rather than carrying an invented vocabulary.
  assert.match(kb.forCategory('stone')._sourced, /sketch/);
  assert.deepEqual(kb.attributeValues('stone', 'finish'), []);
});

test('resolveCategory prefers productType, the field that is the category', () => {
  assert.equal(kb.resolveCategory({ productType: 'Tiles' }), 'tiles');
  assert.equal(kb.resolveCategory({ productType: 'laminates' }), 'laminates');
  assert.equal(kb.resolveCategory({ product_type: 'Wallpaper' }), 'wallpaper');
});

test('resolveCategory falls back to handle, tags and collections', () => {
  assert.equal(kb.resolveCategory({ handle: 'wood-floor-tiles-nordic-honey' }), 'tiles');
  assert.equal(kb.resolveCategory({ tags: ['premium', 'wallpaper'] }), 'wallpaper');
  assert.equal(kb.resolveCategory({ tags: 'a,laminates,b' }), 'laminates');
  assert.equal(kb.resolveCategory({ collections: [{ handle: 'tiles' }] }), 'tiles');
  assert.equal(kb.resolveCategory({ collections: ['laminates'] }), 'laminates');
});

test('resolveCategory returns null rather than guessing', () => {
  assert.equal(kb.resolveCategory({ productType: 'Hardware' }), null);
  assert.equal(kb.resolveCategory({ title: 'Brass Door Handle' }), null);
  assert.equal(kb.resolveCategory({}), null);
});

test('isKnownValue is tolerant of case and spacing but not of drift', () => {
  assert.ok(kb.isKnownValue('tiles', 'material', 'vitrified'));
  assert.ok(kb.isKnownValue('tiles', 'material', '  Full-body   Vitrified '));
  assert.ok(kb.isKnownValue('laminates', 'finish', 'HIGH GLOSS'));
  assert.ok(!kb.isKnownValue('tiles', 'material', 'Marble'));
  assert.ok(!kb.isKnownValue('tiles', 'finish', 'Suede')); // a laminate finish
  assert.ok(!kb.isKnownValue('tiles', 'material', ''));
  assert.ok(!kb.isKnownValue(null, 'material', 'Vitrified'));
});

test('keywordsFor blends category volume with this product own attributes', () => {
  const keywords = kb.keywordsFor(
    { look: 'Wood', material: 'Vitrified', finish: 'Matte', applications: ['Living room'] },
    'tiles',
  );
  assert.ok(keywords.includes('wood look tiles'));
  assert.ok(keywords.includes('vitrified tiles'));
  assert.ok(keywords.includes('matte finish tiles'));
  assert.ok(keywords.includes('tiles for living room'));
  assert.equal(new Set(keywords).size, keywords.length, 'keywords must be deduplicated');
  assert.ok(keywords.every((k) => k === k.toLowerCase()));
});

test('keywordsFor degrades to brand terms for an unknown category', () => {
  assert.deepEqual(kb.keywordsFor({ look: 'Wood' }, null), kb.bank.brandKeywords);
});

test('every category has the three keyword tiers and a negative list', () => {
  for (const id of kb.CATEGORY_IDS) {
    const entry = kb.forCategory(id);
    for (const tier of ['exact', 'phrase', 'broad']) {
      assert.ok(entry.keywords[tier]?.length >= 5, `${id}.${tier} is too thin`);
    }
    assert.ok(entry.longTail.length >= 5, `${id}.longTail is too thin`);
    assert.ok(entry.negative.length >= 5, `${id}.negative is too thin`);
    assert.equal(entry.collectionHandle, id);
  }
});

test('negative keywords exclude the traffic each category actually attracts wrongly', () => {
  assert.ok(kb.forCategory('wallpaper').negative.includes('mobile wallpaper'));
  assert.ok(kb.forCategory('laminates').negative.includes('laminate flooring'));
  assert.ok(kb.forCategory('tiles').negative.includes('tile adhesive'));
});

test('the shared spine matches research §4', () => {
  assert.deepEqual(kb.bank.shared.surface, ['Floor', 'Wall', 'Both', 'Ceiling', 'Exterior']);
  assert.ok(kb.bank.shared.colourFamily.includes('Beige'));
});
