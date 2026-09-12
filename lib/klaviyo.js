'use strict';

/**
 * Klaviyo — Events API (JSON:API, 2024 revision).
 *
 * Ported from glassquickdev/admin-server/lib/klaviyo.js. Unchanged in shape:
 * we only TRACK events. Klaviyo owns the actual email/SMS rendering and sending
 * — a flow in Klaviyo reacts to the event we push. That is why this file has no
 * "send an email" function: there isn't one, and adding one would mean owning
 * templates, unsubscribe links and CAN-SPAM footers that Klaviyo already owns.
 *
 * Env is KLAVIYO_API_KEY here (the source called it KLAVIYO_PRIVATE_API_KEY).
 */

const { fetchWithRetry } = require('./helpers');

const KLAVIYO_BASE = 'https://a.klaviyo.com/api';
const KLAVIYO_REVISION = '2024-10-15';

const key = () => process.env.KLAVIYO_API_KEY || '';

// Private keys start with pk_. A public key (site id) pasted here would 401 on
// every call, so we check the shape and report the channel off instead.
const enabled = () => /^pk_/.test(key());

// Klaviyo profile phone_number must be E.164. Bare 10-digit Indian numbers get
// a +91 prefix; anything non-standard returns null rather than being sent and
// silently dropped by Klaviyo.
function normalizePhone(raw) {
  if (!raw) return null;
  const p = String(raw).trim().replace(/[\s\-()]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return /^\+\d{8,15}$/.test(p) ? p : null;
  const digits = p.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return null;
}

// Klaviyo needs at least one of email / phone_number to resolve a profile.
function buildProfileAttributes({ email, phone, firstName, lastName } = {}) {
  const attrs = {};
  const em = (email || '').trim();
  const ph = normalizePhone(phone);
  if (em) attrs.email = em;
  if (ph) attrs.phone_number = ph;
  if (!attrs.email && !attrs.phone_number) return null;
  if (firstName) attrs.first_name = String(firstName).trim();
  if (lastName) attrs.last_name = String(lastName).trim();
  return attrs;
}

/**
 * Track one Klaviyo event. THIS IS A SEND PATH — the event it pushes is what
 * makes a Klaviyo flow mail a real customer.
 *
 * Never throws: a marketing job that dies mid-batch on one bad profile leaves
 * the rest of the batch unsent, and the caller needs the per-recipient result to
 * write its sent-log row anyway.
 *
 * @returns {Promise<{ok:boolean, skipped?:boolean, status?:number, error?:string}>}
 */
async function trackEvent({ metric, profile, properties = {}, value, uniqueId, time } = {}, log = console) {
  if (!enabled()) {
    log.warn(`[klaviyo] KLAVIYO_API_KEY not set — channel off, event skipped: ${metric}`);
    return { ok: false, skipped: true, error: 'KLAVIYO_API_KEY not configured' };
  }

  const profileAttributes = buildProfileAttributes(profile || {});
  if (!profileAttributes) {
    log.warn(`[klaviyo] no email/phone on profile — event skipped: ${metric}`);
    return { ok: false, skipped: true, error: 'profile has neither email nor phone' };
  }

  const attributes = {
    properties,
    metric: { data: { type: 'metric', attributes: { name: metric } } },
    profile: { data: { type: 'profile', attributes: profileAttributes } },
    time: time || new Date().toISOString(),
  };
  if (typeof value === 'number' && !Number.isNaN(value)) attributes.value = value;
  // Klaviyo dedupes on unique_id — a second event with the same id is dropped.
  // Belt to our sent-log's braces: covers a retry that raced past our own claim.
  if (uniqueId) attributes.unique_id = String(uniqueId);

  try {
    const res = await fetchWithRetry(`${KLAVIYO_BASE}/events/`, {
      method: 'POST',
      headers: {
        Authorization: `Klaviyo-API-Key ${key()}`,
        revision: KLAVIYO_REVISION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ data: { type: 'event', attributes } }),
    });

    // Events API returns 202 Accepted with an empty body on success.
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text().catch(() => '');
    const error = `HTTP ${res.status} ${text}`.slice(0, 300);
    log.error(`[klaviyo] event failed: ${metric} ${error}`);
    return { ok: false, status: res.status, error };
  } catch (e) {
    log.error(`[klaviyo] event failed: ${metric} ${e.message}`);
    return { ok: false, status: 0, error: e.message };
  }
}

module.exports = { trackEvent, normalizePhone, enabled };
