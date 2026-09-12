'use strict';

/**
 * routes/signals.js — GA4 funnel → relevance score + automatic tags.
 *
 *   GET  /preview?days=28   what it WOULD do, writes nothing
 *   POST /sync?apply=1      writes; dry run unless apply=1
 *   POST /cron/nightly      scheduler entrypoint; always writes
 *
 * preview and sync are the same code path — preview is the sync with dryRun
 * forced on — so what you review is exactly what runs. A separate "preview"
 * implementation would be free to drift from the real one, which is the whole
 * point of having a preview.
 *
 * The purchase term in the score, and the Bestseller rule, are live but will tag
 * almost nothing while Material's catalogue is one product with no order
 * history. That is a volume fact, not a bug; both start working on their own as
 * products and orders accumulate.
 */

const { syncProductSignals } = require('../lib/productSignalsSync');
const { reorderCollections } = require('../lib/collectionReorder');
const { requireCronSecret, detach } = require('../lib/cronAuth');

// Clamped rather than validated: a scheduler sending nonsense should get a
// sensible window, not a 400 it will retry forever.
const daysOf = (q) => Math.min(365, Math.max(1, Number(q?.days) || 28));

module.exports = async function (fastify) {
  fastify.get('/preview', async (req) => ({
    success: true,
    ...(await syncProductSignals({ days: daysOf(req.query), dryRun: true, log: fastify.log })),
  }));

  fastify.post('/sync', async (req) => ({
    success: true,
    ...(await syncProductSignals({
      days: daysOf(req.query),
      dryRun: req.query.apply !== '1',
      log: fastify.log,
    })),
  }));

  // Separate from /sync rather than scheduling that one directly, for two
  // reasons: it carries the cron secret instead of an admin session, and it
  // APPLIES unconditionally. A scheduled job that silently dry-ran because a
  // query param went missing would look healthy for weeks while the scores went
  // stale — the one failure mode nobody notices.
  //
  // detach() replies before the work finishes: scoring a catalogue runs past
  // Cloud Scheduler's timeout, and a retry would start a second run on top of
  // the first. A failure costs one day of freshness and nothing else.
  fastify.post('/cron/nightly', { preHandler: requireCronSecret }, (req, reply) =>
    detach(reply, fastify.log, 'signals-nightly', () => runNightly(fastify.log, daysOf(req.query))));
};

async function runNightly(log, days) {
  const result = await syncProductSignals({ days, dryRun: false, log });
  if (result.errors.length) log.error({ errors: result.errors.slice(0, 5) }, '[signals] nightly errors');

  // Push the fresh ranking INTO Shopify's collection order, so listing pages
  // serve it natively instead of the storefront sorting a whole category on
  // every request. Strictly after the scoring: reordering on yesterday's scores
  // would put the collections a day behind for no reason.
  const order = await reorderCollections({ dryRun: false, log });
  if (order.errors) log.error({ results: order.results.filter((r) => r.error).slice(0, 5) }, '[signals] reorder errors');

  // ponytail: no cache purge here. The source ended this job by purging
  // Cloudflare (purge_everything) and a Cloud Run storefront's in-memory
  // category cache, because the new order stayed invisible until the old one
  // expired — up to three days.
  // Ceiling: Material's ranking is served STALE for however long the Next.js
  // storefront caches a collection page, and nobody has decided that yet.
  // Upgrade path: once the caching strategy is settled, add exactly one call at
  // this point — a fetch to a storefront revalidation route
  // (revalidateTag/revalidatePath for ISR) or the CDN's purge API — best-effort,
  // so a failed purge logs and does not fail the nightly run.

  return {
    scores: result.written,
    taggedProducts: result.taggedProducts,
    tagCounts: result.tagCounts,
    errors: result.errors.length,
    reorder: {
      collections: order.collections,
      reordered: order.reordered,
      unchanged: order.unchanged,
      skipped: order.skipped,
      errors: order.errors,
    },
  };
}
