const test = require('node:test');
const assert = require('node:assert');

// Proves the generator never reaches the network on the derive path, and keeps
// generateCopy({ ai: true }) below from making a real call.
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_AI_API_KEY;

const seo = require('../lib/seoGenerator');

/** The exact product from Material-Metafield-Research.html §11, field by field. */
const RESEARCH_PRODUCT = {
  kind: 'product',
  category: 'Tiles',
  categoryId: 'tiles',
  look: 'Wood',
  surface: 'Floor',
  sku: 'TL 06117',
  colourName: 'Nordic Honey',
  size: '1200 × 200 mm',
  material: 'Vitrified',
  finish: 'Matte',
  thicknessMm: 9,
  designVariants: 12,
  applications: ['Living Room', 'Bedroom', 'Kitchen'],
  caveats: ['2–3 mm Spacer is Mandatory'],
  samplePrice: '308',
};

test('clamp cuts on a word boundary and leaves short strings alone', () => {
  assert.equal(seo.clamp('short enough', 40), 'short enough');
  assert.equal(seo.clamp('a much longer sentence than the budget allows', 20), 'a much longer');
  assert.equal(seo.clamp('  collapses   whitespace  ', 40), 'collapses whitespace');
  assert.ok(!seo.clamp('a much longer sentence than the budget allows', 20).endsWith(' '));
  // A single word longer than the budget still has to be cut somewhere.
  assert.equal(seo.clamp('supercalifragilistic', 8).length, 8);
});

test('singular strips one trailing s, and only where it should', () => {
  assert.equal(seo.singular('Tiles'), 'Tile');
  assert.equal(seo.singular('Laminates'), 'Laminate');
  assert.equal(seo.singular('Wallpaper'), 'Wallpaper');
  assert.equal(seo.singular('Glass'), 'Glass'); // -ss is not a plural
  assert.equal(seo.singular(undefined), '');
});

test('deriveTitle reproduces the competitor title grammar from research §11', () => {
  assert.equal(
    seo.deriveTitle(RESEARCH_PRODUCT),
    'Wood Floor Tile · TL 06117 · Nordic Honey · 1200 × 200 mm · Vitrified · ' +
      'Matte Finish · 9 mm · 12 Random Design · Suitable For Living Room, Bedroom, Kitchen · ' +
      '2–3 mm Spacer is Mandatory',
  );
});

test('deriveTitle degrades to the segments that exist rather than leaving holes', () => {
  assert.equal(
    seo.deriveTitle({ category: 'Laminates', material: 'Acrylic', finish: 'Suede' }),
    'Laminate · Acrylic · Suede Finish',
  );
  assert.equal(seo.deriveTitle({}), '');
  // No separator runs, no leading/trailing separator.
  assert.ok(!seo.deriveTitle({ category: 'Tiles', finish: 'Matte' }).includes('· ·'));
});

test('deriveSeoTitle fits the 60-char budget and still names the brand', () => {
  const title = seo.deriveSeoTitle(RESEARCH_PRODUCT);
  assert.ok(title.length <= seo.MAX_SEO_TITLE, `${title.length} chars: ${title}`);
  assert.ok(title.endsWith(' | Material'));
  assert.ok(title.startsWith('Nordic Honey Wood Floor Tile'));
  // Size fits inside the budget, so it must be there; finish does not, so it must not.
  assert.ok(title.includes('1200 × 200 mm'));
  assert.ok(!title.includes('Matte'));
});

test('deriveSeoTitle drops the brand suffix rather than overflowing', () => {
  const long = seo.deriveSeoTitle({
    colourName: 'Extremely Long Colour Name Indeed',
    look: 'Terrazzo',
    surface: 'Exterior',
    category: 'Wallpaper',
  });
  assert.ok(long.length <= seo.MAX_SEO_TITLE);
});

test('deriveSeoDescription lands in the 120-160 band and invents no price', () => {
  const description = seo.deriveSeoDescription(RESEARCH_PRODUCT);
  assert.ok(description.length <= seo.MAX_SEO_DESCRIPTION, `${description.length} chars`);
  assert.ok(description.length >= 120, `${description.length} chars: ${description}`);
  assert.ok(description.includes('Nordic Honey'));
  assert.ok(description.includes('Suitable for living room, bedroom, kitchen.'));
  assert.ok(!/₹|\bRs\.?\b|\d+\s*(?:INR|rupees)/i.test(description));
  // Whole sentences only — never a clause cut mid-word.
  assert.ok(description.endsWith('.'));
});

test('deriveSeoDescription still produces something for a bare product', () => {
  const description = seo.deriveSeoDescription({ title: 'Plain Solids Laminate', category: 'Laminates' });
  assert.ok(description.length > 0);
  assert.ok(description.length <= seo.MAX_SEO_DESCRIPTION);
});

test('asList reads a list metafield, a bare string and rubbish', () => {
  assert.deepEqual(seo.asList('["Living room","Bedroom"]'), ['Living room', 'Bedroom']);
  assert.deepEqual(seo.asList('Living room, Bedroom'), ['Living room', 'Bedroom']);
  assert.deepEqual(seo.asList(''), []);
  assert.deepEqual(seo.asList(null), []);
});

test('fieldsFromProduct flattens a Shopify node onto the custom-namespace keys', () => {
  const fields = seo.fieldsFromProduct({
    id: 'gid://shopify/Product/1',
    handle: 'wood-floor-tile-nordic-honey-1200x200',
    title: 'Wood Floor Tile',
    productType: 'Tiles',
    descriptionHtml: '<p>hello</p>',
    seo: { title: 'existing title', description: 'existing description' },
    metafields: {
      nodes: [
        { key: 'finish', value: 'Matte' },
        { key: 'material', value: 'Vitrified' },
        { key: 'look', value: 'Wood' },
        { key: 'slip_rating', value: 'R10' },
        { key: 'sample_price', value: '308' },
        { key: 'application', value: '["Living room","Bedroom","Kitchen"]' },
      ],
    },
    variants: {
      nodes: [
        {
          sku: 'TL 06117',
          selectedOptions: [{ name: 'Size', value: '1200 × 200 mm' }],
          metafields: { nodes: [{ key: 'thickness_mm', value: '9' }, { key: 'pack_unit', value: 'box' }] },
        },
      ],
    },
  });

  assert.equal(fields.categoryId, 'tiles');
  assert.equal(fields.category, 'Tiles');
  assert.equal(fields.material, 'Vitrified');
  assert.equal(fields.finish, 'Matte');
  assert.equal(fields.slipRating, 'R10');
  assert.equal(fields.size, '1200 × 200 mm');
  assert.equal(fields.sku, 'TL 06117');
  assert.equal(fields.thicknessMm, '9');
  assert.equal(fields.packUnit, 'box');
  assert.deepEqual(fields.applications, ['Living room', 'Bedroom', 'Kitchen']);
  assert.equal(fields.currentSeoTitle, 'existing title');
  assert.equal(fields.kind, 'product');
});

test('fieldsFromProduct survives a product with nothing on it', () => {
  const fields = seo.fieldsFromProduct({ id: 'gid://shopify/Product/2', title: 'Untyped thing' });
  assert.equal(fields.categoryId, null);
  assert.deepEqual(fields.applications, []);
  assert.equal(fields.thicknessMm, undefined);
});

/* ── audit ────────────────────────────────────────────────────────────────── */

const COMPLETE = {
  id: 'gid://shopify/Product/1',
  handle: 'wood-floor-tile',
  title: 'Wood Floor Tile',
  kind: 'product',
  categoryId: 'tiles',
  material: 'Vitrified',
  finish: 'Matte',
  look: 'Wood',
  applications: ['Living room'],
  currentSeoTitle: 'Nordic Honey Wood Floor Tile 1200 × 200 mm | Material',
  currentSeoDescription:
    'Buy Nordic Honey wood-look vitrified tile online at Material. 1200 × 200 mm, matte finish, 9 mm. Suitable for living room, bedroom, kitchen.',
  descriptionHtml: `<p>${'A vitrified wood-look floor tile for Indian homes. '.repeat(8)}</p>`,
};

test('a fully populated product scores 100 with no issues', () => {
  const result = seo.auditFields(COMPLETE);
  assert.equal(result.score, 100, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.equal(result.readiness, 'ready');
});

test('the audit names what is missing, heaviest first', () => {
  const result = seo.auditFields({
    ...COMPLETE,
    currentSeoTitle: null,
    currentSeoDescription: null,
    material: null,
  });
  const ids = result.issues.map((i) => i.id);
  assert.ok(ids.includes('seo_title'));
  assert.ok(ids.includes('seo_description'));
  assert.ok(ids.includes('material'));
  assert.ok(result.score < 60);
  // Sorted by weight descending so the list doubles as a work queue.
  const weights = result.issues.map((i) => i.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
});

test('the audit flags a title or description outside its length band', () => {
  const short = seo.auditFields({ ...COMPLETE, currentSeoTitle: 'Tiles | Material' });
  assert.ok(short.issues.some((i) => i.id === 'seo_title_length'));
  assert.ok(!short.issues.some((i) => i.id === 'seo_title'));

  const longDescription = seo.auditFields({ ...COMPLETE, currentSeoDescription: 'x'.repeat(200) });
  assert.ok(longDescription.issues.some((i) => i.id === 'seo_description_length'));
});

test('the audit flags vocabulary that is not in the controlled list', () => {
  const drifted = seo.auditFields({ ...COMPLETE, finish: 'Shiny' });
  assert.ok(drifted.issues.some((i) => i.id === 'vocabulary'));
  // Case and spacing differences are not drift.
  assert.deepEqual(seo.auditFields({ ...COMPLETE, finish: 'matte' }).issues, []);
});

test('wallpaper is not marked down for a finish it has no facet for', () => {
  // Research §7: wallpaper is the one category with no Finish and no Thickness facet.
  const wallpaper = seo.auditFields({
    ...COMPLETE,
    categoryId: 'wallpaper',
    material: 'Non-woven',
    look: null,
    finish: null,
  });
  assert.ok(!wallpaper.issues.some((i) => i.id === 'finish'));
});

test('collections are scored only on the checks that apply to them', () => {
  const collection = seo.auditFields({
    id: 'gid://shopify/Collection/1',
    kind: 'collection',
    categoryId: 'tiles',
    currentSeoTitle: COMPLETE.currentSeoTitle,
    currentSeoDescription: COMPLETE.currentSeoDescription,
    descriptionHtml: COMPLETE.descriptionHtml,
  });
  assert.equal(collection.score, 100);
  assert.ok(!collection.issues.some((i) => ['material', 'finish', 'application'].includes(i.id)));
});

test('readiness bands match the source rubric', () => {
  assert.equal(seo.readiness(100), 'ready');
  assert.equal(seo.readiness(85), 'ready');
  assert.equal(seo.readiness(84), 'needs minor revision');
  assert.equal(seo.readiness(70), 'needs minor revision');
  assert.equal(seo.readiness(50), 'needs major revision');
  assert.equal(seo.readiness(49), 'not ready');
});

/* ── LLM plumbing, without an LLM ─────────────────────────────────────────── */

test('parseJsonLoose handles clean JSON, fenced JSON and a truncated preamble', () => {
  assert.deepEqual(seo.parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(seo.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(seo.parseJsonLoose('Here you go:\n{"a":1}\nhope that helps'), { a: 1 });
  assert.throws(() => seo.parseJsonLoose('no object here'));
});

test('buildPrompt carries the stored facts and none of the source vocabulary', () => {
  const prompt = seo.buildPrompt({ ...RESEARCH_PRODUCT, title: 'Wood Floor Tile', handle: 'wood-floor-tile' }, {
    keywords: ['vitrified tiles price per sq ft'],
  });
  assert.ok(prompt.includes('Base material: Vitrified'));
  assert.ok(prompt.includes('Finish: Matte'));
  assert.ok(prompt.includes('Suitable for: Living Room, Bedroom, Kitchen'));
  assert.ok(prompt.includes('Sold by: Sq. Ft.'));
  assert.ok(prompt.includes('vitrified tiles price per sq ft'));
  assert.ok(prompt.includes('material.in'));
  assert.ok(/never invent a price/i.test(prompt));
  assert.ok(!/glass|mirror|railing|shower|partition|nameplate/i.test(prompt));
});

test('generateCopy returns derived copy and makes no call when no key is configured', async () => {
  assert.equal(seo.llmConfigured(), false);
  const copy = await seo.generateCopy(RESEARCH_PRODUCT, { ai: true });
  assert.equal(copy.source, 'derived');
  assert.equal(copy.model, null);
  assert.equal(copy.descriptionHtml, null);
  assert.equal(copy.seoTitle, seo.deriveSeoTitle(RESEARCH_PRODUCT));
  assert.ok(copy.keywords.length > 0 && copy.keywords.length <= 15);
});

test('derive resolves the category when only a Shopify productType is given', () => {
  const derived = seo.derive({ title: 'Suede Laminate Sheet', productType: 'Laminates' });
  assert.equal(derived.categoryId, 'laminates');
  assert.ok(derived.derivedTitle.startsWith('Laminate'));
});

test('every metafield key this reads is actually defined by the product model', () => {
  // Guards against reintroducing the source's `seo.*` namespace, which Material has no
  // definitions for, and against reading a key nobody creates -- which fails silently,
  // because the Storefront API returns null for an undefined metafield rather than an error.
  //
  // Asserted against the definition script itself rather than a copied list. A copy has to
  // be updated by hand every time the model grows, and the update that gets forgotten is
  // the one that matters.
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
    ...seo.PRODUCT_METAFIELD_KEYS.filter((k) => !defined.PRODUCT.has(k)).map((k) => `PRODUCT.${k}`),
    ...seo.VARIANT_METAFIELD_KEYS.filter((k) => !defined.PRODUCTVARIANT.has(k)).map((k) => `VARIANT.${k}`),
  ];
  assert.deepEqual(missing, [], `read but never defined: ${missing.join(', ')}`);
});
