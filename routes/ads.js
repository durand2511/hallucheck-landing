const fs = require("node:fs");
const express = require("express");
const { pool } = require("../lib/db.js");
const { requireAuth } = require("../lib/auth.js");
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

module.exports = router;
