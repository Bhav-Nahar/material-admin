'use strict';

/**
 * productSignals.js — per-product funnel metrics from GA4, via BigQuery.
 *
 * Feeds two things that are otherwise guesswork:
 *   - automated product tags (Trending / Popular / Bestseller)
 *   - the "Relevance" PLP sort, which otherwise ranks nothing at all
 *
 * ── The one thing that will surprise you ─────────────────────────────────────
 * GA4's `item_id` is a VARIANT id, not a product id. Verified against Shopify on
 * the store this was first built for: 10 of 10 sampled ids resolved as
 * ProductVariant, 0 as Product. Material's surfaces carry several variants each
 * (size, finish, thickness), so counting item_id directly splits one product's
 * demand across its variants and makes everything look less popular than it is.
 * Every number below is rolled up to the product.
 *
 * ── On the weights ──────────────────────────────────────────────────────────
 * Each step down the funnel is roughly two orders of magnitude rarer than the
 * one above it — measured on the store this came from: ~10,300 view_item, 88
 * add_to_cart, 25 begin_checkout, 6 purchase over six days. So an unweighted sum
 * is just a view count. The weights below are deliberately close to those
 * ratios: one add-to-cart is worth many views because it is many times rarer AND
 * much closer to money.
 *
 * For Material these are a starting point, not a measurement — there is no
 * funnel to measure yet. They are the main lever on what the sort feels like;
 * re-check them once GA4 holds a few weeks of real traffic.
 *
 * ── On order volume, stated plainly ─────────────────────────────────────────
 * Material's catalogue is ~1 product with effectively no order history.
 * Purchase-driven ranking cannot work at that volume and no amount of code
 * changes that. The formula still carries a purchase term, at its proper weight,
 * so the moment volume arrives it starts counting without anyone rebuilding
 * anything. Until then it contributes ~nothing, which is the honest outcome
 * rather than a fake one.
 */

// Funnel weights. Ordered by how rare and how close to revenue each step is.
const WEIGHTS = {
  view: 1,
  cart: 8,
  checkout: 20,
  purchase: 50,
};

/**
 * `project.dataset` for the GA4 export, from the environment.
 *
 * There is deliberately NO default. The source hardcoded one store's dataset,
 * and a hardcoded value that survives a copy-paste into another service queries
 * SOMEBODY ELSE'S analytics: numbers come back, they are just not ours, and
 * nothing about the output looks wrong. Unset is a hard error instead.
 *
 * Read per call rather than at module load, so a test or a script can set the
 * env after requiring this file.
 */
function datasetRef() {
  const { GCP_PROJECT_ID, GA4_DATASET } = process.env;
  if (!GCP_PROJECT_ID || !GA4_DATASET) {
    throw new Error(
      'GCP_PROJECT_ID and GA4_DATASET must both be set (see .env.example) — refusing to query a guessed GA4 dataset',
    );
  }
  return `${GCP_PROJECT_ID}.${GA4_DATASET}`;
}

/**
 * Per-VARIANT funnel counts for a window, straight from the GA4 export.
 *
 * `events_*` spans the daily tables; the wildcard also matches
 * `events_intraday_*`, which holds a partial day and would make "today" look
 * like a collapse in demand — so it is excluded and the window is whole days.
 *
 * The day boundary is Asia/Kolkata: Material sells in India, so "yesterday" has
 * to mean yesterday to the shopper, not to UTC.
 *
 * @param bq   an @google-cloud/bigquery client
 * @param days how far back to look
 */
async function fetchVariantSignals(bq, { days = 28 } = {}) {
  const query = `
    SELECT
      i.item_id AS variant_id,
      ANY_VALUE(i.item_name) AS item_name,
      COUNTIF(event_name = 'view_item')      AS views,
      COUNTIF(event_name = 'add_to_cart')    AS carts,
      COUNTIF(event_name = 'begin_checkout') AS checkouts,
      COUNTIF(event_name = 'purchase')       AS purchases
    FROM \`${datasetRef()}.events_*\`, UNNEST(items) i
    WHERE _TABLE_SUFFIX NOT LIKE '%intraday%'
      AND PARSE_DATE('%Y%m%d', _TABLE_SUFFIX)
          >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL @days DAY)
      AND event_name IN ('view_item','add_to_cart','begin_checkout','purchase')
      AND i.item_id IS NOT NULL
    GROUP BY variant_id
  `;
  const [rows] = await bq.query({ query, params: { days } });
  return rows.map((r) => ({
    variantId: String(r.variant_id),
    itemName: r.item_name || '',
    views: Number(r.views || 0),
    carts: Number(r.carts || 0),
    checkouts: Number(r.checkouts || 0),
    purchases: Number(r.purchases || 0),
  }));
}

/**
 * Variant counts → product counts.
 *
 * `variantToProduct` maps variant id → product id. A variant we cannot map is
 * DROPPED rather than guessed at: attributing a view to the wrong product is
 * worse than not counting it, because it silently promotes something.
 * The caller gets the unmapped ids back so the gap stays visible.
 */
function rollupToProducts(variantRows, variantToProduct) {
  const byProduct = new Map();
  const unmapped = [];

  for (const r of variantRows) {
    const productId = variantToProduct.get(r.variantId);
    if (!productId) {
      unmapped.push(r);
      continue;
    }

    const acc = byProduct.get(productId) || {
      productId, views: 0, carts: 0, checkouts: 0, purchases: 0, variants: 0,
    };
    acc.views += r.views;
    acc.carts += r.carts;
    acc.checkouts += r.checkouts;
    acc.purchases += r.purchases;
    acc.variants += 1;
    byProduct.set(productId, acc);
  }

  return { products: [...byProduct.values()], unmapped };
}

/** Weighted funnel score for one product. */
function scoreOf(p) {
  return p.views * WEIGHTS.view
    + p.carts * WEIGHTS.cart
    + p.checkouts * WEIGHTS.checkout
    + p.purchases * WEIGHTS.purchase;
}

module.exports = { WEIGHTS, datasetRef, fetchVariantSignals, rollupToProducts, scoreOf };
