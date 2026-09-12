const test = require('node:test');
const assert = require('node:assert');

const {
  buildCollectionInput,
  setCollectionProducts,
  menuLinks,
  diagnoseLink,
  nearDuplicates,
  buildVocabulary,
  slug,
} = require('../lib/collections');
const { reorderCollections } = require('../lib/collectionReorder');

/* ── fixtures ───────────────────────────────────────────────────────────────── */

// The live store's definition names, verified 2026-08. Three of the menu's seven
// params slug-match one of these; four do not.
const DEFINITIONS = [
  { name: 'Finish', namespace: 'custom', key: 'finish', ownerType: 'PRODUCT' },
  { name: 'Look', namespace: 'custom', key: 'look', ownerType: 'PRODUCT' },
  { name: 'Pattern', namespace: 'custom', key: 'pattern', ownerType: 'PRODUCT' },
  { name: 'Application', namespace: 'custom', key: 'application', ownerType: 'PRODUCT' },
  { name: 'Slip rating', namespace: 'custom', key: 'slip_rating', ownerType: 'PRODUCT' },
  { name: 'Use case', namespace: 'custom', key: 'use_case', ownerType: 'PRODUCT' },
  { name: 'Size label', namespace: 'custom', key: 'size_label', ownerType: 'PRODUCTVARIANT' },
];

const MENU = {
  menus: [{
    items: [{
      title: 'Tiles',
      url: 'https://material.in/collections/tiles',
      items: [{
        title: 'Shop by finish',
        url: 'https://material.in#',
        items: [
          { title: 'Matte', url: 'https://material.in/collections/tiles?finish=matte', items: [] },
          { title: 'Anti-skid', url: 'https://material.in/collections/tiles?slip=r11', items: [] },
        ],
      }],
    }, {
      title: 'Wood', url: 'https://material.in/collections/wood', items: [],
    }],
  }],
};

/* ── the menu walk ──────────────────────────────────────────────────────────── */

test('menuLinks flattens to one row per destination, group headings excluded', () => {
  const links = menuLinks(MENU);
  // Two leaves + two category links; the "Shop by finish" heading points at "#" and
  // is not a destination, so it must not appear.
  assert.deepEqual(
    links.map((l) => `${l.handle}${l.param ? `?${l.param}=${l.value}` : ''}`),
    ['tiles', 'tiles?finish=matte', 'tiles?slip=r11', 'wood'],
  );
  assert.equal(links[1].path, 'Tiles › Shop by finish');
});

test('sort and cursor are not facets', () => {
  // CONTROL_PARAMS mirrors material-frontend/src/lib/collection.js. A ?sort= link
  // reported as a broken facet would be noise in a report whose only value is signal.
  const links = menuLinks({
    menus: [{ items: [{ title: 'X', url: 'https://material.in/collections/tiles?sort=price&look=marble', items: [] }] }],
  });
  assert.deepEqual(links.map((l) => l.param), ['look']);
});

/* ── the diagnosis ──────────────────────────────────────────────────────────── */

test('a param resolves only when it slugs to a FACET LABEL, not to a metafield key', () => {
  // This is the whole bug. `?slip=` looks right and the data exists, but the storefront
  // matches slug(facet.label) === slug(param) and the label is "Slip rating".
  assert.equal(slug('Slip rating'), 'sliprating');
  assert.notEqual(slug('Slip rating'), slug('slip'));

  const r = diagnoseLink({ handle: 'tiles', param: 'slip', value: 'r11' }, {
    collectionExists: true,
    facets: [{ id: 'filter.p.m.custom.slip_rating', label: 'Slip rating', values: [{ label: 'R11', count: 3 }] }],
    definitions: DEFINITIONS,
  });
  assert.equal(r.status, 'param does not match any facet label');
  assert.match(r.fix, /Slip rating/);
  assert.match(r.fix, /\?slip-rating=/, 'the fix names a param that would actually work');
});

test('an enabled facet with a matching value is ok, and carries the count', () => {
  const r = diagnoseLink({ handle: 'tiles', param: 'finish', value: 'matte' }, {
    collectionExists: true,
    facets: [{ id: 'filter.p.m.custom.finish', label: 'Finish', values: [{ label: 'Matte', count: 4 }] }],
    definitions: DEFINITIONS,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 4);
});

test('a value the facet does not offer is distinguished from a param that cannot resolve', () => {
  const r = diagnoseLink({ handle: 'tiles', param: 'finish', value: 'gloss' }, {
    collectionExists: true,
    facets: [{ id: 'filter.p.m.custom.finish', label: 'Finish', values: [{ label: 'Glossy', count: 3 }] }],
    definitions: DEFINITIONS,
  });
  // "gloss" vs "Glossy": the param is right, the value is one letter off, and the
  // storefront silently drops it. Two different fixes, so two different statuses.
  assert.equal(r.status, 'value not found in facet');
  assert.deepEqual(r.available, ['Glossy']);
});

test('a correctly-named param with the filter switched off says so, and only that', () => {
  // Definition "Finish" exists and matches ?finish=, but Search & Discovery has not
  // enabled it — so the storefront returns no such facet. One switch, not a code change.
  const r = diagnoseLink({ handle: 'tiles', param: 'finish', value: 'matte' }, {
    collectionExists: true,
    facets: [{ id: 'filter.v.availability', label: 'Availability', values: [{ label: 'In stock', count: 6 }] }],
    definitions: DEFINITIONS,
  });
  assert.equal(r.status, 'facet not enabled');
  assert.equal(r.definition, 'custom.finish');
  assert.match(r.fix, /Search & Discovery/);
});

test('a missing collection short-circuits, and a category link with no param is ok', () => {
  assert.equal(
    diagnoseLink({ handle: 'wood', param: null, value: null }, { collectionExists: false, definitions: DEFINITIONS }).status,
    'no such collection',
  );
  assert.equal(
    diagnoseLink({ handle: 'tiles', param: null, value: null }, { collectionExists: true, facets: [], definitions: DEFINITIONS }).status,
    'ok',
  );
});

test('a variant-level definition is named as such in the fix', () => {
  // ?size= targets custom.size_label, which lives on the VARIANT. Renaming the param
  // is not the whole fix, so the report must not imply that it is.
  const r = diagnoseLink({ handle: 'tiles', param: 'size', value: '600x600' }, {
    collectionExists: true, facets: [], definitions: DEFINITIONS,
  });
  assert.equal(r.status, 'param does not match any facet label');
  assert.match(r.fix, /VARIANT metafield/);
});

/* ── the vocabulary linter ──────────────────────────────────────────────────── */

test('near-duplicates separate a formatting split from a word choice', () => {
  const groups = nearDuplicates([
    { category: 'tiles', field: 'application', value: 'Living room' },
    { category: 'tiles', field: 'application', value: 'Living Room' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].reason, 'case/spacing', 'find-and-replace, not a decision');

  const variants = nearDuplicates([
    { category: 'tiles', field: 'finish', value: 'Glossy' },
    { category: 'laminates', field: 'finish', value: 'gloss' },
  ]);
  assert.equal(variants[0].reason, 'variant');
  assert.deepEqual(variants[0].seenIn, ['laminates.finish', 'tiles.finish']);
});

test('a single spelling is never reported as a duplicate of itself', () => {
  assert.deepEqual(
    nearDuplicates([
      { category: 'tiles', field: 'finish', value: 'Matte' },
      { category: 'tiles', field: 'finish', value: 'Matte' },
    ]),
    [],
  );
});

test('the two drifts already in menu-data.json both surface', () => {
  const report = buildVocabulary({
    products: [
      { handle: 'a', category: 'tiles', metafields: { finish: 'Glossy', look: 'Wood' } },
      { handle: 'b', category: 'laminates', metafields: { finish: 'Suede', look: 'Woodgrain' } },
    ],
    links: [
      { handle: 'tiles', param: 'finish', value: 'glossy', url: 'u1' },
      { handle: 'tiles', param: 'finish', value: 'textured', url: 'u2' },
      { handle: 'laminates', param: 'finish', value: 'gloss', url: 'u3' },
    ],
  });

  // 1. gloss (laminates menu) vs glossy (tiles) — one facet value split in two.
  const finish = report.nearDuplicates.finish.find((g) => g.values.includes('gloss'));
  assert.ok(finish, JSON.stringify(report.nearDuplicates));
  assert.ok(finish.values.includes('glossy') || finish.values.includes('Glossy'));

  // 2. finish=textured on TILES is a laminate finish — flagged, and told where it lives.
  const textured = report.byCategory.tiles.finish.find((v) => v.value === 'textured');
  assert.equal(textured.inCategoryVocabulary, false);
  // The laminate vocabulary spells it "Texture", so the hint only fires because the
  // knownIn comparison is stem-level while inCategoryVocabulary above is exact.
  assert.ok(textured.knownIn.includes('laminates'), JSON.stringify(textured));

  // 3. and no product carries it, so the link is a promise nothing can keep.
  assert.equal(textured.products, 0);
  assert.equal(textured.orphanLink, true);

  // Wood / Woodgrain across two categories is the same class of split.
  assert.ok(report.nearDuplicates.look.some((g) => g.values.includes('Wood') && g.values.includes('Woodgrain')));
});

test('a category with no controlled list for a field gets no verdict on it', () => {
  // The keyword bank has no `finish` for wallpaper or stone and no `series` for tiles.
  // Treating an absent list as an empty one marked 30 of 50 live values "off
  // vocabulary" — a report that cries wolf is a report nobody reads twice. Same rule
  // lib/seoGenerator.js applies when it declines to mark wallpaper down for a finish
  // it has no facet for.
  const report = buildVocabulary({
    products: [
      { handle: 'a', category: 'wallpaper', metafields: { finish: 'Textured', material: 'Non-woven' } },
      { handle: 'b', category: 'tiles', metafields: { finish: 'Satin', series: 'Marbles & Stones' } },
    ],
    links: [],
  });
  assert.equal('inCategoryVocabulary' in report.byCategory.wallpaper.finish[0], false, 'no wallpaper finish list, so no claim');
  assert.equal('inCategoryVocabulary' in report.byCategory.tiles.series[0], false, 'no tiles series list either');
  // ...but where a list DOES exist the value is still judged.
  assert.equal(report.byCategory.wallpaper.material[0].inCategoryVocabulary, true);
  assert.equal(report.byCategory.tiles.finish[0].inCategoryVocabulary, false, 'Satin is not a tile finish');
});

test('list metafields contribute each of their values, not the raw array', () => {
  const report = buildVocabulary({
    products: [{ handle: 'a', category: 'tiles', metafields: { surface: ['Floor', 'Wall'], colour_family: ['White', 'Grey'] } }],
    links: [],
  });
  assert.deepEqual(report.byCategory.tiles.surface.map((v) => v.value).sort(), ['Floor', 'Wall']);
  assert.equal(report.byCategory.tiles.colour_family.length, 2);
});

/* ── writes ─────────────────────────────────────────────────────────────────── */

test('a collection is manual or smart, never both, and a smart one is never MANUAL', () => {
  assert.throws(() => buildCollectionInput({ title: 'T', products: ['gid://shopify/Product/1'], ruleSet: { appliedDisjunctively: false, rules: [] } }), /never both/);
  // The same mistake lib/collectionReorder.js used to make against `tiles`.
  assert.throws(() => buildCollectionInput({ title: 'T', sortOrder: 'MANUAL', ruleSet: { appliedDisjunctively: false, rules: [] } }), /automated collections/);
  assert.throws(() => buildCollectionInput({ handle: 'x' }), /title is required/);
});

test('a metafield-definition smart rule warns that the capability is off', () => {
  // All 20 product definitions on this store have capabilities.smartCollectionCondition
  // disabled, so the rule is accepted by the type system and matches nothing.
  const { warnings } = buildCollectionInput({
    title: 'Matte tiles',
    ruleSet: { appliedDisjunctively: false, rules: [{ column: 'PRODUCT_METAFIELD_DEFINITION', relation: 'EQUALS', condition: 'Matte' }] },
  });
  assert.ok(warnings.some((w) => /smartCollectionCondition/.test(w)), warnings.join('|'));
});

test('membership goes through the PRODUCT side, one call per product', async () => {
  // collectionAddProducts / collectionAddProductsV2 / collectionRemoveProducts are all
  // gone from 2026-01, so a collection-side call here would be a schema error at
  // runtime. Pinned because it reads backwards and someone will want to "fix" it.
  const calls = [];
  const gql = async (q, v) => {
    calls.push({ q, v });
    return { productUpdate: { product: { id: v.product.id }, userErrors: [] } };
  };
  const res = await setCollectionProducts(
    { collectionId: 'gid://shopify/Collection/1', add: ['gid://shopify/Product/10'], remove: ['gid://shopify/Product/11'] },
    { dryRun: false, gql },
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => /productUpdate/.test(c.q)), 'must not use a collection-side mutation');
  assert.deepEqual(calls[0].v.product.collectionsToJoin, ['gid://shopify/Collection/1']);
  assert.deepEqual(calls[1].v.product.collectionsToLeave, ['gid://shopify/Collection/1']);
  assert.equal(res.results.length, 2);
});

test('membership dry-runs by default and writes nothing', async () => {
  let called = 0;
  const res = await setCollectionProducts(
    { collectionId: 'gid://shopify/Collection/1', add: ['gid://shopify/Product/10'] },
    { gql: async () => { called += 1; return {}; } },
  );
  assert.equal(called, 0);
  assert.equal(res.dryRun, true);
  assert.equal(res.plan.length, 1);
});

/* ── the reorder bug ────────────────────────────────────────────────────────── */

test('a smart collection is skipped with a reason, not attempted and reported as an error', async () => {
  // `tiles` is smart (TYPE EQUALS "Floor tiles") and is the only collection big enough
  // for this job to matter. Before this check it attempted a reorder every night and
  // recorded a userErrors failure every night.
  const gql = async (query, vars) => {
    if (query.includes('collections(first:5')) {
      return { collections: { nodes: [{ id: 'gid://shopify/Collection/1', handle: 'tiles', sortOrder: 'BEST_SELLING', ruleSet: { appliedDisjunctively: false } }] } };
    }
    if (query.includes('collection(id:')) {
      return { collection: { products: {
        edges: [1, 2, 3].map((n) => ({ cursor: String(n), node: { id: `gid://shopify/Product/${n}`, title: `P${n}`, createdAt: '2026-01-01T00:00:00Z', metafield: { value: String(n) } } })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } } };
    }
    throw new Error(`unexpected mutation against a smart collection: ${query.slice(0, 60)}`);
  };

  const out = await reorderCollections({ handles: ['tiles'], dryRun: false, gql, log: {} });
  assert.equal(out.errors, 0, 'a smart collection is not an error');
  assert.equal(out.skipped, 1);
  assert.match(out.results[0].skipped, /smart collection/);
  assert.equal(out.results[0].products, 3, 'and still reports how much it is leaving alone');
});

test('a manual collection is still reordered', async () => {
  const seen = [];
  const gql = async (query, vars) => {
    seen.push(query);
    if (query.includes('collections(first:5')) {
      return { collections: { nodes: [{ id: 'gid://shopify/Collection/2', handle: 'laminates', sortOrder: 'MANUAL', ruleSet: null }] } };
    }
    if (query.includes('collection(id:')) {
      return { collection: { products: {
        edges: [{ cursor: 'a', node: { id: 'gid://shopify/Product/1', title: 'Low', createdAt: '2026-01-01T00:00:00Z', metafield: { value: '1' } } },
                { cursor: 'b', node: { id: 'gid://shopify/Product/2', title: 'High', createdAt: '2026-01-01T00:00:00Z', metafield: { value: '9' } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } };
    }
    return { collectionReorderProducts: { job: { id: 'j' }, userErrors: [] } };
  };

  const out = await reorderCollections({ handles: ['laminates'], dryRun: false, gql, log: {} });
  assert.equal(out.reordered, 1);
  assert.equal(out.errors, 0);
  assert.ok(seen.some((q) => q.includes('collectionReorderProducts')));
});
