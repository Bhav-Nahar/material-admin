/**
 * promptBuilder.js — scene catalogue + prompt assembly.
 *
 * Ported from glassquickdev/functions/generateProductImages/promptBuilder.js.
 * The structure is the source's — a config map (category -> ordered scene list),
 * a resolver, and per-scene style anchors — but every scene is new. The source's
 * scenes were glass: washroom mirrors, shower enclosures, office partitions,
 * staircase railings, entrance nameplates, LED-on shots. None of that applies to
 * a company selling tiles, laminates and wallpaper, so the whole catalogue is
 * replaced rather than extended.
 *
 * Also dropped with the glass scenes: the `has_LED` / `led_color_options` prompt
 * branch and the AI-drawn `measurement_view`. Sizes here are locked from
 * metafields or the variant value, never guessed by the model.
 */

// ─── Style anchors — one paragraph per scene family ───────────────────────────
// The source classified scenes by sniffing substrings out of the scene ID
// (`id.includes('bathroom')`, `id.includes('led')`, …) through a 60-line
// if/else. Same idea, but each scene names its family explicitly: adding a scene
// is a data change, and a typo in an ID can no longer silently fall through to
// the generic branch.

const STYLE = {
  swatch:
    'Flat-lay macro photography, camera perfectly perpendicular to the surface. ' +
    'Raking side light so texture, grain, gloss and relief are all readable. ' +
    'The surface fills the entire frame edge to edge. No room, no props, no perspective. ' +
    'Ultra-realistic, 4K resolution.',

  scale:
    'One single unit of the product photographed square-on, flat against a plain ' +
    'light-grey background, all four edges fully visible inside the frame with even margins. ' +
    'Soft even studio lighting, no strong shadows, no props, no perspective distortion. ' +
    'Ultra-realistic, 4K resolution.',

  repeat:
    'One clean repeat unit of the pattern, photographed square-on and filling the frame exactly, ' +
    'so that copies of this image placed edge to edge would line up seamlessly. ' +
    'Flat even lighting with no vignette, no gradient across the frame, no shadow falloff at the edges. ' +
    'Ultra-realistic, 4K resolution.',

  room:
    'Professional interior photography. The surface is installed and covers a large ' +
    'continuous area of the room, shown at a natural viewing angle and realistic scale. ' +
    'Soft natural daylight with warm ambient fill, no people, no brand logos. ' +
    'Furniture and props are minimal and neutral — they set the scale, they are not the subject. ' +
    'Ultra-realistic, 4K resolution.',

  outdoor:
    'Architectural photography in natural daylight, shot outdoors. ' +
    'The surface covers a large continuous area, wet-look free and true to colour under sunlight. ' +
    'Open sky or greenery visible for context, no people. ' +
    'Ultra-realistic, 4K resolution.',

  joinery:
    'Interior photography of fitted joinery. The surface is applied to the shutter or panel ' +
    'faces, shown at a slight angle so the sheen and the grain direction read clearly across ' +
    'the full height. Clean modern cabinetry, soft even lighting, handles and edges crisp, no people. ' +
    'Ultra-realistic, 4K resolution.',
};

// ─── Scene metadata — label, style family and prompt hint per scene ID ────────

const SCENE_METADATA = {
  // ── Category-agnostic ──────────────────────────────────────────────────────
  swatch_closeup: {
    label: 'Swatch Close-up',
    style: 'swatch',
    prompt_hint:
      'Flat-lay close-up of the surface itself, filling the frame, showing the true colour, ' +
      'texture and finish at arm-length viewing distance.',
  },
  scale_reference: {
    label: 'Size & Scale',
    style: 'scale',
    prompt_hint:
      'A single unit of the product laid flat and square-on against a plain neutral background, ' +
      'edges fully visible, so its proportions can be judged.',
  },
  repeat_preview: {
    label: 'Pattern Repeat',
    style: 'repeat',
    prompt_hint:
      'One clean repeat of the pattern, square to the frame and evenly lit, suitable for tiling ' +
      'edge to edge to preview how the pattern repeats across a wall.',
  },

  // ── Tiles ──────────────────────────────────────────────────────────────────
  bathroom_floor_wall: {
    label: 'Bathroom Floor & Wall',
    style: 'room',
    prompt_hint:
      'The tile laid across a modern bathroom floor and continuing up the wet-area wall, ' +
      'grout joints straight and consistent, a simple wall-hung basin and glass screen for scale.',
  },
  kitchen_backsplash: {
    label: 'Kitchen Backsplash',
    style: 'room',
    prompt_hint:
      'The tile installed as a kitchen backsplash between a stone countertop and the wall units, ' +
      'even grout lines, warm under-cabinet lighting grazing the surface.',
  },
  living_room_floor: {
    label: 'Living Room Floor',
    style: 'room',
    prompt_hint:
      'The tile laid across a bright open living room floor, joints running with the room, ' +
      'a low sofa and rug at the edge of frame giving scale, daylight from a large window.',
  },
  outdoor_balcony: {
    label: 'Outdoor / Balcony',
    style: 'outdoor',
    prompt_hint:
      'The tile laid across an open balcony or terrace floor in daylight, planters and a railing ' +
      'at the frame edge, city or garden view beyond.',
  },

  // ── Laminates ──────────────────────────────────────────────────────────────
  wardrobe_shutter: {
    label: 'Wardrobe Shutter',
    style: 'joinery',
    prompt_hint:
      'The laminate applied to full-height wardrobe shutters in a modern bedroom, ' +
      'grain running vertically and matched across the shutter line, slim handles.',
  },
  kitchen_shutter: {
    label: 'Kitchen Shutter',
    style: 'joinery',
    prompt_hint:
      'The laminate applied to base and wall kitchen shutters, seen against a stone countertop, ' +
      'consistent sheen across every door front.',
  },
  wall_panelling: {
    label: 'Wall Panelling',
    style: 'joinery',
    prompt_hint:
      'The laminate applied as full-height wall panelling behind a console or bed, ' +
      'clean vertical joints, grazing light showing the surface texture.',
  },

  // ── Wallpaper ──────────────────────────────────────────────────────────────
  bedroom_feature_wall: {
    label: 'Bedroom Feature Wall',
    style: 'room',
    prompt_hint:
      'The wallpaper hung across the full bed-head feature wall of a calm modern bedroom, ' +
      'pattern repeat continuous and undistorted across the drops, soft bedside lighting.',
  },
  living_room_wall: {
    label: 'Living Room Wall',
    style: 'room',
    prompt_hint:
      'The wallpaper hung across a living room wall behind a low sofa, ' +
      'pattern continuous corner to corner, daylight raking across the surface.',
  },
  childrens_room: {
    label: "Children's Room",
    style: 'room',
    prompt_hint:
      "The wallpaper hung across a bright children's bedroom wall, " +
      'cheerful uncluttered room with a low bed and simple toys for scale, no people.',
  },
};

// ─── Scene config — category → ordered scene list ─────────────────────────────
// Rule inherited from the source: 3–6 scenes per category, always ending with the
// category-agnostic swatch plus whichever composited view suits the format —
// scale_reference for a rigid unit (tile, sheet), repeat_preview for a roll.

const SCENE_CONFIG = {
  tiles: [
    'bathroom_floor_wall',
    'kitchen_backsplash',
    'living_room_floor',
    'outdoor_balcony',
    'swatch_closeup',
    'scale_reference',
  ],
  laminates: ['wardrobe_shutter', 'kitchen_shutter', 'wall_panelling', 'swatch_closeup', 'scale_reference'],
  wallpaper: ['bedroom_feature_wall', 'living_room_wall', 'childrens_room', 'swatch_closeup', 'repeat_preview'],

  // ponytail: Stone, Wood and Hardware are declared in the menu with nothing
  // behind them, and Material-Metafield-Research.html §9 is explicit that their
  // field set is an unverified sketch. A generic surface set is the honest
  // ceiling until there is a product to shoot. When those categories go live,
  // add a key here — Stone and Wood are floor/wall surfaces and will mostly
  // reuse the tile scenes.
  default: ['swatch_closeup', 'living_room_floor', 'scale_reference'],
};

// Scenes whose value comes from post-processing in imageComposer, not from the
// model. The pipeline treats these differently: a scale reference is regenerated
// per size variant, the way the source regenerated measurement_view per size.
const COMPOSITED_SCENES = new Set(['scale_reference', 'repeat_preview']);

// ─── Per-category realism constraints ────────────────────────────────────────
// A surface fails differently from a mirror. The model will happily invent a
// grout width, drift the pattern repeat or flip the grain, and any of those makes
// the render a lie about the product.

const CATEGORY_NOTE = {
  tiles:
    'This is a tile. Reproduce the module size and the grout joints faithfully — joints must be ' +
    'straight, of even width, and consistent in colour. Do not invent a different tile format, ' +
    'do not blend adjacent tiles into one continuous sheet, and do not add or remove veining.',
  laminates:
    'This is a decorative laminate. Keep the grain or pattern direction consistent across every ' +
    'panel face, and keep the sheen level exactly as in the reference. Do not turn a matte or ' +
    'suede finish glossy, and do not add a wood texture the reference does not have.',
  wallpaper:
    'This is wallpaper. The pattern repeat must stay uniform in scale and undistorted across the ' +
    'whole wall, aligned between drops, with no visible seams, stretching or perspective warping ' +
    'of the motif. Do not resize the motif to fit the wall.',
  default:
    'Reproduce the surface texture, pattern scale and colour exactly as in the reference photo. ' +
    'Do not stylise or re-interpret the material.',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Maps whatever the caller sent — productType, a handle fragment, a menu label —
 * onto one of the keys in SCENE_CONFIG. Order matters: "wall tiles" contains
 * "tile" and must not be read as wallpaper.
 */
function normaliseCategory(category) {
  const c = String(category || '').toLowerCase().replace(/[^a-z]/g, '');
  if (c.includes('wallpaper')) return 'wallpaper';
  if (c.includes('tile')) return 'tiles';
  if (c.includes('laminate')) return 'laminates';
  return 'default';
}

/**
 * Returns the ordered list of scene IDs to generate.
 * Admin-selected scenes take priority over SCENE_CONFIG defaults.
 */
function getScenesForCategory(category, selectedScenes) {
  if (Array.isArray(selectedScenes) && selectedScenes.length > 0) return selectedScenes;
  return SCENE_CONFIG[normaliseCategory(category)] || SCENE_CONFIG.default;
}

/** Builds the scene object the prompt builder consumes. Unknown IDs degrade rather than throw. */
function makeScene(sceneId) {
  const meta = SCENE_METADATA[sceneId] || { label: sceneId.replace(/_/g, ' '), style: 'room', prompt_hint: '' };
  return { id: sceneId, label: meta.label, style: meta.style, prompt_hint: meta.prompt_hint };
}

// Metafield values arrive either raw or as Shopify's { value } wrapper.
function mfValue(v) {
  const raw = v && typeof v === 'object' && !Array.isArray(v) ? v.value : v;
  if (Array.isArray(raw)) return raw.join(', ');
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw);
}

// ─── Prompt building ──────────────────────────────────────────────────────────

/**
 * The half of the prompt that pins the product down. Everything here is a
 * property the generated image is forbidden to change.
 */
function buildLockedSpecBlock(spec, options = {}) {
  const { sizeValue = null, category = null } = options;

  const facts = [
    ['Product', spec.product_type],
    ['Material', spec.material],
    ['Look', spec.look],
    ['Colour', spec.colour],
    ['Finish', spec.finish],
    ['Surface', spec.surface],
  ]
    .map(([k, v]) => [k, mfValue(v)])
    .filter(([, v]) => v && v !== 'unknown')
    .map(([k, v]) => `${k}: ${v}.`)
    .join(' ');

  const texturePart = spec.texture_description ? ` Surface texture: ${spec.texture_description}.` : '';

  const thickness = Number(mfValue(spec.thickness_mm));
  const thicknessPart = thickness > 0 ? ` Thickness: ${thickness} mm.` : '';

  // "unknown" is the extractor's honest answer when it cannot read a size off the
  // photo. Passing it through would lock the render to a dimension called
  // "unknown" — say nothing instead.
  const rawSize = sizeValue || mfValue(spec.size);
  const size = rawSize && rawSize !== 'unknown' ? rawSize : null;
  const sizePart = size
    ? ` Exact unit size: ${size} — do not alter this dimension or the number of units visible in frame.`
    : '';

  const application = mfValue(spec.application);
  const applicationPart = application ? ` Intended use: ${application}.` : '';

  const note = CATEGORY_NOTE[normaliseCategory(category)] || CATEGORY_NOTE.default;

  return (
    'PRODUCT REFERENCE (do not alter these properties in the generated image): ' +
    facts +
    texturePart +
    thicknessPart +
    sizePart +
    applicationPart +
    ' ' +
    note +
    ' The surface in the generated image must match the reference photo exactly — same colour, ' +
    'same pattern, same texture, same finish and the same scale of pattern relative to the unit. ' +
    'Do not substitute a similar-looking material.'
  );
}

/** The half of the prompt that describes the shot. */
function buildSceneBlock(scene) {
  const photographyStyle = STYLE[scene.style] || STYLE.room;

  return (
    `Scene: ${scene.prompt_hint}\n\n` +
    `${photographyStyle}\n` +
    'Do not add any text, labels, watermarks, dimension arrows or measurement callouts to the image.'
  );
}

function buildPrompt(spec, scene, options = {}) {
  const lockedBlock = buildLockedSpecBlock(spec, options);
  const sceneBlock = buildSceneBlock(scene);
  return `${lockedBlock}\n\n${sceneBlock}`;
}

module.exports = {
  buildPrompt,
  buildLockedSpecBlock,
  buildSceneBlock,
  makeScene,
  normaliseCategory,
  getScenesForCategory,
  SCENE_CONFIG,
  SCENE_METADATA,
  COMPOSITED_SCENES,
};
