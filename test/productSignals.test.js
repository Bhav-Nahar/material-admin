'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { WEIGHTS, datasetRef, rollupToProducts, scoreOf } = require('../lib/productSignals');

test('scoreOf weights the funnel, not just views', () => {
  const flat = { views: 100, carts: 0, checkouts: 0, purchases: 0 };
  const deep = { views: 10, carts: 5, checkouts: 2, purchases: 1 };
  assert.equal(scoreOf(flat), 100);
  assert.equal(scoreOf(deep), 10 + 5 * WEIGHTS.cart + 2 * WEIGHTS.checkout + WEIGHTS.purchase);
  // The whole point of the weights: a product people buy outranks one people
  // only look at, even with 10x fewer views.
  assert.ok(scoreOf(deep) > scoreOf(flat));
});

test('rollupToProducts sums a product\'s variants and drops what it cannot map', () => {
  const rows = [
    { variantId: 'v1', views: 10, carts: 1, checkouts: 0, purchases: 0 },
    { variantId: 'v2', views: 5, carts: 0, checkouts: 1, purchases: 1 },
    { variantId: 'ghost', views: 7, carts: 0, checkouts: 0, purchases: 0 },
  ];
  const { products, unmapped } = rollupToProducts(rows, new Map([['v1', 'p1'], ['v2', 'p1']]));

  assert.equal(products.length, 1);
  assert.deepEqual(products[0], {
    productId: 'p1', views: 15, carts: 1, checkouts: 1, purchases: 1, variants: 2,
  });
  // Never guessed at: an unmappable variant is reported, not attributed.
  assert.deepEqual(unmapped.map((r) => r.variantId), ['ghost']);
});

test('datasetRef refuses to guess a dataset', () => {
  const saved = { p: process.env.GCP_PROJECT_ID, d: process.env.GA4_DATASET };
  try {
    delete process.env.GCP_PROJECT_ID;
    process.env.GA4_DATASET = 'analytics_1';
    assert.throws(() => datasetRef(), /GCP_PROJECT_ID and GA4_DATASET/);

    process.env.GCP_PROJECT_ID = 'material';
    assert.equal(datasetRef(), 'material.analytics_1');
  } finally {
    if (saved.p === undefined) delete process.env.GCP_PROJECT_ID; else process.env.GCP_PROJECT_ID = saved.p;
    if (saved.d === undefined) delete process.env.GA4_DATASET; else process.env.GA4_DATASET = saved.d;
  }
});
