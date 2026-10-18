/**
 * routes/products.js — creating a product, shooting it, and making it sellable.
 *
 * Registered by index.js under /api/products, so paths here are relative to it.
 *
 * The lifecycle these routes cover, in order: /create makes a DRAFT with tracked
 * inventory, /images/generate shoots it, /:id/readiness says what still blocks it,
 * and /:id/publish activates, publishes and VERIFIES it. Nothing here is a thin
 * wrapper over one mutation — see lib/productPublish.js for why "publish" is four
 * steps and why the last one is a read.
 */

const { generateProductImages, stageImage } = require('../lib/productImages/pipeline');
const seo = require('../lib/seoGenerator');
const { SHOP_DOMAIN, adminGraphql } = require('../lib/shopify');
const { resolveCategory } = require('../lib/keywordBank');
const { SCENE_CONFIG, SCENE_METADATA, COMPOSITED_SCENES } = require('../lib/productImages/promptBuilder');
const { buildTemplates } = require('../lib/productImages/imageComposer');
const { rectify } = require('../lib/productImages/rectify');
const blenderRoom = require('../lib/productImages/blenderRoom');
const {
  renderStudio3d,
  closeBrowser,
  DEFAULTS: STUDIO3D_DEFAULTS,
  ROUGHNESS: STUDIO3D_ROUGHNESS,
} = require('../lib/productImages/studio3d');
const { createProduct } = require('../lib/productCreate');
const { fetchProduct, assessProduct, publishProduct, sweep } = require('../lib/productPublish');

// Every code these libs raise deliberately, and what it means to a caller. Anything
// not listed is a bug or Shopify being down, and gets 502 plus a log line.
const CLIENT_ERRORS = {
  bad_category: 400,
  missing_price: 400,
  duplicate_option_value: 400,
  price_unit_mismatch: 400,
  no_location: 400,
  not_found: 404,
  // 422, not 400: the request was well-formed and the product was found. What failed
  // is the product's own state, and the body carries exactly which gates.
  gates_failed: 422,
  readiness_unknown: 422,
  unknown_publication: 422,
  no_publication: 422,
  shopify_rejected: 400,
  no_photo: 400,
  // 503, not 502: the service is fine, this one optional renderer has no browser to
  // drive. Every other template still works, and the message says what to set.
  no_chrome: 503,
  scene_failed: 502,
  // Same shape as no_chrome: the service is fine, one optional tool is not installed.
  no_python: 503,
  rectify_failed: 502,
  room_failed: 502,
  // Same family as no_chrome and no_python: the service is healthy, one optional
  // renderer is not installed on this box.
  no_blender: 503,
  no_template: 503,
  bad_swatch: 400,
  bad_shots: 400,
  render_failed: 502,
  // A render that ran out of time is not a client error and not a broken service —
  // it is a scene that needs fewer samples or a machine that needs a GPU.
  render_timeout: 504,
  no_job: 404,
};

function sendError(reply, req, err, extra = {}) {
  const status = CLIENT_ERRORS[err.code];
  if (!status) req.log.error(err);
  return reply.code(status || 502).send({ success: false, error: err.message, code: err.code, ...extra });
}

const SIMILAR = `
  query similar($q: String!) {
    products(first: 8, query: $q, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id title handle productType
        featuredImage { url }
        metafields(first: 40, namespace: "custom") { nodes { key value } }
        variants(first: 50) {
          nodes {
            price compareAtPrice
            selectedOptions { name value }
            metafields(first: 20, namespace: "custom") { nodes { key value } }
          }
        }
      }
    }
  }`;

const mfMap = (nodes) => Object.fromEntries((nodes || []).map((m) => [m.key, m.value]));

/** A Shopify product → the Add-product form's fields. See GET /similar. */
function asTemplate(p) {
  const mf = mfMap(p.metafields.nodes);
  const variants = p.variants.nodes.map((v) => ({
    ...v,
    mf: mfMap(v.metafields.nodes),
    size: v.selectedOptions.find((o) => /size/i.test(o.name))?.value,
  }));
  const first = variants[0] || { mf: {} };
  // One row per size, priced from the first variant that has it.
  const sizes = [...new Map(variants.filter((v) => v.size).map((v) => [v.size, v])).values()].map((v) => ({
    sizeLabel: v.mf.size_label || v.size,
    price: Number(v.price) || undefined,
    compareAtPrice: Number(v.compareAtPrice) || undefined,
    piecesPerPack: Number(v.mf.pieces_per_pack) || undefined,
  }));
  return {
    id: p.id, title: p.title, handle: p.handle, image: p.featuredImage?.url || null,
    fields: {
      category: p.productType || undefined,
      look: mf.look, finish: mf.finish, material: mf.material,
      flexibility: mf.flexibility, series: mf.series, pattern: mf.pattern, slipRating: mf.slip_rating,
      features: seo.asList(mf.features), applications: seo.asList(mf.application),
      installCaveats: seo.asList(mf.install_caveats),
      surface: seo.asList(mf.surface), useCases: seo.asList(mf.use_case),
      careMaintenance: mf.care_maintenance, installationGuide: mf.installation_guide,
      thicknessMm: Number(first.mf.thickness_mm) || undefined, packUnit: first.mf.pack_unit,
      sizes,
    },
  };
}

module.exports = async function (fastify) {
  /**
   * POST /create — a spec in, a Shopify product out.
   *
   * DRY RUN BY DEFAULT. Pass `?apply=1` to actually write. The plan you get back
   * from the dry run is built by the same function the real call uses, so what you
   * review is what gets created.
   *
   * Post the attributes, not the title: title, SEO title and meta description are
   * derived from the fields (see lib/productCreate.js for why that inversion matters).
   * Pass `title` explicitly only to override.
   */
  /**
   * POST /images/stage — one image into Shopify's staging bucket, attached to nothing.
   * Body: { data: base64 or data: URL, filename?, mimeType? } → { url }
   *
   * Called per image as it is dropped on the form, so the create call later carries
   * only URLs and never meets the body limit however many colours a product has.
   */
  fastify.post('/images/stage', async (req, reply) => {
    const { data, filename = 'image.jpg' } = req.body || {};
    const m = /^data:(image\/[a-z+.-]+);base64,/i.exec(data || '');
    const mimeType = m ? m[1] : req.body?.mimeType || 'image/jpeg';
    const b64 = m ? data.slice(m[0].length) : data;
    if (!b64 || typeof b64 !== 'string') {
      return reply.code(400).send({ success: false, error: 'data (base64 image) is required', code: 'no_image' });
    }
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) {
      return reply.code(400).send({ success: false, error: `${mimeType} is not a jpeg, png or webp`, code: 'bad_type' });
    }
    try {
      return { success: true, url: await stageImage(b64, String(filename).slice(0, 120), mimeType) };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /**
   * POST /describe — a description, installation guide and care text drafted from the
   * create form's attributes, before the product exists. Writes nothing.
   */
  fastify.post('/describe', async (req, reply) => {
    const b = req.body || {};
    const categoryId = resolveCategory({ productType: b.category, title: b.title });
    if (!categoryId) return reply.code(400).send({ success: false, error: 'pick a category first', code: 'bad_category' });
    try {
      const copy = await seo.generateCopy({
        kind: 'product', categoryId, category: b.category, title: b.title,
        look: b.look, material: b.material, finish: b.finish, thicknessMm: b.thicknessMm,
        size: (b.sizes || [])[0], applications: b.applications, colours: b.colours,
        features: b.features, flexibility: b.flexibility, installCaveats: b.installCaveats,
      });
      if (!copy.descriptionHtml) {
        return reply.code(503).send({ success: false, error: 'AI is not configured (GEMINI_API_KEY) — write the description by hand', code: 'no_ai' });
      }
      return { success: true, copy };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /**
   * GET /similar?q=leather — products to start a new one FROM. Read-only.
   *
   * Each match comes back already shaped as Add-product form fields (attributes,
   * sizes with their prices), so the form can copy them in one go. Colours and photos
   * are deliberately not copied: a new product is a new colourway or design, and
   * reusing another product's photos would put the wrong material on its page.
   */
  fastify.get('/similar', async (req, reply) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return { success: true, products: [] };
    try {
      const data = await adminGraphql(SIMILAR, { q: `title:*${q.replace(/["\\]/g, '')}*` });
      return { success: true, products: data.products.nodes.map(asTemplate) };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /**
   * GET /sku-taken?prefix=LAM-LTHR01- — is this product code already used? Read-only.
   * SKUs are CATEGORY-PRODUCT-SIZE-COLOUR-FINISH, so a reused PRODUCT code would give two
   * different products the same SKU the moment their size, colour and finish coincide.
   */
  fastify.get('/sku-taken', async (req, reply) => {
    const prefix = String(req.query.prefix || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (prefix.length < 4) return { success: true, taken: [] };
    try {
      const data = await adminGraphql(
        `query($q: String!) { productVariants(first: 5, query: $q) { nodes { sku product { title } } } }`,
        { q: `sku:${prefix}*` },
      );
      const taken = data.productVariants.nodes.filter((v) => (v.sku || '').toUpperCase().startsWith(prefix));
      return { success: true, taken: taken.map((v) => ({ sku: v.sku, product: v.product.title })) };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  fastify.post('/create', async (req, reply) => {
    const apply = req.query.apply === '1';
    try {
      const result = await createProduct(req.body || {}, { dryRun: !apply });
      const adminUrl = result.product && `https://${SHOP_DOMAIN}/admin/products/${result.product.id.split('/').pop()}`;
      return { success: true, ...result, adminUrl };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /**
   * GET /readiness — gate and score the catalogue.
   *
   * Query: ?limit=100&query=<shopify search>&blocked=1
   *
   * `blocked=1` narrows to the products that CANNOT be published, which is the only
   * list worth acting on first. Everything else is the score, and the score is advice.
   */
  fastify.get('/readiness', async (req, reply) => {
    try {
      const { limit = 100, query = null, blocked } = req.query || {};
      const { results, duplicateIndex } = await sweep({
        limit: Math.min(Number(limit) || 100, 500),
        query,
      });

      // Two counters, never added together — see lib/productReadiness.js. A product
      // that is blocked is not "a low score", and a 100 that is blocked is not ready.
      const byGate = {};
      for (const r of results) for (const g of r.gates) byGate[g.code] = (byGate[g.code] || 0) + 1;
      const scored = results.filter((r) => r.scored);

      return {
        success: true,
        scanned: results.length,
        publishable: results.filter((r) => r.publishable).length,
        blocked: results.filter((r) => r.scored && !r.publishable).length,
        unscored: results.length - scored.length,
        byGate,
        averageScore: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null,
        duplicateIndex,
        results: (blocked ? results.filter((r) => !r.publishable) : results).sort(
          // Blocked first, then worst-scoring. An unscored product sorts to the top of
          // its group: "we do not know" needs looking at before "we know it is a 40".
          (a, b) => Number(a.publishable) - Number(b.publishable) || (a.score ?? -1) - (b.score ?? -1),
        ),
      };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /**
   * GET /:id/readiness — gates and score for one product.
   * `id` is a numeric id, a `gid://shopify/Product/...` or a handle.
   */
  fastify.get('/:id/readiness', async (req, reply) => {
    try {
      const product = await fetchProduct(req.params.id);
      if (!product) return reply.code(404).send({ success: false, error: `product ${req.params.id} not found`, code: 'not_found' });
      return { success: true, ...(await assessProduct(product)) };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /**
   * POST /:id/publish — activate, publish and VERIFY, as one operation.
   *
   * APPLIES BY DEFAULT, unlike /create. Creating a catalogue row is something a
   * forgotten flag should never do by itself; publishing an existing one is an
   * explicit action an operator takes on a named product, and a write endpoint that
   * silently no-ops without a flag is one that gets `?apply=1` pasted into every
   * script until the flag means nothing.
   *
   * The safety here is the gates, not a flag. `?dryRun=1` returns them plus the
   * publication set it would write to, and writes nothing.
   *
   * Body: { publications?: ["Online Store", ...] } — names, defaulting to
   * SHOPIFY_PUBLICATION_NAMES. Never "all": see lib/productPublish.js for the
   * publication this store has that the API's own list does not return.
   */
  fastify.post('/:id/publish', async (req, reply) => {
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    try {
      const result = await publishProduct(req.params.id, {
        dryRun,
        ...(req.body?.publications ? { publications: [].concat(req.body.publications) } : {}),
      });
      return { success: true, ...result };
    } catch (err) {
      // The gates are the POINT of a 422 here — a caller that only reads `error`
      // learns nothing actionable, so they ride along in the body.
      return sendError(reply, req, err, err.code === 'gates_failed' ? { gates: err.gates } : {});
    }
  });

  // What can I ask for? Callers need the scene list before they can send
  // selectedScenes, and an operator needs to see which scenes a category shoots
  // by default without reading promptBuilder.js.
  fastify.get('/images/scenes', async () => ({
    categories: SCENE_CONFIG,
    scenes: Object.entries(SCENE_METADATA).map(([id, m]) => ({
      id,
      label: m.label,
      style: m.style,
      hint: m.prompt_hint,
      // These two get post-processed rather than shipped as the model returned
      // them — see lib/productImages/imageComposer.js.
      composited: COMPOSITED_SCENES.has(id),
    })),
  }));

  /**
   * POST /images/templates — every image that can be built from one flat swatch.
   *
   * NO MODEL CALL, no Shopify write, no cost. Milliseconds, not minutes: it is
   * arithmetic and pasting over the photo you post, which is why it is a separate
   * endpoint from /images/generate rather than a flag on it.
   *
   * Body: { photo: base64, sizeLabel?, thicknessMm?, cols?, repeats? }
   * Returns base64 JPEGs keyed by template id, plus `errors` for any that failed —
   * one bad template never costs you the others.
   *
   * A PREVIEW endpoint on purpose. Nothing is attached to a product; look at the
   * output, then decide. Wiring these into the pipeline so they replace paid scenes
   * is the next step, and it should be taken with eyes on real output first.
   */
  fastify.post('/images/templates', async (req, reply) => {
    const { photo, sizeLabel, thicknessMm, material, size, cols, repeats, features } = req.body || {};
    if (!photo || typeof photo !== 'string') {
      return reply.code(400).send({ success: false, error: 'photo (base64) is required', code: 'no_photo' });
    }
    try {
      const t0 = Date.now();
      const { images, errors, ...res } = await buildTemplates(photo, {
        sizeLabel,
        thicknessMm: Number(thicknessMm) || undefined,
        material,
        ...(size ? { size: Number(size) } : {}),
        ...(cols ? { cols: Number(cols) } : {}),
        ...(repeats ? { repeats: Number(repeats) } : {}),
        ...(Array.isArray(features) ? { features: features.map(String).slice(0, 4) } : {}),
      });
      return {
        success: true,
        ms: Date.now() - t0,
        cost: 0,
        // Named so the UI need not know which ids exist, and so a template added
        // later shows up without a front-end change.
        built: Object.keys(images),
        // Resolution, and whether the SOURCE PHOTO was the limit. A capped render is
        // a message about the supplier photo, not a setting to turn up.
        ...res,
        images,
        errors,
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ success: false, error: err.message });
    }
  });

  /**
   * POST /images/rectify — an angled photo in, a flat square-on swatch out.
   *
   * The precondition every template has and none of them enforced: they all assume a
   * flat, square-on swatch, and an angled photo produces confident nonsense. This
   * finds the tile's four corners and undoes the camera's perspective.
   *
   * Body: { photo: base64, sizeLabel?, max? }
   *
   * Returns `ok: false` with a reason rather than guessing — and a photo that is
   * ALREADY a flat swatch has no outline to find, which is the common good case, not
   * an error. The overlay comes back either way so the corners can be eyeballed.
   */
  fastify.post('/images/rectify', async (req, reply) => {
    const { photo, sizeLabel, max } = req.body || {};
    try {
      const t0 = Date.now();
      const result = await rectify(photo, { sizeLabel, max: Number(max) || undefined });
      return { success: true, ms: Date.now() - t0, cost: 0, ...result };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /* ── Room renders · the Cycles PDP pack ─────────────────────────────────────
     Three endpoints rather than one, because a render is a JOB.

     A three-shot pack is minutes of path tracing, which is past every proxy's idle
     timeout and well past a browser's patience. So POST queues and returns an id,
     GET polls it, and the images come back on the poll that finds it finished.
     Doing this as one synchronous POST was in the original brief with a 4.25-second
     example response, and that number is not reachable: a grazing specular
     reflection alone takes longer than that to converge at any usable sample count.

     There is no cheap fallback any more: /images/room-scene, the 50 ms photo
     composite, was removed. If Blender cannot run, there is no room shot. */

  /**
   * GET /images/room-blender — can this box render at all, and on what.
   *
   * Worth its own endpoint because the answer involves rendering a test frame, and
   * the UI wants to know before it offers the button. Cached after the first call.
   */
  fastify.get('/images/room-blender', async () => {
    const status = await blenderRoom.engineStatus();
    return {
      success: !status.code,
      ...status,
      shots: blenderRoom.SHOTS,
      samples: blenderRoom.SAMPLES,
      defaults: blenderRoom.DEFAULTS,
      jobs: blenderRoom.listJobs(),
    };
  });

  /**
   * POST /images/room-blender — queue a pack. Returns { id } immediately.
   *
   * Body: { swatch, sizeLabel?, widthMm?, heightMm?, finish?, pattern?, groutMm?,
   *         groutColor?, roomTemplate?, resolution?, shots?, seed? }
   */
  fastify.post('/images/room-blender', async (req, reply) => {
    try {
      const { id, queued } = blenderRoom.enqueue(req.body || {});
      // 202: accepted, not done. The id is the only thing that matters here.
      return reply.code(202).send({ success: true, id, queued, cost: 0 });
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  /**
   * GET /images/room-blender/:id — poll one job.
   *
   * `?images=1` reads the PNGs off disk and re-encodes them as JPEG. Left off by
   * default because a poll every two seconds does not want 20 MB of base64 in
   * every reply, and only the last one has anything to carry.
   */
  fastify.get('/images/room-blender/:id', async (req, reply) => {
    const job = await blenderRoom.jobStatus(req.params.id, req.query.images === '1');
    if (!job) {
      const err = new Error('no such render job — it may have expired');
      err.code = 'no_job';
      return sendError(reply, req, err);
    }
    return { success: true, ...job };
  });

  /**
   * The 3D studio shot — a real render, not a composite.
   *
   * GET  returns the tunable parameters and their defaults, so the UI can build its
   *      controls from the server rather than keeping a second copy of the list.
   * POST renders one image. Seconds, not milliseconds, and it needs a Chrome on the
   *      box — see lib/productImages/studio3d.js. Still no model call and no cost.
   *
   * Deliberately NOT part of /images/templates: that endpoint is milliseconds and
   * dependency-free, and folding a browser launch into it would make every caller pay
   * for a renderer most of them do not want.
   */
  fastify.get('/images/studio3d', async () => ({
    success: true,
    // The UI needs only the finishes; the lighting and camera are calibrated and
    // fixed. The full parameter set is still returned for anyone tuning by hand.
    finishes: Object.keys(STUDIO3D_ROUGHNESS),
    defaultFinish: 'matte',
    defaults: STUDIO3D_DEFAULTS,
    note: 'POST a base64 `photo` plus sizeLabel / thicknessMm / material / finish.',
  }));

  fastify.post('/images/studio3d', async (req, reply) => {
    const { photo, ...opts } = req.body || {};
    try {
      const { image, ms, renderer, config, trim } = await renderStudio3d(photo, opts);
      // `trim` reports a border removed from the swatch. Worth surfacing rather than
      // doing silently: a photo with white margins is a photo worth re-taking.
      return { success: true, ms, cost: 0, renderer, config, trim, image };
    } catch (err) {
      return sendError(reply, req, err);
    }
  });

  // The render browser outlives a single request on purpose — it is reused across
  // calls while someone tunes — so it has to be shut down with the service.
  fastify.addHook('onClose', async () => { await closeBrowser(); });

  // Minutes, not milliseconds: one call is a Vision request plus one image
  // generation per scene, each of which is seconds. Nothing here is a read.
  fastify.post('/images/generate', async (req, reply) => {
    try {
      return await generateProductImages(req.body || {}, req.log);
    } catch (err) {
      req.log.error(err);
      return reply.code(err.statusCode || 502).send({ error: err.message });
    }
  });
};
