const test = require('node:test');
const assert = require('node:assert');
const {
  buildProductSet, encode, deriveHandle, PRODUCT_TYPES, VARIANT_TYPES,
} = require('../lib/productCreate');

// A whole box, priced as one — which is what a Shopify variant IS. 6 pieces of
// 1200 × 600 mm cover 46.5 sq ft, so the pack arithmetic below agrees with itself and
// this fixture raises no warnings of its own.
const TILE = {
  category: 'Tiles', look: 'Marble', surface: ['Floor', 'Wall'], material: 'Vitrified',
  finish: 'Matte', colourName: 'Carrara Mist', applications: ['Living Room', 'Bedroom'],
  sku: 'TL-90001', price: 129, sizeLabel: '1200 x 600 mm', thicknessMm: 9,
  packUnit: 'box', piecesPerPack: 6, coveragePerPack: 46.5,
};

test('list metafields are a JSON array STRING, not an array', () => {
  // GraphQL accepts an array here as a String and Shopify then rejects it with a
  // message that never mentions the shape. Worth pinning.
  const mf = encode('surface', 'list.single_line_text_field', ['Floor', 'Wall']);
  assert.equal(typeof mf.value, 'string');
  assert.deepEqual(JSON.parse(mf.value), ['Floor', 'Wall']);

  assert.equal(encode('colour_name', 'single_line_text_field', 'Carrara Mist').value, 'Carrara Mist');
});

test('empty and missing values produce no metafield at all', () => {
  // A metafield written as "" is not the same as absent: it makes a product look
  // populated to the audit and shows an empty row on the PDP.
  assert.equal(encode('finish', 'single_line_text_field', ''), null);
  assert.equal(encode('finish', 'single_line_text_field', null), null);
  assert.equal(encode('surface', 'list.single_line_text_field', []), null);
});

test('the handle is built from identifying fields, not the title', () => {
  const { productSet } = buildProductSet(TILE);
  // The title ends in room names; the handle must not inherit them, or the URL
  // changes whenever merchandising adds a room.
  assert.ok(productSet.title.includes('Living Room'));
  assert.ok(!productSet.handle.includes('living-room'), productSet.handle);
  assert.ok(productSet.handle.includes('tl-90001'));
  assert.ok(productSet.handle.includes('carrara-mist'));
  assert.ok(productSet.handle.length <= 100);
});

test('a long handle truncates on a word boundary', () => {
  const h = deriveHandle(
    { look: 'Marble'.repeat(8), surface: 'Floor', category: 'Tiles', colourName: 'X'.repeat(60), material: 'Vitrified' },
    'TL-1',
  );
  assert.ok(h.length <= 100);
  assert.ok(!h.endsWith('-'));
});

test('variants default to draft and carry their own metafields', () => {
  const { productSet } = buildProductSet(TILE);
  assert.equal(productSet.status, 'DRAFT', 'a live page with no images is not a default');
  const vmf = Object.fromEntries(productSet.variants[0].metafields.map((m) => [m.key, m.value]));
  assert.equal(vmf.size_label, '1200 x 600 mm');
  assert.equal(vmf.thickness_mm, '9');
  assert.equal(productSet.productOptions[0].name, 'Size');
});

test('a missing price or category is refused before anything is written', () => {
  assert.throws(() => buildProductSet({ ...TILE, price: undefined }), /needs a price/);
  assert.throws(() => buildProductSet({ ...TILE, category: 'Curtains' }), /category is required/);
});

test('an off-vocabulary value warns but does not block', () => {
  const { warnings } = buildProductSet({ ...TILE, finish: 'Mate' });
  assert.ok(warnings.some((w) => w.includes('Mate')), warnings.join('|'));
  assert.deepEqual(buildProductSet(TILE).warnings, [], 'known values are silent');
});

test('an empty applications list does not append a literal 0 to the title', () => {
  // `x && str` returns X ITSELF when x is falsy, so [] yielded the NUMBER 0 and
  // join() kept it (String(0) is truthy). Every product created without
  // applications was titled "... · 0". Same trap on a 0 thickness / 0 variants.
  const seo = require('../lib/seoGenerator');
  for (const fields of [
    { category: 'Tiles', sku: 'TL-1', applications: [] },
    { category: 'Tiles', sku: 'TL-1', applications: [], thicknessMm: 0, designVariants: 0 },
    { category: 'Tiles', sku: 'TL-1' },
  ]) {
    const title = seo.deriveTitle(fields);
    assert.ok(!/·\s*0\s*$/.test(title), `trailing zero in: ${title}`);
    assert.ok(!title.split('·').some((s) => s.trim() === '0'), `bare 0 segment in: ${title}`);
  }
});

test('install caveats reach the title, not just the metafield', () => {
  // deriveTitle read `caveats`; every writer sets `installCaveats`. Only a test
  // fixture ever set the former, so the caveat segment never fired on a real
  // product -- "2-3 mm Spacer is Mandatory" could not appear.
  const { productSet } = buildProductSet({
    ...TILE, installCaveats: ['2-3 mm spacer is mandatory'],
  });
  assert.match(productSet.title, /2-3 mm spacer is mandatory/);
  assert.ok(productSet.metafields.some((m) => m.key === 'install_caveats'), 'and still written structurally');
});

test('two variants sharing a size are refused before Shopify sees them', () => {
  // One tile size in two thicknesses is the realistic trigger. productSet is
  // atomic, so a duplicate option value fails the WHOLE product, not one variant.
  assert.throws(
    () => buildProductSet({
      ...TILE,
      variants: [
        { sizeLabel: '600 x 600 mm', thicknessMm: 8, price: 119 },
        { sizeLabel: '600 x 600 mm', thicknessMm: 10, price: 139 },
      ],
    }),
    /two variants share the size/,
  );
  // Distinct sizes are still fine.
  const ok = buildProductSet({
    ...TILE,
    variants: [{ sizeLabel: '600 x 600 mm', price: 119 }, { sizeLabel: '800 x 800 mm', price: 139 }],
  });
  assert.equal(ok.productSet.productOptions[0].values.length, 2);
});

/* ── per-unit pricing ─────────────────────────────────────────────────────── */

// One sheet, priced as one sheet. 8 ft × 4 ft is 32 sq ft, but that is not what the
// price is quoted in and the coverage is here only to prove it is ignored.
const LAMINATE = {
  category: 'Laminates', material: 'Acrylic', finish: 'High Gloss', series: 'Plain Solids',
  sku: 'LM-2201', price: 2450, sizeLabel: '8 ft x 4 ft', thicknessMm: 1,
  packUnit: 'sheet', piecesPerPack: 1, coveragePerPack: 32,
};

// Quoted per sq ft, SOLD by the roll — so the coverage is the roll's own dimensions.
const WALLPAPER = {
  category: 'Wallpaper', material: 'Non-woven', pattern: 'Floral',
  sku: 'WP-3301', price: 3299, sizeLabel: '10000 x 550 mm',
  packUnit: 'roll', rollLengthM: 10, rollWidthMm: 550,
};

const PANEL = {
  category: 'Panels', material: 'Charcoal', finish: 'Texture', series: 'Wooden Panels',
  sku: 'PN-4401', price: 890, sizeLabel: '2900 x 150 mm', packUnit: 'piece', piecesPerPack: 1,
};

const firstVariant = (spec) => buildProductSet(spec).productSet.variants[0];
const variantMetafields = (spec) =>
  Object.fromEntries(firstVariant(spec).metafields.map((m) => [m.key, m.value]));

test('tiles carry a unit price measurement, which is what turns the PDP on', () => {
  // The storefront reads variant.unitPriceMeasurement.quantityValue (material-frontend
  // src/lib/product.js, mapVariant). Without it coverage is 0, perSqFt is 0, and the
  // per-sq-ft headline, the per-box line, the per-unit compare-at and the whole
  // AreaCalculator all disappear. Every product this file made before did exactly that.
  const v = firstVariant(TILE);
  assert.equal(v.showUnitPrice, true);
  assert.deepEqual(v.unitPriceMeasurement, {
    quantityValue: 46.5, quantityUnit: 'FT2', referenceValue: 1, referenceUnit: 'FT2',
  });
  // And the price stays the PACK price. The variant IS the box; Shopify divides.
  assert.equal(v.price, '129');
});

test('laminates and panels carry NONE — the sheet and the piece ARE the unit', () => {
  // The omission is load-bearing, not laziness. Sending a measurement here would make
  // the PDP print "₹X/sq ft" for a price that is per sheet. Omitted, perSqFt falls to
  // 0 and the existing UI correctly renders "₹2,450/sheet" with a quantity stepper.
  for (const [name, spec] of [['laminate', LAMINATE], ['panel', PANEL]]) {
    const v = firstVariant(spec);
    assert.equal(v.unitPriceMeasurement, undefined, `${name} must not claim a per-area rate`);
    assert.equal(v.showUnitPrice, undefined, `${name} must not switch on unit pricing`);
  }
  // Coverage is still STORED for the laminate — it just does not price it.
  assert.equal(variantMetafields(LAMINATE).coverage_per_pack, '32');
});

test('wallpaper derives its coverage from the roll it is sold by', () => {
  // 10 m × 550 mm = 5.5 m² = 59.2 sq ft.
  assert.equal(firstVariant(WALLPAPER).unitPriceMeasurement.quantityValue, 59.2);
  assert.equal(variantMetafields(WALLPAPER).roll_length_m, '10');
  assert.equal(variantMetafields(WALLPAPER).roll_width_mm, '550');
  // A stated coverage always wins over the derivation — a patterned roll with a repeat
  // yields less than its raw area, and only the merchant knows by how much.
  assert.equal(firstVariant({ ...WALLPAPER, coveragePerPack: 57 }).unitPriceMeasurement.quantityValue, 57);
});

test('a sq-ft category with nothing to divide by warns rather than going quiet', () => {
  const { warnings } = buildProductSet({ ...TILE, coveragePerPack: undefined });
  assert.ok(warnings.some((w) => /coverage_per_pack/.test(w)), warnings.join('|'));
  assert.equal(firstVariant({ ...TILE, coveragePerPack: undefined }).unitPriceMeasurement, undefined);
});

test('price_unit defaults from the category, and a contradicting one is REJECTED', () => {
  // A validation, not a default: a default cannot help, because the supplied value
  // always wins over any fallback. Absent, the category answers.
  assert.equal(variantMetafields(TILE).price_unit, 'Sq. Ft.');
  assert.equal(variantMetafields(LAMINATE).price_unit, 'Sheet');
  assert.equal(variantMetafields(PANEL).price_unit, 'Piece');
  assert.equal(variantMetafields(WALLPAPER).price_unit, 'Sq. Ft.');

  // Spelling is not what is being checked — the unit is. Stored as the merchant wrote it.
  assert.equal(variantMetafields({ ...TILE, priceUnit: 'sq ft' }).price_unit, 'sq ft');
  assert.equal(variantMetafields({ ...LAMINATE, priceUnit: 'Sheets' }).price_unit, 'Sheets');

  // Stricter than vocabularyWarnings, deliberately: a wrong unit is a wrong PRICE, not
  // a wrong label. GlassQuick's nameplate went live at ₹64 instead of ~₹9,176 because
  // nothing asserted the unit against the product type, and a warning would have
  // scrolled past the same way.
  assert.throws(
    () => buildProductSet({ ...TILE, priceUnit: 'Sheet' }),
    (err) => err.code === 'price_unit_mismatch' && /contradicts tiles/.test(err.message),
  );
  assert.throws(() => buildProductSet({ ...LAMINATE, priceUnit: 'Sq. Ft.' }), /contradicts laminates/);
  assert.throws(() => buildProductSet({ ...PANEL, priceUnit: 'Sq. Ft.' }), /contradicts panels/);
});

test('pack arithmetic that cannot be true warns, but never blocks', () => {
  // 6 × 1200 × 600 mm is 46.5 sq ft; 4.65 is a decimal point in the wrong place.
  const { warnings, productSet } = buildProductSet({ ...TILE, coveragePerPack: 4.65 });
  assert.ok(warnings.some((w) => /transposed digit/.test(w)), warnings.join('|'));
  assert.equal(productSet.variants.length, 1, 'a warning, not a gate');

  // Rounding and grout lines are not errors: 8 ft × 4 ft against a quoted 32 sq ft.
  assert.deepEqual(buildProductSet(LAMINATE).warnings, []);
  // And a size this cannot parse yields no check at all, rather than a false alarm.
  assert.deepEqual(buildProductSet({ ...TILE, sizeLabel: 'Large', coveragePerPack: 4.65 }).warnings, []);
});

test('prices are whole rupees on both sides', () => {
  // Decimals read as unprofessional in ads and risk a GMC/Meta feed↔landing-page
  // price-mismatch disapproval, which takes down the feed rather than one product.
  const v = firstVariant({ ...TILE, price: 1844.5, compareAtPrice: 2360.4 });
  assert.equal(v.price, '1845');
  assert.equal(v.compareAtPrice, '2360');
  assert.throws(() => buildProductSet({ ...TILE, price: 0.4 }), /needs a price/, 'and rounding cannot make one free');
});

test('compare-at is derived from the discount ladder, and no percentage is stored', () => {
  // 1845 ÷ ((1 − 0.20) × (1 − 0.05)) = 2427.6.
  const { productSet } = buildProductSet({ ...TILE, price: 1845, flatDiscountPct: 20, additionalDiscountPct: 5 });
  assert.equal(productSet.variants[0].compareAtPrice, '2428');

  // The badge computes itself from the two prices, so a stored percentage would be a
  // third copy of the same fact and the first one to go stale.
  const keys = productSet.variants[0].metafields.map((m) => m.key).concat(productSet.metafields.map((m) => m.key));
  assert.ok(!keys.some((k) => /discount/.test(k)), keys.join(','));

  // Optional input, not required: no ladder, no compare-at.
  assert.equal(firstVariant(TILE).compareAtPrice, undefined);
  // An explicit compare-at wins over the derivation.
  assert.equal(firstVariant({ ...TILE, compareAtPrice: 2500, flatDiscountPct: 20 }).compareAtPrice, '2500');
  // And a ladder that cannot describe a price says so instead of writing Infinity.
  const impossible = buildProductSet({ ...TILE, flatDiscountPct: 100 });
  assert.equal(impossible.productSet.variants[0].compareAtPrice, undefined);
  assert.ok(impossible.warnings.some((w) => /compare-at/.test(w)));
});

test('panels and stone can be created at all; a genuinely unknown category still throws', () => {
  // resolveCategory returned null for both, and this file HARD THROWS on null — so
  // these products could not be created, at all, by any input.
  assert.equal(buildProductSet(PANEL).categoryId, 'panels');
  const stone = buildProductSet({
    category: 'Stone', sku: 'ST-5501', price: 4500,
    sizeLabel: '10.75 ft x 5.42 ft', packUnit: 'slab', coveragePerPack: 58.3,
  });
  assert.equal(stone.categoryId, 'stone');
  assert.equal(stone.productSet.variants[0].unitPriceMeasurement.quantityValue, 58.3, 'stone is priced per sq ft');

  // Kept: a category nobody recorded a price unit for cannot be priced safely.
  assert.throws(() => buildProductSet({ ...TILE, category: 'Hardware' }), (err) => err.code === 'bad_category');
});

test('every metafield key this file WRITES is defined by the product model', () => {
  // The mirror of seoGenerator's guard, which asserts every key it READS is defined.
  // A metafield with no definition is accepted by Shopify and then invisible to the
  // Storefront API, which returns null for an undefined key rather than an error —
  // so the PDP goes quiet and nothing anywhere reports a problem.
  const script = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../material-frontend/scripts/setup-product-model.mjs'),
    'utf8',
  );

  const defined = { PRODUCT: new Set(), PRODUCTVARIANT: new Set() };
  for (const [, owner, key] of script.matchAll(/ownerType:\s*"(PRODUCT|PRODUCTVARIANT)",\s*key:\s*"([a-z_]+)"/g)) {
    defined[owner].add(key);
  }
  assert.ok(defined.PRODUCT.size > 5, 'could not parse the definition script — has its shape changed?');

  const missing = [
    ...Object.keys(PRODUCT_TYPES).filter((k) => !defined.PRODUCT.has(k)).map((k) => `PRODUCT.${k}`),
    ...Object.keys(VARIANT_TYPES).filter((k) => !defined.PRODUCTVARIANT.has(k)).map((k) => `VARIANT.${k}`),
  ];
  assert.deepEqual(missing, [], `written but never defined: ${missing.join(', ')}`);
});
