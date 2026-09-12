const fp = require('fastify-plugin');
const { MongoClient } = require('mongodb');

const RETRY_MS = 15000;

/**
 * Mongo, registered WITHOUT blocking boot, and able to recover on its own.
 *
 * TWO THINGS THIS FIXES, both learned the hard way:
 *
 * 1. BOOT. @fastify/mongodb connects during plugin registration, and fastify.listen waits for
 *    registration -- so an unreachable Atlas meant the process never listened at all, taking auth
 *    (which touches no database) down with it. A lapsed IP allowlist entry is enough, and home IPs
 *    change. Nothing here is awaited; boot always succeeds.
 *
 * 2. RECOVERY. The driver CLOSES its topology when the first connect fails, and a closed topology
 *    never retries -- every later query dies with "Topology is closed" even after the database comes
 *    back. So a failed attempt throws its client away and a fresh one is built on a timer. Fix the
 *    allowlist and the backend heals within RETRY_MS without anyone restarting it.
 *
 * Routes read `fastify.mongo.db` per request (never captured at startup), so they pick up whichever
 * client is current.
 */
async function mongoPlugin(fastify) {
  const state = { client: null, db: null, connected: false };
  fastify.decorate('mongo', state);

  let timer = null;
  let closed = false;

  const attempt = async () => {
    if (closed) return;

    // A client whose connect failed is unusable — replace it rather than reuse it.
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    state.client = client;
    state.db = client.db(process.env.MONGODB_DB);

    try {
      await client.connect();
      state.connected = true;
      fastify.log.info('mongo connected');
    } catch (err) {
      state.connected = false;
      await client.close().catch(() => {});
      fastify.log.error(
        { err: err.message.split('\n')[0].slice(0, 120) },
        `mongo unreachable — retrying in ${RETRY_MS / 1000}s`,
      );
      timer = setTimeout(attempt, RETRY_MS);
    }
  };

  attempt();

  fastify.addHook('onClose', async () => {
    closed = true;
    clearTimeout(timer);
    await state.client?.close().catch(() => {});
  });
}

module.exports = fp(mongoPlugin, { name: 'mongo' });
