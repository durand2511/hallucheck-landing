const { pool } = require("./db.js");
const { hashPassword, verifyPassword, newSessionToken } = require("./auth.js");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function createAdvertiserSession(advertiserId) {
  const token = newSessionToken();
  await pool.query(
    "INSERT INTO advertiser_sessions (token, advertiser_id, expires_at) VALUES ($1, $2, $3)",
    [token, advertiserId, new Date(Date.now() + SESSION_TTL_MS)],
  );
  return token;
}

async function getSessionAdvertiser(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT a.*, s.expires_at FROM advertiser_sessions s JOIN advertisers a ON a.id = s.advertiser_id WHERE s.token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query("DELETE FROM advertiser_sessions WHERE token = $1", [token]);
    return null;
  }
  return row;
}

async function deleteAdvertiserSession(token) {
  if (token) await pool.query("DELETE FROM advertiser_sessions WHERE token = $1", [token]);
}

function requireAdvertiser(req, res, next) {
  if (!req.advertiser) return res.status(401).json({ error: "Not logged in." });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createAdvertiserSession,
  getSessionAdvertiser,
  deleteAdvertiserSession,
  requireAdvertiser,
};
