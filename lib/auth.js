const { randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");
const { pool } = require("./db.js");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pw), salt, 64);
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}

function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = scryptSync(String(pw), salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function newSessionToken() {
  return randomBytes(32).toString("hex");
}

async function createSession(userId) {
  const token = newSessionToken();
  await pool.query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [token, userId, new Date(Date.now() + SESSION_TTL_MS)],
  );
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
    return null;
  }
  return row;
}

async function deleteSession(token) {
  if (token) await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Niet ingelogd." });
  next();
}

function requireCeo(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Niet ingelogd." });
  if (req.user.role !== "ceo") return res.status(403).json({ error: "Alleen voor CEO/eigenaar-account." });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  newSessionToken,
  createSession,
  getSessionUser,
  deleteSession,
  requireAuth,
  requireCeo,
};
