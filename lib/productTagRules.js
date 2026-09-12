'use strict';

/**
 * productTagRules.js — turns funnel numbers into the badges a shopper sees.
 *
 * Tags are otherwise typed in by hand: someone decides a product is a
 * "Bestseller" and it stays one forever. These rules derive them from behaviour
 * instead, so they change as the catalogue does.
 *
 * ── Why the thresholds are relative, not absolute ───────────────────────────
 * "Bestseller = 50 orders" would tag nothing today and everything in two years.
 * Every rule below is a PERCENTILE of the current catalogue, so it keeps
 * labelling roughly the same slice as volume grows and nobody has to revisit the
 * numbers. This matters more for Material than it did for the store this came
 * from: with ~1 product live and Tiles / Laminates / Wallpaper only starting to
 * fill, any absolute number picked today is wrong by next quarter. The absolute
 * MIN_* floors exist only to stop a near-empty catalogue from crowning a product
 * with two views.
 *
 * ── The rule that will not fire yet, deliberately ───────────────────────────
 * BESTSELLER needs real orders. Material has effectively none, so today it tags
 * nothing — correctly. It is written now so that the day order volume arrives it
 * starts working with no code change. A "Bestseller" badge driven by page views
 * would be a lie, and shoppers act on these badges.
 */

const RULES = {
  // Sustained demand: top of the catalogue by weighted funnel score.
  POPULAR: {
    tag: 'popular',
    label: 'Popular',
    percentile: 0.90,     // top 10% OF ITS OWN CATEGORY
    // A floor, not a bar. It only stops a category with almost no traffic from
    // crowning a product with two views — the per-category percentile does the
    // real work. Keep it low: set high enough to matter, it silently defeats the
    // whole per-category idea, because a quiet category (Wallpaper today) fails
    // the floor outright no matter where its own cut lands, and then only the
    // busy category can ever earn the badge.
    minScore: 10,
  },
  // Sharp recent interest — measured against the product's OWN earlier rate, so
  // a quiet product that suddenly moves qualifies and a permanently busy one
  // does not. Without that, Trending and Popular would name the same products
  // and one of them would be pointless.
  TRENDING: {
    tag: 'trending',
    label: 'Trending',
    minRecentViews: 25,
    minGrowth: 1.75,      // recent daily rate vs the preceding window
  },
  // Actually bought, repeatedly. Purchases only — never views.
  BESTSELLER: {
    tag: 'bestseller',
    label: 'Bestseller',
    percentile: 0.95,
    minPurchases: 3,
  },
};

/** Value at a percentile of a numeric list (0.9 = 90th). */
function percentileOf(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * Decide each product's tags.
 *
 * @param scored   [{ productId, category, score, purchases,
 *                    recentViews, priorViews, recentDays, priorDays }]
 * @returns Map productId → string[] of tag ids
 */
function assignTags(scored) {
  const out = new Map();
  if (scored.length === 0) return out;

  // Popular and Trending are judged WITHIN a category, not across the store.
  //
  // Judged globally they are useless the moment one category outweighs another,
  // which is exactly Material's shape: Tiles will carry far more traffic than
  // Wallpaper, so a store-wide top-10% cut lands inside Tiles and no wallpaper
  // or laminate could ever earn a badge however well it did among its own kind.
  // "Popular" has to mean popular among the things a shopper is actually looking
  // at — on a wallpaper listing, popular among wallpapers.
  //
  // Bestseller stays GLOBAL on purpose: it claims a product sells, and that
  // should not be grantable by being the least quiet product in a quiet
  // category.
  const byCategory = new Map();
  for (const p of scored) {
    const key = p.category || '(none)';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(p);
  }
  const scoreCutByCategory = new Map();
  for (const [key, list] of byCategory) {
    scoreCutByCategory.set(key, percentileOf(list.map((p) => p.score), RULES.POPULAR.percentile));
  }

  // A trend needs a BEFORE to compare against. A freshly-connected GA4 export
  // holds only a few days, so any window wider than that has an empty prior
  // half — and treating "no history" as "brand new" tags the entire top of the
  // catalogue Trending, the same products already tagged Popular. Two badges
  // naming one set is worse than one badge.
  //
  // So Trending is suppressed outright until the prior window actually has
  // traffic. It switches itself on once the export has enough history, with no
  // code change. Showing nothing is the honest answer to "what is trending?"
  // when we cannot yet know — and on a one-product store that is the answer for
  // a while.
  const priorHasHistory = scored.some((p) => p.priorViews > 0);

  // Only products with ANY purchase inform the bestseller cut — including the
  // zeroes would drag the 95th percentile to 0 and tag everything.
  const bought = scored.map((p) => p.purchases).filter((n) => n > 0);
  const buyCut = percentileOf(bought, RULES.BESTSELLER.percentile);

  for (const p of scored) {
    const tags = [];

    // Per-category cut, with the absolute floor still applied so a category
    // where nothing gets traffic cannot crown a product with two views.
    const cut = scoreCutByCategory.get(p.category || '(none)') ?? 0;
    if (p.score >= Math.max(cut, RULES.POPULAR.minScore)) tags.push(RULES.POPULAR.tag);

    if (p.purchases >= Math.max(buyCut, RULES.BESTSELLER.minPurchases)) {
      tags.push(RULES.BESTSELLER.tag);
    }

    // Rates, not totals — the two windows are usually different lengths.
    if (priorHasHistory) {
      const recentRate = p.recentDays > 0 ? p.recentViews / p.recentDays : 0;
      const priorRate = p.priorDays > 0 ? p.priorViews / p.priorDays : 0;
      // A product with no prior views but real recent ones is genuinely new
      // demand — that IS a trend, and only meaningful once the window as a whole
      // has history to be new against.
      const growing = priorRate > 0
        ? recentRate / priorRate >= RULES.TRENDING.minGrowth
        : true;
      if (p.recentViews >= RULES.TRENDING.minRecentViews && growing) {
        tags.push(RULES.TRENDING.tag);
      }
    }

    if (tags.length) out.set(p.productId, tags);
  }

  return out;
}

module.exports = { RULES, percentileOf, assignTags };
