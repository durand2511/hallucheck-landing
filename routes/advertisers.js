const express = require("express");
const { pool } = require("../lib/db.js");
const {
  hashPassword,
  verifyPassword,
  createAdvertiserSession,
  deleteAdvertiserSession,
  requireAdvertiser,
} = require("../lib/advertiser-auth.js");
const { stripe } = require("../lib/stripe.js");
const { getCostPerClickCents } = require("../lib/settings.js");

const router = express.Router();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 30 * 24 * 60 * 60 * 1000 };

async function ensureStripeCustomer(advertiser, email) {
  if (advertiser.stripe_customer_id) return advertiser.stripe_customer_id;
  const customer = await stripe().customers.create({ email, name: advertiser.company_name || undefined, metadata: { advertiserId: String(advertiser.id) } });
  await pool.query("UPDATE advertisers SET stripe_customer_id = $1 WHERE id = $2", [customer.id, advertiser.id]);
  return customer.id;
}

router.post("/api/advertisers/register", async (req, res) => {
  const { email, password, companyName } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const { rows: existing } = await pool.query("SELECT id FROM advertisers WHERE email = $1", [String(email).trim().toLowerCase()]);
  if (existing.length) return res.status(409).json({ error: "An advertiser account with this email already exists." });

  const { rows: [advertiser] } = await pool.query(
    "INSERT INTO advertisers (email, password_hash, company_name) VALUES ($1, $2, $3) RETURNING *",
    [String(email).trim().toLowerCase(), hashPassword(password), String(companyName || "").trim()],
  );
  const token = await createAdvertiserSession(advertiser.id);
  res.cookie("advertiser_session", token, COOKIE_OPTS);
  res.status(201).json({ advertiser: { id: advertiser.id, email: advertiser.email, companyName: advertiser.company_name } });
});

router.post("/api/advertisers/login", async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query("SELECT * FROM advertisers WHERE email = $1", [String(email || "").trim().toLowerCase()]);
  const advertiser = rows[0];
  if (!advertiser || !verifyPassword(password, advertiser.password_hash)) return res.status(401).json({ error: "Incorrect email or password." });
  const token = await createAdvertiserSession(advertiser.id);
  res.cookie("advertiser_session", token, COOKIE_OPTS);
  res.json({ advertiser: { id: advertiser.id, email: advertiser.email, companyName: advertiser.company_name } });
});

router.post("/api/advertisers/logout", async (req, res) => {
  await deleteAdvertiserSession(req.cookies?.advertiser_session);
  res.clearCookie("advertiser_session");
  res.json({ ok: true });
});

router.get("/api/advertisers/me", requireAdvertiser, async (req, res) => {
  const cpc = await getCostPerClickCents();
  res.json({
    advertiser: {
      id: req.advertiser.id,
      email: req.advertiser.email,
      companyName: req.advertiser.company_name,
      hasPaymentMethod: !!req.advertiser.stripe_payment_method_id,
    },
    costPerClickCents: cpc,
  });
});

// Card-on-file, same pattern as company billing: a SetupIntent lets the frontend collect the
// card via Stripe Elements without it ever touching our server, then we attach it as default.
router.post("/api/advertisers/setup-intent", requireAdvertiser, async (req, res) => {
  const customerId = await ensureStripeCustomer(req.advertiser, req.advertiser.email);
  const intent = await stripe().setupIntents.create({ customer: customerId, payment_method_types: ["card"] });
  res.json({ clientSecret: intent.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

router.post("/api/advertisers/save-card", requireAdvertiser, async (req, res) => {
  const { paymentMethodId } = req.body || {};
  if (!paymentMethodId) return res.status(400).json({ error: "No payment method received." });
  const customerId = await ensureStripeCustomer(req.advertiser, req.advertiser.email);
  await stripe().paymentMethods.attach(paymentMethodId, { customer: customerId });
  await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  await pool.query("UPDATE advertisers SET stripe_payment_method_id = $1 WHERE id = $2", [paymentMethodId, req.advertiser.id]);
  res.json({ ok: true });
});

// --- Ads ---
router.get("/api/advertisers/ads", requireAdvertiser, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ads WHERE advertiser_id = $1 ORDER BY created_at DESC", [req.advertiser.id]);
  res.json({ ads: rows });
});

router.post("/api/advertisers/ads", requireAdvertiser, async (req, res) => {
  const { title, description, websiteUrl, sector } = req.body || {};
  if (!String(title || "").trim()) return res.status(400).json({ error: "An ad title is required." });
  let url = String(websiteUrl || "").trim();
  if (!url) return res.status(400).json({ error: "A website link is required." });
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try { new URL(url); } catch { return res.status(400).json({ error: "That website link doesn't look valid." }); }

  const { rows: [ad] } = await pool.query(
    "INSERT INTO ads (advertiser_id, title, description, website_url, sector) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [req.advertiser.id, String(title).trim(), String(description || "").trim(), url, String(sector || "").trim()],
  );
  res.status(201).json({ ad });
});

router.put("/api/advertisers/ads/:id", requireAdvertiser, async (req, res) => {
  const id = Number(req.params.id);
  const { title, description, websiteUrl, sector, status } = req.body || {};
  const { rows: [existing] } = await pool.query("SELECT * FROM ads WHERE id = $1 AND advertiser_id = $2", [id, req.advertiser.id]);
  if (!existing) return res.status(404).json({ error: "Ad not found." });

  let url = existing.website_url;
  if (websiteUrl !== undefined) {
    url = String(websiteUrl).trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { new URL(url); } catch { return res.status(400).json({ error: "That website link doesn't look valid." }); }
  }

  const { rows: [ad] } = await pool.query(
    `UPDATE ads SET title = $1, description = $2, website_url = $3, sector = $4,
       status = $5, updated_at = now() WHERE id = $6 RETURNING *`,
    [
      title !== undefined ? String(title).trim() : existing.title,
      description !== undefined ? String(description).trim() : existing.description,
      url,
      sector !== undefined ? String(sector).trim() : existing.sector,
      status === "paused" ? "paused" : "active",
      id,
    ],
  );
  res.json({ ad });
});

router.delete("/api/advertisers/ads/:id", requireAdvertiser, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM ads WHERE id = $1 AND advertiser_id = $2", [Number(req.params.id), req.advertiser.id]);
  if (!rowCount) return res.status(404).json({ error: "Ad not found." });
  res.json({ ok: true });
});

module.exports = router;
