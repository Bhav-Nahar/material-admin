'use strict';

/**
 * adsEvents.test.js — payload construction and hashing. Pure; nothing here reaches
 * the network, and one test proves it.
 *
 * Why this file is worth more than its length: a wrong hash is the one failure mode
 * Meta never reports. The event is accepted, `events_received: 1` comes back, Events
 * Manager shows green — and it matched nobody. The only place that error is visible
 * is here, against a fixed vector.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMetaEvent,
  sendMetaEvent,
  normPhone,
  normEmail,
  normZip,
  sha256,
  toFbc,
  deriveEventId,
} = require('../lib/adsEvents');

// Fixed SHA-256 vectors. If normalisation drifts, these are what catch it.
const H = {
  email: '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b', // test@example.com
  phone: '92b5072176e723878b5e06ff3ca61898e4eb74e8c46642a0f2db800b17364ab0', // 919876543210
  country: '582967534d0f909d196b97f9e6921342777aea87b46fa52df165389db1fb8ccf', // in
  zip: 'a5bc8dcde81ed9dbad6edf4f14b3b8e1201702eaa27ab7f8cb708ffe7f49ddc9', // 400001
  state: '0710c7a483c44a4952446c652cc72536dd397c626a4ada58256db92fac05a8d7', // maharashtra
};

const purchase = (over = {}) => ({
  event: 'Purchase',
  orderId: '5501234',
  value: 4999,
  user: { email: 'test@example.com', phone: '9876543210' },
  ...over,
});

// ── Hashing and normalisation ────────────────────────────────────────────────

test('email hashes to the documented vector, however it was typed', () => {
  for (const raw of ['test@example.com', '  TEST@Example.COM  ', 'Test@Example.com\t']) {
    assert.equal(sha256(normEmail(raw)), H.email, `failed for ${JSON.stringify(raw)}`);
  }
});

test('every shape an Indian mobile arrives in collapses to one E.164 hash', () => {
  // Meta wants country-code digits and NO leading '+'. A bare 10-digit number is what
  // Shopify stores, and sending it unprefixed matches nobody.
  const shapes = [
    '9876543210',
    '+91 98765 43210',
    '91-9876543210',
    '09876543210',
    '0091 9876543210',
    '(+91) 98765-43210',
  ];
  for (const raw of shapes) {
    assert.equal(normPhone(raw), '919876543210', `normPhone failed for ${raw}`);
    assert.equal(sha256(normPhone(raw)), H.phone);
  }
});

test('a phone that is already international is left alone', () => {
  assert.equal(normPhone('+971 50 123 4567'), '971501234567');
  assert.equal(normPhone(''), '');
  assert.equal(normPhone(null), '');
  assert.equal(normPhone('not a phone'), '');
});

test('zip is lowercased as well as space-stripped', () => {
  // glassquickdev stripped spaces but never lowercased, so an alphanumeric postcode
  // hashed differently depending on the shopper's caps lock.
  assert.equal(normZip(' 400 001 '), '400001');
  assert.equal(sha256(normZip('400 001')), H.zip);
  assert.equal(normZip('SW1A 1AA'), 'sw1a1aa');
});

test('address fields hash normalised, and country defaults to India', () => {
  const { data } = buildMetaEvent(
    purchase({ user: { email: 'test@example.com', state: ' Maha rashtra ', zip: '400 001' } }),
  );
  assert.deepEqual(data.user_data.st, [H.state]);
  assert.deepEqual(data.user_data.zp, [H.zip]);
  assert.deepEqual(data.user_data.country, [H.country]);
});

test('missing PII fields are omitted, never sent as empty hashes', () => {
  const { data } = buildMetaEvent(purchase({ user: { email: 'test@example.com' } }));
  for (const k of ['ph', 'fn', 'ln', 'ct', 'st', 'zp', 'external_id']) {
    assert.ok(!(k in data.user_data), `${k} should be absent`);
  }
  // Every hash present is 64 hex chars in a one-element array.
  for (const k of ['em', 'country']) {
    assert.match(data.user_data[k][0], /^[0-9a-f]{64}$/);
  }
});

test('no raw PII survives into the payload', () => {
  const { data } = buildMetaEvent(
    purchase({
      user: {
        email: 'test@example.com',
        phone: '9876543210',
        firstName: 'Rita',
        lastName: 'Sharma',
        city: 'Mumbai',
        externalId: 'gid://shopify/Customer/99',
      },
    }),
  );
  const json = JSON.stringify(data);
  for (const secret of ['test@example.com', '9876543210', 'Rita', 'Sharma', 'Mumbai', 'Customer/99']) {
    assert.ok(!json.includes(secret), `raw ${secret} leaked into the payload`);
  }
  assert.ok(!json.includes('@'), 'an @ in the payload means an email went out unhashed');
});

// ── Click ids: plain text, never hashed ──────────────────────────────────────

test('fbc and fbp go out as plain text', () => {
  const { data } = buildMetaEvent(
    purchase({ attribution: { fbc: 'fb.1.1700000000000.abc123', fbp: 'fb.1.1700000000000.987' } }),
  );
  assert.equal(data.user_data.fbc, 'fb.1.1700000000000.abc123');
  assert.equal(data.user_data.fbp, 'fb.1.1700000000000.987');
});

test('fbc is rebuilt from the fbclid material-backend actually captures', () => {
  // attribution.js stores `fbclid` and `firstSeen`, not the Pixel's `_fbc` cookie.
  assert.equal(
    toFbc({ fbclid: 'IwAR123', firstSeen: '2026-08-01T00:00:00.000Z' }),
    `fb.1.${Date.parse('2026-08-01T00:00:00.000Z')}.IwAR123`,
  );
  // An epoch-ms firstSeen works too.
  assert.equal(toFbc({ fbclid: 'IwAR123', firstSeen: '1700000000000' }), 'fb.1.1700000000000.IwAR123');
  // A real cookie always wins over anything we could reconstruct.
  assert.equal(toFbc({ fbc: 'fb.1.5.real', fbclid: 'IwAR123' }), 'fb.1.5.real');
  assert.equal(toFbc({}), undefined);
});

test('a gclid-only visitor is not matchable on Meta', () => {
  // gclid is Google's; it does nothing for Meta and must not be mistaken for a match key.
  assert.throws(() => buildMetaEvent({ event: 'ViewContent', productId: 'p1', attribution: { gclid: 'x' } }), {
    code: 'no_identifiers',
  });
});

// ── event_id / dedupe ────────────────────────────────────────────────────────

test('event_id is derived from a key the browser pixel also knows', () => {
  assert.deepEqual(deriveEventId({ event: 'Purchase', orderId: '5501234' }), {
    eventId: 'Purchase.5501234',
    dedupe: 'pixel',
  });
  assert.deepEqual(deriveEventId({ event: 'AddToCart', productId: 'tile-600' }), {
    eventId: 'AddToCart.tile-600',
    dedupe: 'pixel',
  });
});

test('an explicit eventId always wins', () => {
  const { data, dedupe } = buildMetaEvent(purchase({ eventId: 'from-the-pixel' }));
  assert.equal(data.event_id, 'from-the-pixel');
  assert.equal(dedupe, 'pixel');
});

test('with no shared key the id is unique and says so', () => {
  const a = buildMetaEvent({ event: 'ViewContent', user: { email: 'test@example.com' } });
  const b = buildMetaEvent({ event: 'ViewContent', user: { email: 'test@example.com' } });
  assert.notEqual(a.eventId, b.eventId, 'ids must not collide across unrelated events');
  // Honest about it: nothing tied this to a pixel event, so Meta may count it twice.
  assert.equal(a.dedupe, 'server-only');
});

// ── Event shape ──────────────────────────────────────────────────────────────

test('the five D2C events are accepted and nothing else is', () => {
  for (const event of ['ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase', 'SampleOrder']) {
    const { data } = buildMetaEvent({
      event,
      productId: 'p1',
      user: { email: 'test@example.com' },
    });
    assert.equal(data.event_name, event);
  }
  // The source's B2B lead events do not exist here.
  for (const event of ['Lead', 'QuotationSent', 'purchase', '', undefined]) {
    assert.throws(() => buildMetaEvent({ event, user: { email: 'test@example.com' } }), { code: 'bad_event' });
  }
});

test('a purchase carries value, currency and order id', () => {
  const { data } = buildMetaEvent(purchase({ contentIds: ['tile-600', 'lam-oak'] }));
  assert.equal(data.custom_data.value, 4999);
  assert.equal(data.custom_data.currency, 'INR');
  assert.equal(data.custom_data.order_id, '5501234');
  assert.deepEqual(data.custom_data.content_ids, ['tile-600', 'lam-oak']);
  assert.equal(data.action_source, 'website');
  assert.equal(typeof data.event_time, 'number');
});

test('a sample order is its own event, not a discounted Purchase', () => {
  // Folding ₹99 samples into Purchase would bury real orders in the ROAS number.
  const { data } = buildMetaEvent({
    event: 'SampleOrder',
    orderId: '5501299',
    value: 99,
    user: { phone: '9876543210' },
  });
  assert.equal(data.event_name, 'SampleOrder');
  assert.equal(data.custom_data.value, 99);
  assert.deepEqual(data.user_data.ph, [H.phone]);
});

test('event_source_url falls back to the captured landing page', () => {
  const { data } = buildMetaEvent(
    purchase({ attribution: { landing: '/collections/tiles', utm_source: 'meta' } }),
  );
  assert.equal(data.event_source_url, '/collections/tiles');
  // utm fields are for our reporting; Meta has no use for them and they are not sent.
  assert.ok(!JSON.stringify(data).includes('utm_source'));
});

test('ip + user-agent alone are enough to match, city alone is not', () => {
  const ok = buildMetaEvent({
    event: 'ViewContent',
    productId: 'p1',
    clientIp: '203.0.113.9',
    clientUserAgent: 'Mozilla/5.0',
  });
  assert.equal(ok.data.user_data.client_ip_address, '203.0.113.9');
  assert.throws(() => buildMetaEvent({ event: 'ViewContent', productId: 'p1', user: { city: 'Mumbai' } }), {
    code: 'no_identifiers',
  });
});

// ── Nothing fires without configuration ──────────────────────────────────────

test('with the channel unconfigured, sendMetaEvent makes no network call', async () => {
  const env = { ...process.env };
  delete process.env.META_ACCESS_TOKEN;
  delete process.env.META_PIXEL_ID;

  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = () => {
    calls += 1;
    throw new Error('a test must never reach the network');
  };
  const logged = [];
  const log = { warn: (m) => logged.push(m), info: () => {} };

  try {
    const result = await sendMetaEvent(purchase(), log);
    assert.deepEqual(result, { ok: false, skipped: 'meta-not-configured' });
    assert.equal(calls, 0, 'no fetch may happen with the channel off');
    // Off must be loud, not silent.
    assert.match(logged[0], /Meta CAPI is OFF/);
  } finally {
    global.fetch = realFetch;
    process.env = env;
  }
});

test('requiring the module sends nothing', async () => {
  // Belt and braces: re-require with fetch booby-trapped. Any module-load side effect
  // that touched the network would blow up here.
  const realFetch = global.fetch;
  global.fetch = () => {
    throw new Error('a test must never reach the network');
  };
  try {
    delete require.cache[require.resolve('../lib/adsEvents')];
    delete require.cache[require.resolve('../lib/metaAds')];
    require('../lib/adsEvents');
    require('../lib/metaAds');
  } finally {
    global.fetch = realFetch;
  }
});

test('identity fields at the top level are rejected, not silently ignored', () => {
  // The failure this prevents: every identifier drops out, the event still clears
  // the matchable floor on ip + user-agent, Meta accepts it, and it matches nobody.
  assert.throws(
    () => buildMetaEvent({
      event: 'Purchase', orderId: '1', email: 'a@b.com', phone: '+919876543210',
      clientIp: '49.36.1.2', clientUserAgent: 'Mozilla/5.0',
    }),
    /must be nested under "user"/,
  );
  assert.throws(
    () => buildMetaEvent({
      event: 'Purchase', orderId: '1', fbclid: 'abc',
      user: { email: 'a@b.com' },
    }),
    /must be nested under "attribution"/,
  );
  // The correct shape still builds.
  const { data } = buildMetaEvent({
    event: 'Purchase', orderId: '1', user: { email: 'a@b.com' },
  });
  assert.ok(data.user_data.em, 'nested user.email must still hash through');
});
