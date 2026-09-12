'use strict';

/**
 * productReadiness.js — may this product go live, and how well is it filled in.
 *
 * TWO OUTPUTS, deliberately not one.
 *
 *   gates[]    — must be EMPTY to publish. Blocking. Unweighted.
 *   warnings[] — feed a 0-100 `score`. Advisory. Never blocks anything.
 *
 * ── Why they are separate ────────────────────────────────────────────────────
 * glassquickdev folded both into a single 0-100 score with no gate at all, and the
 * weighting inverted against revenue: a product that was out of stock AND
 * unpublished — literally unbuyable and invisible — scored 85/100 and graded B,
 * while a saleable product filed under the wrong nav tag scored worse. Every one of
 * those checks was defensible on its own; the failure was arithmetic. Adding up
 * "cannot be bought" with "colour_family is empty" produces a number that means
 * nothing, and a number that means nothing gets ignored.
 *
 * The fix is NOT re-weighting — pick any weights and there is still some pile of
 * cosmetic misses that outvotes "invisible". The fix is that one of these questions
 * is boolean and the other is a gradient, and they do not belong in one number.
 *
 * ── The eight gates ─────────────────────────────────────────────────────────
 * Every gate is chosen so that a LEGITIMATE Material product cannot trip it. That
 * property is what lets `gates.length === 0` be a hard precondition rather than
 * advice, and each gate below says in a comment why it holds. If a gate ever fires
 * on a product an operator is right to publish, the gate is wrong — demote it to a
 * warning rather than teaching people to override the check.
 *
 * The per-category exemption generalises seoGenerator.js's `|| f.categoryId ===
 * 'wallpaper'` carve-out on the `finish` check (~line 338), which is the correct
 * pattern: wallpaper has no finish facet, so scoring it on one measures nothing.
 * Here it is two explicit keys instead of an `||` buried in a predicate:
 *
 *   only:    [...]  the check is N/A outside these categories — excluded from the
 *                   score entirely, so an exempt product is not quietly marked down.
 *   warnFor: [...]  a FAILURE in these categories is a warning, not a gate. Used
 *                   where the requirement is real but a legitimate product can miss
 *                   it (a custom-size wallpaper mural genuinely has no size).
 *
 * ── Stable issue ids ────────────────────────────────────────────────────────
 * `section:code[:key]`, ported from glassquickdev. Review state ("we know, it is
 * fine") is keyed on the id, so an id that changes between audits loses it. The key
 * is the offending variant's SKU or the offending sub-condition, never an array
 * index — indexes move when a variant is added.
 *
 * ── "Not fetched" is not "absent" ───────────────────────────────────────────
 * If the metafields did not come back, this refuses to score rather than reporting
 * every field missing. Under rate limiting a partial read looks exactly like an
 * empty product, and an audit that says "everything is missing" on a complete
 * product is worse than an audit that says nothing: someone believes it once.
 */

const seo = require('./seoGenerator');
const { forCategory, CATEGORY_IDS } = require('./keywordBank');
const { normalisePriceUnit } = require('./productCreate');
const { getScenesForCategory, SCENE_METADATA } = require('./productImages/promptBuilder');

/* ── normalisation ────────────────────────────────────────────────────────── */

/**
 * Loose equality for size and label strings.
 *
 * The multiplication sign matters: live products carry "1200 × 200 mm" (U+00D7)
 * while productCreate writes "1200 x 600 mm" (the letter x). Comparing them raw
 * makes the size gate fire on a correct product.
 */
function norm(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Unit equality uses productCreate's alias table, not `norm`, so "Square Feet",
 * "sq ft" and "Sq. Ft." are one unit in both files. A gate that rejected a spelling
 * the create path accepts would fire on a product this service itself created.
 */
const unit = normalisePriceUnit;

const present = (v) => v != null && String(v).trim() !== '' && !(Array.isArray(v) && !v.length);

/* ── the shape the checks read ────────────────────────────────────────────── */

/**
 * Everything the readiness query returns, flattened.
 *
 * Built ON TOP of seoGenerator.fieldsFromProduct rather than beside it, so the SEO
 * rubric's predicates keep working unchanged on this bag — that is what lets the
 * warning set literally BE seoGenerator's RUBRIC plus extras, with no second
 * definition of "meta title is 50-60 characters" to drift.
 */
function readinessFields(product = {}) {
  const base = seo.fieldsFromProduct(product);
  const variantNodes = product.variants?.nodes || [];

  const variants = variantNodes.map((v, i) => {
    const mf = {};
    for (const m of v.metafields?.nodes || []) if (m?.key) mf[m.key] = m.value;
    return {
      id: v.id,
      // The stable key for a per-variant issue id. SKU first because it is what an
      // operator searches for; the option value is the fallback for the (gated)
      // case of a variant with no SKU, and the index is the last resort.
      key: v.sku || (v.selectedOptions || []).map((o) => o.value).join('/') || `variant-${i + 1}`,
      sku: v.sku,
      price: v.price == null ? null : Number(v.price),
      compareAtPrice: v.compareAtPrice == null ? null : Number(v.compareAtPrice),
      sizeOption: (v.selectedOptions || []).find((o) => /size/i.test(o.name))?.value || null,
      sizeLabel: mf.size_label,
      priceUnit: mf.price_unit,
      packUnit: mf.pack_unit,
      coveragePerPack: mf.coverage_per_pack,
      thicknessMm: mf.thickness_mm,
      tracked: v.inventoryItem?.tracked,
      inventoryQuantity: v.inventoryQuantity,
      inventoryPolicy: v.inventoryPolicy,
    };
  });

  const media = product.media?.nodes || [];

  return {
    ...base,
    status: product.status,
    // Every Size option value the product actually declares. A size_label must name
    // one of these — a label that names a size no variant is sold in is a typo.
    sizeOptionValues: (product.options || [])
      .filter((o) => /size/i.test(o.name))
      .flatMap((o) => o.values || []),
    imageCount: media.filter((m) => m.mediaContentType === 'IMAGE').length,
    imageAlts: media.map((m) => m.alt || ''),
    // VERIFIED state, from the product's own resourcePublications — not from the
    // publish mutation having returned no userErrors.
    publishedTo: (product.resourcePublications?.nodes || [])
      .filter((n) => n.isPublished)
      .map((n) => n.publication?.name)
      .filter(Boolean),
    variants,
  };
}

/**
 * What did NOT come back, as distinct from what is not set.
 *
 * Every one of these is a connection the readiness query asks for. GraphQL returns
 * an array or it returns null; null means the read failed or the caller sent a
 * thinner query, and either way the fields behind it are UNKNOWN. Absent from this
 * list, `{}` genuinely means empty.
 */
function loadErrors(product = {}) {
  const errs = [];
  const conn = (node, path) => {
    if (!Array.isArray(node)) errs.push(`${path} not fetched`);
  };

  conn(product.metafields?.nodes, 'product metafields');
  conn(product.media?.nodes, 'product media');
  conn(product.resourcePublications?.nodes, 'product publications');
  conn(product.variants?.nodes, 'product variants');
  for (const [i, v] of (product.variants?.nodes || []).entries()) {
    conn(v.metafields?.nodes, `variant ${v.sku || i + 1} metafields`);
  }
  return errs;
}

/* ── the eight gates ──────────────────────────────────────────────────────── */

// Ported verbatim from glassquickdev/admin-server/lib/product-test-rules.js ~L483-501.
// Both match a WORD that STARTS with test/copy — "Test", "Testing", "Copy of X",
// "copy-of-x" — and deliberately not "latest", "greatest", "contest", "protest",
// which an earlier untuned /test|copy/ flagged on real products. That tuning was
// paid for in false positives; it is not worth rediscovering.
const TITLE_PLACEHOLDER = /\b(test|copy)\w*/i;
const HANDLE_PLACEHOLDER = /(?:^|-)((?:test|copy)[a-z0-9]*)/i;

/** The unit a category is priced in, from lib/keyword-bank.json. Not duplicated here. */
const priceUnitFor = (categoryId) => forCategory(categoryId)?.priceUnit || null;

/**
 * A check. Same five keys as seoGenerator's RUBRIC ({id, weight, label, appliesTo,
 * pass}) so one UI component renders a gate row and a warning row identically, plus
 * three optional ones:
 *
 *   offenders(f) -> string[]   sub-keys that failed; each becomes `${id}:${key}`.
 *   only:    [categoryId]      N/A elsewhere — dropped, not failed.
 *   warnFor: [categoryId]      failure is a warning here, not a gate.
 *   fixedBy: 'publish'         this gate is the POSTCONDITION of publishing, so the
 *                              publish flow skips it as a precondition (it is always
 *                              false before the operation that fixes it) and asserts
 *                              it afterwards instead.
 *
 * `weight` on a gate never affects the publish decision — that is `gates.length ===
 * 0` and nothing else. It exists so the work queue can sort gates and warnings in
 * one list.
 */
const GATES = [
  {
    // A product page with no image does not convert and cannot be advertised; every
    // Material product is a SURFACE, whose entire value proposition is what it looks
    // like. There is no legitimate imageless tile.
    id: 'gate:image',
    weight: 20,
    label: 'has at least one image',
    appliesTo: ['product'],
    pass: (f) => f.imageCount > 0,
  },
  {
    // Price 0 is Shopify's default for a variant nobody set a price on, and it is a
    // free order. A genuinely free product is not a thing Material sells; a sample
    // has its own `sample_price` metafield and is not a variant.
    id: 'gate:variant_price',
    weight: 20,
    label: 'every variant is priced above zero',
    appliesTo: ['product'],
    pass: (f) => f.variants.length > 0 && f.variants.every((v) => v.price > 0),
    offenders: (f) => (f.variants.length ? f.variants.filter((v) => !(v.price > 0)).map((v) => v.key) : ['no-variants']),
  },
  {
    // Category drives the collection, the filters, the title grammar, the keyword
    // bank and the price unit. An unresolvable product is merchandised nowhere. Every
    // real product is one of the three; a fourth category is a code change, not a
    // product that should slip through.
    id: 'gate:category',
    weight: 15,
    label: `resolves to ${CATEGORY_IDS.join('/')}`,
    appliesTo: ['product'],
    pass: (f) => CATEGORY_IDS.includes(f.categoryId),
  },
  {
    // Without price_unit the PDP cannot say what ₹1,844.50 buys — a box, a sheet or a
    // square foot — and the per-sq-ft comparison every Indian tile shopper makes is
    // impossible. The expected value comes from the keyword bank, so a legitimate
    // product in a known category always has one available to it.
    id: 'gate:price_unit',
    weight: 12,
    label: 'price_unit set and matching the category',
    appliesTo: ['product'],
    pass: (f) =>
      Boolean(priceUnitFor(f.categoryId)) &&
      f.variants.length > 0 &&
      f.variants.every((v) => present(v.priceUnit) && unit(v.priceUnit) === unit(priceUnitFor(f.categoryId))),
    offenders: (f) =>
      f.variants
        .filter((v) => !present(v.priceUnit) || unit(v.priceUnit) !== unit(priceUnitFor(f.categoryId)))
        .map((v) => v.key),
  },
  {
    // Priced per sq ft but sold per box: without coverage_per_pack neither the shopper
    // nor the cart can turn "I need 400 sq ft" into a number of boxes.
    //
    // The carve-out is what keeps this honest, and it is a real case rather than a
    // hedge: a laminate priced per Sheet and sold per sheet needs no conversion
    // figure, and demanding one would fire on a perfectly saleable product. So the
    // gate is silent whenever the two units are the same.
    id: 'gate:coverage_per_pack',
    weight: 12,
    label: 'coverage_per_pack set where the price unit differs from the pack unit',
    appliesTo: ['product'],
    pass: (f) => f.variants.every((v) => unit(v.priceUnit) === unit(v.packUnit) || present(v.coveragePerPack)),
    offenders: (f) =>
      f.variants
        .filter((v) => unit(v.priceUnit) !== unit(v.packUnit) && !present(v.coveragePerPack))
        .map((v) => v.key),
  },
  {
    // A tile or a laminate is bought BY its size; a variant that does not declare one,
    // or declares one no variant is actually sold in, cannot be quoted or ordered.
    //
    // Wallpaper is a warning, not a gate, and that exemption is load-bearing rather
    // than convenient: a custom-size mural is priced per sq ft against a wall the
    // customer measures, so it is genuinely sizeless. Gating it would block a real
    // product, which is exactly what would teach an operator to bypass the gates.
    id: 'gate:size_label',
    weight: 12,
    label: 'every variant has a size_label naming a real Size option value',
    appliesTo: ['product'],
    warnFor: ['wallpaper'],
    pass: (f) =>
      f.variants.every(
        (v) => present(v.sizeLabel) && f.sizeOptionValues.some((o) => norm(o) === norm(v.sizeLabel)),
      ),
    offenders: (f) =>
      f.variants
        .filter((v) => !(present(v.sizeLabel) && f.sizeOptionValues.some((o) => norm(o) === norm(v.sizeLabel))))
        .map((v) => v.key),
  },
  {
    // ONE gate, two conditions, because either alone yields an invisible product and
    // splitting them invites fixing half. Measured on this store: a product created by
    // productSet has 0 publications, so ACTIVE on its own is a live product with no
    // sales channel — and a published DRAFT is a 404.
    //
    // `fixedBy: 'publish'` — this is the postcondition of the publish operation, not a
    // precondition of it. It is false by construction on every product waiting to be
    // published, so the publish flow skips it going in and verifies it coming out.
    id: 'gate:visibility',
    weight: 20,
    label: 'ACTIVE and published to at least one channel',
    appliesTo: ['product'],
    fixedBy: 'publish',
    pass: (f) => f.status === 'ACTIVE' && f.publishedTo.length > 0,
    offenders: (f) =>
      [f.status !== 'ACTIVE' && 'not_active', !f.publishedTo.length && 'not_published'].filter(Boolean),
  },
  {
    // Placeholders and collisions, together: all four are the same accident — a
    // product duplicated to make another one, then half-edited. A real product has a
    // real name that nothing else has.
    //
    // Uniqueness is store-wide and cannot be decided from the product alone, so it
    // comes in through ctx.duplicates. When that is not supplied it is not silently
    // passed — see assess(), which records it as a load error instead.
    id: 'gate:naming',
    weight: 15,
    label: 'title and handle are placeholder-free and unique store-wide',
    appliesTo: ['product'],
    pass: (f) =>
      !TITLE_PLACEHOLDER.test(f.title || '') &&
      !HANDLE_PLACEHOLDER.test(f.handle || '') &&
      !(f.duplicateTitles || []).length &&
      !(f.duplicateHandles || []).length,
    offenders: (f) =>
      [
        TITLE_PLACEHOLDER.test(f.title || '') && `title_placeholder`,
        HANDLE_PLACEHOLDER.test(f.handle || '') && `handle_placeholder`,
        (f.duplicateTitles || []).length && 'duplicate_title',
        (f.duplicateHandles || []).length && 'duplicate_handle',
      ].filter(Boolean),
  },
];

/* ── warnings ─────────────────────────────────────────────────────────────── */

/**
 * The scored half. seoGenerator's RUBRIC IS the SEO portion — imported, not copied,
 * so "meta title 50-60 chars" has exactly one definition and the two audits cannot
 * disagree about it. Only `category` is dropped: it is gate 3 now, and counting a
 * category failure twice would let one problem move the score by two checks.
 */
const SEO_WARNINGS = seo.RUBRIC.filter((c) => c.id !== 'category').map((c) => ({
  ...c,
  id: `warn:seo:${c.id}`,
}));

const MATERIAL_WARNINGS = [
  {
    // R-rating drives the anti-skid filter and is the thing that stops a glossy tile
    // going on a bathroom floor. Tiles only: laminates and wallpaper are not walked on.
    id: 'warn:slip_rating',
    weight: 8,
    label: 'slip_rating set',
    appliesTo: ['product'],
    only: ['tiles'],
    pass: (f) => present(f.slipRating),
  },
  {
    // Thickness is a spec-sheet row and a shipping input. N/A on wallpaper, which has
    // no meaningful thickness — the same carve-out shape as seoGenerator's `finish`.
    id: 'warn:thickness',
    weight: 8,
    label: 'thickness_mm on every variant',
    appliesTo: ['product'],
    only: ['tiles', 'laminates'],
    pass: (f) => f.variants.every((v) => present(v.thicknessMm)),
    offenders: (f) => f.variants.filter((v) => !present(v.thicknessMm)).map((v) => v.key),
  },
  {
    id: 'warn:colour_family',
    weight: 6,
    label: 'colour_family set (drives the colour filter)',
    appliesTo: ['product'],
    pass: (f) => present(f.colourFamily),
  },
  {
    id: 'warn:colour_name',
    weight: 6,
    label: 'colour_name set (the title grammar leads with it)',
    appliesTo: ['product'],
    pass: (f) => present(f.colourName),
  },
  {
    id: 'warn:series',
    weight: 5,
    label: 'series set',
    appliesTo: ['product'],
    pass: (f) => present(f.series),
  },
  {
    // Floor vs wall vs exterior. Not applicable to wallpaper, which goes on a wall by
    // definition.
    id: 'warn:surface',
    weight: 6,
    label: 'surface set',
    appliesTo: ['product'],
    only: ['tiles', 'laminates'],
    pass: (f) => present(f.surface),
  },
  {
    // The image pipeline shoots a fixed scene list per category and uploads each with
    // the scene's label as alt text (lib/productImages/pipeline.js), so alt text is
    // where scene coverage is legible. A product with one swatch and no room shot is
    // saleable but under-merchandised.
    id: 'warn:image_scenes',
    weight: 8,
    label: 'images cover the category scene set',
    appliesTo: ['product'],
    pass: (f) => !missingScenes(f).length,
    offenders: (f) => missingScenes(f),
  },
  {
    // A compare-at BELOW the price renders as a negative discount. A compare-at EQUAL
    // to the price renders as a 0% saving, which reads as a bug on the PDP.
    id: 'warn:compare_at_price',
    weight: 8,
    label: 'compareAtPrice, where set, is above the price',
    appliesTo: ['product'],
    pass: (f) => f.variants.every((v) => v.compareAtPrice == null || v.compareAtPrice > v.price),
    offenders: (f) =>
      f.variants.filter((v) => v.compareAtPrice != null && !(v.compareAtPrice > v.price)).map((v) => v.key),
  },
  {
    // Out of stock is a WARNING and not a gate on purpose. A tracked variant at 0 with
    // policy DENY is unbuyable today, but pre-orders, made-to-order laminates and a
    // restock two days out are all legitimate reasons to be live at zero — a gate here
    // would fire on a real product and break the "gates never lie" property the whole
    // design rests on. It is loud in the score instead.
    id: 'warn:out_of_stock',
    weight: 10,
    label: 'every tracked variant has stock',
    appliesTo: ['product'],
    pass: (f) => f.variants.every((v) => !v.tracked || (v.inventoryQuantity || 0) > 0),
    offenders: (f) =>
      f.variants.filter((v) => v.tracked && !((v.inventoryQuantity || 0) > 0)).map((v) => v.key),
  },
  {
    // Untracked is Shopify's default and it means unlimited: the variant never
    // decrements and a shopper can buy 400 boxes of a tile there are 4 of. Not a gate
    // because made-to-order genuinely is unlimited.
    id: 'warn:untracked',
    weight: 8,
    label: 'inventory is tracked on every variant',
    appliesTo: ['product'],
    pass: (f) => f.variants.every((v) => v.tracked !== false),
    offenders: (f) => f.variants.filter((v) => v.tracked === false).map((v) => v.key),
  },
];

const WARNINGS = [...SEO_WARNINGS, ...MATERIAL_WARNINGS];

/**
 * Scene ids the category shoots that no image's alt text accounts for.
 *
 * Alt text is the only evidence of WHICH scene an image is — lib/productImages/
 * pipeline.js uploads each one with the scene's label as its alt. So a product whose
 * images all have blank alt text is not "missing every scene", it is UNMEASURED, and
 * this returns nothing rather than reporting six missing shots on a product with six
 * images. Same rule as loadErrors(), applied to a warning: an image with no alt is
 * already an accessibility problem worth reporting on its own terms, not by inventing
 * a scene gap.
 */
function missingScenes(f) {
  const alts = f.imageAlts.map(norm).filter(Boolean);
  if (!alts.length) return [];
  return getScenesForCategory(f.categoryId || f.category)
    .filter((id) => {
      const label = SCENE_METADATA[id]?.label || id.replace(/_/g, ' ');
      return !alts.some((a) => a.includes(norm(label)) || a.includes(norm(id)));
    });
}

/* ── running them ─────────────────────────────────────────────────────────── */

/** Does this check apply to this product at all? */
function applies(check, fields) {
  if (!check.appliesTo.includes(fields.kind || 'product')) return false;
  return !check.only || check.only.includes(fields.categoryId);
}

/** One failed check → one or more issues with stable `section:code[:key]` ids. */
function issuesFor(check, fields, severity) {
  const keys = check.offenders ? check.offenders(fields) : [];
  const base = { code: check.id, label: check.label, weight: check.weight, severity };
  if (!keys.length) return [{ ...base, id: check.id }];
  return keys.map((key) => ({ ...base, id: `${check.id}:${key}`, key }));
}

/**
 * Gate and score one product.
 *
 * @param {object} fields          from readinessFields()
 * @param {string[]} ctx.loadErrors  connections that did not come back — see loadErrors()
 * @param {object} ctx.duplicates  { titles: [...], handles: [...] } store-wide matches,
 *                                 excluding this product. REQUIRED: omitted is treated as
 *                                 "not checked", never as "unique".
 * @param {string} ctx.skipGatesFixedBy  skip gates whose `fixedBy` matches — the publish
 *                                 flow passes 'publish' so gate 7 is asserted after the
 *                                 write instead of blocking it before.
 */
function assess(fields, { loadErrors: errs = [], duplicates, skipGatesFixedBy = null } = {}) {
  const head = {
    id: fields.id,
    handle: fields.handle,
    title: fields.title,
    categoryId: fields.categoryId,
    status: fields.status,
    publishedTo: fields.publishedTo || [],
  };

  // Uniqueness cannot be decided from the product, so an unsupplied duplicates map is
  // a gap in the READ, not a pass. Same rule as a missing metafield connection.
  const allErrors = [...errs, ...(duplicates ? [] : ['store-wide duplicate check not run'])];

  if (allErrors.length) {
    return {
      ...head,
      scored: false,
      publishable: false,
      score: null,
      readiness: 'not scored',
      loadErrors: allErrors,
      gates: [],
      warnings: [],
    };
  }

  const withDupes = {
    ...fields,
    duplicateTitles: duplicates.titles || [],
    duplicateHandles: duplicates.handles || [],
  };

  const gates = [];
  const warnings = [];
  // The score is over WARNINGS only. A gate contributes nothing to it — a gated
  // product is not "a low score", it is "no", and letting a gate move the number is
  // how the two questions got mixed into one in the first place.
  let total = 0;
  let lost = 0;

  for (const gate of GATES) {
    if (!applies(gate, withDupes)) continue;
    if (skipGatesFixedBy && gate.fixedBy === skipGatesFixedBy) continue;
    // The per-category degrade: same check, different consequence. Where it degrades
    // it becomes a warning in every respect INCLUDING the score — a finding that
    // costs nothing sorts nowhere and gets read by nobody.
    const degraded = (gate.warnFor || []).includes(withDupes.categoryId);
    if (degraded) total += gate.weight;
    if (gate.pass(withDupes)) continue;
    if (!degraded) {
      gates.push(...issuesFor(gate, withDupes, 'gate'));
      continue;
    }
    lost += gate.weight;
    warnings.push(...issuesFor(gate, withDupes, 'warning'));
  }

  for (const check of WARNINGS) {
    if (!applies(check, withDupes)) continue;
    total += check.weight;
    if (check.pass(withDupes)) continue;
    lost += check.weight;
    warnings.push(...issuesFor(check, withDupes, 'warning'));
  }
  const score = total ? Math.round(((total - lost) / total) * 100) : 100;

  return {
    ...head,
    scored: true,
    publishable: gates.length === 0,
    score,
    // Reused, not redefined: the same bands the SEO audit already reports in.
    readiness: seo.readiness(score),
    loadErrors: [],
    gates: gates.sort((a, b) => b.weight - a.weight),
    warnings: warnings.sort((a, b) => b.weight - a.weight),
  };
}

/* ── the query these fields come from ─────────────────────────────────────── */

/**
 * Kept next to readinessFields on purpose: every connection below is one the
 * flattener or loadErrors() reads, and a field dropped from here shows up as a load
 * error rather than as a product that is missing everything.
 *
 * Publication state comes from the product's own `resourcePublications`, never from
 * the shop's `publications` list — VERIFIED on this store: `publications(first: 250)`
 * and `publicationsCount` both say 4, while a published product's own connection
 * returns 5. "Microsoft Copilot" publishes products and no shop-level query this app
 * can run enumerates it. Deciding "is it published" from the shop list would call a
 * published product unpublished.
 */
const PRODUCT_FIELDS = `
  id handle title status productType tags descriptionHtml
  seo { title description }
  options { name values }
  media(first: 20) { nodes { mediaContentType alt } }
  metafields(first: 25, namespace: "custom") { nodes { key value } }
  resourcePublications(first: 50, onlyPublished: false) {
    nodes { isPublished publication { id name } }
  }
  variants(first: 50) {
    nodes {
      id sku price compareAtPrice inventoryQuantity inventoryPolicy
      selectedOptions { name value }
      inventoryItem { id tracked }
      metafields(first: 15, namespace: "custom") { nodes { key value } }
    }
  }
`;

module.exports = {
  GATES,
  WARNINGS,
  PRODUCT_FIELDS,
  TITLE_PLACEHOLDER,
  HANDLE_PLACEHOLDER,
  assess,
  readinessFields,
  loadErrors,
  norm,
  missingScenes,
};
