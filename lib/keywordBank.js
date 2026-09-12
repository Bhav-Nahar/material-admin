/**
 * keywordBank.js — the controlled vocabulary and search phrases behind SEO copy.
 *
 * Ported from glassquickdev/admin-server/lib/keyword-bank.json (69 KB of glass,
 * mirror, railing and nameplate keywords across 13 GlassQuick categories). None of
 * that vocabulary survives: the bank was rebuilt from Material-Metafield-Research.html
 * §§4-8, which read the attribute values off a live competitor catalogue. Only the
 * SHAPE of the source file was kept — per-category keyword tiers plus an attribute
 * map — because that shape is what a prompt builder wants.
 *
 * The source bank also carried `shopping` (Google Shopping bid hints) and a
 * `knowledge` block per category duplicating the taxonomy. Both belong to the ads
 * module, not SEO; dropped here.
 */

const bank = require('./keyword-bank.json');

const CATEGORY_IDS = Object.keys(bank.categories);

/**
 * Which of Material's categories a product belongs to.
 *
 * productType is the category (Material-Metafield-Research §10: "Not a metafield:
 * SKU, price, compare-at price, productType (= category)"), so it is checked first
 * and everything after it is a fallback for products created before that rule stuck.
 *
 * ponytail: substring matching on a six-word haystack. Fine at three categories with
 * no overlapping names. When Stone/Wood/Hardware get stocked, "stone" will collide
 * with the tiles `look` value "Stone" — at that point make productType authoritative
 * and delete the fallbacks rather than adding tie-breaks.
 */
function resolveCategory(source = {}) {
  const type = String(source.productType || source.product_type || '').toLowerCase();
  const direct = CATEGORY_IDS.find(
    (id) => type === id || type === bank.categories[id].label.toLowerCase(),
  );
  if (direct) return direct;

  const haystack = [
    source.productType,
    source.handle,
    source.title,
    ...(Array.isArray(source.tags) ? source.tags : String(source.tags || '').split(',')),
    ...(source.collections || []).map((c) => c.handle || c),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Longest id first so "wallpaper" cannot be shadowed by a shorter partial match.
  return (
    [...CATEGORY_IDS].sort((a, b) => b.length - a.length).find((id) => haystack.includes(id)) || null
  );
}

/** The bank entry for a category id, or null. */
function forCategory(id) {
  return (id && bank.categories[id]) || null;
}

/** Allowed values for one attribute of one category — the controlled list. */
function attributeValues(categoryId, attribute) {
  return forCategory(categoryId)?.attributes?.[attribute] || [];
}

/**
 * Is `value` in the controlled list for this category/attribute?
 *
 * Case- and space-insensitive because Shopify metafields are free text today
 * (research §12: "Either accept free text and clean up later, or define finish as a
 * per-category metaobject reference from the start"). This is the "clean up later"
 * half — it reports drift, it does not prevent it.
 */
function isKnownValue(categoryId, attribute, value) {
  if (!value) return false;
  const norm = (v) => String(v).toLowerCase().replace(/\s+/g, ' ').trim();
  return attributeValues(categoryId, attribute).some((v) => norm(v) === norm(value));
}

/**
 * Search phrases to hand the copy generator for one product.
 *
 * Category keywords first (they carry the volume), then phrases built out of this
 * product's own attribute values, which is where the long tail actually lives.
 */
function keywordsFor(fields = {}, categoryId = fields.categoryId) {
  const entry = forCategory(categoryId);
  if (!entry) return [...bank.brandKeywords];

  const label = entry.label.toLowerCase();
  const specific = [
    fields.look && `${fields.look} look ${label}`,
    fields.material && `${fields.material} ${label}`,
    fields.finish && `${fields.finish} finish ${label}`,
    fields.size && `${fields.size} ${label} price`,
    fields.colourName && `${fields.colourName} ${label}`,
    fields.series && `${fields.series} ${label}`,
    ...(fields.applications || []).map((a) => `${label} for ${a}`.toLowerCase()),
  ].filter(Boolean);

  return [
    ...new Set(
      [...entry.keywords.exact, ...specific, ...entry.keywords.phrase, ...entry.longTail].map((k) =>
        k.toLowerCase(),
      ),
    ),
  ];
}

module.exports = {
  bank,
  CATEGORY_IDS,
  resolveCategory,
  forCategory,
  attributeValues,
  isKnownValue,
  keywordsFor,
};
