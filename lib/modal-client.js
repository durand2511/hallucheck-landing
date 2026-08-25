// Talks to the Modal-hosted Grounding class (modal_app.py) -- replaces RunPod's serverless
// endpoint. Modal scales the container to zero when idle and keeps it warm for a short window
// after the last request (scaledown_window=120 in modal_app.py), so a cold start here means the
// container is loading the model from scratch (multi-minute HF download + weight load on first
// call after a cold spell) -- give it real headroom instead of failing early on a slow first hit.
//
// CRITICAL: does NOT use fetch()'s automatic redirect-following. Modal's web endpoints hold a
// long-running request open for a while, then reply "303 See Other" with a Location URL carrying
// an attempt-token to poll instead of blocking forever. fetch()'s default redirect:"follow" (like
// curl -L) converts that into an automatic GET -- confirmed live that this breaks against Modal's
// endpoint (the underlying task gets cancelled seconds after starting, visible in `modal container
// logs` as "Received a cancellation signal"). A correctly-behaving manual GET to the same Location
// URL (done as a genuinely separate request, not an auto-redirect) works and returns the real
// result once ready. So: redirect:"manual" here, and drive the 303 chain ourselves.
const MAX_WAIT_MS = 20 * 60 * 1000;
const POLL_TIMEOUT_MS = 280 * 1000; // Modal holds each poll connection open ~150-280s before replying
const MAX_POLLS = 30;

function baseUrl() {
  const url = process.env.MODAL_ANALYZE_URL;
  if (!url) throw new Error("MODAL_ANALYZE_URL is not set.");
  return url;
}

async function fetchNoRedirect(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function postAndFollow(url, payload) {
  const overallDeadline = Date.now() + MAX_WAIT_MS;

  let res = await fetchNoRedirect(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, POLL_TIMEOUT_MS);

  let polls = 0;
  while (res.status === 303 && polls < MAX_POLLS && Date.now() < overallDeadline) {
    polls++;
    const location = res.headers.get("location");
    if (!location) throw new Error("Modal gaf een 303 terug zonder Location-header.");
    res = await fetchNoRedirect(location, { method: "GET" }, POLL_TIMEOUT_MS);
  }

  if (res.status === 303) throw new Error("Modal-analyse werd niet op tijd voltooid (te veel poll-pogingen).");
  if (!res.ok) throw new Error(`Modal endpoint gaf ${res.status} terug: ${await res.text().catch(() => "")}`);
  return await res.json();
}

async function analyzeDocument(question, documentText) {
  return await postAndFollow(baseUrl(), { question, document: documentText });
}

// Every endpoint on the Grounding class gets its own URL, differing only in the method name at
// the end (Modal turns analyze_batch into ...-analyze-batch.modal.run). Deriving them from the
// one URL already in the environment keeps .env to a single MODAL_ANALYZE_URL instead of four
// that could drift apart, while each stays individually overridable.
function endpointUrl(method, override) {
  if (process.env[override]) return process.env[override];
  return baseUrl().replace(/-analyze(\.modal\.run)/, `-analyze-${method}$1`);
}

// Extract + compose only: the answer, without waiting for its quotes to be checked.
async function analyzeAnswer(question, documentText) {
  return await postAndFollow(endpointUrl("answer", "MODAL_ANSWER_URL"), { question, document: documentText });
}

// The cite half, for an answer analyzeAnswer produced earlier.
async function analyzeCitations(documentText, answer) {
  // "cite", not "citations": Modal's hostname is {workspace}--{app}-{class}-{method}.modal.run
  // and a DNS label maxes out at 63 characters. "analyze_citations" makes it 65, which Modal
  // truncates, leaving this call reaching for a host that does not exist -- it surfaced as a
  // plain "fetch failed" with nothing pointing at the name. See analyze_cite in modal_app.py.
  const out = await postAndFollow(endpointUrl("cite", "MODAL_CITATIONS_URL"), { document: documentText, answer });
  return out.citations || [];
}

// Fires the analyze_batch endpoint: N independent (question, document) lookups in ONE round trip.
// Each item still gets its own prompts and its own answer server-side -- see _pipeline() in
// modal_app.py -- so this is purely a scheduling win, not a change in what the model is asked.
async function analyzeBatch(items) {
  if (!items.length) return [];
  const data = await postAndFollow(endpointUrl("batch", "MODAL_BATCH_URL"), { items });
  const results = data.results || [];
  if (results.length !== items.length) {
    throw new Error(`Modal batch gaf ${results.length} resultaten terug voor ${items.length} vragen.`);
  }
  return results;
}

// Nudges Modal to start booting the GPU container BEFORE the user has finished typing. A cold
// start is minutes of model load, and it used to sit entirely inside the request the user waits
// on; fired at the moment intent becomes visible (a document gets opened, the question box gets
// focus) it overlaps with human typing time instead, which is time we were going to spend anyway.
//
// Deliberately not awaited by the caller and deliberately NOT aborted on a timeout: hitting the
// endpoint is enough to enqueue the container start, and cancelling the HTTP request is exactly
// what Modal reads as "caller went away" (see the redirect note above), which would undo the very
// thing we asked for. The throttle keeps repeated pings from queueing behind each other on a
// container that only accepts one input at a time.
const WARM_THROTTLE_MS = 60 * 1000;
let lastWarmAt = 0;

function warmUp() {
  const url = process.env.MODAL_HEALTH_URL;
  if (!url || Date.now() - lastWarmAt < WARM_THROTTLE_MS) return;
  lastWarmAt = Date.now();
  fetch(url, { redirect: "manual" }).catch(() => {});
}

async function getStatus() {
  const url = process.env.MODAL_HEALTH_URL;
  if (!url) return "stopped";
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return "stopped";
  const data = await res.json().catch(() => null);
  return data?.ok ? "ready" : "starting";
}

module.exports = { analyzeDocument, analyzeAnswer, analyzeCitations, analyzeBatch, warmUp, getStatus };
