const test = require('node:test');
const assert = require('node:assert');

const readiness = require('../lib/productReadiness');
const { asProductGid, baseHandle } = require('../lib/productPublish');
const { buildProductSet } = require('../lib/productCreate');
const { getScenesForCategory, SCENE_METADATA } = require('../lib/productImages/promptBuilder');

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const mf = (obj) => ({ nodes: Object.entries(obj).map(([key, value]) => ({ key, value: String(value) })) });

/** Every scene the category shoots, as the pipeline writes them: alt = scene label. */
const sceneAlts = (categoryId) => ({
  nodes: getScenesForCategory(categoryId).map((id) => ({ mediaContentType: 'IMAGE', alt: SCENE_METADATA[id].label })),
});

/**
 * A tile that is genuinely ready to sell: complete, in stock, live, unique.
 *
 * The whole gate design rests on a legitimate product tripping NOTHING, so this
 * fixture is the assertion. Deviations below are one field at a time.
 */
function tileNode(over = {}) {
  return {
    id: 'gid://shopify/Product/1',
    handle: 'wood-floor-tile-tl-06117-nordic-honey',
    title: 'Wood Floor Tile · TL 06117 · Nordic Honey · 1200 × 200 mm',
    status: 'ACTIVE',
    productType: 'Tiles',
    tags: [],
    descriptionHtml: `<p>${'A vitrified wood-look plank for living rooms and bedrooms. '.repeat(8)}</p>`,
    seo: {
      title: 'Nordic Honey Wood Floor Tile 1200 × 200 mm | Material'.padEnd(55, ' ').trim(),
      description: 'Buy Nordic Honey wood-look vitrified tile online at Material. 1200 × 200 mm, matte finish, 9 mm, R10 slip rating. Suitable for living room.',
    },
    options: [{ name: 'Size', values: ['1200 × 200 mm'] }],
    media: sceneAlts('tiles'),
    metafields: mf({
      finish: 'Matte',
      material: 'Vitrified',
      look: 'Wood',
      application: '["Living room","Bedroom"]',
      slip_rating: 'R10',
      colour_family: '["Brown"]',
      colour_name: 'Nordic Honey',
      series: 'Wooden Effect',
      surface: '["Floor"]',
    }),
    resourcePublications: { nodes: [{ isPublished: true, publication: { id: 'gid://shopify/Publication/1', name: 'Online Store' } }] },
    variants: {
      nodes: [
        {
          id: 'gid://shopify/ProductVariant/1',
          sku: 'TL 06117',
          price: '1844.50',
          compareAtPrice: '3173.78',
          inventoryQuantity: 80,
          inventoryPolicy: 'DENY',
          selectedOptions: [{ name: 'Size', value: '1200 × 200 mm' }],
          inventoryItem: { id: 'gid://shopify/InventoryItem/1', tracked: true },
          metafields: mf({
            size_label: '1200 x 200 mm',
            price_unit: 'Sq. Ft.',
            pack_unit: 'box',
            coverage_per_pack: '31.2',
            thickness_mm: '9.0',
            pieces_per_pack: '6',
          }),
        },
      ],
    },
    ...over,
  };
}

const NO_DUPES = { titles: [], handles: [] };
/** What lib/productPublish.js's assessProduct does, minus the network. */
const run = (node, ctx = {}) =>
  readiness.assess(readiness.readinessFields(node), {
    duplicates: NO_DUPES,
    loadErrors: readiness.loadErrors(node),
    ...ctx,
  });

/** Only the gate CODES, so a test names the rule rather than the offender key. */
const gateCodes = (r) => [...new Set(r.gates.map((g) => g.code))];
const warnCodes = (r) => [...new Set(r.warnings.map((w) => w.code))];

/* ── the property the whole design rests on ───────────────────────────────── */

test('a legitimate, ready-to-sell product trips no gate at all', () => {
  const r = run(tileNode());
  assert.deepEqual(r.gates, [], JSON.stringify(gateCodes(r)));
  assert.equal(r.publishable, true);
  // And nothing cosmetic is outstanding either, which proves the warning set is
  // satisfiable — a check nothing can pass is a check that trains people to ignore
  // the score.
  assert.equal(r.score, 100, JSON.stringify(warnCodes(r)));
  assert.equal(r.readiness, 'ready');
});

test('a legitimate laminate and a legitimate wallpaper also trip no gate', () => {
  // Laminate: priced AND sold per sheet, so no coverage figure — the carve-out.
  const laminate = tileNode({
    id: 'gid://shopify/Product/2',
    handle: 'wooden-effect-laminate-lm-101',
    title: 'Wooden Effect Laminate · LM 101',
    productType: 'Laminates',
    options: [{ name: 'Size', values: ['2440 x 1220 mm'] }],
    media: sceneAlts('laminates'),
    metafields: mf({ finish: 'Suede', material: 'Acrylic', look: 'Wood', application: '["Wardrobe"]',
      colour_family: '["Brown"]', colour_name: 'Smoked Oak', series: 'Wooden Effect', surface: '["Wall"]' }),
    variants: { nodes: [{ ...tileNode().variants.nodes[0], sku: 'LM 101',
      selectedOptions: [{ name: 'Size', value: '2440 x 1220 mm' }],
      metafields: mf({ size_label: '2440 x 1220 mm', price_unit: 'Sheet', pack_unit: 'Sheet', thickness_mm: '1.0' }) }] },
  });
  const lam = run(laminate);
  assert.deepEqual(lam.gates, [], JSON.stringify(gateCodes(lam)));

  // Wallpaper: a custom-size mural has no size at all, and no slip rating or
  // thickness to have. None of that may gate it.
  const mural = tileNode({
    id: 'gid://shopify/Product/3',
    handle: 'custom-mural-wallpaper-wp-500',
    title: 'Custom Mural Wallpaper · WP 500',
    productType: 'Wallpaper',
    options: [],
    media: sceneAlts('wallpaper'),
    metafields: mf({ finish: 'Textured', material: 'Non-woven', application: '["Bedroom"]',
      colour_family: '["Multi"]', colour_name: 'Tropical Green', series: 'Tropical Florals' }),
    variants: { nodes: [{ ...tileNode().variants.nodes[0], sku: 'WP 500',
      selectedOptions: [{ name: 'Title', value: 'Default Title' }],
      metafields: mf({ price_unit: 'Sq. Ft.', pack_unit: 'roll', coverage_per_pack: '58.1' }) }] },
  });
  const wp = run(mural);
  assert.deepEqual(wp.gates, [], JSON.stringify(gateCodes(wp)));
  // Downgraded, not dropped: it is still worth knowing the mural has no size.
  assert.ok(warnCodes(wp).includes('gate:size_label'), JSON.stringify(warnCodes(wp)));
});

/* ── one gate at a time ───────────────────────────────────────────────────── */

test('each gate fires on its own defect and nothing else does', () => {
  const cases = [
    [['gate:image'], { media: { nodes: [] } }],
    // Category cascades into price_unit ON PURPOSE and this pins it: the expected
    // unit is a property OF the category (lib/keyword-bank.json), so a product that
    // resolves to no category has no unit to be checked against. Fixing the category
    // fixes both, and reporting only the first would hide half the work.
    [['gate:category', 'gate:price_unit'], { productType: 'Curtains', handle: 'x', title: 'Y' }],
    // Two conditions, one gate — either alone is an invisible product.
    [['gate:visibility'], { status: 'DRAFT' }],
    [['gate:visibility'], { resourcePublications: { nodes: [] } }],
  ];
  for (const [codes, over] of cases) {
    const r = run(tileNode(over));
    assert.deepEqual(gateCodes(r).sort(), [...codes].sort(), `got ${JSON.stringify(gateCodes(r))}`);
    assert.equal(r.publishable, false);
  }
});

test('a zero-priced or unpriced variant is gated, and named by SKU', () => {
  const node = tileNode();
  node.variants.nodes[0].price = '0.00';
  const r = run(node);
  assert.deepEqual(gateCodes(r), ['gate:variant_price']);
  assert.equal(r.gates[0].id, 'gate:variant_price:TL 06117');

  // A product with no variants at all cannot be bought either.
  const none = run(tileNode({ variants: { nodes: [] } }));
  assert.ok(gateCodes(none).includes('gate:variant_price'));
});

test('price_unit must be set AND match what the category is priced in', () => {
  const wrong = tileNode();
  // "Sheet" is the laminate unit. On a tile it means the price means something else.
  wrong.variants.nodes[0].metafields = mf({ ...{ size_label: '1200 x 200 mm', pack_unit: 'box', coverage_per_pack: '31.2', thickness_mm: '9' }, price_unit: 'Sheet' });
  assert.ok(gateCodes(run(wrong)).includes('gate:price_unit'));

  const missing = tileNode();
  missing.variants.nodes[0].metafields = mf({ size_label: '1200 x 200 mm', pack_unit: 'box', coverage_per_pack: '31.2', thickness_mm: '9' });
  assert.ok(gateCodes(run(missing)).includes('gate:price_unit'));

  // Spelling is not the test. These are the same unit as "Sq. Ft." and must pass,
  // because lib/productCreate.js accepts every one of them at create time.
  for (const spelling of ['sq ft', 'SQFT', 'Square Feet', 'sq. ft.']) {
    const ok = tileNode();
    ok.variants.nodes[0].metafields = mf({ size_label: '1200 x 200 mm', price_unit: spelling, pack_unit: 'box', coverage_per_pack: '31.2', thickness_mm: '9' });
    assert.deepEqual(run(ok).gates, [], `"${spelling}" should be Sq. Ft.`);
  }
});

test('coverage_per_pack is gated only when the price unit differs from the pack unit', () => {
  // Priced per sq ft, sold per box, no coverage: nobody can work out how many boxes.
  const gapped = tileNode();
  gapped.variants.nodes[0].metafields = mf({ size_label: '1200 x 200 mm', price_unit: 'Sq. Ft.', pack_unit: 'box', thickness_mm: '9' });
  assert.ok(gateCodes(run(gapped)).includes('gate:coverage_per_pack'));

  // THE CARVE-OUT. Priced per sheet, sold per sheet: there is nothing to convert, and
  // demanding a coverage figure here would fire on a perfectly saleable laminate.
  const sheet = tileNode({ productType: 'Laminates', handle: 'lm-1', title: 'Laminate LM 1', media: sceneAlts('laminates'),
    options: [{ name: 'Size', values: ['2440 x 1220 mm'] }] });
  sheet.variants.nodes[0].selectedOptions = [{ name: 'Size', value: '2440 x 1220 mm' }];
  sheet.variants.nodes[0].metafields = mf({ size_label: '2440 x 1220 mm', price_unit: 'Sheet', pack_unit: 'sheets', thickness_mm: '1' });
  assert.deepEqual(gateCodes(run(sheet)).filter((c) => c === 'gate:coverage_per_pack'), []);
});

test('size_label must name a Size option the product actually sells', () => {
  const orphan = tileNode();
  // A real-looking label for a size no variant is sold in — a typo, not a product.
  orphan.variants.nodes[0].metafields = mf({ size_label: '600 x 600 mm', price_unit: 'Sq. Ft.', pack_unit: 'box', coverage_per_pack: '31.2', thickness_mm: '9' });
  assert.ok(gateCodes(run(orphan)).includes('gate:size_label'));

  // The multiplication sign is not a defect. Live products carry "×" (U+00D7) in the
  // option while productCreate writes "x" in the label; comparing them raw would gate
  // every correct product in the store.
  assert.deepEqual(run(tileNode()).gates, [], 'x vs × must compare equal');
});

/* ── gate 8: the tuned regexes ────────────────────────────────────────────── */

test('placeholder detection matches words STARTING with test/copy, not containing them', () => {
  // Ported from glassquickdev. An untuned /test|copy/ flagged all of the right-hand
  // column on real products; that tuning is what makes the gate safe to block on.
  for (const bad of ['Test Tile', 'Testing Tile', 'Tester Tile', 'Copy of Wood Tile', 'Wood Tile copy']) {
    assert.ok(readiness.TITLE_PLACEHOLDER.test(bad), bad);
  }
  for (const good of ['Latest Wood Tile', 'Greatest Hits Tile', 'Contest Winner Tile', 'Protest Grey Tile']) {
    assert.ok(!readiness.TITLE_PLACEHOLDER.test(good), good);
  }
  for (const bad of ['test-tile', 'testing-tile', 'copy-of-wood-tile', 'wood-tile-copy']) {
    assert.ok(readiness.HANDLE_PLACEHOLDER.test(bad), bad);
  }
  for (const good of ['latest-wood-tile', 'greatest-tile', 'contest-tile', 'protest-grey']) {
    assert.ok(!readiness.HANDLE_PLACEHOLDER.test(good), good);
  }
});

test('placeholders and store-wide collisions are one gate with four stable keys', () => {
  const r = run(tileNode({ title: 'Test Wood Tile', handle: 'copy-of-wood-tile' }), {
    duplicates: { titles: ['other-wood-tile'], handles: ['wood-floor-tile-tl-06117-nordic-honey-2'] },
  });
  assert.deepEqual(
    r.gates.map((g) => g.id).sort(),
    ['gate:naming:duplicate_handle', 'gate:naming:duplicate_title', 'gate:naming:handle_placeholder', 'gate:naming:title_placeholder'],
  );
});

/* ── "not fetched" is not "absent" ────────────────────────────────────────── */

test('a metafield connection that did not come back refuses to score', () => {
  const node = tileNode();
  delete node.metafields; // what a throttled or thinner read looks like
  const r = run(node);

  assert.equal(r.scored, false);
  assert.equal(r.score, null);
  assert.equal(r.publishable, false, 'never publish on a read we do not trust');
  assert.deepEqual(r.gates, [], 'and never claim the fields are missing');
  assert.deepEqual(r.warnings, []);
  assert.ok(r.loadErrors.some((e) => /product metafields not fetched/.test(e)), JSON.stringify(r.loadErrors));
});

test('every connection the query asks for is checked, including per-variant', () => {
  const node = tileNode();
  delete node.variants.nodes[0].metafields;
  assert.ok(readiness.loadErrors(node).some((e) => /variant TL 06117 metafields/.test(e)));

  for (const key of ['media', 'resourcePublications', 'variants']) {
    const n = tileNode();
    delete n[key];
    assert.ok(readiness.loadErrors(n).length, `${key} dropped silently`);
  }
  assert.deepEqual(readiness.loadErrors(tileNode()), [], 'a complete node has no load errors');
});

test('an unsupplied duplicate check is "not checked", never "unique"', () => {
  // Uniqueness cannot be decided from the product, so silence here would be the same
  // false pass as reporting a throttled metafield read as an empty field.
  const r = readiness.assess(readiness.readinessFields(tileNode()), {});
  assert.equal(r.scored, false);
  assert.equal(r.publishable, false);
  assert.ok(r.loadErrors.some((e) => /duplicate check not run/.test(e)));
});

/* ── the separation itself ────────────────────────────────────────────────── */

test('a high score never makes an unpublishable product publishable', () => {
  // glassquickdev's exact inversion: out of stock AND unpublished scored 85/100,
  // grade B, and nothing stopped it. Here the score may be whatever it is; the
  // decision is not made from it.
  const node = tileNode({ status: 'DRAFT', resourcePublications: { nodes: [] } });
  node.variants.nodes[0].inventoryQuantity = 0;
  const r = run(node);

  assert.equal(r.publishable, false);
  assert.ok(gateCodes(r).includes('gate:visibility'));
  assert.ok(r.score >= 80, `score is advisory and stays high: ${r.score}`);
  assert.ok(warnCodes(r).includes('warn:out_of_stock'), 'and out of stock is still reported');
});

test('gates carry no weight in the score, and warnings carry none in the decision', () => {
  const clean = run(tileNode());
  // Same product, one gate broken, nothing cosmetic changed.
  const gated = run(tileNode({ media: { nodes: [] } }));
  assert.equal(gated.publishable, false);
  assert.equal(gated.score, clean.score, 'a gate must not move the score');

  // Same product, one warning broken, no gate touched.
  const warned = tileNode();
  warned.metafields = mf({ finish: 'Matte', material: 'Vitrified', look: 'Wood', application: '["Living room"]',
    colour_family: '["Brown"]', colour_name: 'Nordic Honey', series: 'Wooden Effect', surface: '["Floor"]' });
  const w = run(warned);
  assert.equal(w.publishable, true, 'a missing slip rating must not block a sale');
  assert.ok(w.score < 100);
  assert.ok(warnCodes(w).includes('warn:slip_rating'));
});

test('out-of-stock and untracked are loud warnings, never gates', () => {
  // Both make a product hard to sell honestly, and both are legitimate on a
  // made-to-order product — so both are warnings. A gate here would fire on a real
  // product, which is what teaches an operator to route around the gates.
  const node = tileNode();
  node.variants.nodes[0].inventoryQuantity = 0;
  node.variants.nodes[0].inventoryItem = { tracked: false };
  const r = run(node);
  assert.deepEqual(r.gates, []);
  assert.ok(warnCodes(r).includes('warn:untracked'));
  // Untracked means unlimited, so "out of stock" does not apply to it.
  assert.ok(!warnCodes(r).includes('warn:out_of_stock'));
});

/* ── per-category exemption, generalised ──────────────────────────────────── */

test('a wallpaper is not marked down for a thickness or slip rating it cannot have', () => {
  // A standard roll — it HAS a size, so the degraded size gate is satisfied and the
  // only thing left to measure is the exemptions.
  const wp = tileNode({ productType: 'Wallpaper', handle: 'wp-1', title: 'Textured Wallpaper WP 1',
    media: sceneAlts('wallpaper'), options: [{ name: 'Size', values: ['10 m x 550 mm'] }],
    // No `finish`: wallpaper has no finish facet, which is the same fact
    // seoGenerator's RUBRIC carve-out encodes.
    metafields: mf({ material: 'Non-woven', pattern: 'Plain & textured', application: '["Bedroom"]',
      colour_family: '["Multi"]', colour_name: 'Chalk', series: 'Plain Solids' }) });
  wp.variants.nodes[0].selectedOptions = [{ name: 'Size', value: '10 m x 550 mm' }];
  wp.variants.nodes[0].metafields = mf({ size_label: '10 m x 550 mm', price_unit: 'Sq. Ft.', pack_unit: 'roll', coverage_per_pack: '58.1' });

  const r = run(wp);
  const codes = warnCodes(r);
  for (const na of ['warn:slip_rating', 'warn:thickness', 'warn:surface']) {
    assert.ok(!codes.includes(na), `${na} is not applicable to wallpaper`);
  }
  // Exempt means EXCLUDED from the score, not silently failed: a wallpaper missing
  // nothing applicable still scores 100.
  assert.equal(r.score, 100, JSON.stringify(codes));
});

test('a gate degraded to a warning is scored like one', () => {
  // Otherwise the wallpaper carve-out would be a free pass rather than a downgrade —
  // the finding would appear in a list and cost nothing, which is how findings get
  // ignored.
  const mural = tileNode({ productType: 'Wallpaper', handle: 'wp-mural', title: 'Custom Mural WP 2',
    media: sceneAlts('wallpaper'), options: [],
    metafields: mf({ material: 'Non-woven', pattern: 'Mural', application: '["Living room"]',
      colour_family: '["Multi"]', colour_name: 'Tropical', series: 'Tropical Florals' }) });
  mural.variants.nodes[0].selectedOptions = [{ name: 'Title', value: 'Default Title' }];
  mural.variants.nodes[0].metafields = mf({ price_unit: 'Sq. Ft.', pack_unit: 'roll', coverage_per_pack: '58.1' });

  const r = run(mural);
  assert.deepEqual(r.gates, [], 'still publishable — a mural genuinely has no size');
  assert.ok(warnCodes(r).includes('gate:size_label'));
  assert.ok(r.score < 100, `the downgrade must still cost something: ${r.score}`);
});

/* ── stable ids ───────────────────────────────────────────────────────────── */

test('issue ids are section:code:key and survive a variant being added', () => {
  const two = tileNode({ options: [{ name: 'Size', values: ['1200 × 200 mm', '600 × 600 mm'] }] });
  two.variants.nodes.push({
    ...two.variants.nodes[0], id: 'gid://shopify/ProductVariant/2', sku: 'TL 06117-600',
    selectedOptions: [{ name: 'Size', value: '600 × 600 mm' }],
    metafields: mf({ size_label: '600 x 600 mm', price_unit: 'Sq. Ft.', pack_unit: 'box', thickness_mm: '9' }),
  });
  const r = run(two);

  // The second variant has no coverage figure; the first still does.
  assert.deepEqual(r.gates.map((g) => g.id), ['gate:coverage_per_pack:TL 06117-600']);
  for (const issue of [...r.gates, ...r.warnings]) {
    assert.match(issue.id, /^(gate|warn):[a-z_:]+(:.+)?$/, issue.id);
  }

  // Adding a THIRD variant in front must not renumber the second one's issue — which
  // is exactly what an index-based key would do, losing any review state pinned to it.
  const three = tileNode({ options: two.options });
  three.variants.nodes = [
    { ...two.variants.nodes[0], id: 'gid://shopify/ProductVariant/9', sku: 'TL 06117-NEW' },
    ...two.variants.nodes,
  ];
  assert.ok(run(three).gates.some((g) => g.id === 'gate:coverage_per_pack:TL 06117-600'));
});

/* ── shared shape with the SEO rubric ─────────────────────────────────────── */

test('gates and warnings render like seoGenerator RUBRIC rows', () => {
  const seo = require('../lib/seoGenerator');
  for (const check of [...readiness.GATES, ...readiness.WARNINGS]) {
    for (const key of ['id', 'weight', 'label', 'appliesTo', 'pass']) {
      assert.ok(check[key] !== undefined, `${check.id} is missing ${key}`);
    }
    assert.equal(typeof check.pass, 'function');
  }
  // The SEO half is IMPORTED, not restated — so "meta title 50-60 chars" has one
  // definition and the two audits cannot drift apart.
  const seoIds = seo.RUBRIC.filter((c) => c.id !== 'category').map((c) => `warn:seo:${c.id}`);
  for (const id of seoIds) assert.ok(readiness.WARNINGS.some((w) => w.id === id), id);
  // Except `category`, which is gate 3 now and must not be counted twice.
  assert.ok(!readiness.WARNINGS.some((w) => w.id === 'warn:seo:category'));
});

test('gate:visibility is skipped as a precondition by the operation that fixes it', () => {
  // It is false on every product waiting to be published, so blocking on it would
  // make publishing impossible. The publish flow asserts it afterwards instead.
  const node = tileNode({ status: 'DRAFT', resourcePublications: { nodes: [] } });
  assert.ok(gateCodes(run(node)).includes('gate:visibility'));
  assert.deepEqual(run(node, { skipGatesFixedBy: 'publish' }).gates, []);
  // And it is still the readiness endpoint's business: a DRAFT is not ready.
  assert.equal(run(node).publishable, false);
});

test('a product reference may be an id, a gid or a handle', () => {
  assert.equal(asProductGid('123'), 'gid://shopify/Product/123');
  assert.equal(asProductGid('gid://shopify/Product/123'), 'gid://shopify/Product/123');
  assert.equal(asProductGid('wood-floor-tile'), null, 'a handle is looked up, not coerced');
});

test('a handle collides on its base, ignoring the -N Shopify appends', () => {
  // glassquickdev's rule: Shopify auto-suffixes a colliding handle, so `x-2` existing
  // at all is the evidence that the product was created twice — the suffix is the
  // symptom, not the difference.
  assert.equal(baseHandle('wood-floor-tile-2'), 'wood-floor-tile');
  assert.equal(baseHandle('wood-floor-tile'), 'wood-floor-tile');
  // A trailing number that is part of the NAME must survive: a size, a series number
  // or an SKU digit is not a duplicate marker.
  assert.equal(baseHandle('tile-600x600'), 'tile-600x600');
  assert.equal(baseHandle('tile-tl-06117'), 'tile-tl-06117');
});

/* ── inventory at create ──────────────────────────────────────────────────── */

const TILE_SPEC = {
  category: 'Tiles', look: 'Marble', material: 'Vitrified', finish: 'Matte',
  colourName: 'Carrara Mist', sku: 'TL-90001', price: 129, sizeLabel: '1200 x 600 mm',
};
const LOC = 'gid://shopify/Location/88415535241';

test('every variant is created TRACKED, at a location, with a quantity', () => {
  // Measured on the live store: without this a new variant comes back tracked:false
  // and 0 publications — purchasable without limit, and invisible.
  const { productSet } = buildProductSet({ ...TILE_SPEC, quantity: 40 }, { locationId: LOC });
  const v = productSet.variants[0];
  assert.deepEqual(v.inventoryItem, { sku: 'TL-90001', tracked: true });
  assert.deepEqual(v.inventoryQuantities, [{ locationId: LOC, name: 'available', quantity: 40 }]);
});

test('quantity defaults to zero and is still written', () => {
  // Activating at zero is what makes the variant read "sold out" rather than
  // "unlimited", and it leaves a level the merchant can edit in admin.
  const { productSet } = buildProductSet(TILE_SPEC, { locationId: LOC });
  assert.deepEqual(productSet.variants[0].inventoryQuantities, [{ locationId: LOC, name: 'available', quantity: 0 }]);
});

test('tracking is overridable per variant, and per product', () => {
  const perVariant = buildProductSet({
    ...TILE_SPEC,
    variants: [
      { sizeLabel: '600 x 600 mm', price: 119, sku: 'A', quantity: 5 },
      { sizeLabel: '800 x 800 mm', price: 139, sku: 'B', tracked: false },
    ],
  }, { locationId: LOC }).productSet;
  assert.equal(perVariant.variants[0].inventoryItem.tracked, true);
  assert.equal(perVariant.variants[1].inventoryItem.tracked, false);
  // Still activated at the location — Shopify accepts it, and the level is ready for
  // the day tracking is switched on.
  assert.equal(perVariant.variants[1].inventoryQuantities.length, 1);

  const perProduct = buildProductSet({ ...TILE_SPEC, tracked: false }, { locationId: LOC }).productSet;
  assert.equal(perProduct.variants[0].inventoryItem.tracked, false);
});

test('with no location resolved, no inventory quantities are invented', () => {
  const { productSet } = buildProductSet(TILE_SPEC);
  assert.equal(productSet.variants[0].inventoryQuantities, undefined);
  // Tracking is not location-dependent and still applies.
  assert.equal(productSet.variants[0].inventoryItem.tracked, true);
});
