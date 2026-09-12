/**
 * gscAuth.js — Google Search Console access tokens, without google-auth-library.
 *
 * The source (glassquickdev/admin-server/lib/gscAuth.js) wrapped `GoogleAuth` from
 * google-auth-library and preferred Application Default Credentials, because gq-admin
 * ran inside the same GCP project as the Search Console property and ADC resolved to
 * the runtime service account for free.
 *
 * Neither half of that ports. material-admin has a no-new-dependency rule, and it is
 * not guaranteed to run inside a GCP project at all, so there is no ambient identity
 * to resolve. What replaces it is the thing google-auth-library would have done under
 * the ADC-less path anyway: sign a JWT with the service account key and exchange it
 * for an access token. RS256 is `crypto.createSign('RSA-SHA256')` — about fifteen
 * lines, which is cheaper than a dependency that also drags in gaxios and gtoken.
 *
 * Configure GSC_SERVICE_ACCOUNT_JSON with the raw service-account JSON (already in
 * .env.example). That account must be added as a user on the material.in Search
 * Console property, and its project must have the Search Console API enabled.
 *
 * ponytail: explicit service-account key only — no ADC, no metadata-server identity,
 * no key file path. If this ever runs on GCP with a bound service account, the
 * upgrade is a metadata-server branch (GET
 * http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
 * with Metadata-Flavor: Google), which is another ten lines and still no dependency.
 */

const crypto = require('node:crypto');

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cached = null; // { token, expiresAt }

function loadKey() {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let key;
  try {
    key = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GSC_SERVICE_ACCOUNT_JSON is set but is not valid JSON: ${err.message}`);
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('GSC_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }
  return key;
}

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A Search Console access token, or null when no credentials are configured.
 *
 * Returning null rather than throwing keeps "GSC is not set up" distinguishable from
 * "GSC is set up and broken" at the call site. Unlike the source, callers must NOT
 * substitute demo data for null — see routes/seo.js.
 */
async function getGscAccessToken() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const key = loadKey();
  if (!key) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.private_key_id }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPES.join(' '),
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(key.private_key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new Error(`Search Console token exchange failed (${res.status}): ${body?.error_description || body?.error || 'no token returned'}`);
  }

  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return cached.token;
}

/** The Search Console property to query. Domain property, matching the source's shape. */
function gscSiteUrl() {
  return process.env.GSC_SITE || 'sc-domain:material.in';
}

module.exports = { getGscAccessToken, gscSiteUrl };
