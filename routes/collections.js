'use strict';

/**
 * routes/collections.js — collection CRUD and the two navigation reports.
 *
 *   GET  /                what collections exist, how they sort, smart or manual
 *   GET  /health          every menu facet link, resolved against the live storefront
 *   GET  /vocabulary      every controlled metafield value in use, with near-duplicates
 *   POST /create          manual or smart. Dry run unless ?apply=1
 *   POST /:id/products    add/remove membership. Dry run unless ?apply=1
 *   POST /:id/publish     publishablePublish to an EXPLICIT publication set
 *
 * Registered under /api/collections, so paths here are relative to it.
 *
 * The two GETs are read-only against the live store and are the reason this module
 * exists — /health is the only thing in the codebase that can see the failure where
 * all 35 mega-menu facet links silently return the unfiltered collection. Both writes
 * are DRY RUN BY DEFAULT, matching routes/products.js: the plan you review is built by
 * the same function the real call uses.
 */

const {
  listCollections,
  createCollection,
  setCollectionProducts,
  publishCollection,
  collectionHealth,
  collectionVocabulary,
} = require('../lib/collections');

// bad_input is the caller's fault (400); shopify_rejected means the write was refused
// with a 200 and a userErrors payload, which is a bad request too. no_menu means the
// frontend's menu-data.json is not on disk beside this service — a deployment fact,
// not a caller error, so 503. Anything else is unexpected and gets logged.
const CODES = { bad_input: 400, shopify_rejected: 400, no_menu: 503 };

/** `:id` may be a bare numeric id or a full GID; Shopify only accepts the latter. */
const gid = (id, type) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);

const fail = (req, reply, err) => {
  const status = CODES[err.code];
  if (!status) req.log.error(err);
  return reply.code(status || 502).send({
    success: false,
    error: err.message,
    code: err.code,
    ...(err.available ? { available: err.available } : {}),
  });
};

module.exports = async function (fastify) {
  /** GET / — handle, sortOrder, smart-vs-manual, product count, publication count. */
  fastify.get('/', async (req, reply) => {
    try {
      const collections = await listCollections({ limit: Math.min(Number(req.query.limit) || 250, 250) });
      return { success: true, count: collections.length, collections };
    } catch (err) {
      return fail(req, reply, err);
    }
  });

  /**
   * GET /health — does every menu link actually filter anything?
   *
   * Per link: `ok` / `no such collection` / `facet not enabled` /
   * `param does not match any facet label` / `value not found in facet`, each with the
   * fix. Also names the NAV_CATEGORIES handles that are declared but do not exist.
   *
   * Reads Shopify twice over: the STOREFRONT API for facets (a facet is a storefront
   * concept — Search & Discovery's on/off state is invisible from the admin) and the
   * Admin API for metafield definitions, which is what separates "the filter is off"
   * from "the param is misnamed". Nothing is written.
   */
  fastify.get('/health', async (req, reply) => {
    try {
      return { success: true, ...(await collectionHealth({})) };
    } catch (err) {
      return fail(req, reply, err);
    }
  });

  /**
   * GET /vocabulary — the linter behind deferring the free-text-vs-metaobject decision.
   *
   * Distinct values per controlled metafield, per category, with counts, plus
   * near-duplicate groups and values the menu asks for that no product carries. The
   * point is that this stays cheap to run while the catalogue is small, so the decision
   * to leave these as free text never turns into a thousand-SKU cleanup.
   */
  fastify.get('/vocabulary', async (req, reply) => {
    try {
      return {
        success: true,
        ...(await collectionVocabulary({ limit: Math.min(Number(req.query.limit) || 500, 1000) })),
      };
    } catch (err) {
      return fail(req, reply, err);
    }
  });

  /**
   * POST /create — a manual or a smart collection.
   *
   * Body: { title, handle?, descriptionHtml?, seo?, sortOrder?, image?, metafields?,
   *         products?: [ID!]  |  ruleSet?: { appliedDisjunctively, rules: [...] } }
   *
   * DRY RUN BY DEFAULT; `?apply=1` writes. `products` works only here — on an existing
   * collection it is silently ignored, which is what POST /:id/products is for.
   */
  fastify.post('/create', async (req, reply) => {
    try {
      const result = await createCollection(req.body || {}, { dryRun: req.query.apply !== '1' });
      return { success: true, ...result };
    } catch (err) {
      return fail(req, reply, err);
    }
  });

  /**
   * POST /:id/products — change membership of an existing manual collection.
   *
   * Body: { add?: [productGID], remove?: [productGID] }
   *
   * Goes through productUpdate's collectionsToJoin / collectionsToLeave, one call per
   * product, because on 2026-01 there is no collection-side mutation left that can do
   * it: collectionAddProducts, collectionAddProductsV2 and collectionRemoveProducts
   * have all been removed from the schema. See lib/collections.js.
   *
   * Only meaningful on a MANUAL collection — a smart collection's membership comes
   * from its ruleSet, so Shopify refuses the join. GET / says which is which, and a
   * refusal comes back as a per-product `error` in `results` rather than failing the
   * whole batch.
   */
  fastify.post('/:id/products', async (req, reply) => {
    try {
      const result = await setCollectionProducts(
        { collectionId: gid(req.params.id, 'Collection'), ...(req.body || {}) },
        { dryRun: req.query.apply !== '1' },
      );
      return { success: true, ...result };
    } catch (err) {
      return fail(req, reply, err);
    }
  });

  /**
   * POST /:id/publish — publish the collection to a set of publications.
   *
   * Body: { publicationIds: [ID!] } (or set SHOPIFY_PUBLICATION_IDS).
   *
   * Collections are `Publishable`, so this is the same publishablePublish products use.
   * It REFUSES to publish to "everything": on this store `publications(first:50)`
   * returns four while a product's own resourcePublications returns five, so looping
   * the list would leave one channel unpublished and still report success. With no ids
   * given, the 400 carries the (incomplete) list so you can choose.
   */
  fastify.post('/:id/publish', async (req, reply) => {
    try {
      const result = await publishCollection(
        { id: gid(req.params.id, 'Collection'), publicationIds: (req.body || {}).publicationIds },
        { dryRun: req.query.apply !== '1' },
      );
      return { success: true, ...result };
    } catch (err) {
      return fail(req, reply, err);
    }
  });
};
