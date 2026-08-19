const { pool } = require("./db.js");

async function getSetting(key, fallback) {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await pool.query(
    "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
    [key, String(value)],
  );
}

// The one place the cost-per-click lives -- change it here (or via PUT /api/admin/settings/cpc)
// and every ad-click charge picks it up immediately, no code deploy needed.
async function getCostPerClickCents() {
  const v = await getSetting("cost_per_click_cents", "50");
  return parseInt(v, 10) || 50;
}

module.exports = { getSetting, setSetting, getCostPerClickCents };
