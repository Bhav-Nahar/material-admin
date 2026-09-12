/**
 * specExtractor.js — Gemini Vision reads the uploaded product photos and returns
 * a structured spec.
 *
 * Ported from glassquickdev/functions/generateProductImages/specExtractor.js.
 * The call mechanics are the source's; the schema is entirely Material's. The
 * source extracted glass fields (frame, has_LED, led_color_options, shape,
 * approx_width_cm) — none of which mean anything for a surface.
 *
 * Fields and value vocabularies come from
 *   material-frontend/scripts/setup-product-model.mjs   (the 11 live metafields)
 *   Material-Metafield-Research.html §4–§8               (confirmed value lists)
 *
 * The vocabularies are per-category on purpose: research §6 records that Depot's
 * finish list has 33 values in tiles and 12 in laminates with almost no overlap,
 * and that wallpaper has no finish facet at all. Handing the model one merged
 * list would invite a laminate "Suede" finish onto a tile.
 *
 * The source's schema.js is folded in here as PRODUCT_SPEC_DEFAULTS — 90 lines of
 * JSDoc'd defaults did not need their own file.
 *
 * Env: GOOGLE_AI_API_KEY (required), GEMINI_MODEL (optional).
 */

const { normaliseCategory } = require('./promptBuilder');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Read lazily, not at require time, so the module loads in tests and in a process
// that never calls it.
const apiKey = () => process.env.GOOGLE_AI_API_KEY;

const PRODUCT_SPEC_DEFAULTS = {
  product_type: 'surface material', // "floor tile", "decorative laminate", "wallpaper roll"
  material: 'unknown', // substrate — Vitrified, Acrylic, Non-woven…
  finish: 'unknown', // Matte, Texture, High Gloss… (empty for wallpaper)
  look: 'unknown', // Marble, Wood, Terrazzo, Wooden Effect, Floral…
  colour: 'unknown', // shade name as seen, e.g. "Nordic Honey"
  texture_description: '', // free text; the one field that most improves the render
  thickness_mm: 0,
  size: 'unknown', // display label, e.g. "1200 x 600 mm", "8 ft x 4 ft"
  surface: 'unknown', // Floor | Wall | Both | Ceiling | Exterior
  application: [], // Living room, Bedroom, Kitchen, Bathroom…
};

// Confirmed values per category — Material-Metafield-Research.html §5, §6, §7.
const VOCAB = {
  tiles: {
    material: ['Vitrified', 'Ceramic', 'Porcelain', 'Full-body Vitrified', 'Glass'],
    finish: ['Matte', 'Glossy', 'High Gloss', 'Carving Matte', 'Glue Matte'],
    look: ['Marble', 'Cement', 'Wood', 'Terrazzo', 'Zellige', 'Stone', 'Fabric', 'Metallic'],
    sizeHint: 'millimetres, e.g. "1200 x 600 mm", "600 x 600 mm", "300 x 300 mm"',
  },
  laminates: {
    material: ['Acrylic', 'ASA', 'PVC', 'PETG', 'WPC Fibre', 'Decorative laminate'],
    finish: ['Texture', 'High Gloss', 'Suede', 'Matte', 'Glossy'],
    look: ['Wooden Effect', 'Plain Solids', 'Marbles & Stones', 'Geometric & Abstracts', 'Fluted'],
    sizeHint: 'feet, almost always "8 ft x 4 ft"',
  },
  wallpaper: {
    material: ['Non-woven', 'PVC', 'Canvas', 'Handmade', 'Soft Feel'],
    finish: [], // §7: wallpaper has no finish facet
    look: ['Plain & textured', 'Floral', 'Geometric', 'Mural'],
    sizeHint: 'roll dimensions in millimetres, e.g. "10000 x 550 mm", "5000 x 1050 mm"',
  },
  default: { material: [], finish: [], look: [], sizeHint: 'as printed on the product or packaging' },
};

const SURFACE_VALUES = ['Floor', 'Wall', 'Both', 'Ceiling', 'Exterior'];
const APPLICATION_VALUES = [
  'Living room',
  'Bedroom',
  'Kitchen',
  'Bathroom',
  'Balcony',
  'Outdoor',
  'Office',
  'Wardrobe',
  'Kitchen shutters',
  'Wall panelling',
];

const SYSTEM_INSTRUCTION_TEXT =
  'You are a product analyst for an Indian interior-surfaces e-commerce store selling tiles, ' +
  'laminates and wallpaper. Your job is to look at one or more product photos (and any provided ' +
  'product details) and return a structured JSON spec describing the SURFACE itself — its material, ' +
  'colour, texture, finish and format — not the room it might be photographed in. ' +
  'When multiple photos are provided, merge observations from all images into one unified spec — ' +
  'they show the same product. ' +
  'When product context is provided, trust it over your own reading of the photo: it comes from the ' +
  'supplier, your reading does not. ' +
  'Return ONLY valid JSON — no markdown, no explanation, no code fences. ' +
  'Never use null — use [] for arrays, 0 for numbers, "unknown" for uncertain strings.';

function list(values) {
  return values.length ? values.join(' | ') + ' | or describe if none fit' : 'leave as "unknown"';
}

function jsonSchemaFor(categoryKey) {
  const v = VOCAB[categoryKey] || VOCAB.default;
  return `
{
  "product_type": "string — what this is, e.g. 'floor tile', 'wall tile', 'decorative laminate sheet', 'wallpaper roll'",
  "material": "string — substrate, NOT the look it imitates: ${list(v.material)}",
  "finish": "string — surface finish: ${list(v.finish)}",
  "look": "string — the design the surface imitates: ${list(v.look)}",
  "colour": "string — the shade name as you would print it on a label, e.g. 'Nordic Honey', 'Carrara White'",
  "texture_description": "string — one sentence describing the physical surface: relief, grain, veining, gloss, pattern scale. This drives the generated imagery, so be concrete.",
  "thickness_mm": number — thickness in millimetres, 0 if not visible,
  "size": "string — unit size in ${v.sizeHint}, 'unknown' if not visible",
  "surface": "string — where it is installed: ${SURFACE_VALUES.join(' | ')}",
  "application": ["array of rooms or uses this suits, from: ${APPLICATION_VALUES.join(', ')}"]
}`.trim();
}

/** Builds the user prompt, injecting whatever product context the caller has. */
function buildUserPrompt(context = {}) {
  const lines = [];
  const { title, description, metafields, category } = context;

  if (category) lines.push(`PRODUCT CATEGORY: ${category}`, '');

  if (title || description || (metafields && Object.keys(metafields).length > 0)) {
    lines.push('PRODUCT CONTEXT (authoritative — prefer it over your reading of the photos):');
    if (title) lines.push(`- Product title: ${title}`);
    if (description) {
      const plain = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (plain) lines.push(`- Description: ${plain}`);
    }
    if (metafields && Object.keys(metafields).length > 0) {
      lines.push('- Known product specifications:');
      for (const [key, value] of Object.entries(metafields)) {
        const val = value && typeof value === 'object' && !Array.isArray(value) ? value.value : value;
        if (val !== undefined && val !== null && val !== '') {
          lines.push(`    ${key}: ${String(Array.isArray(val) ? val.join(', ') : val).slice(0, 200)}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(
    'Analyse all provided product photos (they show the same surface) and return a single JSON object with EXACTLY these fields:',
    '',
    jsonSchemaFor(normaliseCategory(category)),
    '',
    'Output only the raw JSON object. No code fences, no commentary, no extra keys.',
  );

  return lines.join('\n');
}

/**
 * Extracts a product spec from one or more base64-encoded product images.
 * All images go in a single request — Gemini merges them into one spec.
 *
 * @param {string|string[]} productImages — base64 strings, no "data:" prefix
 * @param {string} [mimeType]
 * @param {object} [context] — { category, title, description, metafields }
 * @returns {Promise<typeof PRODUCT_SPEC_DEFAULTS>}
 */
async function extractProductSpec(productImages, mimeType = 'image/jpeg', context = {}) {
  if (!apiKey()) throw new Error('GOOGLE_AI_API_KEY env var is not set');

  const images = Array.isArray(productImages) ? productImages : [productImages];
  if (images.length === 0) throw new Error('productImages must not be empty');

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${apiKey()}`;

  const requestBody = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION_TEXT }] },
    contents: [
      {
        role: 'user',
        // Images first as visual context, then the instruction.
        parts: [...images.map((data) => ({ inlineData: { mimeType, data } })), { text: buildUserPrompt(context) }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      // thinkingBudget 0: stops billed thinking tokens eating the output budget
      // (MAX_TOKENS truncation → parse failure → wasted paid call).
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) throw new Error(`Gemini Vision API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error(`Gemini returned no text. Response: ${JSON.stringify(data).slice(0, 300)}`);

  const jsonMatch = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim().match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not find JSON in Gemini response.\nRaw: ${rawText.slice(0, 300)}`);

  let spec;
  try {
    spec = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`JSON parse failed: ${err.message}\nExtracted: ${jsonMatch[0].slice(0, 300)}`);
  }

  return {
    ...PRODUCT_SPEC_DEFAULTS,
    ...spec,
    thickness_mm: Number(spec.thickness_mm) || 0,
    application: Array.isArray(spec.application) ? spec.application : [],
  };
}

module.exports = { extractProductSpec, PRODUCT_SPEC_DEFAULTS, VOCAB };
