/**
 * seoGenerator.js — title, meta description and long-form copy for a product or collection.
 *
 * ── Where this came from ─────────────────────────────────────────────────────
 * Two variants existed in glassquickdev. This ports `gcp-functions/seo-generator/main.py`
 * (Vertex AI, Python) rather than `cloud-functions/generate-seo-content/generator.js`
 * (AI Studio SDK, Node) — see the report for why. The Python one is the maintained
 * line: newer model, a prompt built from structured metafields rather than free text,
 * and three production fixes worth carrying (thinkingBudget 0, an explicit MAX_TOKENS
 * check, and salvaging a truncated response instead of retrying a paid call).
 *
 * What is deliberately NOT ported from the Node variant: `generateDemoFallback`. On a
 * 429 it fabricated plausible marketing copy and returned it under a `_demo_mode`
 * flag. Anything downstream that forgot to check the flag would write invented claims
 * to a live storefront. Here a failed generation is an error.
 *
 * ── The split this file is built around ──────────────────────────────────────
 * Material-Metafield-Research.html §11: "Store the fields; derive the title." Depot's
 * titles are formulaic, so a title, a meta title and a meta description are a TEMPLATE
 * over stored attributes — deterministic, free, provably accurate, and testable
 * without a network. Only the long-form body needs a model.
 *
 * So: `derive*` is pure and always runs; `generateCopy` is the only thing that costs
 * money, and it is optional.
 */

const { resolveCategory, forCategory, keywordsFor, isKnownValue } = require('./keywordBank');

// Shopify truncates a meta title around 60 and a meta description around 160; Google's
// pixel budget is close enough to both that character counts are the useful proxy.
const MAX_SEO_TITLE = 60;
const MAX_SEO_DESCRIPTION = 160;
const BRAND = 'Material';

/* ── pure helpers ─────────────────────────────────────────────────────────── */

/** Cut to `max` on a word boundary. `String.slice` alone leaves half a word. */
function clamp(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:–-]+$/, '');
}

/**
 * "Tiles" → "Tile". Category names are the head noun of a title and read wrong plural.
 *
 * ponytail: strips one trailing "s". Correct for Tiles and Laminates, a no-op for
 * Wallpaper, and those are the three live categories. Replace with an explicit
 * singular in keyword-bank.json the first time a category ends in -es or -ies.
 */
function singular(word) {
  const value = String(word || '').trim();
  return /[^s]s$/.test(value) ? value.slice(0, -1) : value;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Join parts with a separator, dropping blanks and de-duplicating adjacent repeats. */
function join(parts, sep = ' · ') {
  const kept = parts.map((p) => (p == null ? '' : String(p).trim())).filter(Boolean);
  return kept.filter((p, i) => p.toLowerCase() !== (kept[i - 1] || '').toLowerCase()).join(sep);
}

/* ── the title grammar ────────────────────────────────────────────────────── */

/**
 * The product title, derived. Material-Metafield-Research §11 records the observed
 * grammar:
 *
 *   [Look] [Surface] [Category] · [SKU] · [Colour name] · [Size] · [Material] ·
 *   [Finish] Finish · [Thickness] · [Design variants] · Suitable For [Applications] ·
 *   [Caveat]
 *
 * against the real title
 *
 *   Wood Floor Tile · TL 06117 · Nordic Honey · 1200 × 200 mm · Vitrified ·
 *   Matte Finish · 9 mm · 12 Random Design · Suitable For Living Room, Bedroom,
 *   Kitchen · 2–3 mm Spacer is Mandatory
 *
 * Every segment is optional; a product with three attributes gets a three-segment
 * title rather than a title full of holes. That is the whole reason to derive it.
 */
function deriveTitle(fields = {}) {
  const head = [fields.look, fields.surface, singular(fields.category)]
    .filter(Boolean)
    .join(' ')
    .trim();

  return join([
    head,
    fields.sku,
    fields.colourName,
    fields.size,
    fields.material,
    // Ternaries, not `&&`. `x && str` returns X ITSELF when x is falsy, so an empty
    // applications array yielded the NUMBER 0, and join() kept it because String(0)
    // is truthy — every product without applications was titled "… · 0". Same trap
    // on a 0 thickness and 0 design variants. deriveSeoDescription already did this
    // correctly; deriveTitle did not.
    fields.finish ? `${fields.finish} Finish` : '',
    fields.thicknessMm ? `${fields.thicknessMm} mm` : '',
    fields.designVariants ? `${fields.designVariants} Random Design` : '',
    fields.applications?.length ? `Suitable For ${fields.applications.join(', ')}` : '',
    // installCaveats is the field every other reader uses (fieldsFromProduct sets it,
    // productCreate writes it to the metafield). `caveats` was a name only a test
    // fixture ever set, so the caveat segment of the grammar never fired on a real
    // product — "2-3 mm Spacer is Mandatory" could not appear in a title.
    ...(fields.installCaveats || fields.caveats || []),
  ]);
}

/**
 * Meta title. Not the product title: the product title is exhaustive (it is the spec
 * sheet), a meta title has 60 characters and must still name the brand. Segments are
 * added most-distinguishing-first and dropped when the budget runs out.
 */
function deriveSeoTitle(fields = {}, max = MAX_SEO_TITLE) {
  const suffix = ` | ${BRAND}`;
  const head =
    [fields.colourName, fields.look, fields.surface, singular(fields.category)]
      .filter(Boolean)
      .join(' ')
      .trim() || String(fields.title || '').trim();

  let title = head;
  for (const extra of [fields.size, fields.finish && `${fields.finish} Finish`, fields.material]) {
    if (!extra) continue;
    const candidate = `${title} ${extra}`;
    if (candidate.length + suffix.length <= max) title = candidate;
  }
  return clamp(title.length + suffix.length <= max ? title + suffix : title, max);
}

/**
 * Meta description. Aims for the 120-160 band the audit scores against, built only
 * from facts already stored — no price, ever. The source prompt had to say "never
 * invent prices" to a model; a template cannot invent one.
 */
function deriveSeoDescription(fields = {}, max = MAX_SEO_DESCRIPTION) {
  const noun = [fields.look && `${fields.look}-look`, fields.material, singular(fields.category)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const specs = [
    fields.size,
    fields.finish && `${fields.finish.toLowerCase()} finish`,
    fields.thicknessMm && `${fields.thicknessMm} mm`,
    fields.slipRating && `${fields.slipRating} slip rating`,
  ].filter(Boolean);

  const sentences = [
    `Buy ${[fields.colourName, noun].filter(Boolean).join(' ') || fields.title} online at ${BRAND}.`,
    specs.length ? `${specs.join(', ')}.` : '',
    fields.applications?.length
      ? `Suitable for ${fields.applications.join(', ').toLowerCase()}.`
      : '',
    fields.samplePrice ? `Order a sample.` : '',
  ].filter(Boolean);

  // Add whole sentences while they fit — a description cut mid-clause reads as broken.
  let out = '';
  for (const sentence of sentences) {
    if (out && `${out} ${sentence}`.length > max) break;
    out = out ? `${out} ${sentence}` : sentence;
  }
  return clamp(out, max);
}

/** Everything the deterministic path can produce for one entity. */
function derive(fields = {}) {
  const categoryId = fields.categoryId || resolveCategory(fields);
  const withCategory = { ...fields, categoryId, category: fields.category || forCategory(categoryId)?.label };
  return {
    categoryId,
    derivedTitle: deriveTitle(withCategory),
    seoTitle: deriveSeoTitle(withCategory),
    seoDescription: deriveSeoDescription(withCategory),
    keywords: keywordsFor(withCategory, categoryId).slice(0, 15),
  };
}

/* ── flattening Shopify's shape into fields ───────────────────────────────── */

/** Metafield keys read off a product. Every one is defined in material-frontend/scripts/setup-product-model.mjs. */
const PRODUCT_METAFIELD_KEYS = [
  'finish',
  'material',
  'look',
  'application',
  'slip_rating',
  'installation_guide',
  'care_maintenance',
  'sample_price',
  // Ship-first set — see setup-product-model.mjs, which owns the definitions.
  'colour_family',
  'colour_name',
  'series',
  'surface',
  'pattern',
  'use_case',
  'design_variants',
  'install_caveats',
];
const VARIANT_METAFIELD_KEYS = [
  'thickness_mm',
  'pack_unit',
  'pieces_per_pack',
  'price_unit',
  'coverage_per_pack',
  'size_label',
];

function metafieldMap(nodes) {
  const out = {};
  for (const mf of nodes || []) if (mf && mf.key) out[mf.key] = mf.value;
  return out;
}

/** `list.single_line_text_field` values arrive as a JSON array in a string. */
function asList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return String(value).split(',').map((v) => v.trim()).filter(Boolean);
  }
}

/**
 * Shopify product node → the flat field bag the derivers and the prompt both take.
 *
 * ponytail: colour_name, series, surface, design_variants and install_caveats have no
 * metafield to read — Material-Metafield-Research §12 lists them as "ship first" but
 * setup-product-model.mjs does not define them yet. deriveTitle already accepts all
 * five, so the upgrade is to add them to that script and to PRODUCT_METAFIELD_KEYS
 * here; nothing else changes. Until then titles are missing their colour and their
 * floor/wall distinction, which is exactly the gap the research flagged.
 */
function fieldsFromProduct(product = {}) {
  const mf = metafieldMap(product.metafields?.nodes || product.metafields);
  const variant = product.variants?.nodes?.[0] || {};
  const vmf = metafieldMap(variant.metafields?.nodes || variant.metafields);
  const size = (variant.selectedOptions || []).find((o) => /size/i.test(o.name))?.value;
  const categoryId = resolveCategory(product);

  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    kind: 'product',
    categoryId,
    category: forCategory(categoryId)?.label || product.productType,
    sku: variant.sku,
    look: mf.look,
    material: mf.material,
    finish: mf.finish,
    slipRating: mf.slip_rating,
    applications: asList(mf.application),
    samplePrice: mf.sample_price,
    // `size_label` is the display string ("1800 x 1200 mm"); the Size OPTION is what
    // the PLP filters on. Prefer the label when set, since it is what the title needs.
    size: vmf.size_label || size,
    colourFamily: asList(mf.colour_family),
    colourName: mf.colour_name,
    series: mf.series,
    // Both are lists, but the title grammar takes one word — the primary surface.
    surface: asList(mf.surface)[0],
    pattern: mf.pattern,
    useCases: asList(mf.use_case),
    designVariants: mf.design_variants,
    installCaveats: asList(mf.install_caveats),
    thicknessMm: vmf.thickness_mm,
    packUnit: vmf.pack_unit,
    piecesPerPack: vmf.pieces_per_pack,
    priceUnit: vmf.price_unit,
    coveragePerPack: vmf.coverage_per_pack,
    installationGuide: mf.installation_guide,
    careMaintenance: mf.care_maintenance,
    descriptionHtml: product.descriptionHtml,
    currentSeoTitle: product.seo?.title,
    currentSeoDescription: product.seo?.description,
  };
}

function fieldsFromCollection(collection = {}) {
  const categoryId = resolveCategory(collection);
  return {
    id: collection.id,
    handle: collection.handle,
    title: collection.title,
    kind: 'collection',
    categoryId,
    category: forCategory(categoryId)?.label || collection.title,
    descriptionHtml: collection.descriptionHtml,
    currentSeoTitle: collection.seo?.title,
    currentSeoDescription: collection.seo?.description,
  };
}

/* ── audit ────────────────────────────────────────────────────────────────── */

/**
 * The source rubric was 15 weighted checks over 16 `seo.*` metafields it had created
 * itself (faq, aeo_qa, geo_facts, schema_extras, ai_geo_schema, internal_links…).
 * Material stores none of those, so scoring them would score nothing. This rubric is
 * the same idea over what Material actually has: native Shopify SEO fields plus the
 * metafields in setup-product-model.mjs.
 *
 * `appliesTo` keeps collections from being marked down for missing product specs;
 * the score is normalised over applicable weight.
 */
const RUBRIC = [
  { id: 'seo_title', weight: 15, label: 'meta title set', appliesTo: ['product', 'collection'],
    pass: (f) => Boolean(f.currentSeoTitle) },
  { id: 'seo_title_length', weight: 10, label: 'meta title 50-60 chars', appliesTo: ['product', 'collection'],
    pass: (f) => (f.currentSeoTitle || '').length >= 50 && (f.currentSeoTitle || '').length <= MAX_SEO_TITLE },
  { id: 'seo_description', weight: 15, label: 'meta description set', appliesTo: ['product', 'collection'],
    pass: (f) => Boolean(f.currentSeoDescription) },
  { id: 'seo_description_length', weight: 10, label: 'meta description 120-160 chars', appliesTo: ['product', 'collection'],
    pass: (f) => (f.currentSeoDescription || '').length >= 120 && (f.currentSeoDescription || '').length <= MAX_SEO_DESCRIPTION },
  { id: 'body', weight: 10, label: 'description at least 300 characters', appliesTo: ['product', 'collection'],
    pass: (f) => stripHtml(f.descriptionHtml).length >= 300 },
  { id: 'category', weight: 8, label: 'resolves to a known category', appliesTo: ['product', 'collection'],
    pass: (f) => Boolean(f.categoryId) },
  { id: 'material', weight: 8, label: 'custom.material set', appliesTo: ['product'],
    pass: (f) => Boolean(f.material) },
  { id: 'finish', weight: 8, label: 'custom.finish set', appliesTo: ['product'],
    pass: (f) => Boolean(f.finish) || f.categoryId === 'wallpaper' }, // §7: wallpaper has no finish facet
  { id: 'application', weight: 8, label: 'custom.application set', appliesTo: ['product'],
    pass: (f) => (f.applications || []).length > 0 },
  { id: 'vocabulary', weight: 8, label: 'attribute values are in the controlled list', appliesTo: ['product'],
    pass: (f) =>
      ['material', 'finish', 'look'].every(
        (attr) => !f[attr] || isKnownValue(f.categoryId, attr, f[attr]),
      ) },
];

function readiness(score) {
  if (score >= 85) return 'ready';
  if (score >= 70) return 'needs minor revision';
  if (score >= 50) return 'needs major revision';
  return 'not ready';
}

/** Score one entity and name what is missing. */
function auditFields(fields = {}) {
  const kind = fields.kind || 'product';
  const applicable = RUBRIC.filter((check) => check.appliesTo.includes(kind));
  const failed = applicable.filter((check) => !check.pass(fields));
  const total = applicable.reduce((sum, check) => sum + check.weight, 0);
  const lost = failed.reduce((sum, check) => sum + check.weight, 0);
  const score = total ? Math.round(((total - lost) / total) * 100) : 100;

  return {
    id: fields.id,
    handle: fields.handle,
    title: fields.title,
    kind,
    categoryId: fields.categoryId,
    score,
    readiness: readiness(score),
    // Heaviest first: the list is a work queue, not a report.
    issues: failed.sort((a, b) => b.weight - a.weight).map((c) => ({ id: c.id, label: c.label, weight: c.weight })),
  };
}

/* ── the model call ───────────────────────────────────────────────────────── */

// Same provider and same default model as the source (glassquickdev seo.js:1374 and
// gcp-functions/seo-generator/main.py:15 both read TEXT_MODEL, defaulting to
// gemini-2.5-flash). Env name kept so an existing deploy's value carries over.
const MODEL = () => process.env.TEXT_MODEL || 'gemini-2.5-flash';
const API_KEY = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '';

function llmConfigured() {
  return Boolean(API_KEY());
}

/**
 * The source ran two transports: Vertex AI (service-account bearer token) first,
 * falling back to Google AI Studio (`?key=`) when no SA key was bundled. Only the AI
 * Studio transport is ported.
 *
 * ponytail: one transport. Vertex needs a signed-JWT token exchange, a project id and
 * a region — lib/gscAuth.js already has the JWT half if it is ever wanted — but the
 * key it would buy is the same model behind a different URL, and GOOGLE_AI_API_KEY is
 * already configured in this service for image generation. Add the Vertex branch when
 * something actually requires it (data residency, VPC-SC, or committed-use pricing).
 */
async function callGemini(prompt, { maxOutputTokens = 8192, signal } = {}) {
  const apiKey = API_KEY();
  if (!apiKey) throw new Error('No LLM key configured — set GEMINI_API_KEY or GOOGLE_AI_API_KEY');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.3,
          responseMimeType: 'application/json',
          // Carried over from main.py: 2.5-flash otherwise spends billed thinking
          // tokens out of the output budget before writing any JSON, which truncated
          // the response, failed the parse, and made the caller pay for a retry.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  );

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);

  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text).find(Boolean) || '';
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new Error(`Gemini hit MAX_TOKENS at ${maxOutputTokens} — response truncated at ${text.length} chars`);
  }
  if (!text) throw new Error(`Gemini returned no text (finishReason=${candidate?.finishReason})`);
  return text.trim();
}

/** The call is already paid for — salvage the outermost object rather than throwing. */
function parseJsonLoose(raw) {
  const text = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw err;
    return JSON.parse(text.slice(start, end + 1));
  }
}

/**
 * The prompt. The source built a ~220-line prompt carrying an entire knowledge bank,
 * a base64 product image, per-kind page blueprints and eighteen rule bullets, then
 * made a second pass of one call per section group. This is one call.
 *
 * The facts block is built from stored attributes, as main.py's `build_prompt` did —
 * that is the part of the source prompt worth keeping. What is cut is everything that
 * asked the model for data Material stores structurally (spec tables, applications
 * lists, JSON-LD) or that the frontend already renders.
 */
function buildPrompt(fields, { keywords = [] } = {}) {
  const entry = forCategory(fields.categoryId);
  const specs = [
    ['Category', fields.category],
    ['Series', fields.series],
    ['Colour', fields.colourName],
    ['Look', fields.look],
    ['Base material', fields.material],
    ['Finish', fields.finish],
    ['Size', fields.size],
    ['Thickness', fields.thicknessMm && `${fields.thicknessMm} mm`],
    ['Slip rating', fields.slipRating],
    ['Pack', fields.piecesPerPack && `${fields.piecesPerPack} per ${fields.packUnit || 'pack'}`],
    ['Sold by', entry?.priceUnit],
    ['Suitable for', (fields.applications || []).join(', ')],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  return `You are a product copywriter for Material (material.in), an Indian direct-to-consumer store selling interior surfaces: tiles, laminates and wallpaper. You write for Indian customers searching on Google India. British English. Never invent a price, a warranty, a certification or a dimension that is not listed below.

${fields.kind === 'collection' ? 'COLLECTION' : 'PRODUCT'} FACTS
- Title: ${fields.title || '(none)'}
- Handle: ${fields.handle || '(none)'}
${specs || '- (no structured attributes recorded)'}
- Existing description: ${stripHtml(fields.descriptionHtml).slice(0, 800) || 'none — write fresh'}

TARGET SEARCH PHRASES (weave in naturally, do not stuff)
${keywords.slice(0, 12).map((k) => `- ${k}`).join('\n') || '- (none)'}

Return ONLY a JSON object with exactly these keys:
{
  "seoTitle": "max 60 characters, ends with | Material",
  "seoDescription": "120-160 characters, one clear benefit plus an intent phrase",
  "descriptionHtml": "${fields.kind === 'collection' ? '200-300' : '150-200'} words of HTML using only <p>, <ul> and <li>. No <html>, <body>, <h1> or inline styles. Cover what it is, how it looks, where it suits, and how it is bought in India.",
  "installationGuide": "${fields.kind === 'collection' ? 'empty string' : '3-5 short plain-text lines, one instruction per line, newline separated'}",
  "careMaintenance": "${fields.kind === 'collection' ? 'empty string' : '3-4 short plain-text lines, one instruction per line, newline separated'}"
}`;
}

/**
 * Generate copy for one entity.
 *
 * Derived values always win for products: they are built from stored attributes and
 * cannot drift from the catalogue. The model fills them only for collections, which
 * have no attributes to derive from. Writes nothing anywhere.
 */
async function generateCopy(fields, { ai = true, signal } = {}) {
  const derived = derive(fields);
  const result = {
    ...derived,
    descriptionHtml: null,
    installationGuide: null,
    careMaintenance: null,
    source: 'derived',
    model: null,
  };

  if (!ai || !llmConfigured()) return result;

  const raw = await callGemini(buildPrompt({ ...fields, ...derived }, { keywords: derived.keywords }), { signal });
  const ai_ = parseJsonLoose(raw);

  return {
    ...result,
    seoTitle:
      fields.kind === 'collection' && ai_.seoTitle ? clamp(ai_.seoTitle, MAX_SEO_TITLE) : derived.seoTitle,
    seoDescription:
      fields.kind === 'collection' && ai_.seoDescription
        ? clamp(ai_.seoDescription, MAX_SEO_DESCRIPTION)
        : derived.seoDescription,
    descriptionHtml: ai_.descriptionHtml || null,
    installationGuide: ai_.installationGuide || null,
    careMaintenance: ai_.careMaintenance || null,
    source: 'gemini',
    model: MODEL(),
  };
}

module.exports = {
  MAX_SEO_TITLE,
  MAX_SEO_DESCRIPTION,
  PRODUCT_METAFIELD_KEYS,
  VARIANT_METAFIELD_KEYS,
  RUBRIC,
  clamp,
  singular,
  stripHtml,
  asList,
  deriveTitle,
  deriveSeoTitle,
  deriveSeoDescription,
  derive,
  fieldsFromProduct,
  fieldsFromCollection,
  auditFields,
  readiness,
  buildPrompt,
  parseJsonLoose,
  generateCopy,
  llmConfigured,
  MODEL,
};
