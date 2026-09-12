'use strict';

/**
 * productCreate.js — make a Shopify product out of a spec.
 *
 * This is the half glassquickdev's Add Product form did before it called the image
 * pipeline, minus the form. You post the ATTRIBUTES; the title, the SEO title and
 * the meta description are DERIVED from them.
 *
 * That inversion is the whole point, and it is the one thing the research says the
 * benchmark gets wrong: Material Depot writes its titles by hand and buries the
 * caveats, warranty and MOQ inside them, which makes those facts unfilterable and
 * means a catalogue of 50,000 products has 50,000 hand-written strings. Store the
 * fields once and the title is a template over them — see lib/seoGenerator.js,
 * which owns the grammar and is reused here rather than reimplemented.
 *
 * Everything goes in ONE productSet call: product, options, variants and every
 * metafield at both levels. Introspected against 2026-01 rather than assumed.
 */

const { adminGraphql } = require('./shopify');
const seo = require('./seoGenerator');
const { isKnownValue, resolveCategory, forCategory, CATEGORY_IDS } = require('./keywordBank');
// The size parser, borrowed rather than written a third time — it already handles
// mm / cm / m / inch / ft and the "trailing unit wins" rule Material's labels use.
const { parseSizeLabel } = require('./productImages/imageComposer');

const NS = 'custom';

// key → Shopify metafield type. Must match material-frontend/scripts/setup-product-model.mjs;
// a mismatch is rejected by Shopify at write time rather than silently coerced.
const PRODUCT_TYPES = {
  finish: 'single_line_text_field',
  material: 'single_line_text_field',
  look: 'single_line_text_field',
  application: 'list.single_line_text_field',
  slip_rating: 'single_line_text_field',
  installation_guide: 'multi_line_text_field',
  care_maintenance: 'multi_line_text_field',
  sample_price: 'number_decimal',
  colour_family: 'list.single_line_text_field',
  colour_name: 'single_line_text_field',
  series: 'single_line_text_field',
  surface: 'list.single_line_text_field',
  pattern: 'single_line_text_field',
  use_case: 'list.single_line_text_field',
  design_variants: 'number_integer',
  install_caveats: 'list.single_line_text_field',
  // Quantity facts, stored once at product level because they do not change with the
  // size chosen: how much to add for cuts and breakage, and the smallest order taken.
  wastage_pct: 'number_decimal',
  moq_qty: 'number_decimal',
};

const VARIANT_TYPES = {
  thickness_mm: 'number_decimal',
  pack_unit: 'single_line_text_field',
  pieces_per_pack: 'number_integer',
  price_unit: 'single_line_text_field',
  coverage_per_pack: 'number_decimal',
  size_label: 'single_line_text_field',
  // Wallpaper's coverage is not a stocked figure, it is the roll's own dimensions.
  // Stored here and used by coverageSqFt below to derive what one roll covers.
  roll_length_m: 'number_decimal',
  roll_width_mm: 'number_decimal',
};

// camelCase in, snake_case out. The API surface reads like the rest of this service;
// the metafield keys are what Shopify and the storefront already agreed on.
const PRODUCT_FIELDS = {
  finish: 'finish', material: 'material', look: 'look', applications: 'application',
  slipRating: 'slip_rating', installationGuide: 'installation_guide',
  careMaintenance: 'care_maintenance', samplePrice: 'sample_price',
  colourFamily: 'colour_family', colourName: 'colour_name', series: 'series',
  surface: 'surface', pattern: 'pattern', useCases: 'use_case',
  designVariants: 'design_variants', installCaveats: 'install_caveats',
  wastagePct: 'wastage_pct', moqQty: 'moq_qty',
};

const VARIANT_FIELDS = {
  thicknessMm: 'thickness_mm', packUnit: 'pack_unit', piecesPerPack: 'pieces_per_pack',
  priceUnit: 'price_unit', coveragePerPack: 'coverage_per_pack', sizeLabel: 'size_label',
  rollLengthM: 'roll_length_m', rollWidthMm: 'roll_width_mm',
};

/**
 * One metafield, encoded for the wire.
 *
 * `list.*` types take a JSON array STRING, not an array — passing an array is
 * accepted by GraphQL as a String and then fails validation with a message that
 * does not mention the shape. Numbers likewise go as strings.
 */
function encode(key, type, value) {
  if (value == null || value === '') return null;
  const isList = type.startsWith('list.');
  if (isList) {
    const arr = [].concat(value).map((v) => String(v).trim()).filter(Boolean);
    if (!arr.length) return null;
    return { namespace: NS, key, type, value: JSON.stringify(arr) };
  }
  if (Array.isArray(value)) value = value[0];
  return { namespace: NS, key, type, value: String(value).trim() };
}

function metafieldsFor(input, fieldMap, typeMap) {
  return Object.entries(fieldMap)
    .map(([inKey, mfKey]) => encode(mfKey, typeMap[mfKey], input[inKey]))
    .filter(Boolean);
}

/**
 * Flags values outside the vocabulary the research recorded for this category.
 *
 * A WARNING, never a rejection. The vocabularies came from one competitor's live
 * catalogue, so they are evidence of what the category uses, not a standard anyone
 * agreed to — blocking on them would make this unusable the first time Material
 * stocks something the benchmark does not. But a silent typo ("Mate" for "Matte")
 * splits a facet in two and nobody notices until the filter looks wrong.
 */
function vocabularyWarnings(categoryId, input) {
  const out = [];
  for (const [field, attr] of [['finish', 'finish'], ['material', 'material'], ['look', 'look']]) {
    const value = input[field];
    if (value && !isKnownValue(categoryId, attr, value)) {
      out.push(`${field}: "${value}" is not a known ${categoryId} ${attr} — check the spelling, or it is genuinely new`);
    }
  }
  return out;
}

/* ── price unit, coverage and the unit price ──────────────────────────────── */

/**
 * "Sq. Ft." / "sq ft" / "SQFT" / "Square Feet" → "sqft". One spelling to compare on.
 *
 * ponytail: an alias table, not a units library. Five categories quote prices in
 * four units between them and none of them are ever converted — this only ever has
 * to answer "is that the same unit as this?".
 */
const PRICE_UNIT_ALIASES = {
  sqft: 'sqft', squarefeet: 'sqft', squarefoot: 'sqft', squarefeets: 'sqft',
  ft2: 'sqft', persqft: 'sqft', sqfeet: 'sqft',
  sheets: 'sheet', pieces: 'piece', pcs: 'piece', pc: 'piece', nos: 'piece',
  rolls: 'roll', boxes: 'box',
};

function normalisePriceUnit(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return PRICE_UNIT_ALIASES[key] || key;
}

/**
 * Defaults `price_unit` from the category, and REJECTS one that contradicts it.
 *
 * This is a VALIDATION, not a default: a default cannot help here, because the
 * supplied value always wins over any fallback. And unlike vocabularyWarnings it is
 * a gate, which is the one place in this file worth being stricter — a wrong unit is
 * a wrong PRICE, not a wrong label. `price: 129` meaning ₹129/sq ft, on a variant
 * that is one 31.2 sq ft box, sells the whole box for ₹129: about ₹4/sq ft, some 31×
 * under. GlassQuick shipped exactly this class of bug — a nameplate went live at ₹64
 * instead of ~₹9,176, ~143× under — because nothing asserted the price unit against
 * the product type. A warning would have scrolled past just the same.
 */
function applyPriceUnit(categoryId, variants) {
  const expected = forCategory(categoryId)?.priceUnit;
  if (!expected) return;
  for (const v of variants) {
    if (v.priceUnit == null || String(v.priceUnit).trim() === '') {
      v.priceUnit = expected;
      continue;
    }
    if (normalisePriceUnit(v.priceUnit) === normalisePriceUnit(expected)) continue;
    const err = new Error(
      `price_unit "${v.priceUnit}" contradicts ${categoryId}, which is priced per "${expected}". ` +
        'A price quoted in the wrong unit is a wrong price, not a wrong label — correct the unit, ' +
        'or the price, before this product is created.',
    );
    err.code = 'price_unit_mismatch';
    throw err;
  }
}

const SQFT_PER_SQM = 10.7639;
const SQFT_PER_SQMM = SQFT_PER_SQM / 1e6;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Roll dimensions → the area one roll covers, in sq ft. 0 when either is missing.
 *
 * ponytail: length × width, with no allowance for a pattern repeat. A repeat wastes
 * real material on a mural and only the merchant knows how much, which is exactly
 * why a STATED coverage_per_pack wins over this. Derive the easy case; let the hard
 * one be typed in.
 */
function rollCoverageSqFt(v) {
  const lengthM = Number(v.rollLengthM);
  const widthMm = Number(v.rollWidthMm);
  if (!(lengthM > 0) || !(widthMm > 0)) return 0;
  return round1(lengthM * (widthMm / 1000) * SQFT_PER_SQM);
}

/**
 * Is this category's price quoted per unit AREA, rather than per pack?
 *
 * The single switch behind the per-category table below, and it reads the SAME field
 * applyPriceUnit validates against, so the two cannot disagree:
 *
 *   Tiles      Sq. Ft.  →  measurement from coverage_per_pack
 *   Wallpaper  Sq. Ft.  →  measurement from the roll dimensions
 *   Stone      Sq. Ft.  →  measurement from coverage_per_pack
 *   Laminates  Sheet    →  none: the sheet IS the unit
 *   Panels     Piece    →  none: the piece IS the unit
 */
const isAreaPriced = (categoryId) => normalisePriceUnit(forCategory(categoryId)?.priceUnit) === 'sqft';

/**
 * What ONE variant covers in sq ft — or 0, meaning "send no unit price at all".
 *
 * The 0 matters because `quantityValue` is what the storefront divides by
 * (material-frontend/src/lib/product.js, mapVariant). Send a measurement on a
 * per-sheet product and the PDP prints a "₹X/sq ft" headline for a price that is not
 * per sq ft; send none and `perSqFt` falls to 0, at which point the existing UI
 * correctly renders "₹X/sheet" with a quantity stepper and no area calculator. Both
 * cases already work — this only decides which one the data is asking for.
 */
function coverageSqFt(categoryId, v) {
  if (!isAreaPriced(categoryId)) return 0;
  const explicit = Number(v.coveragePerPack);
  // Stated coverage wins; roll dimensions are the derivation for wallpaper, which is
  // quoted per sq ft but sold by the roll and rarely carries a coverage figure.
  return explicit > 0 ? round1(explicit) : rollCoverageSqFt(v);
}

/**
 * The two fields that switch per-unit pricing on, or `{}`.
 *
 * Without them a variant reports `quantityValue: 0`, mapVariant sets `perSqFt` to 0,
 * and the ₹/sq ft headline, the ₹/box line, the per-unit compare-at and the whole
 * AreaCalculator vanish — which is what every product this file has created so far
 * did. Both are on ProductVariantSetInput; introspected, not assumed.
 *
 * ponytail: `showUnitPrice` is omitted rather than set false when there is no
 * coverage. It already defaults false, and an explicit false would be one more field
 * to keep in step with the measurement it describes.
 */
function unitPriceFor(categoryId, v) {
  const coverage = coverageSqFt(categoryId, v);
  if (!(coverage > 0)) return {};
  return {
    showUnitPrice: true,
    unitPriceMeasurement: {
      quantityValue: coverage,
      quantityUnit: 'FT2',
      referenceValue: 1,
      referenceUnit: 'FT2',
    },
  };
}

const PACK_TOLERANCE = 0.1;

/**
 * coverage_per_pack ≈ pieces_per_pack × the area of one piece, read off size_label.
 *
 * A WARNING, never a gate. Parsing a free-text size is best effort — a label this
 * cannot read yields no check at all — and refusing a legitimate product because its
 * label is written unusually is worse than not checking it. What the band does catch
 * is the transposed digit: 15.5 typed as 51.5 is 230% out and cannot pass a tenth.
 * Real coverage figures are quoted net of grout lines and rounded, so the band has to
 * be loose enough to leave those alone.
 */
function packArithmeticWarning(v) {
  const pieces = Number(v.piecesPerPack);
  const coverage = Number(v.coveragePerPack);
  if (!(pieces > 0) || !(coverage > 0)) return null;

  const dims = parseSizeLabel(v.sizeLabel);
  if (!dims) return null;

  const expected = pieces * dims.widthMm * dims.heightMm * SQFT_PER_SQMM;
  if (!(expected > 0) || Math.abs(coverage - expected) / expected <= PACK_TOLERANCE) return null;
  return (
    `coverage_per_pack ${coverage} does not match ${pieces} × ${v.sizeLabel} ` +
    `(≈ ${expected.toFixed(1)} sq ft) — check for a transposed digit`
  );
}

/**
 * compareAtPrice, derived from the discount ladder when one is supplied.
 *
 * `price ÷ ((1 − flat%) × (1 − additional%))` — the struck-through price the offer
 * was taken off. An explicit compareAtPrice always wins.
 *
 * Nothing stores a discount PERCENTAGE. The badge on the PDP computes itself from
 * the two prices, so a stored percentage would be a third copy of the same fact and
 * the one that goes stale the first time either price moves.
 */
function compareAtFor(v, warnings) {
  if (v.compareAtPrice != null && v.compareAtPrice !== '') return Math.round(Number(v.compareAtPrice));

  const flat = Number(v.flatDiscountPct) || 0;
  const extra = Number(v.additionalDiscountPct) || 0;
  if (flat <= 0 && extra <= 0) return null;

  const factor = (1 - flat / 100) * (1 - extra / 100);
  if (!(factor > 0) || factor >= 1) {
    warnings.push(
      `discounts of ${flat}% + ${extra}% do not describe a compare-at price — none written`,
    );
    return null;
  }
  return Math.round(Number(v.price) / factor);
}

/* ── where inventory lands ─────────────────────────────────────────────────── */

const LOCATIONS = `
  query Locations {
    locations(first: 10) {
      nodes {
        id name isActive
        inventoryLevels(first: 20) { nodes { quantities(names: ["available"]) { quantity } } }
      }
    }
  }`;

let cachedLocationId = null;

/**
 * The location a new variant's stock is activated at.
 *
 * `SHOPIFY_LOCATION_ID` wins and costs no call. Unset, the store is asked and the
 * location HOLDING STOCK is preferred — on this store that is `Mumbai warehouse`
 * (gid://shopify/Location/88415535241, 371 units across 20 items at the time of
 * writing) while `Shop location` is empty everywhere. Resolved rather than
 * hardcoded, but that is the expected answer and a different one is worth a look.
 *
 * The obvious flags are the WRONG signal here and were measured to be: `Shop
 * location` is the one with shipsInventory=true, and Mumbai has it false. Picking
 * by flag would have put every new product's stock in the empty location.
 *
 * ponytail: 20 inventory levels sampled per location, not a full count. A location
 * with stock has some in its first 20 items; the only case this gets wrong is two
 * stocked locations whose ORDER matters, which is a decision for
 * SHOPIFY_LOCATION_ID rather than a heuristic.
 */
async function resolveLocationId() {
  const configured = (process.env.SHOPIFY_LOCATION_ID || '').trim();
  if (configured) return configured.startsWith('gid://') ? configured : `gid://shopify/Location/${configured}`;
  if (cachedLocationId) return cachedLocationId;

  const active = ((await adminGraphql(LOCATIONS)).locations?.nodes || []).filter((l) => l.isActive);
  if (!active.length) {
    const err = new Error('no active Shopify location — set SHOPIFY_LOCATION_ID');
    err.code = 'no_location';
    throw err;
  }

  const held = (l) =>
    (l.inventoryLevels?.nodes || []).reduce((sum, n) => sum + (n.quantities?.[0]?.quantity || 0), 0);
  const stocked = [...active].sort((a, b) => held(b) - held(a));
  cachedLocationId = (held(stocked[0]) > 0 ? stocked[0] : active[0]).id;
  return cachedLocationId;
}

/** Test seam; also lets a long-lived process pick up a location added after boot. */
function resetLocationCache() {
  cachedLocationId = null;
}

/**
 * Builds the productSet input and the derived copy, writing nothing.
 * Exported so the dry run and the real call cannot diverge.
 *
 * `locationId` is passed in rather than resolved here so this stays pure and
 * unit-testable; createProduct resolves it once.
 */
function buildProductSet(input = {}, { locationId = null } = {}) {
  const categoryId = resolveCategory({ productType: input.category, title: input.title });
  if (!categoryId) {
    // Still a throw, deliberately. The bank now covers panels and stone as well, but
    // a category nobody has recorded a price UNIT for cannot be priced safely — see
    // applyPriceUnit — so guessing one is worse than refusing the product.
    const err = new Error(
      `category is required — one of ${CATEGORY_IDS.join(', ')} (got ${JSON.stringify(input.category)})`,
    );
    err.code = 'bad_category';
    throw err;
  }

  const variantsIn = (input.variants && input.variants.length ? input.variants : [{}]).map((v) => ({
    ...v,
    price: v.price ?? input.price,
    sku: v.sku ?? input.sku,
    sizeLabel: v.sizeLabel ?? input.sizeLabel,
    thicknessMm: v.thicknessMm ?? input.thicknessMm,
    packUnit: v.packUnit ?? input.packUnit,
    piecesPerPack: v.piecesPerPack ?? input.piecesPerPack,
    priceUnit: v.priceUnit ?? input.priceUnit,
    coveragePerPack: v.coveragePerPack ?? input.coveragePerPack,
    rollLengthM: v.rollLengthM ?? input.rollLengthM,
    rollWidthMm: v.rollWidthMm ?? input.rollWidthMm,
    // Compare-at is either given outright or derived from the discount ladder; both
    // fall back to the top level so a single-variant spec need not nest anything.
    compareAtPrice: v.compareAtPrice ?? input.compareAtPrice,
    flatDiscountPct: v.flatDiscountPct ?? input.flatDiscountPct,
    additionalDiscountPct: v.additionalDiscountPct ?? input.additionalDiscountPct,
    // Tracked ON by default. Measured on this store: a variant created without
    // this comes back `tracked: false`, which means Shopify never decrements it
    // and a shopper can buy 400 boxes of a tile there are 4 of. Opt out per
    // variant with `tracked: false` — made-to-order and custom-size murals are
    // the honest cases for that.
    tracked: v.tracked ?? input.tracked ?? true,
    quantity: v.quantity ?? input.quantity ?? 0,
  }));

  // WHOLE RUPEES, before anything is validated against them. Decimal prices read as
  // unprofessional in ads and risk a Merchant Centre / Meta feed↔landing-page price
  // mismatch disapproval, which takes the whole feed down rather than one product.
  // Rounded first so the check below sees the number that will actually be sent —
  // a price of 0.4 is otherwise accepted and then written as a free product.
  for (const v of variantsIn) {
    if (v.price != null && v.price !== '') v.price = Math.round(Number(v.price));
  }

  if (variantsIn.some((v) => !(Number(v.price) > 0))) {
    const err = new Error('every variant needs a price — a positive number (or a top-level `price`)');
    err.code = 'missing_price';
    throw err;
  }

  // Before the title, the handle or anything else is derived: a product whose price
  // is quoted in the wrong unit should not get as far as having copy written for it.
  applyPriceUnit(categoryId, variantsIn);

  const warnings = vocabularyWarnings(categoryId, input);
  for (const v of variantsIn) {
    const packWarning = packArithmeticWarning(v);
    if (packWarning) warnings.push(packWarning);

    // The exact shape of the bug this file was written to fix, said out loud. A
    // sq-ft category with nothing to divide by gets no unitPriceMeasurement, so the
    // variant reports quantityValue 0 and the PDP prints the PACK price as the
    // headline — for a price the merchant is thinking of per sq ft. A warning rather
    // than a gate: coverage is sometimes genuinely unknown when a product is drafted,
    // and it can be filled in later. Silence is what made this invisible.
    if (isAreaPriced(categoryId) && !(coverageSqFt(categoryId, v) > 0)) {
      warnings.push(
        `${categoryId} is priced per ${forCategory(categoryId).priceUnit} but this variant has no ` +
          'coverage_per_pack (nor roll dimensions) — Shopify will show no per-sq-ft rate and the ' +
          'area calculator will not render',
      );
    }

    const compareAt = compareAtFor(v, warnings);
    v.compareAtPrice = compareAt == null ? undefined : compareAt;
  }

  // The fields the title grammar reads. Same shape fieldsFromProduct returns, so
  // deriveTitle behaves identically here and on a product already in Shopify.
  const fields = {
    kind: 'product',
    categoryId,
    category: input.category,
    sku: variantsIn[0].sku,
    size: variantsIn[0].sizeLabel,
    thicknessMm: variantsIn[0].thicknessMm,
    look: input.look,
    material: input.material,
    finish: input.finish,
    colourName: input.colourName,
    series: input.series,
    surface: [].concat(input.surface || [])[0],
    designVariants: input.designVariants,
    applications: [].concat(input.applications || []),
    slipRating: input.slipRating,
    // The caveat segment of the title grammar. Written to the metafield below as
    // well — the title carries it for the shopper scanning a listing, the metafield
    // carries it for anything that needs to filter or display it structurally.
    installCaveats: [].concat(input.installCaveats || []),
  };

  const derived = seo.derive(fields);
  const title = input.title || derived.derivedTitle;

  const hasSizes = variantsIn.some((v) => v.sizeLabel);

  // Shopify rejects a productSet whose option carries the same value twice, and
  // productSet is atomic — so the WHOLE product fails to create, rather than
  // half-creating. The realistic trigger is one tile size in two thicknesses:
  // both variants map to "600 x 600 mm" and the mutation dies.
  //
  // Refused rather than silently deduped. Deduping the option would leave two
  // variants claiming the same option value, which Shopify also rejects — and
  // quietly dropping one of a merchant's variants is worse than saying no.
  // Thickness cannot be a second option: `thickness_mm` is a variant METAFIELD,
  // and a product needing thickness as a sellable axis needs that decision made
  // deliberately, not inferred here.
  if (hasSizes) {
    const seen = new Set();
    const dupes = variantsIn
      .map((v) => v.sizeLabel || 'Default')
      .filter((s) => seen.has(s) || (seen.add(s), false));
    if (dupes.length) {
      const err = new Error(
        `two variants share the size "${[...new Set(dupes)].join('", "')}" — Shopify allows one variant per option value. ` +
          'Give each variant a distinct sizeLabel, or split the other axis into its own product.',
      );
      err.code = 'duplicate_option_value';
      throw err;
    }
  }
  const productSet = {
    title,
    handle: input.handle || deriveHandle(fields, variantsIn[0].sku),
    productType: input.category,
    // DRAFT unless asked otherwise. An ACTIVE product with no images and no
    // description is a live page a shopper can reach the moment it is written.
    status: input.status || 'DRAFT',
    vendor: input.vendor || 'Material',
    descriptionHtml: input.descriptionHtml || undefined,
    seo: { title: derived.seoTitle, description: derived.seoDescription },
    metafields: metafieldsFor(input, PRODUCT_FIELDS, PRODUCT_TYPES),
    ...(hasSizes
      ? { productOptions: [{ name: 'Size', values: variantsIn.map((v) => ({ name: v.sizeLabel || 'Default' })) }] }
      : {}),
    variants: variantsIn.map((v) => ({
      price: String(v.price),
      sku: v.sku || undefined,
      compareAtPrice: v.compareAtPrice != null ? String(v.compareAtPrice) : undefined,
      // Per-unit pricing, switched on per category — see unitPriceFor. `{}` for the
      // categories where the pack IS the unit, and that omission is load-bearing.
      ...unitPriceFor(categoryId, v),
      ...(hasSizes ? { optionValues: [{ optionName: 'Size', name: v.sizeLabel || 'Default' }] } : {}),
      // `inventoryItem.sku` is the authoritative one — measured: given different
      // values above and here, the one here is what the variant ends up with.
      // Both read the same `v.sku`, so they cannot disagree.
      inventoryItem: { sku: v.sku || undefined, tracked: v.tracked },
      // Inline on the variant, and no inventoryActivate first. VERIFIED against
      // 2026-01 on a throwaway DRAFT: productSet ACTIVATES the location for a new
      // variant by itself — the level came back available 7 / on_hand 7 at a
      // location the item had never been stocked at. `ITEM_NOT_STOCKED_AT_LOCATION`
      // in InventorySetQuantitiesUserErrorCode is a precondition of the SET path
      // (inventorySetQuantities on an already-created item), not of this one.
      //
      // Emitted even at quantity 0, and even when tracked is false. Zero is the
      // honest starting number and activating at zero is what makes the variant
      // read "sold out" rather than "unlimited"; the untracked case is accepted by
      // Shopify and leaves a level ready for the day tracking is switched on.
      ...(locationId
        ? { inventoryQuantities: [{ locationId, name: 'available', quantity: Number(v.quantity) || 0 }] }
        : {}),
      metafields: metafieldsFor(v, VARIANT_FIELDS, VARIANT_TYPES),
    })),
  };
  if (input.collections) productSet.collections = [].concat(input.collections);

  return {
    productSet,
    derived: { title, seoTitle: derived.seoTitle, seoDescription: derived.seoDescription, keywords: derived.keywords },
    warnings,
    categoryId,
  };
}

const MAX_HANDLE = 100;

/**
 * The URL slug, built from the IDENTIFYING fields only.
 *
 * Not from the title. Shopify slugifies the title when no handle is given, and this
 * title deliberately ends in "Suitable For Living Room, Bedroom, Bathroom" — which
 * produced a 139-character URL carrying three room names that identify nothing and
 * are shared by half the catalogue. The title is for a human reading a listing; the
 * handle is a permanent identifier, and it should not move when merchandising
 * decides the tile also suits a balcony.
 *
 * Truncation lands on a word boundary: a slug ending mid-word ("...vitrified-mat")
 * reads as a mistake in the address bar.
 */
function deriveHandle(fields, sku) {
  const slug = [
    fields.look,
    fields.surface,
    seo.singular(fields.category),
    sku,
    fields.colourName,
    fields.size,
    fields.material,
    fields.finish,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length <= MAX_HANDLE) return slug;
  return slug.slice(0, slug.lastIndexOf('-', MAX_HANDLE)).replace(/-+$/, '');
}

const PRODUCT_SET = `
  mutation productSet($input: ProductSetInput!) {
    productSet(input: $input) {
      product {
        id handle title status
        onlineStorePreviewUrl
        variants(first: 25) {
          nodes {
            id title sku price
            inventoryQuantity
            inventoryItem { tracked }
          }
        }
      }
      userErrors { field message code }
    }
  }`;

/**
 * @param {object} input  the spec
 * @param {boolean} opts.dryRun  build and return the plan, write nothing. DEFAULT TRUE --
 *   creating catalogue rows is not something that should happen because a flag was forgotten.
 * @param {string} opts.locationId  where stock is activated. Resolved when omitted.
 */
async function createProduct(input, { dryRun = true, locationId } = {}) {
  // Resolved on the DRY RUN too. A read, not a write — and a plan that omits the
  // inventory block is not the plan that would be created, which is the one thing
  // the dry run exists to guarantee.
  const plan = buildProductSet(input, { locationId: locationId || (await resolveLocationId()) });
  if (dryRun) return { ...plan, dryRun: true, product: null };

  const res = await adminGraphql(PRODUCT_SET, { input: plan.productSet });
  const errs = res.productSet?.userErrors || [];
  if (errs.length) {
    const err = new Error(errs.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; '));
    err.code = 'shopify_rejected';
    throw err;
  }

  return { ...plan, dryRun: false, product: res.productSet.product };
}

module.exports = {
  buildProductSet,
  createProduct,
  deriveHandle,
  encode,
  // Exported for lib/productReadiness.js's price-unit gate. One alias table, so a
  // unit this file ACCEPTS at create time cannot be one the gate then rejects.
  normalisePriceUnit,
  resolveLocationId,
  resetLocationCache,
  PRODUCT_TYPES,
  VARIANT_TYPES,
};
