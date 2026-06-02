/**
 * subscribe-worker.js — Cloudflare Worker for TMW newsletter subscriptions
 * Deployed at: https://tmw-subscribe.jake-ab7.workers.dev
 *
 * NOTE: deploy this by pasting it into the Cloudflare dashboard
 * (Workers & Pages → tmw-subscribe → Edit code → Deploy). That preserves the
 * env vars/secrets below. Do NOT `wrangler deploy` without those vars defined,
 * or the topic/segment IDs will be wiped.
 *
 * Environment variables / secrets (already set in the Cloudflare dashboard):
 *   - RESEND_API_KEY, READERS_SEGMENT_ID, ALLOWED_ORIGIN
 *   - TOPIC_GLOBAL_ID, TOPIC_HOTEL_ID, TOPIC_FLORIDA_ID, TOPIC_TENNESSEE_ID,
 *     TOPIC_NEWYORK_ID, TOPIC_CARIBBEAN_ID, TOPIC_ROCKIES_ID
 *
 * POST JSON body — two modes:
 *
 *   1) Subscribe:
 *        { email, name?, first_name?, last_name?, markets: ["florida", ...] }
 *      → creates the Resend contact + sets topic subscriptions.
 *      → returns { success: true, already_subscribed: <bool> }
 *        (already_subscribed lets the site detect a repeat email and jump
 *         straight to "create a password".)
 *
 *   2) Profile update (after they make an account):
 *        { email, update: true, first_name, last_name, profession,
 *          company_name, based }
 *      → updates the existing contact with names + the custom properties.
 *      → returns { success: true, updated: <bool> }
 */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405, env);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ success: false, error: "Invalid JSON" }, 400, env); }

    const email = body && body.email;
    if (!email || typeof email !== "string") {
      return json({ success: false, error: "Email is required" }, 400, env);
    }
    const emailClean = email.trim().toLowerCase();
    if (!isValidEmail(emailClean)) {
      return json({ success: false, error: "Please enter a valid email address" }, 400, env);
    }

    // Names: prefer explicit first/last, else split a single `name`.
    let firstName = clean(body.first_name, 100);
    let lastName  = clean(body.last_name, 100);
    if (!firstName && !lastName && body.name && typeof body.name === "string") {
      const parts = body.name.trim().slice(0, 100).split(/\s+/);
      firstName = parts[0] || "";
      lastName  = parts.slice(1).join(" ");
    }

    // Custom contact properties (added in Resend: profession, company_name, based).
    const props = {
      profession:   clean(body.profession, 200),
      company_name: clean(body.company_name, 200),
      based:        clean(body.based, 200),
    };

    try {
      // ── Mode 2: profile update — patch the existing contact, no topics ──
      if (body.update === true) {
        const ok = await updateContact(env, emailClean, firstName, lastName, props);
        return json({ success: !!ok, updated: !!ok }, ok ? 200 : 500, env);
      }

      // ── Mode 1: subscribe ──
      const validMarkets = ["hotel", "florida", "tennessee", "newyork", "caribbean", "rockies"];
      const marketsClean = Array.isArray(body.markets)
        ? body.markets.filter(m => validMarkets.includes(m))
        : [];

      const contact = await upsertContact(env, emailClean, firstName, lastName, props);
      if (!contact.id) {
        return json({ success: false, error: "Could not create contact. Please try again." }, 500, env);
      }

      const topicMap = {
        hotel:     env.TOPIC_HOTEL_ID,
        florida:   env.TOPIC_FLORIDA_ID,
        tennessee: env.TOPIC_TENNESSEE_ID,
        newyork:   env.TOPIC_NEWYORK_ID,
        caribbean: env.TOPIC_CARIBBEAN_ID,
        rockies:   env.TOPIC_ROCKIES_ID,
      };
      const topicPayload = [{ id: env.TOPIC_GLOBAL_ID, subscription: "opt_in" }];
      for (const key of Object.keys(topicMap)) {
        if (!topicMap[key]) continue;
        topicPayload.push({
          id: topicMap[key],
          subscription: marketsClean.includes(key) ? "opt_in" : "opt_out",
        });
      }
      const topicOk = await subscribeToTopics(env, contact.id, topicPayload);
      if (!topicOk) console.warn(`Topic subscription failed for ${emailClean}, contact created`);

      return json({
        success: true,
        already_subscribed: !!contact.existed,
        message: contact.existed
          ? "You're already on the list."
          : "You're in! Welcome to Markets of Tomorrow.",
      }, 200, env);

    } catch (err) {
      console.error("Subscribe error:", err);
      return json({ success: false, error: "Something went wrong. Please try again." }, 500, env);
    }
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clean(v, max) { return (v && typeof v === "string") ? v.trim().slice(0, max || 200) : ""; }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin":  env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function authHeaders(env) {
  return { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" };
}

// Only attach custom props that actually have a value, so a partial update
// never wipes existing data with blanks.
function withProps(payload, props) {
  if (props.profession)   payload.profession   = props.profession;
  if (props.company_name) payload.company_name = props.company_name;
  if (props.based)        payload.based        = props.based;
  return payload;
}

// Create the contact. Returns { id, existed }. On a duplicate (409/422) it
// looks up the existing contact, patches the new fields onto it, and flags it.
async function upsertContact(env, email, firstName, lastName, props) {
  const url = `https://api.resend.com/audiences/${env.READERS_SEGMENT_ID}/contacts`;
  const payload = withProps(
    { email, first_name: firstName || "", last_name: lastName || "", unsubscribed: false },
    props || {}
  );

  const r = await fetch(url, { method: "POST", headers: authHeaders(env), body: JSON.stringify(payload) });
  const txt = await r.text();

  if (r.ok) {
    try { return { id: JSON.parse(txt).id, existed: false }; }
    catch (e) { return { id: null }; }
  }

  console.error(`upsertContact failed: HTTP ${r.status}`, txt.slice(0, 300));

  // Already exists → fetch it, patch the new fields onto it, flag as existing.
  if (r.status === 409 || r.status === 422) {
    try {
      const lookupUrl = `https://api.resend.com/audiences/${env.READERS_SEGMENT_ID}/contacts/${encodeURIComponent(email)}`;
      const lookup = await fetch(lookupUrl, { headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}` } });
      if (lookup.ok) {
        const data = await lookup.json();
        await updateContact(env, email, firstName, lastName, props); // best-effort
        return { id: data.id, existed: true };
      }
    } catch (e) { /* fall through */ }
  }

  return { id: null };
}

// Patch an existing contact's name + custom properties (by email).
async function updateContact(env, email, firstName, lastName, props) {
  const url = `https://api.resend.com/audiences/${env.READERS_SEGMENT_ID}/contacts/${encodeURIComponent(email)}`;
  const payload = {};
  if (firstName) payload.first_name = firstName;
  if (lastName)  payload.last_name  = lastName;
  withProps(payload, props || {});
  if (Object.keys(payload).length === 0) return true;

  const r = await fetch(url, { method: "PATCH", headers: authHeaders(env), body: JSON.stringify(payload) });
  if (!r.ok) { console.error(`updateContact failed: HTTP ${r.status}`, (await r.text()).slice(0, 300)); return false; }
  return true;
}

async function subscribeToTopics(env, contactId, topicPayload) {
  if (!topicPayload || topicPayload.length === 0) return true;
  const url = `https://api.resend.com/contacts/${contactId}/topics`;
  const r = await fetch(url, { method: "PATCH", headers: authHeaders(env), body: JSON.stringify(topicPayload) });
  if (!r.ok) { console.error(`subscribeToTopics failed: HTTP ${r.status}`, await r.text()); return false; }
  return true;
}
