/**
 * hit.js — call one route in-process, against real credentials.
 *
 *   node scripts/hit.js <module> <prefix> <METHOD> <path> ['{"json":"body"}']
 *   node scripts/hit.js seo /api/seo GET /audit
 *
 * Uses fastify.inject rather than a listening server, so there is no port to
 * manage and no process left running. Everything downstream of the route is
 * real — this DOES reach Shopify and will write if you call a route that writes.
 */
require('dotenv').config({ quiet: true });

const [, , mod, prefix, method, path, body] = process.argv;
if (!path) {
  console.error('usage: node scripts/hit.js <module> <prefix> <METHOD> <path> [jsonBody]');
  process.exit(2);
}

(async () => {
  const f = require('fastify')({ logger: false });
  // Mirrors index.js. Schedulers POST with no body but with a JSON content-type,
  // and Fastify's default parser 400s that before any route runs — so without this
  // the harness reports a failure the real service does not have.
  f.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || !body.trim()) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err); }
  });
  f.register(require('@fastify/cookie'));
  f.register(require('../lib/mongo'));
  f.register(require('../routes/' + mod), { prefix });
  await f.ready();

  const res = await f.inject({
    method,
    url: prefix + path,
    headers: { 'x-cron-secret': process.env.CRON_SECRET, 'content-type': 'application/json' },
    ...(body ? { payload: JSON.parse(body) } : {}),
  });

  console.log('HTTP', res.statusCode);
  try {
    console.log(JSON.stringify(JSON.parse(res.body), null, 2).slice(0, 3000));
  } catch {
    console.log(res.body.slice(0, 1500));
  }
  process.exit(res.statusCode < 400 ? 0 : 1);
})();
