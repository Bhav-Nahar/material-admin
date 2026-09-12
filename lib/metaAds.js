'use strict';

/**
 * metaAds.js — Meta Marketing API: campaign state in, two writes out.
 *
 * glassquickdev's campaigns route is 7,409 lines because it is an ad-authoring UI:
 * creative generation, image upload, interest search, audience builders, catalogue
 * feeds, OAuth dances, a BigQuery ETL. None of that belongs in an API-first admin
 * service — Ads Manager already exists and is better at all of it.
 *
 * What a small D2C store genuinely cannot get from Ads Manager is the same numbers
 * in the same shape as the rest of this service's data, and the ability to stop a
 * campaign from a script at 3am. So: one read, two writes, one health check.
 *
 * ── What spends money ────────────────────────────────────────────────────────
 * `setCampaignStatus` and `setDailyBudget` change live ad delivery. Everything else
 * here is a GET. Nothing runs on module load.
 */

const { fetchWithRetry } = require('./helpers');
const { GRAPH_VERSION } = require('./adsEvents');

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * @returns {{token:string, adAccountId:string}|null} null when the channel is off.
 * Callers must decide what an off channel means for them — this never throws, so an
 * unconfigured deploy cannot crash a route or a cron.
 */
function metaCreds() {
  const token = process.env.META_ACCESS_TOKEN;
  const raw = process.env.META_AD_ACCOUNT_ID;
  if (!token || !raw) return null;
  return { token, adAccountId: String(raw).startsWith('act_') ? String(raw) : `act_${raw}` };
}

async function graph(path, { token, method = 'GET', form } = {}) {
  const res = await fetchWithRetry(`${GRAPH}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (json.error) throw new Error(json.error.error_user_msg || json.error.message);
  if (!res.ok) throw new Error(`Meta ${res.status}`);
  return json;
}

// Meta reports conversions as an untyped `actions` array; pull one out by type.
const actionOf = (row, ...types) => {
  for (const t of types) {
    const hit = (row.actions || []).find((a) => a.action_type === t);
    if (hit) return Number(hit.value || 0);
  }
  return 0;
};
const valueOf = (row, ...types) => {
  for (const t of types) {
    const hit = (row.action_values || []).find((a) => a.action_type === t);
    if (hit) return Number(hit.value || 0);
  }
  return 0;
};

/**
 * Campaign state + performance for a window. READ ONLY.
 *
 * Campaigns with no spend never appear in insights, so the two calls are merged —
 * a paused draft that is costing nothing is exactly the row an operator is looking
 * for when they ask why spend dropped.
 *
 * @param {string} datePreset one of Meta's presets, e.g. `last_7d`, `last_30d`.
 */
async function listCampaigns(datePreset = 'last_30d') {
  const creds = metaCreds();
  if (!creds) return null;
  const { token, adAccountId } = creds;
  const auth = { token };

  const [insights, campaigns] = await Promise.all([
    graph(
      `${adAccountId}/insights?level=campaign&date_preset=${encodeURIComponent(datePreset)}` +
        '&fields=campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,actions,action_values&limit=200',
      auth,
    ),
    graph(
      `${adAccountId}/campaigns?fields=id,name,status,effective_status,daily_budget,lifetime_budget&limit=200`,
      auth,
    ),
  ]);

  const byId = Object.fromEntries((campaigns.data || []).map((c) => [c.id, c]));
  const rows = (insights.data || []).map((r) => {
    const meta = byId[r.campaign_id] || {};
    const spend = Number(r.spend || 0);
    // A "purchase" on Meta has three names depending on how the pixel/CAPI reported
    // it; omni_purchase is the deduped cross-device one, so it is tried first.
    const purchases = actionOf(r, 'omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase');
    const revenue = valueOf(r, 'omni_purchase', 'purchase');
    delete byId[r.campaign_id];
    return {
      id: r.campaign_id,
      name: r.campaign_name,
      status: meta.effective_status || meta.status || null,
      dailyBudget: meta.daily_budget ? Number(meta.daily_budget) / 100 : null,
      spend: Math.round(spend),
      impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0),
      ctr: r.ctr ? +Number(r.ctr).toFixed(2) : 0,
      cpc: r.cpc ? +Number(r.cpc).toFixed(2) : null,
      purchases,
      addToCart: actionOf(r, 'omni_add_to_cart', 'add_to_cart'),
      initiateCheckout: actionOf(r, 'omni_initiated_checkout', 'initiate_checkout'),
      revenue: Math.round(revenue),
      cpa: purchases > 0 ? Math.round(spend / purchases) : null,
      roas: spend > 0 && revenue > 0 ? +(revenue / spend).toFixed(2) : null,
    };
  });

  // Whatever is left in byId never spent in the window.
  for (const c of Object.values(byId)) {
    rows.push({
      id: c.id,
      name: c.name,
      status: c.effective_status || c.status || null,
      dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: null,
      purchases: 0, addToCart: 0, initiateCheckout: 0, revenue: 0, cpa: null, roas: null,
    });
  }
  return rows;
}

/**
 * Pause or resume a campaign. **CHANGES LIVE AD DELIVERY.**
 * Guarded by `?apply=1` plus the shared secret in `routes/ads.js`.
 */
async function setCampaignStatus(campaignId, status) {
  const creds = metaCreds();
  if (!creds) return { ok: false, skipped: 'meta-not-configured' };
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw new Error('status must be ACTIVE or PAUSED');
  await graph(String(campaignId), { token: creds.token, method: 'POST', form: { status } });
  return { ok: true, campaignId: String(campaignId), status };
}

/**
 * Set a campaign's daily budget in rupees. **SPENDS MONEY.**
 * Guarded by `?apply=1` plus the shared secret in `routes/ads.js`.
 *
 * ponytail: campaign-level only. On a non-CBO campaign the budget lives on the ad
 * sets and Meta rejects this with a clear message; glassquickdev then fanned the
 * amount out across ad sets, which is a silent reallocation of somebody's carefully
 * split budget. Better to fail and let the operator split it in Ads Manager. Upgrade
 * path: accept an explicit `{adSetId: amount}` map if that ever gets tedious.
 */
async function setDailyBudget(campaignId, rupees) {
  const creds = metaCreds();
  if (!creds) return { ok: false, skipped: 'meta-not-configured' };
  const amount = Number(rupees);
  if (!(amount > 0)) throw new Error('budget must be a positive daily amount in INR');
  await graph(String(campaignId), {
    token: creds.token,
    method: 'POST',
    // Meta takes budgets in the currency's minor unit — paise.
    form: { daily_budget: String(Math.round(amount * 100)) },
  });
  return { ok: true, campaignId: String(campaignId), dailyBudget: amount };
}

/**
 * Is the pixel still alive? READ ONLY.
 *
 * The failure this catches: a theme deploy drops the pixel tag, nothing errors
 * anywhere, and the store spends for weeks on traffic Meta cannot optimise against.
 * `last_fired_time` is the only signal that turns that from a quarterly surprise
 * into a next-morning alert.
 */
async function pixelHealth({ staleHours = 24 } = {}) {
  const creds = metaCreds();
  const pixelId = process.env.META_PIXEL_ID;
  if (!creds || !pixelId) return { ok: false, skipped: 'meta-not-configured' };

  const p = await graph(`${pixelId}?fields=id,name,last_fired_time,is_unavailable`, {
    token: creds.token,
  });
  const hoursSinceFire = p.last_fired_time
    ? Math.round((Date.now() - new Date(p.last_fired_time).getTime()) / 36e5)
    : null;

  const issues = [];
  if (p.is_unavailable) issues.push('pixel is flagged unavailable — recreate it in Events Manager');
  if (hoursSinceFire == null) issues.push('pixel has never fired');
  else if (hoursSinceFire > staleHours)
    issues.push(`pixel has not fired for ${hoursSinceFire}h — check the storefront tag`);

  return {
    ok: issues.length === 0,
    pixelId: p.id,
    name: p.name,
    lastFired: p.last_fired_time || null,
    hoursSinceFire,
    issues,
  };
}

module.exports = { metaCreds, listCampaigns, setCampaignStatus, setDailyBudget, pixelHealth };
