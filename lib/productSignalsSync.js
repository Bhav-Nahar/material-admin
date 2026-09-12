'use strict';

/**
 * productSignalsSync.js — run the whole pipeline and write the result back.
 *
 *   GA4 (BigQuery) → variant rollup → score → tags → Shopify
 *
 * Output goes to two different places, because they are read by different
 * things:
 *
 *   custom.relevance_score   metafield  — what the PLP sorts on
 *   native Shopify tags      product    — the badges a shopper sees
 *
 * The badges MUST be native tags. The storefront resolves a product's badge from
 * `product.tags`, which is what the Storefront API returns on every product
 * query — it does not fetch a badge metafield. Writing the tags to a metafield
 * (the first version of this file did) computes everything correctly and shows
 * nobody anything.
 *
 * ── Never clobber a human ───────────────────────────────────────────────────
 * productUpdate(tags:) REPLACES the entire tag list, so one nightly run would
 * erase every manually-set tag in the catalogue. This uses tagsAdd/tagsRemove
 * instead, which are additive and subtractive, and it only ever touches the
 * three tags in MANAGED_TAGS. Everything else on a product is untouchable by
 * this job, by construction rather than by care.
 *
 * dryRun defaults to TRUE. Writing across a whole catalogue on the strength of
 * an untested weighting is not something that should be one typo away. The route
 * layer opts in; only the cron entrypoint applies unconditionally.
 */

const { BigQuery } = require('@google-cloud/bigquery');
const { adminGraphql } = require('./shopify');
const signals = require('./productSignals');
const { assignTags } = require('./productTagRules');

const SCORE_KEY = 'relevance_score';
const NAMESPACE = 'custom';

// The only tags this job may touch. Anything outside this list belongs to a
// human and is never added or removed here. The storefront picks the FIRST
// config match — bestseller > popular > trending — so a product that earns
// several shows the strongest.
const MANAGED_TAGS = ['bestseller', 'popular', 'trending'];

// Material's top-level storefront categories, as Shopify collection handles.
// Popular and Trending are judged within one of these rather than across the
// store — see productTagRules.
//
// stone / wood / hardware are declared but hold no products yet. They cost
// nothing here (a category with no products simply never produces a cut) and
// they start working the day the first product lands in one, with no code
// change — the same "written now, fires later" property as the Bestseller rule.
const NAV_CATEGORIES = new Set([
  'tiles', 'laminates', 'wallpaper', 'stone', 'wood', 'hardware',
]);

// `bestseller` is only REMOVED once there is enough purchase data to justify
// saying a product is not one. Below this, the tag is add-only and whatever a
// merchandiser set by hand stays put.
//
// Why: with no order signal the rule earns nothing, so an unguarded sync would
// strip every hand-set bestseller tag on its first run — deleting a deliberate
// human decision on the strength of data that cannot support the opposite claim.
// Material is squarely in that state today (~1 product, effectively no orders),
// so this guard is doing real work from the first run, not sitting idle. Popular
// and Trending have no such guard because they rest on view data, which is
// plentiful as soon as there is any traffic at all.
//
// 20 is a floor, not a real statistical bar: enough that "no purchases" means
// something about the product rather than about the store.
const MIN_PURCHASES_TO_JUDGE_BESTSELLER = 20;

// Shopify caps metafieldsSet at 25 per call.
const WRITE_CHUNK = 25;

/**
 * @param opts.gql (query, variables) => data — injectable so this file needs no
 *        credentials of its own and stays testable. Note that adminGraphql
 *        returns the `data` object DIRECTLY and throws on errors, so there is no
 *        `.data` to unwrap below; the userErrors checks still matter, because
 *        Shopify reports "I refused to do that" with a 200.
 */
async function syncProductSignals({ days = 28, dryRun = true, gql = adminGraphql, bq, log = console } = {}) {
  const recentDays = Math.max(1, Math.round(days / 2));
  const priorDays = days - recentDays;
  const client = bq || new BigQuery({ projectId: process.env.GCP_PROJECT_ID });

  const [all, recent, catalogue] = await Promise.all([
    signals.fetchVariantSignals(client, { days }),
    signals.fetchVariantSignals(client, { days: recentDays }),
    loadCatalogue(gql),
  ]);

  const rolled = signals.rollupToProducts(all, catalogue.variantToProduct);
  const rolledRecent = signals.rollupToProducts(recent, catalogue.variantToProduct);
  const recentById = new Map(rolledRecent.products.map((p) => [p.productId, p]));

  const scored = rolled.products.map((p) => ({
    ...p,
    score: signals.scoreOf(p),
    recentViews: recentById.get(p.productId)?.views || 0,
    priorViews: Math.max(0, p.views - (recentById.get(p.productId)?.views || 0)),
    recentDays,
    priorDays,
    category: catalogue.categoryByProduct.get(p.productId) || null,
  }));

  const tags = assignTags(scored);

  // Every ACTIVE product gets a score written, including the ones with no
  // traffic — they score 0. Writing only the products with data would leave the
  // rest holding a stale score from a previous run, which is worse than a known
  // zero: a product that stopped selling would keep its old rank.
  const scoreById = new Map(scored.map((p) => [p.productId, p.score]));
  const metafields = catalogue.productIds.map((productId) => ({
    ownerId: `gid://shopify/Product/${productId}`,
    namespace: NAMESPACE,
    key: SCORE_KEY,
    type: 'number_integer',
    value: String(Math.round(scoreById.get(productId) || 0)),
  }));

  // Tag deltas. Only products whose managed tags actually CHANGE are touched —
  // on a steady catalogue that is a handful per night rather than one API call
  // per product, and it keeps `updatedAt` meaningful for everything else.
  const totalPurchases = scored.reduce((s, p) => s + p.purchases, 0);
  const mayJudgeBestseller = totalPurchases >= MIN_PURCHASES_TO_JUDGE_BESTSELLER;

  const tagOps = [];
  for (const productId of catalogue.productIds) {
    const current = catalogue.tagsByProduct.get(productId) || [];
    const currentManaged = current.filter((t) => MANAGED_TAGS.includes(t.toLowerCase()));
    const desired = tags.get(productId) || [];

    const add = desired.filter((t) => !currentManaged.includes(t));
    let remove = currentManaged.filter((t) => !desired.includes(t));
    // Add-only for bestseller until the data can support taking it away.
    if (!mayJudgeBestseller) remove = remove.filter((t) => t !== 'bestseller');

    if (add.length || remove.length) tagOps.push({ productId, add, remove });
  }

  const summary = {
    days, recentDays, priorDays,
    catalogueProducts: catalogue.productIds.length,
    productsWithSignal: scored.length,
    productsWithoutSignal: catalogue.productIds.length - scored.length,
    unmappedVariants: rolled.unmapped.length,
    unmappedViews: rolled.unmapped.reduce((s, r) => s + r.views, 0),
    tagCounts: countTags(tags),
    totalPurchases,
    bestsellerRemovalEnabled: mayJudgeBestseller,
    scoreWrites: metafields.length,
    tagChanges: tagOps.length,
    tagsToAdd: tagOps.reduce((s, o) => s + o.add.length, 0),
    tagsToRemove: tagOps.reduce((s, o) => s + o.remove.length, 0),
    dryRun,
  };

  if (dryRun) {
    log.info?.({ summary }, '[signals] DRY RUN — nothing written');
    return { ...summary, written: 0, taggedProducts: 0, errors: [] };
  }

  let written = 0;
  const errors = [];
  for (let i = 0; i < metafields.length; i += WRITE_CHUNK) {
    const chunk = metafields.slice(i, i + WRITE_CHUNK);
    try {
      const res = await gql(`
        mutation($mf: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $mf) { userErrors { field message } }
        }`, { mf: chunk });
      const errs = res.metafieldsSet?.userErrors || [];
      if (errs.length) errors.push(...errs.map((e) => e.message));
      else written += chunk.length;
    } catch (e) {
      errors.push(e.message);
    }
  }

  // Remove before add, so a product moving between tags is never briefly
  // wearing both.
  let taggedProducts = 0;
  for (const op of tagOps) {
    const id = `gid://shopify/Product/${op.productId}`;
    try {
      if (op.remove.length) {
        const r = await gql(
          `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
          { id, tags: op.remove });
        (r.tagsRemove?.userErrors || []).forEach((e) => errors.push(e.message));
      }
      if (op.add.length) {
        const r = await gql(
          `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { id, tags: op.add });
        (r.tagsAdd?.userErrors || []).forEach((e) => errors.push(e.message));
      }
      taggedProducts++;
    } catch (e) {
      errors.push(`${op.productId}: ${e.message}`);
    }
  }

  log.info?.({ ...summary, written, taggedProducts, errors: errors.length }, '[signals] sync complete');
  return { ...summary, written, taggedProducts, errors };
}

/**
 * Active products, their variants (so GA4's variant ids can be rolled up) and
 * their CURRENT tags (so the delta only touches what actually changed).
 *
 * The page cap is a runaway guard, not a catalogue estimate — 25 pages of 100 is
 * far past anything Material will hold for a long time.
 */
async function loadCatalogue(gql) {
  const variantToProduct = new Map();
  const tagsByProduct = new Map();
  const categoryByProduct = new Map();
  const productIds = [];
  let after = null;
  for (let page = 0; page < 25; page++) {
    const res = await gql(`
      query($a: String) {
        products(first: 100, after: $a, query: "status:active") {
          edges { cursor node {
            id tags
            collections(first: 25) { nodes { handle } }
            variants(first: 100) { nodes { id } }
          } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { a: after });
    const conn = res.products;
    if (!conn) break;
    for (const { node } of conn.edges) {
      const pid = node.id.replace('gid://shopify/Product/', '');
      productIds.push(pid);
      tagsByProduct.set(pid, node.tags || []);
      // Which top-level category a product belongs to, so Popular can be judged
      // against its own kind. A product in none of them falls into one shared
      // bucket, which is honest: we cannot say what it is popular among.
      const handles = (node.collections?.nodes || []).map((c) => c.handle);
      categoryByProduct.set(pid, handles.find((h) => NAV_CATEGORIES.has(h)) || null);
      for (const v of node.variants.nodes) {
        variantToProduct.set(v.id.replace('gid://shopify/ProductVariant/', ''), pid);
      }
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { variantToProduct, tagsByProduct, categoryByProduct, productIds };
}

function countTags(tags) {
  const counts = {};
  for (const list of tags.values()) for (const t of list) counts[t] = (counts[t] || 0) + 1;
  return counts;
}

module.exports = { syncProductSignals, SCORE_KEY, NAMESPACE, MANAGED_TAGS, NAV_CATEGORIES };
