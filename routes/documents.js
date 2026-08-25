const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { pool } = require("../lib/db.js");
const { requireAuth } = require("../lib/auth.js");
// Same model-client switch as routes/excel.js: MODAL_ANALYZE_URL (real 31B model) first,
// LOCAL_MODEL_URL (free local 1.5B on the Dell laptop) second, RunPod as the last fallback.
const { analyzeDocument, analyzeAnswer, analyzeCitations, warmUp } = process.env.MODAL_ANALYZE_URL
  ? require("../lib/modal-client.js")
  : process.env.LOCAL_MODEL_URL
  ? require("../lib/local-model-client.js")
  : require("../lib/serverless-client.js");

const router = express.Router();

// A company shares one subscription, but not one filing cabinet. An employee was seeing every
// document and every Q&A thread belonging to everyone else in the firm, which for an accountancy
// practice means one employee reading another's client files. Employees now see only what they
// uploaded themselves; the CEO keeps the full view, so nothing becomes unreachable when someone
// leaves or is away.
//
// Returned as a SQL fragment plus params rather than filtering in JS, so a row the user may not
// see is never fetched in the first place -- there is no version of this where the wrong document
// is loaded and then hidden afterwards.
function visibilityScope(user, startIndex) {
  if (user.role === "ceo") return { sql: "", params: [] };
  return { sql: ` AND d.uploaded_by = $${startIndex}`, params: [user.id] };
}
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function safeFilename(name) {
  const base = path.basename(String(name || "document"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-200) || "document";
}

async function extractDocumentText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf") {
    const { extractText } = require("pdf-parse");
    const result = await extractText(file.buffer);
    return typeof result === "string" ? result : result.text || "";
  }
  return file.buffer.toString("utf-8");
}

// Upload once (paste text or a PDF/text file), ask as many follow-up questions as you like
// afterwards -- each question is its own grounded lookup against the same stored text, so the
// answer either comes back with a real citation or is flagged as not found, never guessed.
router.post("/api/documents", requireAuth, upload.single("file"), async (req, res) => {
  let text = String(req.body?.text || "").trim();
  let originalFilename = String(req.body?.title || "").trim().slice(0, 200) || "Geplakte tekst";
  if (req.file) {
    try {
      text = (await extractDocumentText(req.file)).trim();
      originalFilename = req.file.originalname;
    } catch (err) {
      return res.status(400).json({ error: "Could not read this file: " + err.message });
    }
  }
  if (!text) return res.status(400).json({ error: "Please paste some text, or upload a PDF/text file." });

  const companyDir = path.join(DATA_DIR, "documents", String(req.user.company_id));
  fs.mkdirSync(companyDir, { recursive: true });
  const storagePath = path.join(companyDir, `${Date.now()}-${safeFilename(originalFilename)}.txt`);
  fs.writeFileSync(storagePath, text, "utf-8");

  const { rows: [document] } = await pool.query(
    `INSERT INTO documents (company_id, uploaded_by, filename, storage_path, size_bytes, complexity, status, analyzed_at)
     VALUES ($1, $2, $3, $4, $5, 'klein', 'done', now())
     RETURNING id, filename, size_bytes, created_at`,
    [req.user.company_id, req.user.id, originalFilename, storagePath, Buffer.byteLength(text, "utf-8")],
  );
  res.status(201).json({ document });
  warmUp(); // a freshly uploaded document is about to get its first question
});

// The model container scales to zero, so the first question after a quiet spell pays a full
// cold start inside the request the user is watching. The frontend pings this the moment intent
// becomes visible -- a document gets opened, the question box gets focus -- so the GPU boots while
// the user is still typing. Returns immediately and on purpose: warmUp() is fire-and-forget, and
// making the browser wait for a boot it only wanted to TRIGGER would defeat the point.
router.post("/api/model/warm", requireAuth, (req, res) => {
  warmUp();
  res.status(202).json({ ok: true });
});

router.get("/api/documents", requireAuth, async (req, res) => {
  const scope = visibilityScope(req.user, 2);
  const { rows } = await pool.query(
    `SELECT d.id, d.filename, d.size_bytes, d.created_at,
       (SELECT COUNT(*) FROM document_queries dq WHERE dq.document_id = d.id) AS query_count
     FROM documents d WHERE d.company_id = $1${scope.sql} ORDER BY d.created_at DESC`,
    [req.user.company_id, ...scope.params],
  );
  res.json({ documents: rows });
});

router.delete("/api/documents/:id", requireAuth, async (req, res) => {
  const { rows: [document] } = await pool.query(
    `SELECT * FROM documents d WHERE d.id = $1 AND d.company_id = $2${visibilityScope(req.user, 3).sql}`,
    [Number(req.params.id), req.user.company_id, ...visibilityScope(req.user, 3).params],
  );
  if (!document) return res.status(404).json({ error: "Document not found." });
  fs.unlink(document.storage_path, (err) => { if (err && err.code !== "ENOENT") console.error("[documents] failed to delete file:", err.message); });
  await pool.query("DELETE FROM documents WHERE id = $1", [document.id]);
  res.json({ ok: true });
});

router.get("/api/documents/:id/queries", requireAuth, async (req, res) => {
  const { rows: [document] } = await pool.query(
    `SELECT d.id FROM documents d WHERE d.id = $1 AND d.company_id = $2${visibilityScope(req.user, 3).sql}`,
    [Number(req.params.id), req.user.company_id, ...visibilityScope(req.user, 3).params],
  );
  if (!document) return res.status(404).json({ error: "Document not found." });
  const { rows } = await pool.query(
    "SELECT id, question, answer, citations_json, status, error_message, created_at FROM document_queries WHERE document_id = $1 ORDER BY created_at ASC",
    [document.id],
  );
  res.json({ queries: rows });
});

router.post("/api/documents/:id/query", requireAuth, async (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "Please enter a question." });

  const { rows: [document] } = await pool.query(
    `SELECT * FROM documents d WHERE d.id = $1 AND d.company_id = $2${visibilityScope(req.user, 3).sql}`,
    [Number(req.params.id), req.user.company_id, ...visibilityScope(req.user, 3).params],
  );
  if (!document) return res.status(404).json({ error: "Document not found." });

  // Decoding is greedy and the stored document never changes, so re-asking a question this
  // document has already answered would spend minutes of GPU time reproducing the answer that is
  // already sitting in the row below. The re-ask still becomes its own thread entry, so the
  // conversation reads exactly as it did before -- it just skips the model.
  const { rows: [cached] } = await pool.query(
    `SELECT id, answer, citations_json FROM document_queries
     WHERE document_id = $1 AND question = $2 AND status = 'done'
     ORDER BY created_at DESC LIMIT 1`,
    [document.id, question],
  );
  if (cached) {
    const { rows: [copy] } = await pool.query(
      `INSERT INTO document_queries (document_id, asked_by, question, status, answer, citations_json, reused_from_query_id)
       VALUES ($1, $2, $3, 'done', $4, $5, $6) RETURNING id`,
      [document.id, req.user.id, question, cached.answer, JSON.stringify(cached.citations_json ?? []), cached.id],
    );
    return res.status(202).json({ query_id: copy.id });
  }

  const { rows: [query] } = await pool.query(
    `INSERT INTO document_queries (document_id, asked_by, question, status) VALUES ($1, $2, $3, 'pending') RETURNING id, created_at`,
    [document.id, req.user.id, question],
  );
  res.status(202).json({ query_id: query.id });

  try {
    const text = fs.readFileSync(document.storage_path, "utf-8");

    // Two calls instead of one, on purpose. Composing the answer and checking its quotes are
    // separate halves of the pipeline, and the second takes about as long as the first -- so
    // waiting for both before showing anything meant the answer sat finished and invisible for
    // roughly half the wait. Storing it after the first call lets the poll the browser is
    // already running put it on screen, with citations_json left NULL as the "quotes still being
    // checked" state (an empty array would mean "checked, found nothing", which is different).
    // Falls back to the single call for the local/RunPod clients, which have no split endpoint.
    if (analyzeAnswer && analyzeCitations) {
      const out = await analyzeAnswer(question, text);
      const answer = String(out.answer || "").trim();
      await pool.query("UPDATE document_queries SET answer = $1, status = 'done' WHERE id = $2", [answer, query.id]);
      try {
        const citations = await analyzeCitations(text, answer);
        await pool.query("UPDATE document_queries SET citations_json = $1 WHERE id = $2", [JSON.stringify(citations), query.id]);
      } catch (citeErr) {
        // The answer already reached the user and is still valid -- only the check failed. Record
        // that distinctly rather than storing an empty array, which would read as "we looked and
        // this answer is unsupported" and quietly turn an outage into an accusation.
        console.error("[documents] citation check failed:", citeErr);
        await pool.query(
          "UPDATE document_queries SET citations_json = '[]'::jsonb, error_message = $1 WHERE id = $2",
          ["De onderbouwing kon niet worden gecontroleerd: " + citeErr.message, query.id],
        );
      }
    } else {
      const out = await analyzeDocument(question, text);
      await pool.query(
        "UPDATE document_queries SET answer = $1, citations_json = $2, status = 'done' WHERE id = $3",
        [String(out.answer || "").trim(), JSON.stringify(out.citations || []), query.id],
      );
    }
  } catch (err) {
    console.error("[documents] query failed:", err);
    await pool.query(
      "UPDATE document_queries SET status = 'failed', error_message = $1 WHERE id = $2",
      [err.message, query.id],
    );
  }
});

router.get("/api/document-queries/:id", requireAuth, async (req, res) => {
  const { rows: [query] } = await pool.query(
    `SELECT dq.id, dq.question, dq.answer, dq.citations_json, dq.status, dq.error_message, dq.created_at
     FROM document_queries dq JOIN documents d ON d.id = dq.document_id
     WHERE dq.id = $1 AND d.company_id = $2${visibilityScope(req.user, 3).sql}`,
    [Number(req.params.id), req.user.company_id, ...visibilityScope(req.user, 3).params],
  );
  if (!query) return res.status(404).json({ error: "Query not found." });
  res.json({ query });
});

module.exports = router;
