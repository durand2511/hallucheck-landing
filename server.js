const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { sendMail, smtpConfigFromEnv } = require("./lib/smtp.js");

const PORT = process.env.PORT || 8092;
const NOTIFY_TO = process.env.CONTACT_EMAIL || "durand2511@gmail.com";
const DATA_FILE = path.join(__dirname, "data", "waitlist.json");
const PUBLIC_DIR = path.join(__dirname, "public");

function loadWaitlist() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return []; }
}
function saveWaitlist(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function serveStatic(req, res) {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  const full = path.join(PUBLIC_DIR, path.normalize(p));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleWaitlist(req, res) {
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: "Invalid request body." }); }
  const email = String(body?.email ?? "").trim().slice(0, 200);
  const useCase = String(body?.useCase ?? "").trim().slice(0, 1000);
  const company = String(body?.company ?? "").trim().slice(0, 200);
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: "Please enter a valid email address." });

  const list = loadWaitlist();
  if (!list.some((e) => e.email.toLowerCase() === email.toLowerCase())) {
    list.push({ email, company, useCase, ts: new Date().toISOString() });
    saveWaitlist(list);
  }

  const cfg = smtpConfigFromEnv();
  if (cfg) {
    const html =
      `<p>New HalluCheck waitlist signup</p>` +
      `<p><b>Email:</b> ${email}<br><b>Company:</b> ${company || "-"}<br><b>Use case:</b> ${useCase || "-"}</p>` +
      `<p>Total waitlist size: ${list.length}</p>`;
    try {
      await sendMail(cfg, { to: NOTIFY_TO, subject: "🔎 New HalluCheck waitlist signup — " + email, html, fromName: "HalluCheck" });
    } catch (e) {
      console.error("waitlist notify mail failed:", e.message);
    }
  }
  json(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/waitlist") return handleWaitlist(req, res);
  if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { ok: true });
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("method not allowed");
});

server.listen(PORT, () => console.log("hallucheck-landing listening on :" + PORT));
