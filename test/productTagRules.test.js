'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RULES, percentileOf, assignTags } = require('../lib/productTagRules');

const product = (o) => ({
  productId: o.productId, category: o.category || null, score: o.score || 0,
  purchases: o.purchases || 0, recentViews: o.recentViews || 0, priorViews: o.priorViews || 0,
  recentDays: 14, priorDays: 14,
});

test('percentileOf takes the value at the percentile, not an interpolation', () => {
  assert.equal(percentileOf([], 0.9), 0);
  assert.equal(percentileOf([5], 0.9), 5);
  assert.equal(percentileOf([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(percentileOf([50, 10, 30, 20, 40], 0.5), 30); // sorts first
});

test('Popular is judged inside a category, so a quiet one can still earn it', () => {
  const tags = assignTags([
    ...[100, 200, 300, 400, 500].map((score, i) => product({ productId: `tile${i}`, category: 'tiles', score })),
    ...[12, 14].map((score, i) => product({ productId: `wall${i}`, category: 'wallpaper', score })),
  ]);
  // Top of Tiles only — 400 loses to its own category's cut despite outscoring
  // every wallpaper by 20x.
  assert.deepEqual(tags.get('tile4'), ['popular']);
  assert.equal(tags.get('tile3'), undefined);
  // Judged globally this could never happen, and Wallpaper would be badgeless
  // forever.
  assert.deepEqual(tags.get('wall1'), ['popular']);
});

test('the minScore floor stops a no-traffic category crowning a product', () => {
  const tags = assignTags([2, 3].map((score, i) => product({ productId: `stone${i}`, category: 'stone', score })));
  assert.ok(RULES.POPULAR.minScore > 3);
  assert.equal(tags.size, 0);
});

test('Trending is suppressed entirely until the prior window has history', () => {
  const surging = [
    product({ productId: 'a', category: 'tiles', score: 500, recentViews: 100 }),
    product({ productId: 'b', category: 'tiles', score: 400, recentViews: 90 }),
  ];
  // No prior views anywhere: "no history" must not read as "brand new", or every
  // product already tagged Popular gets a second, identical badge.
  for (const [, list] of assignTags(surging)) assert.ok(!list.includes('trending'));

  // One product with prior traffic switches the rule on for the whole run.
  const withHistory = [
    product({ productId: 'a', category: 'tiles', score: 500, recentViews: 100, priorViews: 10 }),
    product({ productId: 'b', category: 'tiles', score: 400, recentViews: 100, priorViews: 100 }),
  ];
  const tags = assignTags(withHistory);
  assert.ok(tags.get('a').includes('trending'));            // 10x its own earlier rate
  assert.ok(!(tags.get('b') || []).includes('trending'));   // busy, but flat — that is Popular's job
});

test('Bestseller is global, purchase-only, and floored', () => {
  const tags = assignTags([
    product({ productId: 'a', category: 'tiles', score: 900, purchases: 0 }),      // views alone never buy the badge
    product({ productId: 'b', category: 'tiles', score: 10, purchases: 5 }),
    product({ productId: 'c', category: 'wallpaper', score: 10, purchases: 5 }),   // quiet category, still qualifies
    product({ productId: 'd', category: 'tiles', score: 10, purchases: 1 }),       // below the 3-purchase floor
  ]);
  assert.ok(!(tags.get('a') || []).includes('bestseller'));
  assert.ok(tags.get('b').includes('bestseller'));
  assert.ok(tags.get('c').includes('bestseller'));
  assert.ok(!(tags.get('d') || []).includes('bestseller'));
});
