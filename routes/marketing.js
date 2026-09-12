'use strict';

/**
 * marketing.js — journey crons, an operator one-off, and a preview.
 *
 * The glassquickdev original was 2,014 lines, but almost all of it was an AI
 * content-generation studio (Gemini prompts, GCS uploads, a knowledge bank of
 * English prose fed to an LLM, GTM tag provisioning). None of that is sending
 * machinery and none of it is ported. What is ported is the part that actually
 * moves messages: the transports, and the scheduled-reminder shape from
 * functions/visitReminderCron — bounded due-set → atomic claim → send → record.
 *
 * ── WHERE SENDING CAN HAPPEN ─────────────────────────────────────────────────
 * Exactly two call sites, both in this file, both below in `deliver()`:
 *   klaviyo.trackEvent(...)   — email/SMS, via a Klaviyo flow
 *   whatsapp.sendTemplate(...) — WhatsApp
 * `deliver` is reached from exactly two routes: POST /cron/<journey> and
 * POST /send. Both sit behind requireCronSecret. GET /journeys and
 * GET /preview/:id never reference `deliver` and never import a transport path
 * that reaches it — see lib/journeys.js, which imports no transport at all.
 */

const { requireCronSecret, detach } = require('../lib/cronAuth');
const { adminGraphql } = require('../lib/shopify');
const journeys = require('../lib/journeys');
const klaviyo = require('../lib/klaviyo');
const whatsapp = require('../lib/whatsapp');

const SENT = 'marketing_sent';
const MAX_PER_RUN = Number(process.env.MARKETING_MAX_PER_RUN || 200);

// ─────────────────────────────────────────────────────────────────────────────
// Contact resolution
//
// material-backend keeps no `customers` collection — Shopify is the record. One
// bulk `nodes(ids:)` call per batch rather than one per recipient.
//
// Consent: registration writes emailMarketingConsent/smsMarketingConsent plus a
// `whatsapp:opted-in` / `whatsapp:opted-out` TAG, because Shopify has no
// WhatsApp consent field. There is no endpoint to change it afterwards, so the
// tag is the only WhatsApp signal that exists.
// ─────────────────────────────────────────────────────────────────────────────
async function contactsFor(customerIds) {
  const ids = [...new Set(customerIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;

  for (let i = 0; i < ids.length; i += 50) {
    const data = await adminGraphql(
      `query($ids: [ID!]!) {
         nodes(ids: $ids) {
           ... on Customer {
             id email phone firstName lastName tags
             emailMarketingConsent { marketingState }
           }
         }
       }`,
      { ids: ids.slice(i, i + 50) },
    );
    for (const n of data?.nodes || []) {
      if (!n?.id) continue;
      const tags = n.tags || [];
      out.set(n.id, {
        email: n.email || null,
        phone: n.phone || null,
        firstName: n.firstName || null,
        lastName: n.lastName || null,
        emailOptIn: n.emailMarketingConsent?.marketingState === 'SUBSCRIBED',
        waOptIn: tags.includes('whatsapp:opted-in'),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The only send path in this service.
// ─────────────────────────────────────────────────────────────────────────────
async function deliver(plan, contact, journey, log) {
  const results = {};

  const wantEmail = !journey.requiresConsent || contact.emailOptIn;
  if (contact.email && wantEmail) {
    results.klaviyo = await klaviyo.trackEvent(
      {
        metric: plan.metric,
        profile: { email: contact.email, phone: contact.phone, firstName: contact.firstName, lastName: contact.lastName },
        properties: plan.properties,
        value: plan.value,
        uniqueId: plan.uniqueId,
      },
      log,
    );
  }

  const wantWa = !journey.requiresConsent || contact.waOptIn;
  if (contact.phone && wantWa && plan.waTemplate) {
    results.whatsapp = await whatsapp.sendTemplate(
      contact.phone,
      plan.waTemplate,
      { bodyParams: plan.bodyParams },
      log,
    );
  }

  const attempted = Object.values(results);
  return {
    ok: attempted.some((r) => r.ok),
    // Nothing attempted, or every attempt skipped without touching the network.
    skipped: !attempted.length || attempted.every((r) => r.skipped),
    results,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner. Ported shape, with the two bugs the source shipped fixed:
//   1. glassquickdev claimed the reminder then swallowed send failures, so a
//      failed send was permanently marked sent and never retried. Here a send
//      that never reached the network RELEASES its claim.
//   2. It had no per-run cap and a silent 200-row clamp. Here the cap is
//      explicit and the window is bounded on both sides.
// ─────────────────────────────────────────────────────────────────────────────
async function run(db, journey, log, now = Date.now()) {
  if (!journey.enabled) {
    log.warn(`[marketing] ${journey.id} is disabled: ${journey.blockedBy}`);
    return { journey: journey.id, disabled: true, reason: journey.blockedBy };
  }

  // Channel check BEFORE claiming anything. If both channels are off, claiming
  // would write sent-log rows for messages nobody ever received, and those
  // customers would never be messaged again once the key was finally set.
  if (!klaviyo.enabled() && !whatsapp.enabled()) {
    log.error(`[marketing] ${journey.id} skipped — no channel configured (KLAVIYO_API_KEY, WHATSAPP_TOKEN both unset)`);
    return { journey: journey.id, skipped: true, reason: 'no channel configured' };
  }

  const docs = await db.collection(journey.collection).find(journey.filter(now)).limit(MAX_PER_RUN).toArray();
  const suppressed = journey.suppress ? await journey.suppress(db, docs) : new Set();

  const plans = [];
  for (const doc of docs) {
    if (suppressed.has(String(doc._id))) continue;
    const p = journeys.plan(journey, doc, now);
    if (p) plans.push(p);
  }

  const contacts = await contactsFor(plans.map((p) => p.customerId));
  const stats = { journey: journey.id, due: plans.length, sent: 0, alreadySent: 0, noContact: 0, failed: 0 };

  for (const p of plans) {
    const contact = contacts.get(p.customerId);
    if (!contact || (!contact.email && !contact.phone)) {
      stats.noContact++;
      continue;
    }

    // ── The atomic claim ──────────────────────────────────────────────────
    // insertOne against the _id unique index. A duplicate key means another run
    // (or an earlier one) already owns this touch. Claim BEFORE the send, so a
    // crash mid-send loses one message rather than sending it twice — the right
    // side of that trade when the recipient is a real customer.
    try {
      await db.collection(SENT).insertOne({
        _id: p.key,
        journey: journey.id,
        subjectId: p.subjectId,
        touch: p.touch,
        customerId: p.customerId,
        claimedAt: new Date(),
        status: 'claimed',
      });
    } catch (err) {
      if (err.code === 11000) {
        stats.alreadySent++;
        continue;
      }
      throw err;
    }

    let outcome;
    try {
      outcome = await deliver(p, contact, journey, log);
    } catch (err) {
      outcome = { ok: false, skipped: false, results: { error: err.message } };
    }

    if (outcome.skipped) {
      // Never reached the network — release the claim so it retries once the
      // channel is configured or the contact is fixed. This is the one case
      // where releasing cannot cause a double-send.
      await db.collection(SENT).deleteOne({ _id: p.key });
      stats.noContact++;
      continue;
    }

    await db.collection(SENT).updateOne(
      { _id: p.key },
      { $set: { status: outcome.ok ? 'sent' : 'failed', sentAt: new Date(), result: outcome.results } },
    );
    outcome.ok ? stats.sent++ : stats.failed++;
  }

  log.info(stats, `[marketing] ${journey.id} done`);
  return stats;
}

module.exports = async function (fastify) {
  // Unique index is implicit on _id, which IS the dedupe key — no index to
  // create and no way to forget it in a new environment.

  /** What is configured. Reports channel health without echoing any secret. */
  fastify.get('/journeys', async () => ({
    success: true,
    channels: {
      klaviyo: klaviyo.enabled() ? 'on' : 'off — KLAVIYO_API_KEY unset or not a pk_ key',
      whatsapp: whatsapp.enabled() ? 'on' : 'off — WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID unset',
    },
    maxPerRun: MAX_PER_RUN,
    journeys: journeys.JOURNEYS.map((j) => ({
      id: j.id,
      label: j.label,
      enabled: j.enabled,
      blockedBy: j.blockedBy || null,
      cron: `POST /api/marketing/cron/${j.id}`,
      anchor: j.anchor,
      delayHours: j.delayHours,
      maxTouches: j.maxTouches,
      requiresConsent: j.requiresConsent,
      channels: [j.metric && 'email/sms (klaviyo)', j.waTemplate && 'whatsapp'].filter(Boolean),
    })),
  }));

  /**
   * Preview. STRUCTURALLY INCAPABLE OF SENDING: it calls journeys.plan, and
   * lib/journeys.js imports no transport. There is no dryRun flag to pass wrong
   * — the sending code is simply not reachable from this handler.
   *
   * It also does not resolve contacts, so it cannot leak a customer's email or
   * phone; it answers "who is due and what would they get", nothing more.
   */
  fastify.get('/preview/:id', async (request, reply) => {
    const journey = journeys.byId(request.params.id);
    if (!journey) return reply.code(404).send({ success: false, error: 'unknown journey' });
    if (!journey.enabled) {
      return reply.code(409).send({ success: false, error: 'journey disabled', blockedBy: journey.blockedBy });
    }

    const now = Date.now();
    const db = fastify.mongo.db;
    const docs = await db.collection(journey.collection).find(journey.filter(now)).limit(MAX_PER_RUN).toArray();
    const suppressed = journey.suppress ? await journey.suppress(db, docs) : new Set();

    const sample = [];
    for (const doc of docs) {
      if (suppressed.has(String(doc._id))) continue;
      const p = journeys.plan(journey, doc, now);
      if (p) sample.push(p);
    }

    const alreadySent = sample.length
      ? await db.collection(SENT).countDocuments({ _id: { $in: sample.map((p) => p.key) } })
      : 0;

    return {
      success: true,
      journey: journey.id,
      window: journeys.windowFor(journey, now),
      due: sample.length,
      alreadySent,
      wouldSend: sample.length - alreadySent,
      sample: sample.slice(0, 20),
    };
  });

  /**
   * Operator one-off. SENDS. Behind the cron secret (the only shared secret
   * this service has) AND an explicit `confirm: true` — a curl missing either
   * one does nothing.
   */
  fastify.post('/send', { preHandler: requireCronSecret }, async (request, reply) => {
    const { channel, email, phone, metric, template, properties, bodyParams, confirm } = request.body || {};
    if (confirm !== true) {
      return reply.code(400).send({ success: false, error: 'refusing to send without { confirm: true }' });
    }
    if (channel === 'email') {
      if (!email || !metric) return reply.code(400).send({ success: false, error: 'email and metric required' });
      const result = await klaviyo.trackEvent(
        { metric, profile: { email, phone }, properties: properties || {}, uniqueId: `manual:${metric}:${email}:${Date.now()}` },
        request.log,
      );
      return reply.code(result.ok ? 200 : 502).send({ success: result.ok, result });
    }
    if (channel === 'whatsapp') {
      if (!phone || !template) return reply.code(400).send({ success: false, error: 'phone and template required' });
      const result = await whatsapp.sendTemplate(phone, template, { bodyParams: bodyParams || [] }, request.log);
      return reply.code(result.ok ? 200 : 502).send({ success: result.ok, result });
    }
    return reply.code(400).send({ success: false, error: "channel must be 'email' or 'whatsapp'" });
  });

  // One cron entrypoint per journey, generated from the data. Adding a journey
  // adds its cron route; there is no list to keep in sync. Cron applies
  // unconditionally — no dryRun parameter, by contract.
  for (const journey of journeys.JOURNEYS) {
    fastify.post(`/cron/${journey.id}`, { preHandler: requireCronSecret }, (request, reply) =>
      detach(reply, fastify.log, journey.id, () => run(fastify.mongo.db, journey, fastify.log)),
    );
  }
};

// Exported for tests. `run` needs a db, a journey and a logger passed in
// explicitly — importing this module runs nothing.
module.exports.run = run;
module.exports.deliver = deliver;
