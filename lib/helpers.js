// Lifted from lucira-backend/lib/helpers.js, minus the Shopify image/link resolvers
// this backend has no use for. Shopify throttles hard on the Admin API, so every
// call goes through here.
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, { ...options, signal: options.signal || controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok && (res.status >= 500 || res.status === 429) && retries > 0) {
      let currentBackoff = backoff;
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
        currentBackoff = Number.isNaN(retryAfter) ? backoff * 2 : retryAfter * 1000;
      }
      await new Promise((r) => setTimeout(r, currentBackoff));
      return fetchWithRetry(url, options, retries - 1, currentBackoff * 2);
    }
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, backoff));
      return fetchWithRetry(url, options, retries - 1, backoff * 2);
    }
    throw err;
  }
}

module.exports = { fetchWithRetry };
