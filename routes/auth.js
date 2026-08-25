const express = require("express");
const { pool } = require("../lib/db.js");
const { hashPassword, verifyPassword, createSession, deleteSession } = require("../lib/auth.js");
const { defaultPlanForTrack } = require("../lib/plans.js");

const router = express.Router();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const COOKIE_OPTS = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 30 * 24 * 60 * 60 * 1000 };

// Minimal brute-force guard: 10 failed attempts per email in 15 minutes locks it out. In-memory is
// fine for a single-instance deploy; move to Postgres/Redis if this ever runs multi-instance.
const LOGIN_ATTEMPTS = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function checkLoginRateLimit(email) {
  const now = Date.now();
  const entry = LOGIN_ATTEMPTS.get(email);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    LOGIN_ATTEMPTS.set(email, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}
function clearLoginRateLimit(email) {
  LOGIN_ATTEMPTS.delete(email);
}

// Company signup: creates the company + its CEO/owner account. Billing (Stripe subscription) is
// wired up separately by the frontend right after this, via /api/billing/*.
router.post("/api/register", async (req, res) => {
  const { companyName, email, password, name, track: rawTrack } = req.body || {};
  // Track is chosen on the landing page (Accountancy vs. Andere bedrijven) before the user ever
  // sees a plan — it decides which feature set + plan grid they get, not the other way round.
  const track = rawTrack === "general" ? "general" : "accountancy";
  // No plan choice at signup — you get access first, and pick/confirm a plan later when you
  // actually activate billing from the dashboard. Default plan is just the schema default until then.
  const plan = defaultPlanForTrack(track);
  if (!String(companyName || "").trim()) return res.status(400).json({ error: "Company name is required." });
  if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [String(email).trim().toLowerCase()]);
  if (existing.length) return res.status(409).json({ error: "An account with this email address already exists." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [company] } = await client.query(
      "INSERT INTO companies (name, track, plan) VALUES ($1, $2, $3) RETURNING *",
      [String(companyName).trim(), track, plan],
    );
    const { rows: [user] } = await client.query(
      "INSERT INTO users (company_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, 'ceo') RETURNING *",
      [company.id, String(email).trim().toLowerCase(), hashPassword(password), String(name || "").trim()],
    );
    await client.query("COMMIT");
    if (track === "accountancy") {
      require("../lib/seed-templates.js").seedTemplatesForCompany(company.id, user.id).catch((err) =>
        console.error("[register] template seeding failed:", err.message),
      );
    }
    const token = await createSession(user.id);
    res.cookie("session", token, COOKIE_OPTS);
    res.status(201).json({ company: { id: company.id, name: company.name, track: company.track, plan: company.plan }, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    await client.query("ROLLBACK");
    req.log?.error?.(err);
    res.status(500).json({ error: "Registration failed." });
  } finally {
    client.release();
  }
});

router.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!checkLoginRateLimit(normalizedEmail)) {
    return res.status(429).json({ error: "Too many login attempts. Please try again in 15 minutes." });
  }
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "Incorrect email or password." });
  clearLoginRateLimit(normalizedEmail);
  const token = await createSession(user.id);
  res.cookie("session", token, COOKIE_OPTS);
  res.json({ user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

router.post("/api/logout", async (req, res) => {
  await deleteSession(req.cookies?.session);
  res.clearCookie("session");
  res.json({ ok: true });
});

router.get("/api/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in." });
  const { rows: [company] } = await pool.query("SELECT id, name, track, plan, subscription_status FROM companies WHERE id = $1", [req.user.company_id]);
  res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role, name: req.user.name }, company });
});

module.exports = router;
