'use strict';

/**
 * adsEvents.js — server-side conversion events (Meta Conversions API).
 *
 * The other half of `material-backend/lib/attribution.js`. That file captures what
 * the shopper's browser knows — click ids, utm fields, first-seen — and stores it on
 * the customer and the order. This file is what finally tells Meta a conversion
 * happened, using exactly those field names.
 *
 * ── Why a server-side send at all ────────────────────────────────────────────
 * The browser pixel is the primary signal and stays primary. It just loses events:
 * Safari/ITP caps cookies, ad blockers eat the tag, and a Shopify thank-you page can
 * be closed before the pixel flushes. CAPI covers the gap. Both halves fire for the
 * same conversion ON PURPOSE — Meta collapses them by `event_id`, which is why the
 * id contract below is not optional decoration.
 *
 * ── PII ──────────────────────────────────────────────────────────────────────
 * Email, phone, name, city, state and zip are SHA-256 hashed here, before the fetch.
 * Raw PII never leaves this process and is never logged. glassquickdev shipped raw
 * email/phone over the wire to a Cloud Function and hashed it there; collapsing the
 * relay into this service removes that hop entirely.
 *
 * Click and browser ids (fbc, fbp, gclid) and the client IP/User-Agent are sent as
 * PLAIN TEXT. That is Meta's spec — they are identifiers, not personal data, and
 * hashing them silently destroys attribution rather than protecting anyone.
 *
 * ── What spends money / sends data ───────────────────────────────────────────
 * `sendMetaEvent` is the ONLY function here that touches the network. Everything
 * else is pure. It refuses to run unless META_ACCESS_TOKEN and META_PIXEL_ID are
 * both set, and nothing calls it on module load.
 */

const { createHash, randomUUID } = require('node:crypto');
const { fetchWithRetry } = require('./helpers');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';

/**
 * The five signals Material optimises on.
 *
 * Names are Meta's own strings on purpose: the browser pixel fires the identical
 * string, so dedupe is two identical (event_name, event_id) pairs meeting at Meta
 * rather than a translation table someone has to keep in sync.
 *
 * `SampleOrder` is a CUSTOM event, not a standard one — a paid sample is the
 * strongest mid-funnel signal in surfaces (nobody orders a ₹99 tile sample idly) but
 * folding it into `Purchase` would drown real ₹40k orders in sample revenue and wreck
 * ROAS. The browser side must fire it with `fbq('trackCustom', 'SampleOrder', …)`,
 * and Events Manager needs a Custom Conversion on it before a campaign can optimise
 * towards it.
 */
const EVENTS = new Set(['ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase', 'SampleOrder']);

// ── Normalisation + hashing ──────────────────────────────────────────────────
// Meta matches on the hash, so normalisation IS the matching. " Rita@Gmail.com "
// and "rita@gmail.com" are the same person and must produce the same 64 hex chars,
// or the event arrives technically valid and matches nobody.

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Lowercase, trimmed. Deliberately NOT stripping gmail dots — Meta does that itself. */
const normEmail = (v) => String(v ?? '').trim().toLowerCase();

/**
 * E.164 digits, no '+' — Meta's documented phone format.
 *
 * India-first because Material ships within India: a bare 10-digit mobile is the
 * normal shape of a number in the Shopify customer record, and sending it unprefixed
 * matches nothing. `+91`, `0091`, `091` and a leading STD `0` all collapse to the
 * same `91XXXXXXXXXX`.
 */
function normPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2); // 0091… international prefix
  if (d.length === 10) return '91' + d; // bare Indian mobile
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1); // 0-prefixed STD
  return d;
}

/** Names, city, state: lowercase, no punctuation, no spaces. Meta's spec for all three. */
const normText = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// Zip keeps digits/letters, drops spaces and case. glassquickdev's relay stripped
// spaces but never lowercased, so a UK-style or alphanumeric postcode hashed
// differently depending on how the shopper typed it. Fixed here.
const normZip = (v) => String(v ?? '').trim().toLowerCase().replace(/\s/g, '');

const hashed = (v, norm = normText) => {
  const n = norm(v);
  return n ? [sha256(n)] : undefined;
};

// ── Click ids ────────────────────────────────────────────────────────────────

/**
 * Meta's `fbc`, from whatever the storefront managed to capture.
 *
 * A real `_fbc` cookie always wins — the Pixel writes it with the right timestamp
 * and we should never second-guess it. But `material-backend/lib/attribution.js`
 * captures `fbclid` (the raw URL param) and `firstSeen`, NOT the cookie, so the
 * common case here is rebuilding the documented `fb.<subdomainIndex>.<ts>.<fbclid>`
 * form from those two. Subdomain index 1 = a cookie on `material.in`.
 */
function toFbc(attr = {}) {
  if (attr.fbc) return String(attr.fbc);
  if (!attr.fbclid) return undefined;
  const seen = attr.firstSeen;
  const ms = /^\d{10,}$/.test(String(seen ?? '')) ? Number(seen) : Date.parse(seen);
  return `fb.1.${Number.isFinite(ms) ? ms : Date.now()}.${attr.fbclid}`;
}

// ── event_id ─────────────────────────────────────────────────────────────────

/**
 * The dedupe key. `<EventName>.<stable key>` — the same string the browser pixel
 * must pass as `eventID`.
 *
 * Derived from an id both sides already know (order, checkout, cart, product) so the
 * two halves agree without coordinating. When there is no shared key we mint a UUID:
 * that still stops OUR retries double-counting, but it cannot dedupe against the
 * pixel, so the caller is told `dedupe: 'server-only'` rather than left to assume.
 */
function deriveEventId(input) {
  if (input.eventId) return { eventId: String(input.eventId), dedupe: 'pixel' };
  const key = input.orderId || input.checkoutToken || input.cartId || input.productId;
  return key
    ? { eventId: `${input.event}.${key}`, dedupe: 'pixel' }
    : { eventId: `${input.event}.${randomUUID()}`, dedupe: 'server-only' };
}

// ── Payload ──────────────────────────────────────────────────────────────────

/**
 * Build the single `data[0]` object Meta expects. Pure — no env, no clock beyond a
 * default event_time, no network. This is the function the tests exercise, because
 * a subtly wrong hash is silently accepted by Meta and matches nobody.
 *
 * @throws {Error} code `bad_event` for an unknown event name, `no_identifiers` when
 *   nothing in the payload could ever match a person.
 */
function buildMetaEvent(input = {}) {
  const { event, user = {}, attribution = {} } = input;

  if (!EVENTS.has(event)) {
    const err = new Error(`event must be one of ${[...EVENTS].join(', ')}`);
    err.code = 'bad_event';
    throw err;
  }

  // Identity fields go under `user`, not at the top level. Getting that wrong is
  // silent and expensive: every identifier drops out, the event still clears the
  // matchable floor below on ip + user-agent alone, and Meta accepts it. You get a
  // healthy-looking "events received" count attributing almost nothing, and no
  // error anywhere to tell you. Caught it by making the mistake.
  const misplaced = ['email', 'phone', 'firstName', 'lastName', 'zip', 'externalId']
    .filter((k) => input[k] !== undefined);
  if (misplaced.length) {
    const err = new Error(
      `${misplaced.join(', ')} must be nested under "user" — top-level identity fields are ignored`,
    );
    err.code = 'misplaced_user_fields';
    throw err;
  }
  if (input.fbclid !== undefined || input.fbp !== undefined) {
    const err = new Error('fbclid/fbp must be nested under "attribution"');
    err.code = 'misplaced_user_fields';
    throw err;
  }

  const { eventId, dedupe } = deriveEventId(input);

  const user_data = {
    em: hashed(user.email, normEmail),
    ph: hashed(user.phone, normPhone),
    fn: hashed(user.firstName),
    ln: hashed(user.lastName),
    ct: hashed(user.city),
    st: hashed(user.state),
    zp: hashed(user.zip, normZip),
    // India-only store. A country hash on its own matches nobody, but paired with
    // em/ph it lifts match quality, so it is a default rather than a requirement.
    country: hashed(user.country || 'in'),
    // Shopify customer id. Hashed like PII because it identifies a person, and it is
    // the one key that survives a shopper changing their email.
    external_id: hashed(user.externalId, (v) => String(v ?? '').trim()),
    // Plain text, never hashed — Meta's spec. Hashing these looks safer and silently
    // costs you the attribution the whole module exists to produce.
    fbc: toFbc(attribution),
    fbp: attribution.fbp ? String(attribution.fbp) : undefined,
    // Must be the SHOPPER's, forwarded by the caller. Never this server's — an
    // ad-server IP tells Meta every customer lives in one datacentre.
    client_ip_address: input.clientIp || undefined,
    client_user_agent: input.clientUserAgent || undefined,
  };
  for (const k of Object.keys(user_data)) if (user_data[k] === undefined) delete user_data[k];

  // Country/city/state/zip alone cannot identify anyone. Sending an event Meta will
  // accept and never match burns quota and inflates "events received" into a number
  // that looks healthy while attributing nothing.
  const MATCHABLE = ['em', 'ph', 'external_id', 'fbc', 'fbp'];
  const matchable =
    MATCHABLE.some((k) => user_data[k]) ||
    (user_data.client_ip_address && user_data.client_user_agent);
  if (!matchable) {
    const err = new Error('no usable identifier (need email, phone, customer id, fbc/fbp, or ip+user-agent)');
    err.code = 'no_identifiers';
    throw err;
  }

  const custom_data = { currency: input.currency || 'INR', content_type: 'product' };
  if (input.value != null) custom_data.value = Number(input.value);
  if (input.contents) custom_data.contents = input.contents;
  else if (input.contentIds) custom_data.content_ids = [].concat(input.contentIds).map(String);
  if (input.contentName) custom_data.content_name = String(input.contentName);
  if (event === 'Purchase' || event === 'SampleOrder') {
    if (input.orderId) custom_data.order_id = String(input.orderId);
  }

  const data = {
    event_name: event,
    event_time: Number(input.eventTime) || Math.floor(Date.now() / 1000),
    // Everything here originates from material.in, including the Shopify checkout.
    action_source: 'website',
    event_id: eventId,
    user_data,
    custom_data,
  };
  const url = input.sourceUrl || attribution.landing;
  if (url) data.event_source_url = String(url);

  return { data, eventId, dedupe };
}

// ── The one function that talks to Meta ──────────────────────────────────────

/** @returns {{token:string,pixelId:string}|null} null when the channel is switched off. */
function metaConfig() {
  const token = process.env.META_ACCESS_TOKEN;
  const pixelId = process.env.META_PIXEL_ID;
  return token && pixelId ? { token, pixelId } : null;
}

/**
 * POST one conversion event to the Meta Conversions API.
 *
 * The only network call in this file, and the only thing here that sends user data
 * anywhere. Guarded three ways: it needs both env vars, it needs a valid event name,
 * and it needs at least one matchable identifier. Nothing invokes it implicitly —
 * only `routes/ads.js` on an authenticated POST.
 *
 * Never throws for a Meta-side failure. A conversion event is telemetry; the order it
 * describes has already happened and must not be failed because a pixel is unhappy.
 * Input errors DO throw, because those are ours to fix.
 *
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string, eventId?:string, dedupe?:string}>}
 */
async function sendMetaEvent(input, log = console) {
  const cfg = metaConfig();
  if (!cfg) {
    // Loud, and never mistakable for a send. An unset token is the normal state of a
    // half-configured deploy; the failure mode to avoid is weeks of "ok" responses
    // while Meta receives nothing.
    log.warn(
      `[adsEvents] Meta CAPI is OFF (META_ACCESS_TOKEN/META_PIXEL_ID unset) — ${input?.event} NOT sent`,
    );
    return { ok: false, skipped: 'meta-not-configured' };
  }

  const { data, eventId, dedupe } = buildMetaEvent(input);
  const body = { data: [data] };
  // Routes an event to Events Manager's Test Events tab instead of live reporting.
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const res = await fetchWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.pixelId}/events`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(body),
      },
      2,
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const error = json.error?.error_user_msg || json.error?.message || `HTTP ${res.status}`;
      log.warn(`[adsEvents] ${data.event_name} ${eventId} rejected: ${error}`);
      return { ok: false, error, eventId, dedupe };
    }
    log.info(`[adsEvents] ${data.event_name} ${eventId} sent (dedupe=${dedupe})`);
    return { ok: true, eventId, dedupe, eventsReceived: json.events_received };
  } catch (err) {
    log.warn(`[adsEvents] ${data.event_name} ${eventId} failed: ${err.message}`);
    return { ok: false, error: err.message, eventId, dedupe };
  }
}

module.exports = {
  EVENTS,
  GRAPH_VERSION,
  buildMetaEvent,
  sendMetaEvent,
  metaConfig,
  normEmail,
  normPhone,
  normZip,
  normText,
  sha256,
  toFbc,
  deriveEventId,
};
