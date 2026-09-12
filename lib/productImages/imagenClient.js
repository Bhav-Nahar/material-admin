/**
 * imagenClient.js — Gemini image-to-image generation.
 *
 * Ported from glassquickdev/functions/generateProductImages/imagenClient.js.
 *
 * Dropped: the `createClient(provider)` wrapper. It existed to switch between two
 * Google accounts (GOOGLE_AI_API_KEY vs GOOGLE_AI_API_KEY_2) to dodge per-key
 * quota, but the shipped version ignored its own argument and always used
 * account 2 — a factory returning one fixed client. One key, one function.
 *
 * Env: GOOGLE_AI_API_KEY (required), IMAGE_MODEL (optional override).
 */

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image-preview';

/**
 * @param {string}      prompt
 * @param {string}      productImageBase64    — the anchor: what the surface actually looks like
 * @param {string|null} sceneReferenceBase64  — optional per-scene style anchor
 * @returns {Promise<string>} base64 image data
 */
async function generateImage(prompt, productImageBase64, sceneReferenceBase64 = null, mimeType = 'image/jpeg') {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_AI_API_KEY env var is not set');
  if (!prompt) throw new Error('prompt is required');
  if (!productImageBase64) throw new Error('productImageBase64 is required');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }, { inlineData: { mimeType, data: productImageBase64 } }];
  if (sceneReferenceBase64) parts.push({ inlineData: { mimeType, data: sceneReferenceBase64 } });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
  });

  if (!res.ok) throw new Error(`Gemini image API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const outParts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = outParts.find((p) => p.inlineData?.data);

  if (!imagePart) {
    // The model refusing in prose is the common failure, and the prose says why.
    const textPart = outParts.find((p) => p.text);
    throw new Error(
      'Gemini returned no image for this scene.' +
        (textPart ? ` Model said: "${textPart.text.slice(0, 200)}"` : '') +
        ` Response: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  return imagePart.inlineData.data;
}

module.exports = { generateImage, IMAGE_MODEL };
