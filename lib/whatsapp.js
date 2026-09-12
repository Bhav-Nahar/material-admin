'use strict';

/**
 * WhatsApp Cloud API sender.
 *
 * Ported from glassquickdev/admin-server/lib/whatsappSend.js, minus everything
 * that served a B2B agent inbox: inbound media fetch/upload, mark-read, and
 * template create/list. Material has no agent console — this service only sends
 * outbound automation, so the file keeps the two send verbs and drops ~180 lines.
 *
 * Credentials come from env only (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID).
 * The source resolved them from Firestore first, with env as fallback; there is
 * no Firestore here and no UI writing config, so env is the only source.
 *
 * The WhatsApp rule that shapes this file: outside the 24-hour customer-service
 * window you may ONLY send an approved TEMPLATE. Automation always runs outside
 * that window, so sendTemplate is the function the journeys use.
 */

const { fetchWithRetry } = require('./helpers');

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`;

const token = () => process.env.WHATSAPP_TOKEN || '';
const phoneNumberId = () => process.env.WHATSAPP_PHONE_NUMBER_ID || '';

const enabled = () => !!(token() && phoneNumberId());

// E.164 without the leading "+" — what the Cloud API wants in `to`.
// Mirrors klaviyo.js normalizePhone's +91 assumption for bare 10-digit numbers.
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) d = `91${d}`;
  if (d.length === 11 && d.startsWith('0')) d = `91${d.slice(1)}`;
  if (d.length < 11 || d.length > 15) return null;
  return d;
}

/**
 * The one network call. Not exported — every send path goes through a named
 * verb below so there is no generic "post whatever to Meta" handle in scope.
 * Never throws; callers need a result to write their sent-log row.
 */
async function post(payload, log) {
  if (!enabled()) {
    log.warn('[whatsapp] WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set — channel off, message skipped');
    return { ok: false, skipped: true, error: 'WhatsApp not configured' };
  }

  try {
    const res = await fetchWithRetry(`${GRAPH}/${phoneNumberId()}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const e = json?.error || {};
      // 131047 = outside the 24h window, template required. 132000 = template
      // parameter count mismatch. Both are configuration errors, not transient.
      const error = `WhatsApp ${res.status} (${e.code || '?'}): ${(e.message || '').slice(0, 200)}`;
      log.error(`[whatsapp] send failed: ${error}`);
      return { ok: false, status: res.status, code: e.code, error };
    }
    return { ok: true, status: res.status, messageId: json?.messages?.[0]?.id || null };
  } catch (err) {
    log.error(`[whatsapp] send failed: ${err.message}`);
    return { ok: false, status: 0, error: err.message };
  }
}

/**
 * Send an approved template. THIS IS A SEND PATH.
 *
 * bodyParams      — ordered strings for {{1}}, {{2}}, …; count must match the
 *                   approved template exactly or Meta rejects with 132000.
 * buttonUrlParams — ordered suffixes for dynamic URL buttons, indexed from 0.
 */
async function sendTemplate(phone, name, { language = 'en', bodyParams = [], headerImage = null, buttonUrlParams = [] } = {}, log = console) {
  const to = waNumber(phone);
  if (!to) return { ok: false, skipped: true, error: `not a valid WhatsApp number: ${phone}` };
  if (!name) return { ok: false, skipped: true, error: 'template name required' };

  const components = [];
  if (headerImage) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImage } }] });
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t ?? '') })) });
  }
  buttonUrlParams.forEach((param, i) => {
    if (param == null || param === '') return;
    components.push({ type: 'button', sub_type: 'url', index: String(i), parameters: [{ type: 'text', text: String(param) }] });
  });

  return post({
    to,
    type: 'template',
    template: { name, language: { code: language }, components: components.length ? components : undefined },
  }, log);
}

/**
 * Free-form text. THIS IS A SEND PATH. Only valid inside the 24-hour service
 * window (customer messaged us first) — fails with code 131047 otherwise.
 *
 * ponytail: nothing here tracks the 24h window, so this is operator-only and
 * will simply fail for a cold contact. Upgrade path is storing last-inbound-at
 * per phone from a Meta webhook, which needs an inbound webhook this service
 * does not have. Journeys use sendTemplate and are unaffected.
 */
async function sendText(phone, body, log = console) {
  const to = waNumber(phone);
  if (!to) return { ok: false, skipped: true, error: `not a valid WhatsApp number: ${phone}` };
  return post({ to, type: 'text', text: { preview_url: true, body: String(body).slice(0, 4096) } }, log);
}

module.exports = { enabled, waNumber, sendTemplate, sendText };
