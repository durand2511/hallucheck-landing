const { ensurePodRunning, markUsed } = require("./runpod.js");

// 502/503/504 from RunPod's own HTTPS proxy show up occasionally even right after its own
// /health check just returned 200 -- a momentary proxy-layer hiccup (connection pool churn etc),
// not the model server actually being down. Confirmed live: ensurePodRunning()'s health check
// passed, then the very next request to the same endpoint got a 502. These are worth a short
// retry instead of failing the whole analysis over a transient blip that clears itself in seconds.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;

async function analyzeDocument(question, documentText) {
  const endpoint = await ensurePodRunning();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${endpoint}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, document: documentText }),
    });
    if (res.ok) {
      await markUsed();
      return await res.json();
    }
    const retryable = RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS;
    if (!retryable) throw new Error(`Model server gaf ${res.status} terug`);
    console.warn(`[model-client] gateway ${res.status} on attempt ${attempt}, retrying`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
}

module.exports = { analyzeDocument };
