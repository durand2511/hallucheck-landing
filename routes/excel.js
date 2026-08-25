const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const { pool } = require("../lib/db.js");
const { requireAuth } = require("../lib/auth.js");
// MODAL_ANALYZE_URL (the real, paid Modal-hosted 31B model) takes priority; LOCAL_MODEL_URL
// switches to the free local 1.5B model on the Dell laptop for testing without cloud GPU cost;
// otherwise falls back to the older RunPod serverless endpoint.
const { analyzeDocument, analyzeBatch, warmUp } = process.env.MODAL_ANALYZE_URL
  ? require("../lib/modal-client.js")
  : process.env.LOCAL_MODEL_URL
  ? require("../lib/local-model-client.js")
  : require("../lib/serverless-client.js");

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function safeFilename(name) {
  const base = path.basename(String(name || "template"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-200) || "template";
}

// Lets someone paste a PDF (e.g. a scanned journal export or a supplier statement) instead of
// retyping the figures as plain text -- same pdf-parse library the old documents feature used.
async function extractInputText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf") {
    const { extractText } = require("pdf-parse");
    const result = await extractText(file.buffer);
    return typeof result === "string" ? result : result.text || "";
  }
  return file.buffer.toString("utf-8");
}

// Parses a number the model wrote in EITHER Dutch (1.234,56 / 1.234) or plain English (1234.56)
// format into a real JS number. Getting this wrong silently corrupts a correct figure into a
// wrong one (e.g. "54.000" -> 54 if parsed as English) -- worse than leaving the cell blank,
// since a wrong number looks just as confident as a right one.
function parseLocaleNumber(raw) {
  const s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s) return NaN;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // whichever separator appears LAST is the decimal one; the other is a thousands separator
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    return lastComma > lastDot
      ? Number(s.replace(/\./g, "").replace(",", "."))   // 1.234,56 (NL)
      : Number(s.replace(/,/g, ""));                       // 1,234.56 (EN)
  }
  if (hasComma && !hasDot) return Number(s.replace(",", ".")); // 54,5 -> decimal comma
  if (hasDot && !hasComma) {
    // ambiguous: "54.000" is NL-thousands (=54000), "54.5" is a genuine decimal. Groups of
    // exactly 3 digits after the LAST dot, with nothing after, reads as a thousands separator.
    const groups = s.split(".");
    const isThousandsGrouped = groups.length > 1 && groups.slice(1).every((g) => g.length === 3);
    return isThousandsGrouped ? Number(groups.join("")) : Number(s);
  }
  return Number(s);
}

// Renders a worksheet as a plain 2D grid of display strings, so the frontend can show a real
// spreadsheet-shaped preview (voor/na) instead of an abstract field list -- capped to a
// reasonable range so a huge template doesn't blow up the response. Trims to the ACTUAL used
// column range (not a fixed width) -- a 2-column template shouldn't render 12 mostly-empty
// columns, that's what caused the awkward horizontal scroll.
function sheetToGrid(sheet, maxRow = 40, maxColCap = 20) {
  const grid = [];
  const rowCount = Math.min(sheet.rowCount || 0, maxRow);
  const maxCol = Math.min(sheet.columnCount || 1, maxColCap) || 1;
  for (let r = 1; r <= rowCount; r++) {
    const row = [];
    for (let c = 1; c <= maxCol; c++) {
      const cell = sheet.getCell(r, c);
      let display = "";
      if (cell.value != null) {
        if (typeof cell.value === "object" && cell.value.formula) display = `=${cell.value.formula}`;
        else if (typeof cell.value === "object" && cell.value.result != null) display = String(cell.value.result);
        else display = String(cell.value);
      }
      row.push(display);
    }
    grid.push(row);
  }
  return grid;
}

// The local 1.5B model gets confused when a whole multi-fact document is handed over for a
// single-field lookup (confirmed: the exact same sentence that fails inside a 3-sentence
// document succeeds immediately when given alone) -- so each field only ever gets the 2 most
// relevant sentences, not the full input. Pure word-overlap, no model call, so it can't itself
// introduce a wrong number -- worst case it picks a less-relevant sentence and the field comes
// back "not mentioned", never a wrong value.
const DOT_PLACEHOLDER = "@@DOT@@"; // a token that will not occur in normal pasted text

function splitSentences(text) {
  // protect "128.400"-style thousands-separator dots so they don't get read as sentence ends --
  // without this, "Personeelskosten waren 32.500 euro" splits into "...32." + "500 euro", and the
  // model receives a truncated number instead of the real one.
  const guarded = text.replace(/(\d)\.(\d)/g, "$1" + DOT_PLACEHOLDER + "$2");
  const parts = (guarded.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [guarded]).map((s) => s.trim()).filter(Boolean);
  return parts.map((s) => s.split(DOT_PLACEHOLDER).join("."));
}

// A pre-filter that GUESSES which sentence is relevant can silently skip the right one if its
// wording doesn't happen to share the field's words -- so instead of guessing, every sentence
// gets its own independent shot, one at a time (never bundled -- bundling is what caused the
// multi-fact confusion). Two steps per sentence, not one: a plain "what is the value" question
// turned out to make the model confidently hand back the ONLY number in an unrelated sentence
// (asked for "personeelskosten" against an afschrijvingen-only sentence -> confidently returned
// the afschrijvingen figure). A separate yes/no relevance check first ("does this text actually
// state a value for X") reliably says no on the wrong sentence and yes on the right one --
// confirmed by direct testing -- so only a sentence that passes that check ever gets asked for
// its value.
async function sentenceIsRelevant(field, sentence) {
  const q = `Does this text specifically state a value for "${field}"? Answer with just YES or NO.`;
  try {
    const out = await analyzeDocument(q, sentence);
    return /\byes\b/i.test(out.answer || "");
  } catch {
    return false;
  }
}

function questionForField(field) {
  return `What is the value for "${field}"? Answer with just the value (a number or short piece of text), nothing else. If it is not mentioned, say so.`;
}

// One sentence, one field, one independent lookup -- unchanged. What changed is only WHEN they
// run relative to each other. Asking them one at a time meant fields x sentences sequential round
// trips to a container that accepts a single input at a time, so a modest template against a page
// of figures spent almost all of its wall clock waiting in line rather than computing. The model
// server batches a whole set in one pass (analyze_batch -> _pipeline in modal_app.py), so the
// same set of questions now costs roughly what the slowest single one used to.
//
// Sentences are still walked in waves rather than all at once, which preserves the cheap part of
// the old early-exit: a field answered by sentence 2 never pays for sentences 13 onwards. Waves
// keep the batches big enough to be worth batching and small enough not to compute answers that
// were about to be thrown away.
const WAVE_SENTENCES = 12;
// Ceiling on questions per HTTP call, so one wave of a wide template can't build a request big
// enough to run past the model endpoint's own per-request timeout.
//
// Sized from measurement, not taste. On the H100 a batch of 8 costs ~2.2x what a single lookup
// costs (measured: 8 extracts in 43.5s against 19.8s for one), and a full three-stage pass over a
// group of 8 lands around 290s. modal_app.py allows 1800s per request, so ~3 groups -- 24 items --
// keeps a comfortable 2x margin. The first version of this constant was 128, which works out to
// roughly 4600s of work: it would have failed on every wide template, and always as a timeout
// rather than as anything that pointed at the batch size.
const MAX_BATCH_ITEMS = 24;

async function analyzeInBatches(items) {
  const out = [];
  for (let i = 0; i < items.length; i += MAX_BATCH_ITEMS) {
    out.push(...(await analyzeBatch(items.slice(i, i + MAX_BATCH_ITEMS))));
  }
  return out;
}

async function resolveFields(fieldMap, text) {
  const sentences = splitSentences(text);
  const candidates = sentences.length ? sentences : [text];
  const results = fieldMap.map((f) => ({ field: f.field, cell: f.cell, value: "", grounded: false, citation: null }));
  let unresolved = results.map((_, i) => i);

  for (let start = 0; start < candidates.length && unresolved.length; start += WAVE_SENTENCES) {
    const wave = candidates.slice(start, start + WAVE_SENTENCES);
    const items = [];
    const origin = [];
    for (const fieldIdx of unresolved) {
      wave.forEach((sentence, sentenceIdx) => {
        items.push({ question: questionForField(results[fieldIdx].field), document: sentence });
        origin.push({ fieldIdx, sentenceIdx });
      });
    }

    // Deliberately NOT swallowed the way the old per-sentence loop swallowed its errors: back
    // then a failure cost one sentence, so carrying on still produced a real answer. A failed
    // batch call is an endpoint problem covering every field at once, and reporting that as
    // "not found in the document" would be a lie that silently leaves the template unfilled.
    const out = await analyzeInBatches(items);

    // First grounded sentence in document order wins -- exactly the sequential loop's rule.
    //
    // "Grounded" means a citation that actually carries a quote, NOT merely a non-empty citations
    // array. The pipeline emits one entry per sentence of the answer whether or not it found
    // supporting text (an unsupported one is {quote: null, grounded: false}), so the old
    // `citations.length > 0` test was true for literally any non-empty answer. That quietly
    // defeated this feature's core safety property -- the "never write a guess" rule enforced a
    // few lines below only holds if `grounded` means what it says. documents.html got this right
    // (`citations.some((c) => c && c.grounded)`); this path did not.
    const best = new Map();
    out.forEach((res, i) => {
      const { fieldIdx, sentenceIdx } = origin[i];
      const citation = (res.citations || []).find((c) => c && c.grounded && c.quote);
      if (!citation) return;
      const prev = best.get(fieldIdx);
      if (!prev || sentenceIdx < prev.sentenceIdx) best.set(fieldIdx, { sentenceIdx, res, citation });
    });
    for (const [fieldIdx, hit] of best) {
      results[fieldIdx].grounded = true;
      results[fieldIdx].value = String(hit.res.answer || "").trim();
      results[fieldIdx].citation = hit.citation;
    }
    unresolved = unresolved.filter((i) => !results[i].grounded);
  }
  return results;
}

// field_map is entirely human-defined at upload time -- which named field goes in which cell.
// The model is never asked to guess a cell location; it only ever answers "what is the value
// for this named field", the exact same grounded-Q&A mechanism the rest of the product already
// uses. That keeps the one part of this feature that could silently go wrong (writing the wrong
// number into the wrong cell) fully deterministic and outside the model's control.
function parseFieldMap(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("field_map must be valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("field_map must be a non-empty array.");
  for (const f of parsed) {
    if (!f.field || !f.cell) throw new Error("Each field_map entry needs a 'field' name and a target 'cell' (e.g. B4).");
  }
  return parsed;
}

router.post("/api/excel-templates", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No template file received." });
  const name = String(req.body?.name || req.file.originalname).trim().slice(0, 200);
  let fieldMap;
  try {
    fieldMap = parseFieldMap(req.body?.field_map);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const companyDir = path.join(DATA_DIR, "excel-templates", String(req.user.company_id));
  fs.mkdirSync(companyDir, { recursive: true });
  const storagePath = path.join(companyDir, `${Date.now()}-${safeFilename(req.file.originalname)}`);
  fs.writeFileSync(storagePath, req.file.buffer);

  const { rows: [template] } = await pool.query(
    `INSERT INTO excel_templates (company_id, created_by, name, original_filename, storage_path, field_map_json)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, original_filename, field_map_json, is_favorite, created_at`,
    [req.user.company_id, req.user.id, name, req.file.originalname, storagePath, JSON.stringify(fieldMap)],
  );
  res.status(201).json({ template });
});

router.get("/api/excel-templates", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, original_filename, field_map_json, is_favorite, created_at FROM excel_templates WHERE company_id = $1 ORDER BY is_favorite DESC, created_at DESC",
    [req.user.company_id],
  );
  res.json({ templates: rows });
});

router.patch("/api/excel-templates/:id/favorite", requireAuth, async (req, res) => {
  const { rows: [template] } = await pool.query(
    "UPDATE excel_templates SET is_favorite = NOT is_favorite WHERE id = $1 AND company_id = $2 RETURNING id, is_favorite",
    [Number(req.params.id), req.user.company_id],
  );
  if (!template) return res.status(404).json({ error: "Template not found." });
  res.json({ template });
});

router.delete("/api/excel-templates/:id", requireAuth, async (req, res) => {
  const { rows: [template] } = await pool.query(
    "SELECT * FROM excel_templates WHERE id = $1 AND company_id = $2",
    [Number(req.params.id), req.user.company_id],
  );
  if (!template) return res.status(404).json({ error: "Template not found." });
  fs.unlink(template.storage_path, (err) => { if (err && err.code !== "ENOENT") console.error("[excel] failed to delete template file:", err.message); });
  await pool.query("DELETE FROM excel_templates WHERE id = $1", [template.id]);
  res.json({ ok: true });
});

// The core interaction: paste your figures as plain text, get every field mapped to its cell --
// each field is answered independently via the SAME grounded-Q&A pipeline the rest of the product
// uses (the pasted text stands in as the "document"). If the model can't cite the value directly
// from what you typed, the field comes back ungrounded and is left BLANK for the accountant to
// fill in by hand, rather than guessed. Excel's own formulas in the template do every calculation;
// this endpoint only ever writes the plain input values the model found, verbatim.
router.post("/api/excel-templates/:id/fill", requireAuth, upload.single("file"), async (req, res) => {
  let inputText = String(req.body?.input_text || "").trim();
  if (req.file) {
    try {
      inputText = (await extractInputText(req.file)).trim();
    } catch (err) {
      return res.status(400).json({ error: "Could not read this file: " + err.message });
    }
  }
  if (!inputText) return res.status(400).json({ error: "Please paste your figures as text, or upload a PDF/text file." });

  const { rows: [template] } = await pool.query(
    "SELECT * FROM excel_templates WHERE id = $1 AND company_id = $2",
    [Number(req.params.id), req.user.company_id],
  );
  if (!template) return res.status(404).json({ error: "Template not found." });

  const { rows: [fill] } = await pool.query(
    `INSERT INTO excel_fills (template_id, filled_by, input_text, result_json, output_storage_path)
     VALUES ($1, $2, $3, '{"status":"pending"}', '') RETURNING id, created_at`,
    [template.id, req.user.id, inputText],
  );
  res.status(202).json({ fill_id: fill.id });
  warmUp(); // no-op if already warm; overlaps any cold start with the work just below

  try {
    const results = await resolveFields(template.field_map_json, inputText);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(template.storage_path);
    const sheet = workbook.worksheets[0];
    const gridBefore = sheetToGrid(sheet); // snapshot BEFORE writing any values in

    for (const r of results) {
      if (!r.grounded) continue; // leave the cell exactly as the template had it -- never write a guess
      const asNumber = parseLocaleNumber(r.value);
      sheet.getCell(r.cell).value = Number.isFinite(asNumber) && r.value.match(/[\d]/) ? asNumber : r.value;
    }
    const gridAfter = sheetToGrid(sheet); // snapshot AFTER, so the frontend can show a real voor/na

    const outDir = path.join(DATA_DIR, "excel-fills", String(req.user.company_id));
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, `${fill.id}-${safeFilename(template.original_filename)}`);
    await workbook.xlsx.writeFile(outputPath);

    await pool.query(
      "UPDATE excel_fills SET result_json = $1, output_storage_path = $2 WHERE id = $3",
      [JSON.stringify({ status: "done", fields: results, gridBefore, gridAfter }), outputPath, fill.id],
    );
  } catch (err) {
    console.error("[excel] fill failed:", err);
    await pool.query(
      "UPDATE excel_fills SET result_json = $1 WHERE id = $2",
      [JSON.stringify({ status: "failed", error: err.message }), fill.id],
    );
  }
});

router.get("/api/excel-fills/:id", requireAuth, async (req, res) => {
  const { rows: [fill] } = await pool.query(
    `SELECT ef.id, ef.input_text, ef.result_json, ef.created_at, et.name AS template_name
     FROM excel_fills ef JOIN excel_templates et ON et.id = ef.template_id
     WHERE ef.id = $1 AND et.company_id = $2`,
    [Number(req.params.id), req.user.company_id],
  );
  if (!fill) return res.status(404).json({ error: "Fill not found." });
  res.json({ fill });
});

router.get("/api/excel-fills/:id/download", requireAuth, async (req, res) => {
  const { rows: [fill] } = await pool.query(
    `SELECT ef.output_storage_path, ef.result_json, et.original_filename, et.company_id
     FROM excel_fills ef JOIN excel_templates et ON et.id = ef.template_id
     WHERE ef.id = $1 AND et.company_id = $2`,
    [Number(req.params.id), req.user.company_id],
  );
  if (!fill || fill.result_json?.status !== "done") return res.status(404).json({ error: "Not ready or not found." });
  res.download(fill.output_storage_path, fill.original_filename);
});

module.exports = router;
