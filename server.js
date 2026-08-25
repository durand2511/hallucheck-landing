// Must be the very first thing that runs: several required modules below (lib/db.js, lib/stripe.js,
// routes/excel.js's Modal-vs-RunPod client selection) read process.env at REQUIRE time, not later --
// loading .env after those requires would silently leave them all unconfigured. In production
// (Render) these same variables come from real platform env vars, so dotenv finding no .env file
// there is expected and harmless (it only fills in gaps, never overrides an already-set var).
require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
require("express-async-errors"); // without this, a thrown/rejected error inside an async route
// handler crashes the whole process (Express 4 doesn't forward async errors on its own) — that
// would take the entire multi-tenant server down over a single bad request from one company.
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { pool } = require("./lib/db.js");
const { getSessionUser } = require("./lib/auth.js");
const { sendMail, smtpConfigFromEnv } = require("./lib/smtp.js");
const { seedTemplatesForAllCompanies } = require("./lib/seed-templates.js");

const PORT = process.env.PORT || 8092;
const NOTIFY_TO = process.env.CONTACT_EMAIL || "durand2511@gmail.com";
const DATA_FILE = path.join(__dirname, "data", "waitlist.json");

const app = express();
app.set("trust proxy", 1); // Render sits behind a reverse proxy — needed for correct client IPs in rate limiting

// Site-wide HTTP Basic Auth gate while this is still in testing — keeps random visitors from
// triggering real GPU spend on the analysis pipeline. /healthz stays open so Render's own health
// checks don't start failing deploys, and the Stripe webhook stays open since Stripe's servers
// can't supply these credentials. Opt-in via env vars so removing them later fully disables this.
app.use((req, res, next) => {
  if (req.path === "/healthz" || req.path === "/api/billing/webhook") return next();
  const SITE_USER = process.env.SITE_AUTH_USER;
  const SITE_PASS = process.env.SITE_AUTH_PASS;
  if (!SITE_USER || !SITE_PASS) return next();

  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString("utf-8").split(":");
    const userBuf = Buffer.from(user || "");
    const passBuf = Buffer.from(pass || "");
    const userOk = userBuf.length === Buffer.byteLength(SITE_USER) && crypto.timingSafeEqual(userBuf, Buffer.from(SITE_USER));
    const passOk = passBuf.length === Buffer.byteLength(SITE_PASS) && crypto.timingSafeEqual(passBuf, Buffer.from(SITE_PASS));
    if (userOk && passOk) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="vanKonijnenburg"');
  res.status(401).send("Authentication required.");
});

// The Stripe webhook route needs the untouched raw request body to verify its signature (see
// routes/billing.js), so it must be excluded from the global JSON parser or that verification
// would always fail — express.json() would already have consumed/parsed the stream by then.
const jsonParser = express.json({ limit: "2mb" });
app.use((req, res, next) => (req.path === "/api/billing/webhook" ? next() : jsonParser(req, res, next)));
app.use(cookieParser());
app.use("/api/", rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));

app.use(async (req, res, next) => {
  req.user = await getSessionUser(req.cookies?.session).catch(() => null);
  next();
});

app.use(require("./routes/auth.js"));
app.use(require("./routes/employees.js"));
app.use(require("./routes/excel.js"));
app.use(require("./routes/documents.js"));
app.use(require("./routes/billing.js"));

function loadWaitlist() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return []; }
}
function saveWaitlist(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

app.post("/api/waitlist", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().slice(0, 200);
  const useCase = String(req.body?.useCase ?? "").trim().slice(0, 1000);
  const company = String(req.body?.company ?? "").trim().slice(0, 200);
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: "Please enter a valid email address." });

  const list = loadWaitlist();
  if (!list.some((e) => e.email.toLowerCase() === email.toLowerCase())) {
    list.push({ email, company, useCase, ts: new Date().toISOString() });
    saveWaitlist(list);
  }

  const cfg = smtpConfigFromEnv();
  if (cfg) {
    const html = `<p>New vanKonijnenburg waitlist signup</p><p><b>Email:</b> ${email}<br><b>Company:</b> ${company || "-"}<br><b>Use case:</b> ${useCase || "-"}</p><p>Total waitlist size: ${list.length}</p>`;
    sendMail(cfg, { to: NOTIFY_TO, subject: "🔎 New vanKonijnenburg waitlist signup — " + email, html, fromName: "vanKonijnenburg" })
      .catch((e) => console.error("waitlist notify mail failed:", e.message));
  }
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// A restart (deploy, crash, or a manual kill during local dev) drops whatever in-flight promises
// were running an analysis -- the DB row is left at status 'pending' forever with no process left
// to ever resolve it, and the frontend's poll loop only stops polling once status changes, so the
// UI would spin indefinitely with no indication anything went wrong. A fresh boot is proof no
// in-memory work could still be running, so any 'pending' row at this point is provably orphaned.
async function failOrphanedPendingWork() {
  const { rowCount: queryCount } = await pool.query(
    `UPDATE document_queries SET status = 'failed', error_message = 'Onderbroken door een server-herstart. Probeer het opnieuw.' WHERE status = 'pending'`,
  );
  const { rowCount: fillCount } = await pool.query(
    `UPDATE excel_fills SET result_json = jsonb_set(result_json, '{status}', '"failed"') || '{"error":"Onderbroken door een server-herstart. Probeer het opnieuw."}'::jsonb
     WHERE result_json->>'status' = 'pending'`,
  );
  if (queryCount || fillCount) console.log(`[boot] marked ${queryCount} document quer${queryCount === 1 ? "y" : "ies"} and ${fillCount} excel fill(s) as failed (orphaned by restart)`);
}

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schema); // idempotent (CREATE TABLE/INDEX IF NOT EXISTS) — safe to run every boot
  await failOrphanedPendingWork();
  seedTemplatesForAllCompanies().catch((err) => console.error("[boot] template seeding failed:", err.message));
  app.listen(PORT, () => console.log("vanKonijnenburg listening on :" + PORT));
}
main();
