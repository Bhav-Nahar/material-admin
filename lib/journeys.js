'use strict';

/**
 * journeys.js — the D2C journey definitions, as DATA.
 *
 * ── THIS FILE CANNOT SEND ────────────────────────────────────────────────────
 * It requires no transport. There is no `require('./klaviyo')` and no
 * `require('./whatsapp')` below, and test/journeys.test.js asserts that stays
 * true. Everything here computes WHO is due and WHAT the message would say;
 * handing that to a network call is routes/marketing.js's job and happens only
 * in the cron path. That is the structural half of "a preview cannot send" —
 * the preview endpoint reaches only this file, so there is no flag to get wrong.
 *
 * ── What replaced the B2B journeys ───────────────────────────────────────────
 * glassquickdev's jobs were quotation follow-ups, site-visit reminders and
 * technician dispatch. Material has no quotations, no site visits and no
 * technicians, so none of them survived. What was worth porting is the SHAPE of
 * `visitReminderCron`: bounded due-set → atomic claim → send → record.
 *
 * ── Anchors are Mongo, not Shopify ───────────────────────────────────────────
 * material-backend has no order webhooks, so there is no fulfillment state in
 * Mongo to key on. Every journey below anchors on a timestamp that the payment
 * flow already writes to the `orders` collection.
 */

const HOUR = 3600 * 1000;

/**
 * Which touch (0-based) is due for a subject right now.
 *
 * Derived from elapsed time rather than counted from the sent-log, so it costs
 * no extra query and two concurrent runs compute the same number — the claim in
 * the runner is then what makes it exactly-once.
 *
 * Returns -1 when nothing is due (still inside the delay, or past the last touch).
 */
function touchFor(journey, anchor, now) {
  const elapsed = now - new Date(anchor).getTime() - journey.delayHours * HOUR;
  if (elapsed < 0) return -1;
  const interval = (journey.touchIntervalHours || 0) * HOUR;
  if (!interval) return elapsed <= journey.windowHours * HOUR ? 0 : -1;
  const touch = Math.floor(elapsed / interval);
  return touch < journey.maxTouches ? touch : -1;
}

/**
 * The bounded time window for a journey's due set.
 *
 * Both sides bounded, deliberately. The source scanned the whole collection and
 * filtered in memory, which silently capped at the 200 newest rows and could
 * never reach an older record. An upper bound also means switching a journey on
 * does not blast every historical order with a month-old "your order shipped".
 */
function windowFor(journey, now) {
  const span = journey.touchIntervalHours
    ? journey.maxTouches * journey.touchIntervalHours
    : journey.windowHours;
  return {
    from: new Date(now - journey.delayHours * HOUR - span * HOUR),
    to: new Date(now - journey.delayHours * HOUR),
  };
}

/** The sent-log _id. Unique per (journey, subject, touch) — this IS the dedupe. */
function dedupeKey(journey, doc, touch) {
  return `${journey.id}:${String(doc._id)}:${touch}`;
}

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// ─────────────────────────────────────────────────────────────────────────────
// The journeys.
//
// Each entry owns its own query and its own copy. The runner has no `switch` on
// journey.id — adding a journey means adding an object here, not a branch there.
//
// enabled:false entries are still listed by GET /journeys, with `blockedBy`
// saying what is missing. A journey that cannot fire says so out loud rather
// than being quietly absent.
// ─────────────────────────────────────────────────────────────────────────────
const JOURNEYS = [
  {
    id: 'abandoned_cart',
    label: 'Abandoned checkout',
    enabled: true,
    collection: 'orders',
    // Marketing, not transactional — honours the opt-out tag.
    requiresConsent: true,
    metric: 'Abandoned Checkout',
    waTemplate: 'material_abandoned_cart_v1',
    delayHours: 4,
    windowHours: 44,
    maxTouches: 1,
    anchor: 'createdAt',

    /**
     * NOT the `carts` collection. That holds only {customerId, cartId} and its
     * `updatedAt` is bumped at login, not on add-to-cart — a staleness window
     * on it would fire at everyone who logged in and never shopped.
     *
     * `orders` rows are written BEFORE payment (material-backend
     * routes/payment.js), so status PENDING with no razorpayPaymentId is a
     * genuine "reached Razorpay, did not pay" record, with a real timestamp.
     *
     * ponytail: this misses guest carts and Shopify hosted-checkout abandons,
     * which never reach Mongo. Upgrade path is a checkouts/create webhook,
     * which material-backend has no webhook route for at all today.
     */
    filter(now) {
      const { from, to } = windowFor(this, now);
      return {
        status: 'PENDING',
        razorpayPaymentId: { $exists: false },
        createdAt: { $gte: from, $lte: to },
      };
    },

    /**
     * Drop anyone who actually bought. The PENDING row is never flipped when a
     * customer retries and succeeds on a NEW razorpay order, so the same cart
     * can have both a stale PENDING row and a real PAID one.
     */
    async suppress(db, docs) {
      const cartIds = docs.map((d) => d.cartId).filter(Boolean);
      if (!cartIds.length) return new Set();
      const paid = await db
        .collection('orders')
        .find({ cartId: { $in: cartIds }, status: { $in: ['PAID', 'ADVANCE_PAID'] } }, { projection: { cartId: 1 } })
        .toArray();
      const bought = new Set(paid.map((p) => p.cartId));
      return new Set(docs.filter((d) => bought.has(d.cartId)).map((d) => String(d._id)));
    },

    render(doc) {
      return {
        properties: { CartId: doc.cartId, OrderTotal: doc.orderTotal, Currency: 'INR' },
        value: doc.orderTotal,
        bodyParams: [rupees(doc.orderTotal)],
      };
    },
  },

  {
    id: 'order_confirmation',
    label: 'Order confirmation',
    enabled: true,
    collection: 'orders',
    // Transactional — a customer who opted out of marketing still gets told
    // their order was taken.
    requiresConsent: false,
    metric: 'Order Confirmed',
    waTemplate: 'material_order_confirmation_v1',
    delayHours: 0,
    windowHours: 6,
    maxTouches: 1,
    anchor: 'paidAt',

    // ponytail: this is the CONFIRMATION half only. The dispatch half needs a
    // fulfillment timestamp, and material-backend stores none — it reads
    // fulfillmentStatus live from Shopify per request and has no webhook route.
    // Upgrade path is a fulfillments/create webhook writing `dispatchedAt` onto
    // the order, after which dispatch is another entry in this list with
    // anchor:'dispatchedAt' and no new runner code.
    //
    // Shopify already sends its own confirmation EMAIL; the value added here is
    // the WhatsApp copy, which Shopify cannot send.
    filter(now) {
      const { from, to } = windowFor(this, now);
      return { status: { $in: ['PAID', 'ADVANCE_PAID'] }, paidAt: { $gte: from, $lte: to } };
    },

    render(doc) {
      return {
        properties: {
          OrderName: doc.shopifyOrderName,
          OrderTotal: doc.orderTotal,
          BalanceDue: doc.balanceDue,
          PaymentMode: doc.paymentMode,
          Currency: 'INR',
        },
        value: doc.orderTotal,
        bodyParams: [doc.shopifyOrderName || 'your order', rupees(doc.orderTotal)],
      };
    },
  },

  {
    id: 'review_request',
    label: 'Review request',
    enabled: true,
    collection: 'orders',
    requiresConsent: true,
    metric: 'Review Requested',
    waTemplate: 'material_review_request_v1',

    // Timing ported from functions/reviewReminderCron → the admin route it
    // calls. That job fired the first ask on the "installed" OMS transition,
    // then up to 2 reminders at a 20-hour interval (deliberately under 24h so a
    // daily cron never skips a day to jitter), capping at 3 touches total.
    //
    // Material has no installation status, so the anchor is `paidAt` + 10 days
    // as a delivery proxy. 3 touches at 20h preserved exactly.
    //
    // ponytail: 10 days is a guess at Indian surface-materials delivery, not a
    // measured number. Upgrade path is the same fulfillment webhook as above,
    // after which this anchors on delivery rather than payment.
    delayHours: 240,
    touchIntervalHours: 20,
    maxTouches: 3,
    windowHours: 60,
    anchor: 'paidAt',

    filter(now) {
      const { from, to } = windowFor(this, now);
      return { status: { $in: ['PAID', 'ADVANCE_PAID'] }, paidAt: { $gte: from, $lte: to } };
    },

    render(doc) {
      return {
        properties: { OrderName: doc.shopifyOrderName, OrderId: doc.shopifyOrderId },
        bodyParams: [doc.shopifyOrderName || 'your order'],
      };
    },
  },

  {
    id: 'sample_followup',
    label: 'Sample-ordered follow-up',
    enabled: false,

    // A sample is not purchasable anywhere in Material today, so this journey
    // has no due set to query — there is nothing to key on and enabling it
    // would scan for a field that no writer ever writes.
    //
    // What exists: a product-level `custom.sample_price` metafield
    // (material-frontend/scripts/setup-product-model.mjs) and a PDP button that
    // opens a WhatsApp deep link with the product written into the message
    // (material-frontend .../ProductPage.jsx: "there is no sample variant in
    // this store, so this opens WhatsApp rather than pretending there is a
    // sample to add to a cart"). A sample request therefore exists only inside
    // a WhatsApp conversation — no order, no cart line, no tag, no row.
    //
    // To switch on: make a sample purchasable (sample variant, or a line-item
    // property on the order), then this entry needs only a filter + render and
    // anchor:'dispatchedAt'. The runner needs no change.
    blockedBy:
      'No sample purchase exists to trigger on — samples are a WhatsApp deep link, not an order. Needs a sample variant or line-item property first.',
    collection: 'orders',
    requiresConsent: true,
    metric: 'Sample Followup',
    waTemplate: 'material_sample_followup_v1',
    delayHours: 72,
    windowHours: 48,
    maxTouches: 1,
    anchor: 'dispatchedAt',
    filter() {
      throw new Error('sample_followup is disabled — see blockedBy');
    },
    render() {
      throw new Error('sample_followup is disabled — see blockedBy');
    },
  },
];

const byId = (id) => JOURNEYS.find((j) => j.id === id) || null;

/**
 * Everything needed to send, computed. Pure — no DB, no network, no clock of
 * its own. The preview endpoint returns exactly this; the cron path passes it
 * to a transport. Same numbers on both sides, because it is the same function.
 */
function plan(journey, doc, now) {
  const anchor = doc[journey.anchor];
  if (!anchor) return null;
  const touch = touchFor(journey, anchor, now);
  if (touch < 0) return null;

  const { properties = {}, value, bodyParams = [] } = journey.render(doc);
  const key = dedupeKey(journey, doc, touch);
  return {
    key,
    touch,
    subjectId: String(doc._id),
    customerId: doc.customerId || null,
    metric: journey.metric,
    // Klaviyo drops a repeat unique_id, so a retry that raced past our own
    // claim still cannot produce a second email.
    uniqueId: key,
    properties: { ...properties, Journey: journey.id, Touch: touch },
    value,
    waTemplate: journey.waTemplate,
    bodyParams,
  };
}

module.exports = { JOURNEYS, byId, plan, touchFor, windowFor, dedupeKey, HOUR };
