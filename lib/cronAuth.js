/**
 * cronAuth.js — the guard on every scheduler-triggered route.
 *
 * Scheduled jobs cannot carry an admin session, so they carry a shared secret
 * instead. Kept separate from the human-facing admin auth because the two fail
 * differently: a human getting a 401 retries with a login, a scheduler getting a
 * 401 retries forever and nobody notices.
 *
 * ── Why cron routes APPLY unconditionally ────────────────────────────────────
 * glassquickdev learned this one the expensive way: their /sync route dry-runs
 * unless `?apply=1`, so a scheduled job that lost the query param would report
 * healthy for weeks while the data went stale. Cron entrypoints here take no
 * dryRun parameter at all — if it is scheduled, it writes.
 */

/**
 * Fastify preHandler. Returns 401 unless the caller presents the shared secret.
 *
 * An UNSET secret rejects everything rather than allowing everything. A missing
 * env var is the normal state of a half-configured deploy, and defaulting that
 * to "open" puts catalogue writes behind no auth at all.
 */
function requireCronSecret(request, reply, done) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    request.log.error('CRON_SECRET is not set — refusing every cron request');
    reply.code(401).send({ success: false, error: 'cron auth not configured' });
    return;
  }
  if (request.headers['x-cron-secret'] !== expected) {
    reply.code(401).send({ success: false, error: 'bad secret' });
    return;
  }
  done();
}

/**
 * Reply now, work later.
 *
 * Cloud Scheduler times out around 30 minutes and retries on non-2xx; scoring a
 * full catalogue or generating a set of images runs past that. A retry would
 * start a second run on top of the first, so long jobs acknowledge immediately
 * and report progress to the logs instead. Cost of a failure is one cycle of
 * staleness, which is the cheaper end of the trade.
 */
function detach(reply, log, name, work) {
  reply.send({ success: true, started: true, job: name });
  Promise.resolve()
    .then(work)
    .then((result) => log.info({ job: name, result }, `[${name}] done`))
    .catch((err) => log.error({ job: name, err: err.message }, `[${name}] failed`));
}

module.exports = { requireCronSecret, detach };
