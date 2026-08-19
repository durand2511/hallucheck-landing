const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { pool } = require("../lib/db.js");
const { requireAuth } = require("../lib/auth.js");
const { currentMonthKey } = require("../lib/plans.js");
const { analyzeDocument } = require("../lib/model-client.js");

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

// No fixed definition was given for "complex" vs "small" document, so this uses a page-count
// proxy (word count / ~500 words per page) as the classifier -- easy to retune later once real
// customer documents show what actually separates the two tiers in practice.
const COMPLEX_WORD_THRESHOLD = 2500; // ~5 pages

// Long documents are the whole point of this product (full annual reports, entire audit files,
// multi-hundred-page prospectuses) -- 200MB comfortably covers even a large scanned PDF, and the
// analysis pipeline itself has no length cap: model_server.py chunks the full document text and
// processes every chunk, it never truncates.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf") {
    const { extractText: pdfExtract } = require("pdf-parse");
    const result = await pdfExtract(file.buffer);
    return typeof result === "string" ? result : result.text || "";
  }
  return file.buffer.toString("utf-8");
}

// Internal DB value stays "klein" (CHECK constraint in schema.sql) -- only the UI label is
// translated (frontend renders it as "Small document"), so no schema/constraint migration needed.
function classify(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words > COMPLEX_WORD_THRESHOLD ? "complex" : "klein";
}

// Strip any path separators / traversal segments from the client-supplied filename before it
// ever touches path.join — an uploaded filename like "../../etc/cron.d/x" must not be able to
// write outside the company's own upload directory.
function safeFilename(name) {
  const base = path.basename(String(name || "upload"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-200) || "upload";
}

router.post("/api/documents", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received." });

  const month = currentMonthKey();
  let text;
  try {
    text = await extractText(req.file);
  } catch (err) {
    return res.status(400).json({ error: "Could not read this file: " + err.message });
  }
  const complexity = classify(text);

  const companyDir = path.join(DATA_DIR, "uploads", String(req.user.company_id));
  fs.mkdirSync(companyDir, { recursive: true });
  const storagePath = path.join(companyDir, `${Date.now()}-${safeFilename(req.file.originalname)}`);
  fs.writeFileSync(storagePath, req.file.buffer);
  fs.writeFileSync(storagePath + ".txt", text);

  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (company_id, uploaded_by, filename, storage_path, size_bytes, complexity)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, filename, complexity, status, created_at`,
    [req.user.company_id, req.user.id, req.file.originalname, storagePath, req.file.size, complexity],
  );

  // Usage is tracked for internal analytics only now (the product is free to use) -- no plan/quota
  // enforcement happens against these counters.
  await pool.query(
    `INSERT INTO usage_counters (company_id, month, complex_count, klein_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, month) DO UPDATE SET
       complex_count = usage_counters.complex_count + $3,
       klein_count = usage_counters.klein_count + $4`,
    [req.user.company_id, month, complexity === "complex" ? 1 : 0, complexity === "klein" ? 1 : 0],
  );

  res.status(201).json({ document: doc });
});

router.get("/api/documents", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, filename, complexity, status, created_at, analyzed_at FROM documents WHERE company_id = $1 ORDER BY created_at DESC",
    [req.user.company_id],
  );
  res.json({ documents: rows });
});

router.get("/api/documents/:id", requireAuth, async (req, res) => {
  const { rows: [doc] } = await pool.query(
    "SELECT * FROM documents WHERE id = $1 AND company_id = $2",
    [Number(req.params.id), req.user.company_id],
  );
  if (!doc) return res.status(404).json({ error: "Document not found." });
  res.json({ document: doc });
});

// The core interaction: upload once, then ask as many questions as needed. Each question is its
// own row so the UI can show a running Q&A thread with citations per answer — asking a follow-up
// question does NOT count against the monthly document quota (only the initial upload does).
router.post("/api/documents/:id/query", requireAuth, async (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "Please enter a question about the document." });

  const { rows: [doc] } = await pool.query(
    "SELECT * FROM documents WHERE id = $1 AND company_id = $2",
    [Number(req.params.id), req.user.company_id],
  );
  if (!doc) return res.status(404).json({ error: "Document not found." });

  const { rows: [query] } = await pool.query(
    "INSERT INTO document_queries (document_id, asked_by, question) VALUES ($1, $2, $3) RETURNING *",
    [doc.id, req.user.id, question],
  );

  await pool.query("UPDATE documents SET status = 'analyzing' WHERE id = $1", [doc.id]);
  try {
    const text = fs.readFileSync(doc.storage_path + ".txt", "utf-8");
    const result = await analyzeDocument(question, text);
    await pool.query(
      "UPDATE document_queries SET status = 'done', answer = $1, citations_json = $2 WHERE id = $3",
      [result.answer, JSON.stringify(result.citations || []), query.id],
    );
    await pool.query("UPDATE documents SET status = 'done', analyzed_at = now() WHERE id = $1", [doc.id]);
    res.json({ query: { ...query, answer: result.answer, citations: result.citations, status: "done" } });
  } catch (err) {
    await pool.query("UPDATE document_queries SET status = 'failed' WHERE id = $1", [query.id]);
    await pool.query("UPDATE documents SET status = 'failed' WHERE id = $1", [doc.id]);
    res.status(502).json({ error: "Analysis failed: " + err.message });
  }
});

router.get("/api/documents/:id/queries", requireAuth, async (req, res) => {
  const { rows: [doc] } = await pool.query(
    "SELECT id FROM documents WHERE id = $1 AND company_id = $2",
    [Number(req.params.id), req.user.company_id],
  );
  if (!doc) return res.status(404).json({ error: "Document not found." });
  const { rows } = await pool.query(
    "SELECT id, question, answer, citations_json, status, created_at FROM document_queries WHERE document_id = $1 ORDER BY created_at",
    [doc.id],
  );
  res.json({ queries: rows });
});

router.get("/api/usage", requireAuth, async (req, res) => {
  const month = currentMonthKey();
  const { rows: [usage] } = await pool.query(
    "SELECT * FROM usage_counters WHERE company_id = $1 AND month = $2",
    [req.user.company_id, month],
  );
  res.json({
    month,
    complexUsed: usage?.complex_count || 0,
    kleinUsed: usage?.klein_count || 0,
  });
});

module.exports = router;
