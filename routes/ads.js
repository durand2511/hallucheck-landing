const fs = require("node:fs");
const express = require("express");
const { pool } = require("../lib/db.js");
const { requireAuth, requireCeo } = require("../lib/auth.js");
const { getCostPerClickCents } = require("../lib/settings.js");

const router = express.Router();

const STOPWORDS = new Set(["this", "that", "with", "from", "have", "does", "your", "about", "which", "their", "there", "would", "could", "should"]);
function significantWords(text) {
  return [...new Set((text || "").toLowerCase().match(/[a-z]{4,}/g) || [])].filter((w) => !STOPWORDS.has(w));
}

function scoreAd(ad, searchText) {
  const words = significantWords([ad.sector, ad.title, ad.description].join(" "));
  if (!words.length) return 0;
  const lower = searchText.toLowerCase();
  return words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
}

// Only surfaces ads when the AI actually flagged something it couldn't resolve (an ungrounded
// claim) -- if every claim in the answer is grounded, the AI already solved the problem itself
// and no ad is relevant. When there IS an unresolved issue, ads are scored against both that
// specific issue and the source document, so what's shown is tied to what was actually found.
router.get("/api/documents/:docId/queries/:queryId/ads", requireAuth, async (req, res) => {
  const { rows: [query] } = await pool.query(
    `SELECT q.*, d.storage_path, d.company_id FROM document_queries q
     JOIN documents d ON d.id = q.document_id WHERE q.id = $1 AND d.id = $2`,
    [Number(req.params.queryId), Number(req.params.docId)],
  );
  if (!query || query.company_id !== req.user.company_id) return res.status(404).json({ error: "Not found." });

  const citations = query.citations_json || [];
  const unresolved = citations.filter((c) => c && c.grounded === false);
  if (!unresolved.length) return res.json({ showAds: false, ads: [] });

  const issue = unresolved[0].claim;
  let documentText = "";
  try { documentText = fs.readFileSync(query.storage_path + ".txt", "utf-8"); } catch { /* fine, score on the issue alone */ }
  const searchText = `${unresolved.map((c) => c.claim).join(" ")} ${documentText}`;

  const { rows: activeAds } = await pool.query("SELECT * FROM ads WHERE status = 'active'");
  const ranked = activeAds
    .map((ad) => ({ ad, score: scoreAd(ad, searchText) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => ({ id: r.ad.id, title: r.ad.title, description: r.ad.description, url: r.ad.website_url }));

  res.json({ showAds: ranked.length > 0, issue, ads: ranked });
});

router.post("/api/ads/:id/click", requireAuth, async (req, res) => {
  const { rows: [ad] } = await pool.query("SELECT * FROM ads WHERE id = $1 AND status = 'active'", [Number(req.params.id)]);
  if (!ad) return res.status(404).json({ error: "Ad not found." });
  const cpc = await getCostPerClickCents();
  await pool.query(
    "INSERT INTO ad_clicks (ad_id, advertiser_id, document_query_id, charged_cents) VALUES ($1, $2, $3, $4)",
    [ad.id, ad.advertiser_id, req.body?.queryId ? Number(req.body.queryId) : null, cpc],
  );
  res.json({ url: ad.website_url });
});

// Anyone in the company (employee or CEO) can forward an ad they see while reviewing a document
// -- it always lands in the CEO's message center, since the CEO is usually the one who'd actually
// decide whether to engage a vendor, not whoever happened to be looking at that document.
router.post("/api/ads/:id/forward", requireAuth, async (req, res) => {
  const { rows: [ad] } = await pool.query("SELECT * FROM ads WHERE id = $1", [Number(req.params.id)]);
  if (!ad) return res.status(404).json({ error: "Ad not found." });
  const { rows: [forward] } = await pool.query(
    "INSERT INTO ad_forwards (company_id, ad_id, document_query_id, forwarded_by, note) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [req.user.company_id, ad.id, req.body?.queryId ? Number(req.body.queryId) : null, req.user.id, String(req.body?.note || "").trim()],
  );
  res.status(201).json({ forward });
});

router.get("/api/messages", requireCeo, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.note, f.read, f.created_at,
            a.title, a.description, a.website_url,
            u.name AS forwarded_by_name, u.email AS forwarded_by_email
     FROM ad_forwards f
     JOIN ads a ON a.id = f.ad_id
     JOIN users u ON u.id = f.forwarded_by
     WHERE f.company_id = $1
     ORDER BY f.created_at DESC`,
    [req.user.company_id],
  );
  const unreadCount = rows.filter((r) => !r.read).length;
  res.json({ messages: rows, unreadCount });
});

// Opening a forwarded ad marks it read AND counts as a real click (the CEO engaging with the
// vendor is exactly the outcome a click is meant to capture) -- same billing path as a direct click.
router.post("/api/messages/:id/click", requireCeo, async (req, res) => {
  const { rows: [forward] } = await pool.query(
    "SELECT f.*, a.website_url, a.advertiser_id, a.status FROM ad_forwards f JOIN ads a ON a.id = f.ad_id WHERE f.id = $1 AND f.company_id = $2",
    [Number(req.params.id), req.user.company_id],
  );
  if (!forward) return res.status(404).json({ error: "Message not found." });
  await pool.query("UPDATE ad_forwards SET read = true WHERE id = $1", [forward.id]);
  if (forward.status === "active") {
    const cpc = await getCostPerClickCents();
    await pool.query(
      "INSERT INTO ad_clicks (ad_id, advertiser_id, document_query_id, charged_cents) VALUES ($1, $2, $3, $4)",
      [forward.ad_id, forward.advertiser_id, forward.document_query_id, cpc],
    );
  }
  res.json({ url: forward.website_url });
});

module.exports = router;
