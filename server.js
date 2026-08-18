const path = require("node:path");
const fs = require("node:fs");
require("express-async-errors"); // without this, a thrown/rejected error inside an async route
// handler crashes the whole process (Express 4 doesn't forward async errors on its own) — that
// would take the entire multi-tenant server down over a single bad request from one company.
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { pool } = require("./lib/db.js");
const { getSessionUser } = require("./lib/auth.js");
const { sendMail, smtpConfigFromEnv } = require("./lib/smtp.js");
const { startIdleWatcher } = require("./lib/runpod.js");

const PORT = process.env.PORT || 8092;
const NOTIFY_TO = process.env.CONTACT_EMAIL || "durand2511@gmail.com";
const DATA_FILE = path.join(__dirname, "data", "waitlist.json");

const app = express();
app.set("trust proxy", 1); // Render sits behind a reverse proxy — needed for correct client IPs in rate limiting

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

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  await pool.query(schema); // idempotent (CREATE TABLE/INDEX IF NOT EXISTS) — safe to run every boot
  startIdleWatcher();
  app.listen(PORT, () => console.log("vanKonijnenburg listening on :" + PORT));
}
main();
