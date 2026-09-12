/**
 * pipeline.js — orchestration for product image generation.
 *
 * Ported from glassquickdev/functions/generateProductImages/index.js, which was a
 * GCP Cloud Function handler with the pipeline inlined. Here the handler lives in
 * routes/products.js and this file is just the pipeline, so it can be called from
 * a cron job later without going through HTTP.
 *
 *   1. extractProductSpec  — Gemini Vision reads the uploaded photos → spec
 *   2. scene resolution     — SCENE_CONFIG[category], overridden by selectedScenes
 *   3. variant resolution   — uses the caller's variants, else asks Shopify
 *   4. generation           — Gemini image-to-image (product anchor + scene anchor)
 *   5. compositing          — scale bar / repeat preview (see imageComposer)
 *   6. Shopify upload       — staged upload → productUpdate(media:)
 *
 * NOT PORTED — the A/B path. The source could run a second prompt-generation
 * route through Claude (`claudePromptGenerator.js`, flags `abTest` / `claudeOnly`)
 * and upload both sets side by side with a `_claude` suffix to compare them. That
 * is an experiment harness, and carrying it here would double every branch in
 * this file — generateAndUpload / generateAndUploadClaude / generateBoth /
 * generateVariantScene all existed only to fan out over two prompt writers. One
 * path.
 */

const { adminGraphql } = require('../shopify');
const { extractProductSpec } = require('./specExtractor');
const { generateImage } = require('./imagenClient');
const { buildPrompt, makeScene, getScenesForCategory, COMPOSITED_SCENES } = require('./promptBuilder');
const { addScaleReference, compositeRepeatPreview } = require('./imageComposer');

// ─── Shopify ─────────────────────────────────────────────────────────────────
// The source POSTed base64 straight to REST /products/{id}/images.json. That
// endpoint does not exist on the API version this service pins (2026-01), so
// uploads go the modern way: stage → PUT the bytes → attach. Three calls instead
// of one, but it is the only route that still works.
//
// productCreateMedia is GONE in 2026-01 — verified by schema introspection
// against the live shop, which lists stagedUploadsCreate and
// productVariantAppendMedia but no productCreateMedia and no media-create
// mutation of any name. Attaching now goes through productUpdate's `media`
// argument, which takes the same CreateMediaInput.
//
// Still unverified END TO END: introspection proves the mutation exists and its
// input shape, not that a staged resourceUrl round-trips into a live image. That
// needs one real upload against the shop.

const STAGED_UPLOADS = `
  mutation stagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

const CREATE_MEDIA = `
  mutation createMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productUpdate(product: { id: $productId }, media: $media) {
      product { media(first: 1, reverse: true) { nodes { ... on MediaImage { id image { url } } } } }
      userErrors { field message }
    }
  }`;

const APPEND_MEDIA = `
  mutation appendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      userErrors { field message }
    }
  }`;

const PRODUCT_VARIANTS = `
  query productVariants($id: ID!) {
    product(id: $id) {
      id
      variants(first: 100) { nodes { id title selectedOptions { name value } } }
    }
  }`;

const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);

function firstError(errors, what) {
  if (errors && errors.length) throw new Error(`${what}: ${errors.map((e) => e.message).join('; ')}`);
}

/**
 * Uploads one generated image and attaches it to the product.
 * @returns {{ id: string, url: string|null }} media id, and url once Shopify has
 *   processed it — null on the immediate response, which is normal.
 */
async function uploadToShopify(base64Image, productGid, sceneId, alt) {
  const filename = `${sceneId}.jpg`;

  const staged = await adminGraphql(STAGED_UPLOADS, {
    input: [{ filename, mimeType: 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST' }],
  });
  firstError(staged.stagedUploadsCreate.userErrors, 'stagedUploadsCreate');
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error('stagedUploadsCreate returned no target');

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([Buffer.from(base64Image, 'base64')], { type: 'image/jpeg' }), filename);

  const put = await fetch(target.url, { method: 'POST', body: form });
  if (!put.ok) throw new Error(`Staged upload ${put.status}: ${(await put.text()).slice(0, 200)}`);

  const created = await adminGraphql(CREATE_MEDIA, {
    productId: productGid,
    media: [{ originalSource: target.resourceUrl, alt, mediaContentType: 'IMAGE' }],
  });
  firstError(created.productUpdate.userErrors, 'productUpdate(media:)');

  // productUpdate returns the product, not the media it just attached, so the new
  // image is read back as the most recent one. `reverse: true` takes the newest —
  // media(first:1) alone returns the OLDEST and every upload would report the
  // product's original photo as its result.
  const media = created.productUpdate.product?.media?.nodes?.[0];
  if (!media) throw new Error('productUpdate(media:) attached nothing');
  return { id: media.id, url: media.image?.url || null };
}

async function assignToVariants(productGid, mediaId, variantIds) {
  if (!variantIds || !variantIds.length) return;
  const res = await adminGraphql(APPEND_MEDIA, {
    productId: productGid,
    variantMedia: variantIds.map((id) => ({ variantId: gid('ProductVariant', id), mediaIds: [mediaId] })),
  });
  firstError(res.productVariantAppendMedia.userErrors, 'productVariantAppendMedia');
}

/**
 * Flattens a product's variants to { option, value, ids[] }, deduped.
 *
 * Kept from the source: without the dedupe, a product with 3 sizes × 2 finishes
 * generates 6 images where 5 are duplicates. Material's setup script makes Size
 * the option, so in practice this collapses to one row per size.
 */
async function fetchShopifyVariants(productGid) {
  const data = await adminGraphql(PRODUCT_VARIANTS, { id: productGid });
  const nodes = data.product?.variants?.nodes || [];

  const byKey = new Map();
  for (const variant of nodes) {
    for (const { name, value } of variant.selectedOptions || []) {
      if (!name || !value || value === 'Default Title') continue;
      const option = name.toLowerCase();
      const key = `${option}::${value}`;
      if (!byKey.has(key)) byKey.set(key, { option, value, ids: [] });
      byKey.get(key).ids.push(variant.id);
    }
  }
  return [...byKey.values()];
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * @param {object} input
 * @param {string}   input.productId            Shopify product ID, numeric or gid
 * @param {string[]} input.productImages        base64 photos of the surface, no data: prefix
 * @param {string}   [input.category]           Tiles | Laminates | Wallpaper
 * @param {object}   [input.metafields]         known specs; these beat anything Vision reads
 * @param {string[]} [input.selectedScenes]     override the category's scene list
 * @param {object}   [input.sceneReferenceImages] sceneId → base64 style anchor
 * @param {Array}    [input.shopifyVariants]    [{ option, value, ids }] — fetched if absent
 * @param {string}   [input.title]              extra context for Vision
 * @param {string}   [input.description]
 */
async function generateProductImages(input = {}, log = console) {
  const {
    productId,
    productImages,
    category = null,
    metafields = {},
    selectedScenes,
    sceneReferenceImages = {},
    shopifyVariants = [],
    title,
    description,
  } = input;

  if (!productId || !String(productId).trim()) throw badRequest('productId is required.');
  if (!Array.isArray(productImages) || productImages.length === 0) {
    throw badRequest('productImages must be a non-empty array of base64 strings.');
  }

  const productGid = gid('Product', String(productId).trim());
  log.info?.(`[img-gen] START product=${productGid} category=${category} images=${productImages.length}`);

  // ── 1. Spec ────────────────────────────────────────────────────────────────
  const spec = await extractProductSpec(productImages, 'image/jpeg', {
    category,
    metafields,
    title,
    description,
  }).catch((err) => {
    const e = new Error(`Failed to analyse product photos: ${err.message}`);
    e.statusCode = 502;
    throw e;
  });

  // Supplier data beats a model's reading of a photo, every time. The source did
  // this for its three glass fields; these are Material's, from
  // setup-product-model.mjs plus the size label.
  for (const key of ['finish', 'material', 'look', 'colour', 'thickness_mm', 'size', 'surface', 'application']) {
    const v = metafields[key];
    const val = v && typeof v === 'object' && !Array.isArray(v) ? v.value : v;
    if (val !== undefined && val !== null && val !== '') spec[key] = val;
  }

  // Never AI-guessed: the base size comes from metafields or not at all.
  const baseSize = spec.size && spec.size !== 'unknown' ? spec.size : null;

  // ── 2. Scenes ──────────────────────────────────────────────────────────────
  const sceneIds = getScenesForCategory(category, selectedScenes);
  log.info?.(`[img-gen] scenes=[${sceneIds.join(', ')}]`);

  // ── 3. Variants ────────────────────────────────────────────────────────────
  let variants = shopifyVariants;
  if (!variants.length || variants.some((v) => !v.ids && !v.id)) {
    variants = await fetchShopifyVariants(productGid).catch((err) => {
      log.warn?.(`[img-gen] variant fetch failed: ${err.message} — proceeding without variants`);
      return [];
    });
  }
  const sizeVariants = variants.filter((v) => v.option === 'size');

  // ── 4/5/6. Generate → composite → upload ───────────────────────────────────
  const defaultImages = {};
  const variantImages = {};
  const errors = {};

  /**
   * ponytail: a failed composite degrades to the raw render rather than losing
   * the scene. Today that is EVERY composite, because imageComposer has no
   * raster library — so scale_reference and repeat_preview currently ship as
   * plain single-unit / single-repeat shots with no bar and no tiling. They are
   * still useful images. Install sharp and they light up with no change here.
   */
  async function composite(sceneId, b64, sizeValue) {
    try {
      if (sceneId === 'scale_reference') return await addScaleReference(b64, sizeValue);
      if (sceneId === 'repeat_preview') return await compositeRepeatPreview(b64, 3);
    } catch (err) {
      log.warn?.(`[img-gen] composite skipped for ${sceneId}: ${err.message}`);
    }
    return b64;
  }

  async function generateAndUpload(sceneId, sizeValue, variantIds, errorKey) {
    try {
      const scene = makeScene(sceneId);
      const prompt = buildPrompt(spec, scene, { sizeValue, category });
      const raw = await generateImage(prompt, productImages[0], sceneReferenceImages[sceneId] || null);
      const finished = await composite(sceneId, raw, sizeValue);

      const media = await uploadToShopify(finished, productGid, errorKey, scene.label);
      await assignToVariants(productGid, media.id, variantIds);

      log.info?.(`[img-gen] ok ${errorKey} → ${media.id}`);
      return media;
    } catch (err) {
      log.error?.(`[img-gen] fail ${errorKey}: ${err.message}`);
      errors[errorKey] = err.message;
      return null;
    }
  }

  for (const sceneId of sceneIds) {
    // A scale reference is the one scene whose content genuinely changes with the
    // size chosen, so it is regenerated per size variant and pinned to those
    // variants — the same treatment the source gave measurement_view.
    if (sceneId === 'scale_reference' && sizeVariants.length) {
      for (const variant of sizeVariants) {
        const key = `scale_reference_${variant.value.replace(/\s+/g, '_')}`;
        const media = await generateAndUpload(sceneId, variant.value, variant.ids || [variant.id], key);
        if (media) {
          variantImages[variant.value] = variantImages[variant.value] || {};
          variantImages[variant.value][sceneId] = media.url || media.id;
        }
      }
      continue;
    }

    const media = await generateAndUpload(sceneId, baseSize, [], sceneId);
    if (media) defaultImages[sceneId] = media.url || media.id;
  }

  log.info?.(
    `[img-gen] DONE default=${Object.keys(defaultImages).length} ` +
      `variant=${Object.keys(variantImages).length} errors=${Object.keys(errors).length}`,
  );

  return { spec, scenes: sceneIds, defaultImages, variantImages, errors };
}

module.exports = { generateProductImages, fetchShopifyVariants, uploadToShopify };
