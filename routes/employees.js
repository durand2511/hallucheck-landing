const express = require("express");
const { pool } = require("../lib/db.js");
const { hashPassword, requireCeo } = require("../lib/auth.js");

const router = express.Router();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

router.get("/api/employees", requireCeo, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, created_at FROM users WHERE company_id = $1 ORDER BY created_at",
    [req.user.company_id],
  );
  res.json({ employees: rows });
});

router.post("/api/employees", requireCeo, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [String(email).trim().toLowerCase()]);
  if (existing.length) return res.status(409).json({ error: "An account with this email address already exists." });

  const { rows: [employee] } = await pool.query(
    "INSERT INTO users (company_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, 'employee') RETURNING id, email, name, role, created_at",
    [req.user.company_id, String(email).trim().toLowerCase(), hashPassword(password), String(name || "").trim()],
  );
  res.status(201).json({ employee });
});

router.delete("/api/employees/:id", requireCeo, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own CEO account." });
  const { rowCount } = await pool.query(
    "DELETE FROM users WHERE id = $1 AND company_id = $2 AND role = 'employee'",
    [id, req.user.company_id],
  );
  if (!rowCount) return res.status(404).json({ error: "Employee not found." });
  res.json({ ok: true });
});

module.exports = router;
