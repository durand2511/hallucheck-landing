// Talks to the RunPod Serverless endpoint instead of managing on-demand Pods directly. RunPod's
// own worker scaler handles cold starts, warm reuse, and scale-to-zero -- there's no pod lifecycle
// to babysit here (no ensurePodRunning, no idle watcher, no per-request GPU/cloud/datacenter
// fallback chain), which was the whole source of today's stock-outage pain on the Pods API.
const API_BASE = "https://api.runpod.ai/v2";
const POLL_INTERVAL_MS = 3000;
// A confirmed cold start (no cached model, worker scaled to zero) took ~10.2 minutes end to end
// (5.4 min queued waiting for a worker + 4.8 min downloading/loading the model + answering), and
// a real (non-trivial) document's own analysis then separately exceeded the endpoint's own
// 10-minute executionTimeoutMs (now raised to 15 min there too, see createEndpoint notes).
// 20 minutes here covers cold-start queue delay PLUS that full execution budget with real margin,
// instead of the client giving up before RunPod's own timeout even would.
const MAX_WAIT_MS = 20 * 60 * 1000;

function endpointId() {
  const id = process.env.RUNPOD_SERVERLESS_ENDPOINT_ID;
  if (!id) throw new Error("RUNPOD_SERVERLESS_ENDPOINT_ID is not set.");
  return id;
}

function apiKey() {
  const k = process.env.RUNPOD_API_KEY;
  if (!k) throw new Error("RUNPOD_API_KEY is not set.");
  return k;
}

async function analyzeDocument(question, documentText) {
  const base = `${API_BASE}/${endpointId()}`;
  const headers = { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" };

  const submitRes = await fetch(`${base}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { question, document: documentText } }),
  });
  if (!submitRes.ok) throw new Error(`Serverless submit gaf ${submitRes.status} terug`);
  const { id: jobId } = await submitRes.json();
  if (!jobId) throw new Error("Serverless submit gaf geen job id terug.");

  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    const statusRes = await fetch(`${base}/status/${jobId}`, { headers });
    if (statusRes.ok) {
      const data = await statusRes.json();
      if (data.status === "COMPLETED") {
        return data.output;
      }
      if (data.status === "FAILED") {
        throw new Error(`Serverless job faalde: ${data.error || "onbekende fout"}`);
      }
      // IN_QUEUE / IN_PROGRESS -- keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // Best-effort cancel so a timed-out job doesn't keep burning worker time in the background.
  await fetch(`${base}/cancel/${jobId}`, { method: "POST", headers }).catch(() => {});
  throw new Error("De analyse werd niet op tijd voltooid.");
}

// Feeds the existing "Awake/Waking up/Asleep" badge in dashboard.html -- reuses the same
// starting/ready/stopped vocabulary the frontend already understands, just derived from RunPod's
// own endpoint health instead of a pod row we manage ourselves (Serverless has no pod lifecycle
// for this app to track or get stuck in a stale state over).
async function getStatus() {
  const base = `${API_BASE}/${endpointId()}`;
  const res = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${apiKey()}` } }).catch(() => null);
  if (!res || !res.ok) return "stopped";
  const data = await res.json().catch(() => null);
  const workers = data?.workers || {};
  if ((workers.initializing || 0) > 0) return "starting";
  if ((workers.running || 0) > 0 || (workers.ready || 0) > 0 || (workers.idle || 0) > 0) return "ready";
  return "stopped";
}

module.exports = { analyzeDocument, getStatus };
