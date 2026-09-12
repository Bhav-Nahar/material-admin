require('dotenv').config();

/**
 * material-admin — admin API, scheduled jobs and batch work.
 *
 * Deliberately NOT part of material-backend. That service answers storefront
 * requests: short, public, latency-sensitive. This one scores the whole
 * catalogue, calls image models for minutes at a time and holds Shopify Admin
 * WRITE credentials. Same process would mean batch work competing with checkout
 * and catalogue-write tokens sitting in the app that serves anonymous traffic.
 *
 * lib/{helpers,adminToken,shopify,mongo}.js are COPIES of material-backend's.
 * ~200 lines duplicated on purpose — a shared package for that is more
 * machinery than the duplication costs. Revisit if they start to drift.
 */

const fastify = require('fastify')({
  routerOptions: { ignoreTrailingSlash: true },
  logger: { transport: { target: 'pino-pretty' } },
  // Batch endpoints accept whole product payloads, including base64 images.
  bodyLimit: 30 * 1024 * 1024,
});

// No public origin. This service is reached by schedulers, by operators, and
// later by an admin UI — never by a shopper's browser on material.in.
fastify.register(require('@fastify/cors'), {
  origin: (process.env.ADMIN_CORS_ORIGINS || 'http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  credentials: true,
  methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
});

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  if (!body || !body.trim()) return done(null, {});
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    err.statusCode = 400;
    done(err);
  }
});

fastify.register(require('@fastify/cookie'));
fastify.register(require('./lib/mongo'));

// Higher cap than the storefront's 60/min: this service is called by schedulers
// and operators running bulk jobs, not by the public. It exists to stop a
// runaway loop, not to shape traffic.
fastify.register(require('@fastify/rate-limit'), {
  global: true,
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  timeWindow: '1 minute',
});

// Every route, collected as it registers. Only for the index page below — a
// service with no UI is otherwise a set of paths you have to already know.
const ROUTES = [];
fastify.addHook('onRoute', (r) => {
  if (r.path !== '/' && !r.path.startsWith('/*')) ROUTES.push({ method: r.method, path: r.path });
});

/** The route list the UI's Routes tab renders. */
fastify.get('/routes.json', async () => {
  const seen = new Set();
  return {
    routes: ROUTES.flatMap((r) => [].concat(r.method).map((m) => ({ method: m, path: r.path })))
      .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .filter((r) => !seen.has(r.method + r.path) && seen.add(r.method + r.path))
      .map((r) => ({ ...r, secret: r.path.includes('/cron/') || r.path.startsWith('/api/ads/') }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
});

// ── UI ───────────────────────────────────────────────────────────────────────
// An explicit allowlist rather than @fastify/static. Three known files need no
// dependency, and a map means no user-supplied string ever reaches the
// filesystem — the traversal bug this class of code is famous for cannot exist.
const path = require('node:path');
const { readFileSync } = require('node:fs');

const ASSETS = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.css': ['public/app.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
};

for (const [url, [file, type]] of Object.entries(ASSETS)) {
  // Read per request, not cached at boot: editing the UI and hitting reload is the
  // whole development loop, and a cached read makes it look like the edit did nothing.
  fastify.get(url, async (request, reply) =>
    reply.type(type).send(readFileSync(path.join(__dirname, file), 'utf8')));
}

fastify.get('/health', async () => {
  const mongo = await Promise.race([
    fastify.mongo.db
      .command({ ping: 1 })
      .then(() => 'ok')
      .catch((err) => `unreachable: ${err.message.split('\n')[0].slice(0, 90)}`),
    new Promise((resolve) => setTimeout(() => resolve('unreachable: timed out after 3s'), 3000)),
  ]);

  return { status: mongo === 'ok' ? 'ok' : 'degraded', mongo, timestamp: new Date().toISOString() };
});

// ── Modules ──────────────────────────────────────────────────────────────────
// Each registers its own routes and, where it has one, its cron entrypoint
// under /cron/*. Added as they land; an unported module is simply absent rather
// than stubbed, so /health never claims a capability that does not exist yet.
for (const [prefix, mod] of [
  ['/api/signals', './routes/signals'],
  ['/api/seo', './routes/seo'],
  ['/api/products', './routes/products'],
  ['/api/marketing', './routes/marketing'],
  ['/api/ads', './routes/ads'],
  ['/api/collections', './routes/collections'],
]) {
  try {
    fastify.register(require(mod), { prefix });
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    fastify.log.warn(`module not present yet: ${mod}`);
  }
}

// Fail at boot, not on the first scheduled run at 3am.
const REQUIRED_ENV = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'MONGODB_URI',
  'MONGODB_DB',
  'CRON_SECRET',
];

const start = async () => {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')}\nSee .env.example`);
    process.exit(1);
  }

  try {
    // 8081, so it can run beside material-backend's 8080 in development.
    const port = Number(process.env.PORT || 8081);
    const host = process.env.HOST || '0.0.0.0';
    await fastify.listen({ port, host });
    console.log(`Material admin on http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
