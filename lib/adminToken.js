// Admin API tokens are not static any more: you exchange the custom app's
// client_id/client_secret for one via the client_credentials grant, and it expires
// in ~24h. Pasting a token into .env works until the next day and then 401s, which
// is exactly what the first `shpca_` value in this repo's .env did.
//
// So: fetch on demand, cache until just before expiry, and re-fetch.
const EXPIRY_SKEW_MS = 60 * 1000; // refresh a minute early rather than racing it

let cached = null; // { token, expiresAt }
let inflight = null; // dedupes the stampede when several requests miss at once

async function requestToken() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new Error(
      `Could not get a Shopify Admin token (${res.status}): ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  // expires_in is seconds; Shopify currently returns ~86399.
  return { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
}

async function getAdminToken({ force = false } = {}) {
  if (!force && cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;
  if (inflight) return inflight;

  inflight = requestToken().then(
    (fresh) => {
      cached = fresh;
      inflight = null;
      return fresh.token;
    },
    (err) => {
      inflight = null;
      throw err;
    },
  );
  return inflight;
}

// Called when Shopify rejects a token we thought was good — revoked early, or the
// app was reinstalled. Next call mints a fresh one.
function invalidate() {
  cached = null;
}

module.exports = { getAdminToken, invalidate };
