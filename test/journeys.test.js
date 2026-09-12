'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const journeys = require('../lib/journeys');
const { JOURNEYS, byId, plan, touchFor, windowFor, dedupeKey, HOUR } = journeys;

// Fixed clock. Every assertion below is relative to it, so nothing depends on
// when the suite runs.
const NOW = Date.parse('2026-03-15T12:00:00.000Z');
const ago = (hours) => new Date(NOW - hours * HOUR);

// ─────────────────────────────────────────────────────────────────────────────
// The structural guarantee: a preview cannot send, because the file the preview
// path reaches has no transport to reach for. If someone wires a send into
// journeys.js, this fails before it can ship.
// ─────────────────────────────────────────────────────────────────────────────
test('lib/journeys.js imports no transport, so no preview path can send', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'lib', 'journeys.js'), 'utf8');
  // Comments in that file discuss require() by name; scan the code, not the prose.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, [], 'journeys.js must require nothing at all');
  assert.ok(!/\bfetch\s*\(/.test(src), 'journeys.js must not call fetch');
});

test('requiring the route module sends nothing and starts nothing', () => {
  const marketing = require('../routes/marketing');
  assert.strictEqual(typeof marketing, 'function', 'route module is a fastify plugin');
  // run/deliver exist but demand a db, journey and logger — no ambient defaults.
  assert.strictEqual(marketing.run.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Journey data sanity
// ─────────────────────────────────────────────────────────────────────────────
test('journey ids are unique', () => {
  const ids = JOURNEYS.map((j) => j.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('every disabled journey explains what blocks it', () => {
  for (const j of JOURNEYS.filter((x) => !x.enabled)) {
    assert.ok(j.blockedBy && j.blockedBy.length > 20, `${j.id} needs a blockedBy`);
  }
});

test('the B2B journeys are gone', () => {
  const ids = JOURNEYS.map((j) => j.id).join(',');
  for (const dropped of ['quotation', 'visit', 'technician']) {
    assert.ok(!ids.includes(dropped), `${dropped} should not survive the port`);
  }
});

test('sample_followup is present but disabled — no purchase exists to trigger on', () => {
  const j = byId('sample_followup');
  assert.strictEqual(j.enabled, false);
  assert.throws(() => j.filter(NOW), /disabled/);
});

test('transactional journeys ignore marketing consent, marketing ones require it', () => {
  assert.strictEqual(byId('order_confirmation').requiresConsent, false);
  assert.strictEqual(byId('abandoned_cart').requiresConsent, true);
  assert.strictEqual(byId('review_request').requiresConsent, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Due-set timing
// ─────────────────────────────────────────────────────────────────────────────
test('single-touch journey: nothing before the delay, one touch inside the window', () => {
  const j = byId('abandoned_cart'); // delay 4h, window 44h

  assert.strictEqual(touchFor(j, ago(1), NOW), -1, 'too fresh — still shopping');
  assert.strictEqual(touchFor(j, ago(3.9), NOW), -1, 'just inside the delay');
  assert.strictEqual(touchFor(j, ago(5), NOW), 0, 'due');
  assert.strictEqual(touchFor(j, ago(47), NOW), 0, 'still inside the window');
  assert.strictEqual(touchFor(j, ago(49), NOW), -1, 'too old — do not chase');
});

test('review_request reproduces the ported 20h cadence, capped at 3 touches', () => {
  const j = byId('review_request'); // delay 240h (10d), interval 20h, max 3

  assert.strictEqual(touchFor(j, ago(239), NOW), -1, 'before the 10-day delay');
  assert.strictEqual(touchFor(j, ago(240), NOW), 0, 'first ask');
  assert.strictEqual(touchFor(j, ago(261), NOW), 1, 'first reminder, 20h later');
  assert.strictEqual(touchFor(j, ago(281), NOW), 2, 'second reminder');
  assert.strictEqual(touchFor(j, ago(301), NOW), -1, 'capped — 3 touches total, then silence');
});

test('the due window is bounded on BOTH sides', () => {
  for (const j of JOURNEYS.filter((x) => x.enabled)) {
    const { from, to } = windowFor(j, NOW);
    assert.ok(from instanceof Date && to instanceof Date, `${j.id} window is dates`);
    assert.ok(from < to, `${j.id} window is non-empty`);
    assert.ok(to.getTime() <= NOW, `${j.id} never selects the future`);
  }
});

test('window and touchFor agree — anything the query returns yields a touch', () => {
  const j = byId('review_request');
  const { from, to } = windowFor(j, NOW);
  assert.ok(touchFor(j, to, NOW) >= 0, 'newest row in the window is due');
  assert.ok(touchFor(j, new Date(from.getTime() + 1000), NOW) >= 0, 'oldest row in the window is due');
  assert.strictEqual(touchFor(j, new Date(from.getTime() - HOUR), NOW), -1, 'just outside is not');
});

// ─────────────────────────────────────────────────────────────────────────────
// Query shape — the abandoned-cart filter is the one with real subtlety
// ─────────────────────────────────────────────────────────────────────────────
test('abandoned_cart selects unpaid checkouts, not the carts pointer collection', () => {
  const j = byId('abandoned_cart');
  assert.strictEqual(j.collection, 'orders', 'carts holds no line items and its updatedAt means last login');

  const f = j.filter(NOW);
  assert.strictEqual(f.status, 'PENDING');
  assert.deepStrictEqual(f.razorpayPaymentId, { $exists: false }, 'must exclude anyone who paid');
  assert.deepStrictEqual(f.createdAt, { $gte: ago(48), $lte: ago(4) });
});

test('order_confirmation and review_request select paid orders only', () => {
  for (const id of ['order_confirmation', 'review_request']) {
    const f = byId(id).filter(NOW);
    assert.deepStrictEqual(f.status, { $in: ['PAID', 'ADVANCE_PAID'] });
    assert.ok(f.paidAt.$gte instanceof Date && f.paidAt.$lte instanceof Date);
  }
});

test('abandoned_cart suppresses carts that later converted', async () => {
  const j = byId('abandoned_cart');
  const docs = [
    { _id: 'a', cartId: 'gid://shopify/Cart/1' },
    { _id: 'b', cartId: 'gid://shopify/Cart/2' },
  ];
  // Minimal db stub: cart 2 has a paid order, cart 1 does not.
  const db = {
    collection: () => ({
      find: () => ({ toArray: async () => [{ cartId: 'gid://shopify/Cart/2' }] }),
    }),
  };

  const suppressed = await j.suppress(db, docs);
  assert.ok(!suppressed.has('a'), 'never bought — still chase');
  assert.ok(suppressed.has('b'), 'already bought — do not chase');
});

// ─────────────────────────────────────────────────────────────────────────────
// Dedupe
// ─────────────────────────────────────────────────────────────────────────────
test('the dedupe key is stable per touch and distinct across touches', () => {
  const j = byId('review_request');
  const doc = { _id: 'order1' };
  assert.strictEqual(dedupeKey(j, doc, 0), dedupeKey(j, doc, 0), 'stable across runs');
  assert.notStrictEqual(dedupeKey(j, doc, 0), dedupeKey(j, doc, 1), 'reminder 1 is its own message');
  assert.notStrictEqual(dedupeKey(j, doc, 0), dedupeKey(byId('abandoned_cart'), doc, 0), 'scoped per journey');
});

test('the Klaviyo idempotency key IS the sent-log key', () => {
  const p = plan(byId('review_request'), { _id: 'o1', paidAt: ago(240), customerId: 'gid://shopify/Customer/1' }, NOW);
  assert.strictEqual(p.uniqueId, p.key, 'so a raced retry is dropped downstream too');
});

test('re-running over the same due set sends nothing the second time', () => {
  const j = byId('abandoned_cart');
  const docs = [
    { _id: 'o1', createdAt: ago(6), cartId: 'c1', orderTotal: 12000, customerId: 'cust1' },
    { _id: 'o2', createdAt: ago(20), cartId: 'c2', orderTotal: 4500, customerId: 'cust2' },
  ];

  // The sent-log, modelled as the unique _id index it actually is.
  const sentLog = new Set();
  const runOnce = () => {
    let sent = 0;
    for (const doc of docs) {
      const p = plan(j, doc, NOW);
      if (!p) continue;
      if (sentLog.has(p.key)) continue; // the claim loses → skip
      sentLog.add(p.key); // the claim wins → this run owns the send
      sent++;
    }
    return sent;
  };

  assert.strictEqual(runOnce(), 2, 'first run sends to both');
  assert.strictEqual(runOnce(), 0, 'retry sends to nobody');
  assert.strictEqual(runOnce(), 0, 'and stays that way');
  assert.strictEqual(sentLog.size, 2);
});

test('a later touch is a new claim, so reminders still go out after the first ask', () => {
  const j = byId('review_request');
  const doc = { _id: 'o1', paidAt: ago(240), customerId: 'c1' };
  const sentLog = new Set([plan(j, doc, NOW).key]); // first ask already sent

  // 20 hours later the same order is due again, under a different key.
  const later = plan(j, doc, NOW + 21 * HOUR);
  assert.strictEqual(later.touch, 1);
  assert.ok(!sentLog.has(later.key), 'reminder is not blocked by the original ask');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
test('plan returns null when the anchor timestamp is missing', () => {
  const j = byId('order_confirmation');
  assert.strictEqual(plan(j, { _id: 'o1', paidAt: null }, NOW), null, 'unpaid order has no paidAt');
  assert.strictEqual(plan(j, { _id: 'o1' }, NOW), null);
});

test('plan carries the journey and touch into the event properties', () => {
  const p = plan(byId('order_confirmation'), {
    _id: 'o1',
    paidAt: ago(1),
    customerId: 'gid://shopify/Customer/9',
    shopifyOrderName: '#1001',
    orderTotal: 48500,
    balanceDue: 0,
    paymentMode: 'full',
  }, NOW);

  assert.strictEqual(p.properties.Journey, 'order_confirmation');
  assert.strictEqual(p.properties.Touch, 0);
  assert.strictEqual(p.properties.OrderName, '#1001');
  assert.strictEqual(p.value, 48500);
  assert.strictEqual(p.customerId, 'gid://shopify/Customer/9');
});

test('WhatsApp body params are ordered strings — Meta rejects a count mismatch', () => {
  const p = plan(byId('order_confirmation'), {
    _id: 'o1', paidAt: ago(1), customerId: 'c1', shopifyOrderName: '#1001', orderTotal: 48500,
  }, NOW);

  assert.ok(Array.isArray(p.bodyParams));
  assert.ok(p.bodyParams.every((x) => typeof x === 'string'), 'every {{n}} must be a string');
  assert.deepStrictEqual(p.bodyParams, ['#1001', '₹48,500']);
});

test('money renders in Indian digit grouping', () => {
  const p = plan(byId('abandoned_cart'), { _id: 'o1', createdAt: ago(6), cartId: 'c1', orderTotal: 1250000 }, NOW);
  assert.deepStrictEqual(p.bodyParams, ['₹12,50,000'], 'lakh grouping, not 1,250,000');
});
