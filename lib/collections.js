'use strict';

/**
 * collections.js — collection writes, plus the two reports that say whether
 * Material's navigation actually works.
 *
 * The writes are the boring half. The reports are the point:
 *
 *   collectionHealth()      every menu link, resolved against the live storefront
 *   collectionVocabulary()  every controlled metafield value in use, with duplicates
 *
 * This is Material's answer to glassquickdev's `nav-coverage` report — the one idea
 * in that repo worth carrying over. Its version found products that reach no PLP and
 * PLPs with no products; Material's problem is one layer up. The mega menu declares
 * 35 facet links and every one of them currently returns the UNFILTERED collection,
 * silently, because material-frontend/src/lib/collection.js resolves a readable param
 * by matching `slug(facet.label) === slug(paramName)` and, on no match, returns [] and
 * never issues a filtered request. No error, no empty state — just the whole category
 * where a filtered category was promised. Nothing else in this codebase can see that.
 *
 * ── What NOT to build here ──────────────────────────────────────────────────────
 * glassquickdev's answer to the same class of problem was categoryFilterSchema.ts
 * (1,512 lines) plus a `custom.collections` positional-hierarchy metafield. Both exist
 * to work around a storefront that could not get facets from Shopify. Material's can:
 * one `products(filters:)` connection returns the facets, their labels and their
 * per-value counts, and cleanFacet's 16 lines implement the guards GlassQuick
 * hand-built. Porting either would be re-solving a solved problem in a way that then
 * has to be kept in sync with Shopify by hand.
 *
 * ── API version ─────────────────────────────────────────────────────────────────
 * Introspected against 2026-01, not assumed. The collection mutation set is exactly
 * collectionCreate / collectionUpdate / collectionDelete / collectionDuplicate /
 * collectionReorderProducts — `collectionAddProducts`, `collectionAddProductsV2` and
 * `collectionRemoveProducts` are ALL GONE, which is why membership below is changed
 * from the PRODUCT side. See setCollectionProducts().
 *
 * FORWARD BREAK (noted, deliberately not coded for): 2026-07 renames
 * collectionCreate/collectionUpdate's argument from `input:` to `collection:` with new
 * input types. Writing a version shim now would be guessing at a schema nobody here
 * has introspected; the two mutation strings below are where that change lands.
 */

const path = require('node:path');
const { readFileSync } = require('node:fs');
const { adminGraphql, storefrontGraphql } = require('./shopify');
const { NAV_CATEGORIES } = require('./collectionReorder');
const { resolveCategory, isKnownValue, attributeValues, CATEGORY_IDS } = require('./keywordBank');

/* ── shared ─────────────────────────────────────────────────────────────────── */

/**
 * The SAME normalisation material-frontend/src/lib/collection.js uses to match a
 * readable param against a facet label. Copied rather than imported: that file is ESM
 * in another package, and the whole value of this report is that it reproduces the
 * storefront's decision exactly. If the two ever drift, this report starts lying —
 * which is why it is one line and pinned by a test.
 */
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Query keys that steer the page rather than filter it — mirrors CONTROL_PARAMS there. */
const CONTROL_PARAMS = new Set(['sort', 'cursor', 'q', 'page', 'price.gte', 'price.lte']);

const assertNoUserErrors = (payload, label) => {
  const errors = payload?.userErrors || [];
  if (errors.length) {
    const err = new Error(`${label}: ${errors.map((e) => e.message).join('; ')}`);
    err.code = 'shopify_rejected';
    throw err;
  }
  return payload;
};

/* ── list ───────────────────────────────────────────────────────────────────── */

const LIST_QUERY = `
  query Collections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      nodes {
        id handle title sortOrder updatedAt
        ruleSet { appliedDisjunctively rules { column relation condition } }
        productsCount { count }
        resourcePublicationsCount { count }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Every collection, with the four facts that decide what you can do to one:
 * how it sorts, whether it is smart, how many products it holds, where it is published.
 *
 * `smart` is `ruleSet != null` — Shopify has no boolean for it, and a smart collection
 * is the one thing you cannot manually reorder (see lib/collectionReorder.js).
 */
async function listCollections({ gql = adminGraphql, limit = 250 } = {}) {
  const out = [];
  let after = null;
  while (out.length < limit) {
    const data = await gql(LIST_QUERY, { first: Math.min(50, limit - out.length), after });
    const page = data.collections;
    for (const c of page.nodes) {
      out.push({
        id: c.id,
        handle: c.handle,
        title: c.title,
        sortOrder: c.sortOrder,
        smart: Boolean(c.ruleSet),
        rules: c.ruleSet?.rules || null,
        appliedDisjunctively: c.ruleSet?.appliedDisjunctively ?? null,
        products: c.productsCount?.count ?? null,
        publications: c.resourcePublicationsCount?.count ?? null,
        updatedAt: c.updatedAt,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return out;
}

/* ── create ─────────────────────────────────────────────────────────────────── */

const COLLECTION_CREATE = `
  mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle title sortOrder ruleSet { rules { column relation condition } } }
      userErrors { field message }
    }
  }
`;

/**
 * Turn a request body into a CollectionInput, refusing the combinations Shopify
 * accepts at the type level and then rejects (or, worse, silently ignores).
 *
 * Pure and exported, so the dry run and the real call cannot diverge — the same
 * posture as lib/productCreate.js's buildProductSet.
 */
function buildCollectionInput(input = {}) {
  const { title, handle, descriptionHtml, seo, sortOrder, image, metafields, products, ruleSet } = input;

  if (!title) {
    const err = new Error('title is required');
    err.code = 'bad_input';
    throw err;
  }
  if (products && ruleSet) {
    const err = new Error('a collection is either manual (`products`) or smart (`ruleSet`), never both');
    err.code = 'bad_input';
    throw err;
  }
  // The same mistake lib/collectionReorder.js used to make against `tiles`: an
  // automated collection has no manual order to impose, so MANUAL on a ruleSet is
  // a userError at write time. Caught here, where the message can say why.
  if (ruleSet && sortOrder === 'MANUAL') {
    const err = new Error('a smart collection cannot use sortOrder MANUAL — automated collections do not support manual ordering');
    err.code = 'bad_input';
    throw err;
  }
  if (ruleSet && typeof ruleSet.appliedDisjunctively !== 'boolean') {
    const err = new Error('ruleSet.appliedDisjunctively is required (false = match ALL rules, true = match ANY)');
    err.code = 'bad_input';
    throw err;
  }

  const warnings = [];
  // Verified on this store: ZERO collection metafield definitions exist. A metafield
  // written without one still stores, but it is not typed, not filterable and not
  // shown as a field in the admin — so this warns rather than refusing, the same way
  // productCreate warns on off-vocabulary values.
  if (metafields?.length) {
    warnings.push('this store has no COLLECTION metafield definitions — these will be stored untyped and will not be filterable');
  }
  if (ruleSet?.rules?.some((r) => String(r.column || '').includes('METAFIELD_DEFINITION'))) {
    warnings.push(
      'a *_METAFIELD_DEFINITION rule needs that definition to have capabilities.smartCollectionCondition.enabled = true; ' +
        'all 20 product definitions on this store currently have it false. Turn it on with metafieldDefinitionUpdate first.',
    );
  }

  return {
    input: {
      title,
      ...(handle ? { handle } : {}),
      ...(descriptionHtml ? { descriptionHtml } : {}),
      ...(seo ? { seo } : {}),
      ...(sortOrder ? { sortOrder } : {}),
      ...(image ? { image } : {}),
      ...(metafields?.length ? { metafields } : {}),
      // `products` is valid ONLY here. CollectionInput carries the field on
      // collectionUpdate too, where it does nothing — it will not add products to an
      // existing collection, and it fails silently. See setCollectionProducts().
      ...(products?.length ? { products: [].concat(products) } : {}),
      ...(ruleSet ? { ruleSet } : {}),
    },
    kind: ruleSet ? 'smart' : 'manual',
    warnings,
  };
}

/**
 * @param opts.dryRun  build the plan and return it, write nothing. DEFAULT TRUE —
 *   matching lib/productCreate.js: creating catalogue rows should not happen because
 *   a flag was forgotten.
 */
async function createCollection(input, { dryRun = true, gql = adminGraphql } = {}) {
  const plan = buildCollectionInput(input);
  if (dryRun) return { ...plan, dryRun: true, collection: null };

  const res = await gql(COLLECTION_CREATE, { input: plan.input });
  assertNoUserErrors(res.collectionCreate, 'collectionCreate');
  return { ...plan, dryRun: false, collection: res.collectionCreate.collection };
}

/* ── membership ─────────────────────────────────────────────────────────────── */

const PRODUCT_UPDATE = `
  mutation ProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id handle } userErrors { field message } }
  }
`;

/**
 * Add products to, or remove products from, an existing manual collection.
 *
 * Done one product at a time from the PRODUCT side, which looks backwards until you
 * check the schema: on 2026-01 there is no collection-side way to do it. The entire
 * collection mutation set is collectionCreate / collectionUpdate / collectionDelete /
 * collectionDuplicate / collectionReorderProducts — `collectionAddProducts`,
 * `collectionAddProductsV2` and `collectionRemoveProducts` have all been removed, and
 * `CollectionInput.products` only takes effect on collectionCreate. Introspected, not
 * remembered. productUpdate's `collectionsToJoin` / `collectionsToLeave` is what is
 * left, and it is per product.
 *
 * ponytail: N calls for N products, sequential. Fine at Material's 11-product
 * catalogue; if a bulk move ever matters the replacement is productSet's
 * `collections` (whole-set semantics) or Shopify's bulk operation API, not a
 * concurrency pool here.
 */
async function setCollectionProducts({ collectionId, add = [], remove = [] }, { dryRun = true, gql = adminGraphql } = {}) {
  if (!collectionId) {
    const err = new Error('collectionId is required');
    err.code = 'bad_input';
    throw err;
  }
  const addIds = [].concat(add).filter(Boolean);
  const removeIds = [].concat(remove).filter(Boolean);
  if (!addIds.length && !removeIds.length) {
    const err = new Error('nothing to do — pass `add` and/or `remove` as arrays of product GIDs');
    err.code = 'bad_input';
    throw err;
  }

  const plan = [
    ...addIds.map((id) => ({ id, collectionsToJoin: [collectionId] })),
    ...removeIds.map((id) => ({ id, collectionsToLeave: [collectionId] })),
  ];
  if (dryRun) return { dryRun: true, collectionId, via: 'productUpdate', plan, results: [] };

  const results = [];
  for (const product of plan) {
    try {
      const res = await gql(PRODUCT_UPDATE, { product });
      assertNoUserErrors(res.productUpdate, 'productUpdate');
      results.push({ id: product.id, joined: !!product.collectionsToJoin, left: !!product.collectionsToLeave });
    } catch (e) {
      results.push({ id: product.id, error: e.message });
    }
  }
  return { dryRun: false, collectionId, via: 'productUpdate', plan, results };
}

/* ── publish ────────────────────────────────────────────────────────────────── */

const PUBLISHABLE_PUBLISH = `
  mutation Publish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable { availablePublicationsCount { count } resourcePublicationsCount { count } }
      userErrors { field message }
    }
  }
`;

const PUBLICATIONS = `{ publications(first: 50) { nodes { id name } } }`;

/**
 * Collections implement `Publishable`, exactly like products, so this is the same
 * publishablePublish call — no collection-specific publishing mutation is needed.
 *
 * VERIFIED TRAP, and the reason this refuses to guess: `publications(first:50)` does
 * NOT list every publication on this store. It returns four (Online Store, Shop,
 * Point of Sale, Material Headless) and `publicationsCount` agrees — but reading
 * `resourcePublications(first:20)` off a live product returns FIVE, the extra one
 * being "Microsoft Copilot" (gid://shopify/Publication/209445027977). Code that
 * publishes "to every publication" by looping the list would therefore quietly leave
 * one channel unpublished forever, and the count it printed would look right.
 *
 * So: publish to an EXPLICIT set. Pass `publicationIds`, or set
 * SHOPIFY_PUBLICATION_IDS. With neither, this returns the incomplete list and says so
 * rather than picking for you.
 */
async function publishCollection({ id, publicationIds }, { dryRun = true, gql = adminGraphql } = {}) {
  const ids = [].concat(
    publicationIds || (process.env.SHOPIFY_PUBLICATION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  );

  if (!ids.length) {
    const available = (await gql(PUBLICATIONS)).publications.nodes;
    const err = new Error(
      'publicationIds is required — `publications(first:50)` is known to under-report on this store, ' +
        'so publishing to "all" would silently skip a channel. Pass the ids you mean, or set SHOPIFY_PUBLICATION_IDS.',
    );
    err.code = 'bad_input';
    err.available = available;
    throw err;
  }

  const input = ids.map((publicationId) => ({ publicationId }));
  if (dryRun) return { dryRun: true, id, publicationIds: ids, published: null };

  const res = await gql(PUBLISHABLE_PUBLISH, { id, input });
  assertNoUserErrors(res.publishablePublish, 'publishablePublish');
  return {
    dryRun: false,
    id,
    publicationIds: ids,
    published: res.publishablePublish.publishable?.resourcePublicationsCount?.count ?? null,
  };
}

/* ── menu ───────────────────────────────────────────────────────────────────── */

const MENU_JSON =
  process.env.MATERIAL_MENU_JSON ||
  path.join(__dirname, '..', '..', 'material-frontend', 'src', 'data', 'menu-data.json');

function readMenu(file = MENU_JSON) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error(`menu-data.json not readable at ${file} — set MATERIAL_MENU_JSON (${e.message})`);
    err.code = 'no_menu';
    throw err;
  }
}

/**
 * Flatten Shopify's nested menu shape into one row per LINK, with the collection
 * handle and facet param already pulled out of the URL.
 *
 * Group rows (`url: ".../#"`) carry no destination and are skipped. A category row
 * with no query string is kept: `/collections/wood` is still a link a shopper can
 * click, and on this store it 404s.
 *
 * Pure — the whole health report's parsing is testable without a network or a file.
 */
function menuLinks(menu) {
  const out = [];
  const walk = (node, trail) => {
    const url = String(node.url || '');
    const m = url.match(/\/collections\/([^/?#]+)(?:\?([^#]*))?/);
    if (m) {
      const handle = decodeURIComponent(m[1]);
      const params = [...new URLSearchParams(m[2] || '')].filter(([k]) => !CONTROL_PARAMS.has(k));
      const base = { title: node.title, url, handle, path: trail.join(' › ') };
      if (!params.length) out.push({ ...base, param: null, value: null });
      else for (const [param, value] of params) out.push({ ...base, param, value });
    }
    for (const child of node.items || []) walk(child, [...trail, node.title]);
  };
  for (const m of menu?.menus || []) for (const item of m.items || []) walk(item, []);
  return out;
}

/**
 * Material's readable menu params → the product metafield definition each was MEANT
 * to filter on. Hand-verified against the live store on 2026-08.
 *
 * This table is not a mapping the code applies — it CANNOT be, because resolution
 * happens in the storefront against the facet's label. It is the missing half of the
 * diagnosis: without it a mismatch reads "?room= matches nothing", with it the report
 * can say "the definition you meant is named Application, so the param has to be
 * ?application= (or the definition has to be renamed Room)".
 *
 * Three of the seven match their definition name. Four do not, and `size` is also a
 * VARIANT metafield rather than a product one.
 */
const PARAM_INTENT = {
  room: 'custom.application',      // definition name "Application"  — MISMATCH
  look: 'custom.look',             // "Look"                         — matches
  finish: 'custom.finish',         // "Finish"                       — matches
  pattern: 'custom.pattern',       // "Pattern"                      — matches
  slip: 'custom.slip_rating',      // "Slip rating"                  — MISMATCH
  use: 'custom.use_case',          // "Use case"                     — MISMATCH
  size: 'custom.size_label',       // "Size label", VARIANT-level     — MISMATCH
};

/**
 * Does this one link do what it says?
 *
 * Reproduces material-frontend/src/lib/collection.js's resolveNamedFilters decision
 * exactly — a param resolves only when some facet's LABEL slugs to the same string,
 * and a value only when some value's label does. Everything else is why-it-failed.
 *
 * Pure. `facets` is what the Storefront API returned for the collection; `definitions`
 * is the admin's metafield definition list, needed only to tell "the filter is off" —
 * which is one switch in Search & Discovery — apart from "the param is misnamed",
 * which is a code or data change.
 */
function diagnoseLink(link, { collectionExists, facets = [], definitions = [] } = {}) {
  const row = { ...link };
  if (!collectionExists) {
    return { ...row, status: 'no such collection', fix: `create the "${link.handle}" collection, or drop the menu entry` };
  }
  if (!link.param) return { ...row, status: 'ok', note: 'category link, no facet to resolve' };

  const facet = facets.find((f) => slug(f.label) === slug(link.param));
  if (facet) {
    const value = (facet.values || []).find((v) => slug(v.label) === slug(link.value));
    if (!value) {
      return {
        ...row,
        status: 'value not found in facet',
        facet: facet.label,
        available: (facet.values || []).map((v) => v.label),
        fix: `"${link.value}" is not a value of the "${facet.label}" facet`,
      };
    }
    // count 0 still RESOLVES — resolveNamedFilters reads the raw filter list, not
    // cleanFacet's filtered one — so the link works and lands on an empty grid.
    return { ...row, status: 'ok', facet: facet.label, count: value.count, filterId: facet.id };
  }

  const byName = definitions.find((d) => slug(d.name) === slug(link.param));
  if (byName) {
    return {
      ...row,
      status: 'facet not enabled',
      definition: `${byName.namespace}.${byName.key}`,
      fix: `the "${byName.name}" definition exists and the param matches it — turn the filter on in the Search & Discovery app`,
    };
  }

  const intent = PARAM_INTENT[link.param];
  const target = intent && definitions.find((d) => `${d.namespace}.${d.key}` === intent);
  return {
    ...row,
    status: 'param does not match any facet label',
    definition: target ? `${target.namespace}.${target.key}` : null,
    fix: target
      ? `?${link.param}= can never resolve: that data lives in "${target.name}"${target.ownerType === 'PRODUCTVARIANT' ? ' (a VARIANT metafield)' : ''}. ` +
        `Link ?${target.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}= instead, or rename the definition to "${link.param}" — then enable it in Search & Discovery`
      : `no product metafield definition is named "${link.param}", and no facet on this collection is labelled that`,
  };
}

const FACETS_QUERY = `
  query Facets($handle: String!) {
    collection(handle: $handle) {
      handle
      products(first: 1) { filters { id label type values { id label count } } }
    }
  }
`;

const DEFINITIONS_QUERY = `
  query Defs($ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(first: 100, ownerType: $ownerType) {
      nodes { name namespace key type { name } capabilities { smartCollectionCondition { enabled } } }
    }
  }
`;

/**
 * The whole menu, link by link, against the live store.
 *
 * Facets come from the STOREFRONT API, because a facet is a storefront concept — the
 * Admin API has no view of what Search & Discovery has enabled. That is also why the
 * failure this catches is invisible from the admin side.
 */
async function collectionHealth({ gql = adminGraphql, sf = storefrontGraphql, menu = null, menuFile } = {}) {
  const links = menuLinks(menu || readMenu(menuFile));
  const handles = [...new Set(links.map((l) => l.handle))];

  // Not wrapped in a try: a storefront failure here is a missing token or an
  // unreachable Shopify, and both are global rather than per-handle. Swallowing it
  // would turn "I could not ask" into "the collection does not exist" — a report that
  // invents 35 problems is worse than a 502.
  const facetsByHandle = {};
  for (const handle of handles) {
    const data = await sf(FACETS_QUERY, { handle });
    facetsByHandle[handle] = data.collection ? data.collection.products.filters || [] : null;
  }

  const definitions = [];
  for (const ownerType of ['PRODUCT', 'PRODUCTVARIANT']) {
    const data = await gql(DEFINITIONS_QUERY, { ownerType });
    for (const d of data.metafieldDefinitions.nodes) definitions.push({ ...d, ownerType });
  }

  const results = links.map((link) => {
    const facets = facetsByHandle[link.handle];
    return diagnoseLink(link, {
      collectionExists: Array.isArray(facets),
      facets: Array.isArray(facets) ? facets : [],
      definitions,
    });
  });

  const count = (status) => results.filter((r) => r.status === status).length;
  const live = new Set(handles.filter((h) => Array.isArray(facetsByHandle[h])));

  return {
    checkedAt: new Date().toISOString(),
    summary: {
      links: results.length,
      ok: count('ok'),
      okButEmpty: results.filter((r) => r.status === 'ok' && r.count === 0).length,
      noSuchCollection: count('no such collection'),
      facetNotEnabled: count('facet not enabled'),
      paramMismatch: count('param does not match any facet label'),
      valueNotFound: count('value not found in facet'),
    },
    // NAV_CATEGORIES is shared with lib/collectionReorder.js and lib/productSignalsSync.js,
    // both of which list handles that do not exist yet. That is deliberate — an absent
    // handle costs one skipped iteration and starts working the day the collection is
    // created — but "deliberate" and "silent" are different things, so it is named here.
    declared: {
      navCategories: NAV_CATEGORIES,
      missing: NAV_CATEGORIES.filter((h) => !live.has(h)),
      note: 'declared in lib/collectionReorder.js + lib/productSignalsSync.js; absent handles are skipped, not errors',
    },
    storefrontFacets: Object.fromEntries(
      Object.entries(facetsByHandle).map(([h, f]) => [h, Array.isArray(f) ? f.map((x) => x.label) : null]),
    ),
    seeAlso: 'GET /api/collections/vocabulary — whether the VALUE a link asks for exists on any product at all',
    links: results,
  };
}

/* ── vocabulary ─────────────────────────────────────────────────────────────── */

/**
 * The metafields whose values are a controlled vocabulary — the ones where a typo
 * splits a facet in two and nobody notices until the filter looks wrong.
 *
 * `application` is the ninth, beyond the eight this report was specified with: it is
 * just as controlled, the menu's `?room=` links target it, and it is the one field
 * with a real case collision live today ("Living room" on six products, "Living Room"
 * on one). Drop the string to drop the check.
 */
const LINTED_FIELDS = [
  'finish', 'material', 'look', 'colour_family', 'series', 'surface', 'pattern', 'use_case', 'application',
];

/** metafield key → the keyword-bank attribute holding its controlled list, where one exists. */
const BANK_ATTRIBUTE = {
  finish: 'finish', material: 'material', look: 'look', series: 'series',
  surface: 'surface', pattern: 'pattern', use_case: 'useCase', application: 'application',
};

/** Menu param → the metafield its values are claiming to be. Only the linted ones. */
const PARAM_FIELD = { finish: 'finish', look: 'look', pattern: 'pattern', use: 'use_case' };

/**
 * Case, spacing and punctuation stripped — two values that differ only here are the
 * same word to a shopper and two separate facet values to Shopify.
 */
const norm = (v) => String(v).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * ...and one step further: the obvious morphological variants.
 *
 * ponytail: one suffix list applied until it stops matching, not a stemmer. It catches
 * exactly the drift this catalogue has — gloss/glossy, texture/textured,
 * wood/woodgrain/wood-look, solid/solid colour — and nothing about it pretends to
 * generalise.
 *
 * It runs to a fixed point rather than stripping once, because stripping once is not
 * symmetric: "glossy" loses `y` and lands on "gloss" while "gloss" loses `s` and lands
 * on "glos", so the two words that most need grouping would not group. Trailing `e` is
 * in the list for the same reason — "textured" loses `ed` and lands on "textur", not on
 * the "Texture" the laminate vocabulary actually uses.
 *
 * Running to a fixed point over-strips ("gloss" and "glossy" both end up "glo"), which
 * does not matter: the stem is a bucket key that is never shown, and the raw values are
 * what the report prints. The 3-character floor stops a short value stemming to
 * nothing. A wrong grouping costs a glance, not a bad write — this report is advisory.
 */
function stem(v) {
  let s = norm(v).replace(/ /g, '');
  for (let previous = ''; s !== previous && s.length > 3; ) {
    previous = s;
    // `e` last: at the one index where both could match, `ed` has to win.
    s = s.replace(/(look|grain|effect|colour|color|ed|es|s|y|e)$/, '');
  }
  return s;
}

/**
 * Group raw values by stem and keep the groups holding more than one distinct value.
 * Pure; the interesting half of this module's test coverage.
 */
function nearDuplicates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = stem(row.value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()]
    .filter((g) => new Set(g.map((r) => r.value)).size > 1)
    .map((g) => ({
      // Same word once case and spacing are ignored = a pure formatting split, which is
      // a find-and-replace. Anything else is a judgement call about which word wins.
      reason: new Set(g.map((r) => norm(r.value))).size === 1 ? 'case/spacing' : 'variant',
      values: [...new Set(g.map((r) => r.value))],
      seenIn: [...new Set(g.map((r) => `${r.category}.${r.field}`))].sort(),
    }));
}

/**
 * Build the vocabulary report from already-fetched products plus the menu.
 *
 * Pure, so the whole linter is testable with fixtures. Menu values are folded in
 * alongside product values on purpose: the two failures worth catching — `finish=gloss`
 * on laminates against `finish=glossy` on tiles, and `finish=textured` on tiles which is
 * a laminate finish — both live in the MENU, not on a product. A value with
 * `products: 0, menu: 1` is a filter link promising something nothing carries.
 */
function buildVocabulary({ products = [], links = [] } = {}) {
  const rows = [];

  for (const p of products) {
    const category = p.category || 'uncategorised';
    for (const field of LINTED_FIELDS) {
      for (const value of [].concat(p.metafields?.[field] ?? [])) {
        if (value !== '' && value != null) rows.push({ category, field, value: String(value), source: 'product', handle: p.handle });
      }
    }
  }
  // A menu link's value is matched case- and punctuation-insensitively by the
  // storefront, so `?finish=glossy` against a stored "Glossy" is not drift — it is the
  // link working. Fold such a value onto the spelling the CATALOGUE uses before
  // counting, or every menu link would be reported as a near-duplicate of the value it
  // correctly resolves to, and the report would be almost entirely noise.
  const canonical = new Map(rows.map((r) => [`${r.field}:${norm(r.value)}`, r.value]));
  for (const link of links) {
    const field = PARAM_FIELD[link.param];
    if (!field || !link.value) continue;
    const value = canonical.get(`${field}:${norm(link.value)}`) || link.value;
    rows.push({ category: link.handle, field, value, source: 'menu', handle: link.url });
  }

  const byCategory = {};
  for (const row of rows) {
    const bucket = (byCategory[row.category] ??= {});
    const field = (bucket[row.field] ??= {});
    const entry = (field[row.value] ??= { value: row.value, products: 0, menu: 0 });
    entry[row.source === 'menu' ? 'menu' : 'products'] += 1;
  }

  const out = {};
  for (const [category, fields] of Object.entries(byCategory)) {
    out[category] = {};
    for (const [field, values] of Object.entries(fields)) {
      const attribute = BANK_ATTRIBUTE[field];
      out[category][field] = Object.values(values)
        .sort((a, b) => b.products - a.products || a.value.localeCompare(b.value))
        .map((v) => {
          // Exact (case- and space-insensitive) against this category's controlled list:
          // a value one letter off IS the thing worth flagging, so this must not be
          // fuzzy.
          //
          // Judged only where a list actually exists. The keyword bank has no `finish`
          // for wallpaper or stone and no `series` for tiles, and an empty list would
          // otherwise mark every value in those cells wrong — 30 flags out of 50 values
          // when it was first run, which is a report nobody reads twice. Same rule
          // lib/seoGenerator.js applies when it declines to mark wallpaper down for a
          // finish it has no facet for.
          const hasList = attribute && CATEGORY_IDS.includes(category) && attributeValues(category, attribute).length > 0;
          const known = hasList ? isKnownValue(category, attribute, v.value) : null;
          // Where else the value IS a known one — this is what turns "textured is not a
          // tile finish" into "textured is a LAMINATE finish, on the tiles menu". Fuzzy
          // on purpose, and only here: the laminate vocabulary spells it "Texture", and
          // a hint that has to be exact is a hint that never fires.
          const knownIn = known === false
            ? CATEGORY_IDS.filter((c) => c !== category && attributeValues(c, attribute).some((k) => stem(k) === stem(v.value)))
            : [];
          return {
            ...v,
            ...(known === null ? {} : { inCategoryVocabulary: known }),
            ...(knownIn.length ? { knownIn } : {}),
            ...(v.products === 0 ? { orphanLink: true } : {}),
          };
        });
    }
  }

  const duplicates = {};
  for (const field of LINTED_FIELDS) {
    const found = nearDuplicates(rows.filter((r) => r.field === field));
    if (found.length) duplicates[field] = found;
  }

  return {
    summary: {
      products: products.length,
      values: new Set(rows.map((r) => `${r.field}:${r.value}`)).size,
      nearDuplicateGroups: Object.values(duplicates).reduce((n, g) => n + g.length, 0),
      offVocabulary: Object.values(out).flatMap((f) => Object.values(f)).flat().filter((v) => v.inCategoryVocabulary === false).length,
      orphanMenuValues: Object.values(out).flatMap((f) => Object.values(f)).flat().filter((v) => v.orphanLink).length,
    },
    fields: LINTED_FIELDS,
    byCategory: out,
    nearDuplicates: duplicates,
  };
}

const VOCAB_QUERY = `
  query Vocab($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        handle productType
        collections(first: 10) { nodes { handle } }
        metafields(first: 30, namespace: "custom") { nodes { key value type } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** `list.*` metafields arrive as a JSON array STRING — the same encoding productCreate writes. */
function decode(node) {
  if (!node.type?.startsWith('list.')) return node.value;
  try {
    return JSON.parse(node.value);
  } catch {
    return node.value;
  }
}

async function collectionVocabulary({ gql = adminGraphql, menu = null, menuFile, limit = 500 } = {}) {
  const products = [];
  let after = null;
  while (products.length < limit) {
    const data = await gql(VOCAB_QUERY, { first: Math.min(50, limit - products.length), after });
    for (const node of data.products.nodes) {
      const handles = node.collections.nodes.map((c) => c.handle);
      products.push({
        handle: node.handle,
        // Collection membership first: the report groups by the listing page a value is
        // seen on, and that IS the collection. productType is the fallback for a product
        // not in a nav collection yet — every product in this store's `stone` collection
        // has a productType the keyword bank has no category for.
        category: handles.find((h) => NAV_CATEGORIES.includes(h))
          || resolveCategory({ productType: node.productType, handle: node.handle, collections: handles })
          || 'uncategorised',
        metafields: Object.fromEntries(node.metafields.nodes.map((m) => [m.key, decode(m)])),
      });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }

  return buildVocabulary({ products, links: menuLinks(menu || readMenu(menuFile)) });
}

module.exports = {
  listCollections,
  buildCollectionInput,
  createCollection,
  setCollectionProducts,
  publishCollection,
  collectionHealth,
  collectionVocabulary,
  // pure, for tests
  slug,
  menuLinks,
  diagnoseLink,
  nearDuplicates,
  buildVocabulary,
  readMenu,
  PARAM_INTENT,
  LINTED_FIELDS,
};
