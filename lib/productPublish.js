'use strict';

/**
 * productPublish.js — the Shopify half of making a product visible.
 *
 * lib/productReadiness.js decides IF a product may go live and stays pure; this file
 * is the only part that talks to Shopify. Same split as routes/products.js →
 * lib/productCreate.js.
 *
 * ── One operation, four steps, in this order ─────────────────────────────────
 *   1. gates      — refuse before writing anything
 *   2. ACTIVE     — productUpdate(status: ACTIVE)
 *   3. publish    — publishablePublish to an explicit publication set
 *   4. VERIFY     — read resourcePublications back
 *
 * Step 4 is not paranoia. A product can be ACTIVE and still invisible, which is why
 * step 2 and step 3 are one endpoint rather than two: doing either alone leaves a
 * product an operator believes is live and a shopper cannot reach. And a mutation
 * that returned no userErrors is evidence about the REQUEST, not about the state —
 * the only thing that proves a product is published is reading that it is.
 *
 * ── The publication trap, verified on this store ─────────────────────────────
 * `publications(first: 250)` returns FOUR (Online Store, Shop, Point of Sale,
 * Material Headless). `publicationsCount` also says four, and `catalogType: APP`
 * returns the same four — so this is not a paging bug and there is no filter that
 * fixes it. A product's own `resourcePublications` returns FIVE: the fifth is
 * "Microsoft Copilot", which exists and publishes products.
 *
 * So a "publish to everything" loop over `publications` silently skips a live channel
 * and reports success. Hence: the target set is an EXPLICIT, configurable list of
 * NAMES, never "all".
 *
 * `resolvePublications` also folds in the product's own resourcePublications, but be
 * clear about what that buys — measured: on a product created a moment ago that
 * connection is EMPTY even with `onlyPublished: false`. It enumerates the
 * publications a product is ASSOCIATED with, not the ones available to it. So the
 * union recovers a channel the product already touches and nothing more; there is no
 * query available to this app that enumerates Microsoft Copilot from scratch. If it
 * ever needs to be a target by name, put its id in SHOPIFY_PUBLICATION_NAMES's place
 * by hand, or read it off a product that already has it.
 *
 * "current" is never used: this app has no publication of its own, so publishing to
 * `current` publishes to nothing while returning no error at all.
 */

const { adminGraphql } = require('./shopify');
const readiness = require('./productReadiness');

/* ── which channels ───────────────────────────────────────────────────────── */

/**
 * Default: the Online Store alone — the storefront material.in serves. It IS in the
 * shop-level publications list, so the trap above does not bite the default path.
 *
 * Everything else is opt-in per call or per deploy, because publishing to Shop or to
 * Point of Sale has commercial consequences (marketplace listing, till inventory)
 * that are not this endpoint's to assume.
 */
const DEFAULT_PUBLICATIONS = () =>
  (process.env.SHOPIFY_PUBLICATION_NAMES || 'Online Store')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

const SHOP_PUBLICATIONS = `query Publications { publications(first: 250) { nodes { id name } } }`;

/**
 * name → publication id, from both sources, with the product's own view winning
 * nothing and losing nothing — it only ADDS the channels the shop list omits.
 */
async function resolvePublications(names, product) {
  const byName = new Map();
  for (const node of (await adminGraphql(SHOP_PUBLICATIONS)).publications?.nodes || []) {
    byName.set(node.name.toLowerCase(), { id: node.id, name: node.name, source: 'publications' });
  }
  for (const rp of product?.resourcePublications?.nodes || []) {
    const key = rp.publication?.name?.toLowerCase();
    if (key && !byName.has(key)) {
      byName.set(key, { id: rp.publication.id, name: rp.publication.name, source: 'resourcePublications' });
    }
  }

  const resolved = [];
  const unresolved = [];
  for (const name of names) {
    const hit = byName.get(name.trim().toLowerCase());
    if (hit) resolved.push(hit);
    else unresolved.push(name);
  }
  return { resolved, unresolved, available: [...byName.values()].map((p) => p.name) };
}

/* ── reads ────────────────────────────────────────────────────────────────── */

const BY_ID = `query ById($id: ID!) { product(id: $id) { ${readiness.PRODUCT_FIELDS} } }`;
const BY_HANDLE = `
  query ByHandle($q: String!) { products(first: 1, query: $q) { nodes { ${readiness.PRODUCT_FIELDS} } } }`;

/** `123`, `gid://shopify/Product/123` or a handle. */
function asProductGid(ref) {
  const value = String(ref || '').trim();
  if (value.startsWith('gid://')) return value;
  return /^\d+$/.test(value) ? `gid://shopify/Product/${value}` : null;
}

async function fetchProduct(ref) {
  const gid = asProductGid(ref);
  if (gid) return (await adminGraphql(BY_ID, { id: gid })).product || null;
  return (await adminGraphql(BY_HANDLE, { q: `handle:${ref}` })).products?.nodes?.[0] || null;
}

/**
 * Store-wide title and handle collisions for ONE product.
 *
 * Two candidate searches, then exact comparison here. Shopify's `query:` is tokenised
 * and fuzzy — `title:"Matte Tile"` also returns "Matte Tile Grey" — so the search is
 * used only to NARROW the store to plausible matches and equality is decided in JS.
 * That way a fuzzy match cannot invent a duplicate.
 *
 * The trailing `-\d+` strip is glassquickdev's: Shopify auto-suffixes a colliding
 * handle, so `matte-tile-2` existing at all is the signal that the product was
 * created twice. It is compared against the base handle for the same reason.
 *
 * ponytail: `first: 50` per search. A title so generic that fifty products out-rank
 * the real twin is a naming problem this gate is already reporting by other means.
 */
const DUPLICATE_SEARCH = `
  query Duplicates($byTitle: String!, $byHandle: String!) {
    byTitle: products(first: 50, query: $byTitle) { nodes { id title handle } }
    byHandle: products(first: 50, query: $byHandle) { nodes { id title handle } }
  }`;

/**
 * The handle with Shopify's collision suffix removed.
 *
 * `[1-9]\d?` and not `\d+`, which is what glassquickdev used: Shopify's suffix counts
 * up from 1, so it is one or two digits with no leading zero, whereas a Material
 * handle routinely ENDS in a number that is part of the name — `...-tl-06117` (an
 * SKU), `...-600x600` (a size). `\d+` turned `tile-tl-06117` into `tile-tl` and made
 * every tile in a series look like a duplicate of every other.
 *
 * ponytail: a handle whose real last segment is a bare 1-99 (`...-tile-9`) is still
 * stripped. The cost is one false duplicate REPORT on a gate an operator reads, not a
 * bad write, and the alternative is asking Shopify to confirm every candidate.
 */
const baseHandle = (h) => String(h || '').replace(/-[1-9]\d?$/, '');

async function duplicatesFor(product) {
  const title = product.title || '';
  const handle = product.handle || '';
  // Quotes escaped, not stripped: a title containing one must still be searchable,
  // and an unescaped quote makes Shopify's parser read the rest of the term as syntax.
  const quoted = title.replace(/(["\\])/g, '\\$1');
  const data = await adminGraphql(DUPLICATE_SEARCH, {
    byTitle: `title:"${quoted}"`,
    byHandle: `handle:${baseHandle(handle)}`,
  });

  const others = [...(data.byTitle?.nodes || []), ...(data.byHandle?.nodes || [])].filter(
    (n) => n.id !== product.id,
  );
  const same = (a, b) => readiness.norm(a) === readiness.norm(b) && readiness.norm(a) !== '';

  return {
    titles: [...new Set(others.filter((n) => same(n.title, title)).map((n) => n.handle))],
    handles: [...new Set(
      others.filter((n) => same(baseHandle(n.handle), baseHandle(handle))).map((n) => n.handle),
    )],
  };
}

/** Gate and score one already-fetched product node. */
async function assessProduct(product, { skipGatesFixedBy = null } = {}) {
  const errs = readiness.loadErrors(product);
  // Do not spend two searches on a product whose read already failed — the assessment
  // is going to refuse to score either way.
  const duplicates = errs.length ? { titles: [], handles: [] } : await duplicatesFor(product);
  return readiness.assess(readiness.readinessFields(product), {
    loadErrors: errs,
    duplicates,
    skipGatesFixedBy,
  });
}

/* ── writes ───────────────────────────────────────────────────────────────── */

// `product: ProductUpdateInput`, matching routes/seo.js. productChangeStatus does not
// exist in 2026-01 — status is an ordinary field on this input.
const SET_ACTIVE = `
  mutation Activate($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id status } userErrors { field message } }
  }`;

const PUBLISH = `
  mutation Publish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }`;

const VERIFY = `
  query Verify($id: ID!) {
    product(id: $id) {
      id status onlineStorePreviewUrl
      resourcePublications(first: 50, onlyPublished: false) {
        nodes { isPublished publication { id name } }
      }
    }
  }`;

function assertNoUserErrors(payload, label) {
  const errors = payload?.userErrors || [];
  if (errors.length) {
    const err = new Error(`${label}: ${errors.map((e) => e.message).join('; ')}`);
    err.code = 'shopify_rejected';
    throw err;
  }
  return payload;
}

function fail(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

/**
 * Activate, publish and verify — one operation.
 *
 * @param {string} ref  product gid, numeric id or handle
 * @param {boolean} opts.dryRun  return the gate results and the target set, write
 *   nothing. NOT the default: unlike creating a product, this is an explicit
 *   operator action on an existing row, and a flag that has to be remembered to make
 *   the endpoint do its job is a flag that gets scripted away.
 * @param {string[]} opts.publications  publication NAMES to publish to.
 */
async function publishProduct(ref, { dryRun = false, publications = DEFAULT_PUBLICATIONS() } = {}) {
  const product = await fetchProduct(ref);
  if (!product) fail('not_found', `product ${ref} not found`);

  // gate:visibility is the postcondition of this very operation — false on every
  // product waiting to be published — so it is skipped going in and asserted at the
  // end against a fresh read. Every other gate blocks.
  const assessment = await assessProduct(product, { skipGatesFixedBy: 'publish' });
  const targets = await resolvePublications(publications, product);

  const plan = {
    id: product.id,
    handle: product.handle,
    title: product.title,
    statusBefore: product.status,
    wouldActivate: product.status !== 'ACTIVE',
    wouldPublishTo: targets.resolved,
    unresolvedPublications: targets.unresolved,
    availablePublications: targets.available,
    readiness: assessment,
  };

  if (dryRun) return { ...plan, dryRun: true, applied: false };

  if (!assessment.scored) {
    fail('readiness_unknown', `refusing to publish — ${assessment.loadErrors.join('; ')}`);
  }
  if (assessment.gates.length) {
    fail(
      'gates_failed',
      `${assessment.gates.length} gate(s) block publishing: ${assessment.gates.map((g) => g.id).join(', ')}`,
      { gates: assessment.gates },
    );
  }
  if (targets.unresolved.length) {
    fail('unknown_publication', `no publication named ${targets.unresolved.map((n) => `"${n}"`).join(', ')} — available: ${targets.available.join(', ')}`);
  }
  if (!targets.resolved.length) fail('no_publication', 'no publications to publish to');

  if (product.status !== 'ACTIVE') {
    assertNoUserErrors(
      (await adminGraphql(SET_ACTIVE, { product: { id: product.id, status: 'ACTIVE' } })).productUpdate,
      'productUpdate(status: ACTIVE)',
    );
  }

  assertNoUserErrors(
    (await adminGraphql(PUBLISH, {
      id: product.id,
      input: targets.resolved.map((p) => ({ publicationId: p.id })),
    })).publishablePublish,
    'publishablePublish',
  );

  // ── verify ──
  const after = (await adminGraphql(VERIFY, { id: product.id })).product;
  const publishedIds = new Set(
    (after?.resourcePublications?.nodes || []).filter((n) => n.isPublished).map((n) => n.publication?.id),
  );
  const notPublished = targets.resolved.filter((p) => !publishedIds.has(p.id));

  if (after?.status !== 'ACTIVE' || notPublished.length) {
    fail(
      'verify_failed',
      `publish reported success but the product is not live: status=${after?.status}` +
        (notPublished.length ? `, not published to ${notPublished.map((p) => p.name).join(', ')}` : ''),
    );
  }

  return {
    ...plan,
    dryRun: false,
    applied: true,
    status: after.status,
    publishedTo: (after.resourcePublications?.nodes || [])
      .filter((n) => n.isPublished)
      .map((n) => n.publication.name),
    previewUrl: after.onlineStorePreviewUrl,
  };
}

/* ── the sweep ────────────────────────────────────────────────────────────── */

const SCAN = `
  query Scan($first: Int!, $after: String, $q: String) {
    products(first: $first, after: $after, query: $q) {
      nodes { ${readiness.PRODUCT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const INDEX = `
  query Index($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes { id title handle }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/**
 * Title/handle collisions for the WHOLE catalogue, in one index pass.
 *
 * The per-product `duplicatesFor` costs two searches; running it across a sweep would
 * cost 2N. This is `ceil(N/250)` calls for the same answer, and it is exact rather
 * than search-ranked.
 *
 * ponytail: capped at `max` products. Beyond the cap the sweep reports the duplicate
 * check as a LOAD ERROR for the products it could not index rather than claiming they
 * are unique — the same "not fetched is not absent" rule as everywhere else. Raise the
 * cap or move this to a bulk operation when the catalogue outgrows it.
 */
async function duplicateIndex({ max = 2000 } = {}) {
  const byTitle = new Map();
  const byHandle = new Map();
  const seen = [];
  let after = null;

  while (seen.length < max) {
    const page = (await adminGraphql(INDEX, { first: Math.min(250, max - seen.length), after })).products;
    for (const n of page.nodes) {
      seen.push(n);
      const t = readiness.norm(n.title);
      const h = readiness.norm(baseHandle(n.handle));
      if (t) byTitle.set(t, [...(byTitle.get(t) || []), n]);
      if (h) byHandle.set(h, [...(byHandle.get(h) || []), n]);
    }
    if (!page.pageInfo.hasNextPage) return { byTitle, byHandle, complete: true, indexed: seen.length };
    after = page.pageInfo.endCursor;
  }
  return { byTitle, byHandle, complete: false, indexed: seen.length };
}

const lookup = (index, product) => ({
  titles: (index.byTitle.get(readiness.norm(product.title)) || [])
    .filter((n) => n.id !== product.id)
    .map((n) => n.handle),
  handles: (index.byHandle.get(readiness.norm(baseHandle(product.handle))) || [])
    .filter((n) => n.id !== product.id)
    .map((n) => n.handle),
});

/** Page the catalogue, gating and scoring as it goes. Stops at `limit`. */
async function sweep({ limit = 100, query = null } = {}) {
  const index = await duplicateIndex();
  const results = [];
  let after = null;

  // 10 a page, not seo.js's 25: PRODUCT_FIELDS here nests options, media, 50
  // variants, two metafield connections and resourcePublications, and Shopify's cost
  // budget is per query.
  while (results.length < limit) {
    const page = (await adminGraphql(SCAN, { first: Math.min(10, limit - results.length), after, q: query }))
      .products;

    for (const node of page.nodes) {
      const errs = readiness.loadErrors(node);
      const indexed = index.byHandle.has(readiness.norm(baseHandle(node.handle)));
      results.push(
        readiness.assess(readiness.readinessFields(node), {
          loadErrors: [
            ...errs,
            // Past the index cap: not "unique", UNKNOWN.
            ...(indexed ? [] : [`store-wide duplicate check incomplete — only ${index.indexed} products indexed`]),
          ],
          duplicates: lookup(index, node),
        }),
      );
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return { results, duplicateIndex: { indexed: index.indexed, complete: index.complete } };
}

module.exports = {
  DEFAULT_PUBLICATIONS,
  asProductGid,
  baseHandle,
  assessProduct,
  duplicatesFor,
  fetchProduct,
  publishProduct,
  resolvePublications,
  sweep,
};
