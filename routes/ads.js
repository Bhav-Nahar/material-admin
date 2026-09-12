'use strict';

/**
 * routes/ads.js — performance marketing.
 *
 * Registered under `/api/ads`, so every path below is relative to that.
 *
 * ── This module spends money and sends customer data to Meta ─────────────────
 * Two things here leave the building:
 *
 *   POST /events                    → sends hashed customer data to Meta CAPI
 *   POST /campaigns/:id/status      → starts or stops live ad delivery
 *   POST /campaigns/:id/budget      → changes daily spend
 *
 * All three require the shared secret. The two campaign writes additionally require
 * `?apply=1`; without it they report what they WOULD do and change nothing. Reads
 * (`GET /campaigns`, the health cron) cannot spend or send anything.
 *
 * ponytail: the shared secret is `x-cron-secret`, reused rather than minting a
 * second one. This service has exactly one caller class today — schedulers and
 * material-backend, both server-side. Upgrade path: when a human admin UI lands it
 * gets a session guard, and these routes move onto it.
 */

const { requireCronSecret, detach } = require('../lib/cronAuth');
const { sendMetaEvent, buildMetaEvent, EVENTS } = require('../lib/adsEvents');
const metaAds = require('../lib/metaAds');

const secured = { preHandler: requireCronSecret };

module.exports = async function (fastify, opts) {
  /**
   * POST /events — one server-side conversion event.
   *
   * Called by material-backend (order paid, checkout started) and by the storefront's
   * own server actions. Body shape, with only `event` required:
   *
   * {
   *   "event": "Purchase",                  // ViewContent | AddToCart | InitiateCheckout | Purchase | SampleOrder
   *   "eventId": "Purchase.5501234",        // MUST equal the pixel's eventID; derived from orderId when omitted
   *   "value": 4999, "currency": "INR",
   *   "orderId": "5501234",                 // or checkoutToken / cartId / productId
   *   "contentIds": ["glazed-tile-600x600"],
   *   "user":        { "email","phone","firstName","lastName","city","state","zip","externalId" },
   *   "attribution": { "gclid","fbclid","fbc","fbp","firstSeen","landing", ...utm_* },
   *   "clientIp": "…", "clientUserAgent": "…"   // the SHOPPER's, forwarded by the caller
   * }
   *
   * `attribution` uses material-backend/lib/attribution.js's field names verbatim, so
   * the caller can pass the object it already stored on the order without a mapping.
   *
   * `clientIp`/`clientUserAgent` are read from the BODY, never from this request —
   * the connection here belongs to material-backend, and forwarding a server's IP as
   * the shopper's tells Meta every Material customer lives in one datacentre.
   */
  fastify.post('/events', secured, async (request, reply) => {
    const body = request.body || {};
    if (!EVENTS.has(body.event)) {
      return reply.code(400).send({
        success: false,
        error: `event must be one of ${[...EVENTS].join(', ')}`,
      });
    }

    let result;
    try {
      result = await sendMetaEvent(body, request.log);
    } catch (err) {
      // Only input errors reach here — sendMetaEvent swallows Meta-side failures.
      return reply.code(422).send({ success: false, error: err.message, code: err.code });
    }

    // An unconfigured channel is not a success. 503 so a caller's retry/alerting sees
    // it, rather than a 200 that reads as "event delivered".
    if (result.skipped) return reply.code(503).send({ success: false, ...result });
    if (!result.ok) return reply.code(502).send({ success: false, ...result });

    // `dedupe: 'server-only'` means nothing tied this event to a browser pixel event —
    // Meta may count it twice. The caller sees it; so does the log line in adsEvents.
    return { success: true, ...result };
  });

  /**
   * GET /campaigns — campaign state and 30-day performance. Read only.
   * `?window=last_7d` for any Meta date preset.
   */
  fastify.get('/campaigns', async (request, reply) => {
    const rows = await metaAds.listCampaigns(request.query.window || 'last_30d');
    if (!rows) {
      request.log.warn('[ads] META_ACCESS_TOKEN/META_AD_ACCOUNT_ID unset — Meta channel is OFF');
      return reply.code(503).send({ success: false, skipped: 'meta-not-configured' });
    }
    const totals = rows.reduce(
      (t, c) => ({
        spend: t.spend + c.spend,
        clicks: t.clicks + c.clicks,
        purchases: t.purchases + c.purchases,
        revenue: t.revenue + c.revenue,
      }),
      { spend: 0, clicks: 0, purchases: 0, revenue: 0 },
    );
    totals.roas = totals.spend > 0 && totals.revenue > 0 ? +(totals.revenue / totals.spend).toFixed(2) : null;
    return { success: true, window: request.query.window || 'last_30d', totals, campaigns: rows };
  });

  /**
   * POST /campaigns/:id/status?apply=1  { "status": "PAUSED" }
   * Starts or stops live delivery. Without `?apply=1` it only reports the intent.
   */
  fastify.post('/campaigns/:id/status', secured, async (request, reply) => {
    const status = String((request.body || {}).status || '').toUpperCase();
    if (!['ACTIVE', 'PAUSED'].includes(status)) {
      return reply.code(400).send({ success: false, error: 'status must be ACTIVE or PAUSED' });
    }
    if (request.query.apply !== '1') {
      return { success: true, applied: false, would: { campaignId: request.params.id, status } };
    }
    request.log.warn(`[ads] setting campaign ${request.params.id} to ${status}`);
    const result = await metaAds.setCampaignStatus(request.params.id, status);
    if (result.skipped) return reply.code(503).send({ success: false, ...result });
    return { success: true, applied: true, ...result };
  });

  /**
   * POST /campaigns/:id/budget?apply=1  { "dailyBudget": 2500 }
   * Daily budget in rupees. Without `?apply=1` it only reports the intent.
   */
  fastify.post('/campaigns/:id/budget', secured, async (request, reply) => {
    const dailyBudget = Number((request.body || {}).dailyBudget);
    if (!(dailyBudget > 0)) {
      return reply.code(400).send({ success: false, error: 'dailyBudget must be a positive INR amount' });
    }
    if (request.query.apply !== '1') {
      return { success: true, applied: false, would: { campaignId: request.params.id, dailyBudget } };
    }
    request.log.warn(`[ads] setting campaign ${request.params.id} daily budget to INR ${dailyBudget}`);
    const result = await metaAds.setDailyBudget(request.params.id, dailyBudget);
    if (result.skipped) return reply.code(503).send({ success: false, ...result });
    return { success: true, applied: true, ...result };
  });

  /**
   * POST /cron/pixel-health — daily. Read only; cannot spend or send anything.
   *
   * The one scheduled job this module needs. Everything above depends on the pixel
   * still firing, and a pixel that stops firing announces itself nowhere — the money
   * keeps going out, the events stop coming in, and nobody notices until a monthly
   * report looks wrong.
   */
  fastify.post('/cron/pixel-health', secured, (request, reply) =>
    detach(reply, fastify.log, 'pixel-health', async () => {
      const health = await metaAds.pixelHealth();
      if (health.skipped) {
        fastify.log.warn('[pixel-health] Meta channel is OFF — nothing to check');
      } else if (!health.ok) {
        // error, not warn: this is the line that should page someone.
        fastify.log.error({ health }, `[pixel-health] ${health.issues.join('; ')}`);
      }
      return health;
    }),
  );

  /**
   * GET /events/preview — build a payload without sending it.
   *
   * ponytail: a debug affordance, but the cheap one. Verifying that a hash is right
   * otherwise means firing a real event at Meta and waiting for Events Manager, and
   * a wrong hash is invisible there — it just quietly matches nobody.
   */
  fastify.get('/events/preview', secured, async (request, reply) => {
    try {
      const { data, dedupe } = buildMetaEvent(JSON.parse(request.query.payload || '{}'));
      return { success: true, dedupe, data };
    } catch (err) {
      return reply.code(400).send({ success: false, error: err.message, code: err.code });
    }
  });
};

/**
 * ── Dayparting: deliberately NOT ported ──────────────────────────────────────
 * glassquickdev runs a Cloud Function that pauses its Meta campaigns at 23:00 IST and
 * resumes them at 10:00 IST, because CBO campaigns reject Meta's native ad schedule.
 * The logic is trivial to port — `setCampaignStatus` above is all it needs — and it is
 * still the wrong thing for Material:
 *
 *   1. It exists because GlassQuick's conversion is a phone call somebody has to
 *      answer. Material's is a checkout that works at 3am. Late-night traffic is
 *      cheap, and there is nobody who needs to be awake for it.
 *   2. Pausing and resuming a campaign daily disturbs delivery pacing, and on a store
 *      this size the campaigns rarely leave the learning phase to begin with. The
 *      dayparting saves less than the churn costs.
 *   3. If time-of-day genuinely underperforms, Meta's own optimisation already bids
 *      it down, using far more data than a fixed clock.
 *
 * If it is ever wanted: two Cloud Scheduler entries hitting a `/cron/dayparting`
 * route that calls `setCampaignStatus` over a configured campaign list. ~15 lines.
 */
