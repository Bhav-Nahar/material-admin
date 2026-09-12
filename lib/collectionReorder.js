'use strict';

/**
 * collectionReorder.js — push the relevance ranking INTO Shopify, once a night.
 *
 * The alternative is ranking per request: the storefront pulls the whole
 * category into memory and sorts it by custom.relevance_score, because Shopify
 * cannot sort a collection by a metafield. Measured on the store this came from,
 * that cost 8.4s on a cold category page against 0.11s for a native listing —
 * an eight-second wait for a real shopper.
 *
 * The ranking only changes when the nightly scoring runs, so it belongs in the
 * nightly job rather than in the request path. Ordering the collection in
 * Shopify means the storefront just reads COLLECTION_DEFAULT — native
 * pagination, no cache to grow, no whole-category fetch, at normal speed.
 *
 * ── What this changes in the admin ──────────────────────────────────────────
 * MANUAL collections move from whatever they were to MANUAL, which means THIS JOB
 * owns their order. If it stops running the order freezes rather than degrading,
 * which is the safe direction. BEST_SELLING is not a loss: Material has
 * effectively no order history, so Shopify has nothing to rank with either.
 *
 * SMART collections are skipped, because an automated collection has no manual
 * order to impose — see the check in reorderCollections(). Today that is `tiles`,
 * the only collection with enough products for this job to matter at all.
 *
 * ── At Material's current size ──────────────────────────────────────────────
 * A collection with fewer than 2 products is skipped, so with ~1 product live
 * this job correctly does nothing at all and says so. It starts mattering on its
 * own as Tiles / Laminates / Wallpaper fill up.
 */

const { adminGraphql } = require('./shopify');

// Only the collections a listing page actually serves — Material's top-level
// categories. Reordering every collection in the store would be slow and mostly
// pointless, since most are never browsed as a page and products overlap.
//
// `wood` and `hardware` do not exist as collections at all, and `stone` holds one
// product. That is deliberate, not drift: a handle that does not resolve costs one
// skipped iteration and starts working the day someone creates the collection, so
// listing it up front is cheaper than remembering to add it later. The risk is that
// "deliberate" and "forgotten" look identical from here — which is why
// GET /api/collections/health reports these handles as declared-but-absent instead
// of leaving them silent. Same list in lib/productSignalsSync.js.
const NAV_CATEGORIES = [
  'tiles', 'laminates', 'wallpaper', 'stone', 'wood', 'hardware',
];

const MOVE_CHUNK = 250;   // Shopify's cap per collectionReorderProducts call
const PAGE = 250;

/**
 * Order every listing collection by relevance_score, highest first.
 *
 * @param opts.gql     (query, variables) => data — adminGraphql by default.
 *                     It returns `data` directly and throws, so nothing below
 *                     unwraps `.data`; userErrors are still checked, because
 *                     Shopify refuses work with a 200.
 * @param opts.handles override the collection list (used by tests)
 * @param opts.dryRun  compute the order and report, write nothing
 */
async function reorderCollections({ handles = NAV_CATEGORIES, dryRun = true, gql = adminGraphql, log = console } = {}) {
  const results = [];

  for (const handle of handles) {
    try {
      const info = await loadCollection(gql, handle);
      if (!info) { results.push({ handle, skipped: 'no such collection' }); continue; }

      // A SMART collection cannot be manually ordered: Shopify computes its
      // membership from its ruleSet, so there is no stored position to move.
      //
      // Checked BEFORE the product count and before the write, because it is a
      // permanent property of the collection rather than a today-fact. The schema
      // accepts both `collectionUpdate(sortOrder: MANUAL)` and
      // `collectionReorderProducts` against a smart collection, so introspection
      // cannot settle this — it comes back as a userErrors entry at run time, which
      // the code below does handle but which reads as a FAILURE in the nightly log.
      // Skipping with a reason says the true thing: nothing is wrong, this
      // collection is simply not orderable.
      //
      // This matters at Material right now: `tiles` is smart (rule TYPE EQUALS
      // "Floor tiles") and is the ONLY collection with more than one product, so
      // before this check the job attempted its one meaningful reorder every night
      // and recorded an error every night.
      if (info.smart) {
        results.push({ handle, products: info.products.length, skipped: 'smart collection — automated collections do not support manual ordering' });
        continue;
      }

      if (info.products.length < 2) { results.push({ handle, skipped: 'fewer than 2 products' }); continue; }

      // Highest score first; ties by newest, so a product with no signal yet is
      // not buried purely for being added late — the same rule a request-time
      // sort would use.
      const ranked = [...info.products].sort((a, b) =>
        (b.score - a.score) || (b.createdAt - a.createdAt));

      const alreadyInOrder = ranked.every((p, i) => p.id === info.products[i].id);
      if (alreadyInOrder && info.sortOrder === 'MANUAL') {
        results.push({ handle, products: ranked.length, unchanged: true });
        continue;
      }

      if (dryRun) {
        results.push({
          handle, products: ranked.length, wouldReorder: true,
          sortOrder: info.sortOrder,
          top: ranked.slice(0, 3).map((p) => `${p.title.slice(0, 24)}(${p.score})`),
        });
        continue;
      }

      // An order can only be imposed on a manually-sorted collection.
      // FORWARD BREAK (noted, not coded for): 2026-07 renames this argument from
      // `input:` to `collection:` with a new input type. This line and
      // lib/collections.js's collectionCreate are where that lands.
      if (info.sortOrder !== 'MANUAL') {
        const upd = await gql(
          `mutation($id:ID!){ collectionUpdate(input:{id:$id, sortOrder:MANUAL}){ userErrors{ message } } }`,
          { id: info.id });
        const ue = upd.collectionUpdate?.userErrors || [];
        if (ue.length) { results.push({ handle, error: ue.map((e) => e.message).join('; ') }); continue; }
      }

      const moves = ranked.map((p, i) => ({ id: p.id, newPosition: String(i) }));
      let failed = null;
      for (let i = 0; i < moves.length && !failed; i += MOVE_CHUNK) {
        const r = await gql(
          `mutation($id:ID!,$moves:[MoveInput!]!){
             collectionReorderProducts(id:$id, moves:$moves){ job{ id } userErrors{ message } } }`,
          { id: info.id, moves: moves.slice(i, i + MOVE_CHUNK) });
        const errs = r.collectionReorderProducts?.userErrors || [];
        if (errs.length) failed = errs.map((e) => e.message).join('; ');
      }

      results.push(failed
        ? { handle, error: failed }
        : {
            handle, products: ranked.length, reordered: true,
            top: ranked.slice(0, 3).map((p) => `${p.title.slice(0, 24)}(${p.score})`),
          });
    } catch (e) {
      results.push({ handle, error: e.message });
    }
  }

  const summary = {
    dryRun,
    collections: results.length,
    reordered: results.filter((r) => r.reordered || r.wouldReorder).length,
    unchanged: results.filter((r) => r.unchanged).length,
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => r.error).length,
  };
  log.info?.({ summary }, '[reorder] done');
  return { ...summary, results };
}

/**
 * A collection and its products, scored.
 *
 * Looked up with collections(query:"handle:…") rather than the source's
 * collectionByHandle, which Shopify deprecated and this service is pinned to a
 * much newer API version. The handle is compared back exactly, because the
 * search index matches loosely.
 */
async function loadCollection(gql, handle) {
  // `ruleSet` is how you tell a smart collection from a manual one — Shopify exposes
  // no boolean for it, and it is null on every manual collection.
  const found = await gql(
    `query($q:String!){ collections(first:5, query:$q){ nodes{ id handle sortOrder ruleSet{ appliedDisjunctively } } } }`,
    { q: `handle:${handle}` });
  const col = (found.collections?.nodes || []).find((c) => c.handle === handle);
  if (!col) return null;

  const products = [];
  let after = null;
  for (let i = 0; i < 12; i++) {
    const r = await gql(`
      query($id:ID!,$a:String){ collection(id:$id){ products(first:${PAGE}, after:$a){
        edges{ cursor node{ id title createdAt
          metafield(namespace:"custom",key:"relevance_score"){ value } } }
        pageInfo{ hasNextPage endCursor } } } }`, { id: col.id, a: after });
    const conn = r.collection?.products;
    if (!conn) break;
    for (const { node } of conn.edges) {
      products.push({
        id: node.id,
        title: node.title || '',
        score: Number(node.metafield?.value || 0) || 0,
        createdAt: Date.parse(node.createdAt || '') || 0,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { id: col.id, sortOrder: col.sortOrder, smart: Boolean(col.ruleSet), products };
}

module.exports = { reorderCollections, NAV_CATEGORIES };
