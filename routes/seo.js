/**
 * routes/seo.js — SEO copy generation, write-back and audit.
 *
 * Ported from glassquickdev/admin-server/routes/seo.js, which is 3,002 lines and 30
 * endpoints. This is five. What was cut and why:
 *
 *   • /bootstrap-definitions, /repair-definitions, /definitions (3 routes, ~200 lines)
 *     — created and repaired sixteen `seo.*` metafield definitions. Material does not
 *     have an `seo` namespace: meta title and description are NATIVE Shopify fields,
 *     and every other metafield is declared in material-frontend/scripts/setup-product-model.mjs.
 *     A second service creating definitions behind that script's back is how two
 *     sources of truth start.
 *   • /products, /collections, /product/:gid, /collection/:gid, /routes, /route
 *     (6 routes, ~250 lines) — paginated list-and-detail reads for the admin UI's
 *     table. An API-first service has no table. /audit already returns the only
 *     derived thing those endpoints added.
 *   • /robots (GET+POST), /generate-sitemap (~150 lines plus XML builders and GCS
 *     read/write) — material-frontend/src/app/robots.js and sitemap.js already do
 *     this, from Shopify, at request time. robots.js documents why there is exactly
 *     one wildcard group and sitemap.js why the two files must list the same
 *     disallow set. A second writer putting a static robots.txt in a bucket would
 *     silently win or silently lose depending on hosting. configuration/robots-config.json
 *     was therefore NOT ported: the frontend covers it.
 *   • /psi (~90 lines) — PageSpeed Insights with a 24-hour in-process Map cache that
 *     every restart drops and no second instance shares. Lighthouse in CI, or a call
 *     to the same public API from wherever the result is actually read.
 *   • /scan-bad-urls, /fix-bad-urls, /fix-page-urls, /fix-product-schema (~250 lines)
 *     — all four exist to repair damage from the LLM writing raw HTML with invented
 *     links and invented `offers` nodes into metafields. Here the model never writes
 *     a link or a schema node: descriptionHtml is the only HTML it produces, and
 *     material-frontend renders Product JSON-LD itself
 *     (src/app/(shop)/products/[handle]/page.js). No damage, no repair endpoints.
 *   • /autolink (~40 lines) plus autoLinkPageDescription/sanitizeHtmlLinks/
 *     normalizeInternalUrl (~110 lines) — wove internal links into generated copy
 *     against a hand-maintained keyword→path table. Same reason.
 *   • /generate-offpage, /knowledge-bank GET+POST (~90 lines) — guest posts, press
 *     releases and an editable brand knowledge bank. That is a content-marketing
 *     tool, not SEO plumbing.
 *   • 4 of the 5 /gsc/* routes — /submit-index, /pages-performance, /inspect and
 *     /connection-status. One read endpoint is kept; the rest can come back when
 *     something calls them.
 *   • Every demo-data fallback (~55 lines). getDemoGscPerformance invented clicks and
 *     impressions, getDemoInspection returned a canned "Indexed / PASS / PASS", and
 *     the Node generator variant fabricated whole marketing paragraphs on a 429. All
 *     three returned fiction under a flag callers had to remember to check. Here an
 *     unconfigured integration is a 503 and a failed generation is a 500.
 *   • The second LLM pass (generateLongPageDescription, ~110 lines) — one Gemini call
 *     per section group, up to three per entity, each fed the previous sections to
 *     avoid repeating itself. Three paid calls to write one page of copy.
 *
 * The source has NO scheduled job — no cron secret, no scheduler header, no /cron/
 * path anywhere in its 3,002 lines. The cron route below is therefore new rather than
 * ported, and it is deliberately the safe half of the work: it applies only DERIVED
 * copy, built from attributes already stored in Shopify, and never calls the model.
 */

const { adminGraphql } = require('../lib/shopify');
const { requireCronSecret, detach } = require('../lib/cronAuth');
const { getGscAccessToken, gscSiteUrl } = require('../lib/gscAuth');
const seo = require('../lib/seoGenerator');

/* ── Shopify ──────────────────────────────────────────────────────────────── */

const PRODUCT_FIELDS = `
  id handle title productType tags descriptionHtml
  seo { title description }
  metafields(first: 20, namespace: "custom") { nodes { key value } }
  variants(first: 1) {
    nodes { sku selectedOptions { name value } metafields(first: 10, namespace: "custom") { nodes { key value } } }
  }
`;

const COLLECTION_FIELDS = `id handle title descriptionHtml seo { title description }`;

// `query: "handle:x"` rather than productByIdentifier/collectionByHandle: it is the
// one lookup spelled the same way on every API version, and both entities support it.
const BY_HANDLE = (root, fields) => `
  query ByHandle($q: String!) { ${root}(first: 1, query: $q) { nodes { ${fields} } } }
`;
const BY_ID = (root, fields) => `
  query ById($id: ID!) { ${root}(id: $id) { ${fields} } }
`;

// `product: ProductUpdateInput` rather than the older `input: ProductInput`, matching
// lib/productImages/pipeline.js. That argument needs SHOPIFY_API_VERSION at 2025-01 or
// later — .env.example already pins 2026-01 for exactly this reason, but lib/shopify.js
// still defaults to 2024-10 where the write would fail with an unknown-argument error.
const PRODUCT_UPDATE = `
  mutation ProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id } userErrors { field message } }
  }
`;

const COLLECTION_UPDATE = `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) { collection { id } userErrors { field message } }
  }
`;

const METAFIELDS_SET = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message } }
  }
`;

// adminGraphql throws on transport and top-level GraphQL errors but cannot know that a
// mutation payload carries its own errors. A userError here means the write did not
// happen, so it must not return 200.
function assertNoUserErrors(payload, label) {
  const errors = payload?.userErrors || [];
  if (errors.length) throw new Error(`${label}: ${errors.map((e) => e.message).join('; ')}`);
  return payload;
}

async function fetchEntity(kind, ref) {
  const isProduct = kind !== 'collection';
  const root = isProduct ? 'products' : 'collections';
  const fields = isProduct ? PRODUCT_FIELDS : COLLECTION_FIELDS;

  if (String(ref).startsWith('gid://')) {
    const data = await adminGraphql(BY_ID(isProduct ? 'product' : 'collection', fields), { id: ref });
    return data[isProduct ? 'product' : 'collection'] || null;
  }
  const data = await adminGraphql(BY_HANDLE(root, fields), { q: `handle:${ref}` });
  return data[root]?.nodes?.[0] || null;
}

const toFields = (kind, node) =>
  kind === 'collection' ? seo.fieldsFromCollection(node) : seo.fieldsFromProduct(node);

/**
 * Write generated copy back.
 *
 * Meta title and description are native Shopify SEO fields. descriptionHtml is only
 * touched when explicitly asked for, because overwriting hand-written body copy with
 * generated copy is not a thing to do by default. installation_guide and
 * care_maintenance go to `custom` — the namespace and keys are exactly those in
 * material-frontend/scripts/setup-product-model.mjs, which owns the definitions.
 */
async function applyCopy(kind, id, copy, { body = false } = {}) {
  const written = [];

  if (kind === 'collection') {
    const input = { id, seo: { title: copy.seoTitle, description: copy.seoDescription } };
    if (body && copy.descriptionHtml) input.descriptionHtml = copy.descriptionHtml;
    assertNoUserErrors((await adminGraphql(COLLECTION_UPDATE, { input })).collectionUpdate, 'collectionUpdate');
    return ['seo.title', 'seo.description', ...(input.descriptionHtml ? ['descriptionHtml'] : [])];
  }

  const product = { id, seo: { title: copy.seoTitle, description: copy.seoDescription } };
  if (body && copy.descriptionHtml) product.descriptionHtml = copy.descriptionHtml;
  assertNoUserErrors((await adminGraphql(PRODUCT_UPDATE, { product })).productUpdate, 'productUpdate');
  written.push('seo.title', 'seo.description', ...(product.descriptionHtml ? ['descriptionHtml'] : []));

  const metafields = [
    copy.installationGuide && { key: 'installation_guide', value: copy.installationGuide },
    copy.careMaintenance && { key: 'care_maintenance', value: copy.careMaintenance },
  ]
    .filter(Boolean)
    .map((m) => ({ ...m, namespace: 'custom', type: 'multi_line_text_field', ownerId: id }));

  if (metafields.length) {
    assertNoUserErrors((await adminGraphql(METAFIELDS_SET, { metafields })).metafieldsSet, 'metafieldsSet');
    written.push(...metafields.map((m) => `custom.${m.key}`));
  }
  return written;
}

/** Page the catalogue, scoring as it goes. Stops at `limit`; never loops unbounded. */
async function scan(kind, { limit = 100, query = null } = {}) {
  const isProduct = kind !== 'collection';
  const root = isProduct ? 'products' : 'collections';
  const fields = isProduct ? PRODUCT_FIELDS : COLLECTION_FIELDS;
  const PAGE = `
    query Scan($first: Int!, $after: String, $q: String) {
      ${root}(first: $first, after: $after, query: $q) {
        nodes { ${fields} }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const results = [];
  let after = null;
  // 25 a page: PRODUCT_FIELDS nests variants and two metafield connections, and
  // Shopify's cost budget is per query, not per node.
  while (results.length < limit) {
    const data = await adminGraphql(PAGE, {
      first: Math.min(25, limit - results.length),
      after,
      q: query,
    });
    const page = data[root];
    for (const node of page.nodes) results.push({ node, fields: toFields(kind, node) });
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return results;
}

/* ── routes ───────────────────────────────────────────────────────────────── */

module.exports = async function (fastify) {
  /**
   * POST /generate — copy for one product or collection. Writes nothing.
   * Body: { id | handle, kind?: 'product'|'collection', ai?: boolean }
   */
  fastify.post('/generate', async (request, reply) => {
    const { id, handle, kind = 'product', ai = true } = request.body || {};
    const ref = id || handle;
    if (!ref) return reply.code(400).send({ success: false, error: 'id or handle is required' });

    const node = await fetchEntity(kind, ref);
    if (!node) return reply.code(404).send({ success: false, error: `${kind} ${ref} not found` });

    const fields = toFields(kind, node);
    const copy = await seo.generateCopy(fields, { ai });
    return {
      success: true,
      id: node.id,
      handle: node.handle,
      kind,
      llmConfigured: seo.llmConfigured(),
      copy,
      audit: seo.auditFields(fields),
    };
  });

  /**
   * POST /apply — write copy to Shopify.
   * Body: { id | handle, kind?, ai?, body?: boolean, copy?: {...} }
   *
   * `copy` lets an operator edit what /generate returned before it lands, which is
   * the review step the source's editor UI provided. Omit it and this regenerates.
   */
  fastify.post('/apply', async (request, reply) => {
    const { id, handle, kind = 'product', ai = true, body = false, copy: override } = request.body || {};
    const ref = id || handle;
    if (!ref) return reply.code(400).send({ success: false, error: 'id or handle is required' });

    const node = await fetchEntity(kind, ref);
    if (!node) return reply.code(404).send({ success: false, error: `${kind} ${ref} not found` });

    const fields = toFields(kind, node);
    const copy = { ...(await seo.generateCopy(fields, { ai: ai && !override })), ...(override || {}) };
    if (!copy.seoTitle || !copy.seoDescription) {
      return reply.code(422).send({ success: false, error: 'seoTitle and seoDescription are both required' });
    }

    const written = await applyCopy(kind, node.id, copy, { body });
    return { success: true, id: node.id, handle: node.handle, kind, written, copy };
  });

  /**
   * GET /audit — what is missing SEO fields.
   * Query: ?kind=product|collection&limit=100&failing=1&query=<shopify search>
   */
  fastify.get('/audit', async (request) => {
    const { kind = 'product', limit = 100, failing, query = null } = request.query || {};
    const rows = await scan(kind, { limit: Math.min(Number(limit) || 100, 500), query });
    const audited = rows.map((r) => seo.auditFields(r.fields));

    const byIssue = {};
    for (const row of audited) for (const issue of row.issues) byIssue[issue.id] = (byIssue[issue.id] || 0) + 1;

    return {
      success: true,
      kind,
      scanned: audited.length,
      averageScore: audited.length
        ? Math.round(audited.reduce((s, r) => s + r.score, 0) / audited.length)
        : 100,
      byReadiness: audited.reduce((acc, r) => ({ ...acc, [r.readiness]: (acc[r.readiness] || 0) + 1 }), {}),
      byIssue,
      results: (failing ? audited.filter((r) => r.issues.length) : audited).sort((a, b) => a.score - b.score),
    };
  });

  /**
   * GET /gsc/queries — top Search Console queries for the property.
   *
   * The one GSC read kept from the source's five. Unlike the source it does NOT
   * substitute demo data when unconfigured or failing: invented impression counts
   * that look real are worse than a 503.
   */
  fastify.get('/gsc/queries', async (request, reply) => {
    const token = await getGscAccessToken();
    if (!token) {
      return reply
        .code(503)
        .send({ success: false, error: 'Search Console not configured — set GSC_SERVICE_ACCOUNT_JSON' });
    }

    const days = Math.min(Number(request.query?.days) || 28, 480);
    const iso = (d) => d.toISOString().slice(0, 10);
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSiteUrl())}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: iso(new Date(Date.now() - days * 86400_000)),
          endDate: iso(new Date()),
          dimensions: ['query'],
          rowLimit: Math.min(Number(request.query?.limit) || 25, 500),
          ...(request.query?.page ? { dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: request.query.page }] }] } : {}),
        }),
      },
    );

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      return reply.code(502).send({
        success: false,
        error: `Search Console ${res.status}: ${payload?.error?.message || 'request failed'}`,
      });
    }

    return {
      success: true,
      site: gscSiteUrl(),
      days,
      queries: (payload?.rows || []).map((r) => ({
        query: r.keys?.[0],
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })),
    };
  });

  /**
   * POST /cron/seo-backfill — give every product missing a meta title or description
   * a derived one.
   *
   * Applies unconditionally, per lib/cronAuth.js. Safe to run unattended precisely
   * because it never calls the model: the copy is a template over attributes already
   * in Shopify, so the worst case is a plain title, not a fabricated claim. It also
   * never touches descriptionHtml or an entity that already has both fields.
   */
  fastify.post('/cron/seo-backfill', { preHandler: requireCronSecret }, (request, reply) =>
    detach(reply, fastify.log, 'seo-backfill', async () => {
      const limit = Number(process.env.SEO_BACKFILL_LIMIT || 250);
      const rows = await scan('product', { limit });
      const missing = rows.filter((r) => !r.fields.currentSeoTitle || !r.fields.currentSeoDescription);

      let applied = 0;
      const failures = [];
      for (const { fields } of missing) {
        try {
          await applyCopy('product', fields.id, seo.derive(fields));
          applied += 1;
        } catch (err) {
          failures.push({ handle: fields.handle, error: err.message });
        }
      }
      return { scanned: rows.length, missing: missing.length, applied, failures };
    }),
  );
};
