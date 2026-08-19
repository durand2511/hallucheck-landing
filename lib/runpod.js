const { pool } = require("./db.js");

const API_BASE = "https://api.runpod.io/graphql";
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
// Every 48GB-class card capable of running this model in 4-bit. Real ordering is decided live in
// cheapestAvailableGpuOrder() -- RunPod's per-GPU pricing AND stock both shift minute to minute
// (confirmed earlier: A6000 and A40 have each been the cheaper one at different times), so a
// static hardcoded order would drift stale. This list is just the candidate pool.
const GPU_CANDIDATES = ["NVIDIA RTX A6000", "NVIDIA A40", "NVIDIA L40", "NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA RTX PRO 5000 Blackwell"];
const TEMPLATE_ID = process.env.RUNPOD_TEMPLATE_ID || "";
const INFERENCE_PORT = 8000;

function apiKey() {
  const k = process.env.RUNPOD_API_KEY;
  if (!k) throw new Error("RUNPOD_API_KEY is not set.");
  return k;
}

async function gql(query, variables) {
  const res = await fetch(`${API_BASE}?api_key=${apiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error("RunPod API error: " + JSON.stringify(data.errors));
  return data.data;
}

async function getPodRow() {
  const { rows } = await pool.query("SELECT * FROM gpu_pod WHERE id = 1");
  return rows[0];
}

async function setPodRow(fields) {
  const keys = Object.keys(fields);
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await pool.query(`UPDATE gpu_pod SET ${set} WHERE id = 1`, keys.map((k) => fields[k]));
}

// Ranks every candidate GPU type by live secure-cloud price (cheapest first), skipping any
// reporting zero/no stock -- checked fresh on every pod creation rather than cached, since prices
// and availability both move independently of each other from one moment to the next.
async function cheapestAvailableGpuOrder() {
  if (process.env.RUNPOD_GPU_TYPE) return [process.env.RUNPOD_GPU_TYPE];
  const query = `
    query gpuTypes($ids: [String!]) {
      gpuTypes(input: { id: $ids }) {
        id
        lowestPrice(input: { gpuCount: 1, secureCloud: true }) { uninterruptablePrice stockStatus }
      }
    }`;
  try {
    const data = await gql(query, { ids: GPU_CANDIDATES });
    const ranked = (data.gpuTypes || [])
      .filter((g) => g.lowestPrice && g.lowestPrice.uninterruptablePrice != null && g.lowestPrice.stockStatus)
      .sort((a, b) => a.lowestPrice.uninterruptablePrice - b.lowestPrice.uninterruptablePrice)
      .map((g) => g.id);
    if (ranked.length) return ranked;
  } catch (err) {
    console.warn("[runpod] pricing lookup failed, falling back to candidate list order:", err.message);
  }
  return GPU_CANDIDATES;
}

async function createPod() {
  const mutation = `
    mutation podFindAndDeployOnDemand($input: PodFindAndDeployOnDemandInput!) {
      podFindAndDeployOnDemand(input: $input) {
        id
        imageName
        machineId
        desiredStatus
      }
    }`;
  const gpuOrder = await cheapestAvailableGpuOrder();
  let lastErr;
  for (const gpuTypeId of gpuOrder) {
    const input = {
      cloudType: "SECURE",
      gpuCount: 1,
      volumeInGb: 40,
      containerDiskInGb: 20,
      gpuTypeId,
      name: "vankonijnenburg-analyzer",
      templateId: TEMPLATE_ID || undefined,
      imageName: TEMPLATE_ID ? undefined : "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
      ports: `${INFERENCE_PORT}/http,22/tcp`,
      startSsh: true,
      // Network volume holds the model weights + adapter + repo so a fresh pod never needs to
      // re-download them on every cold start (they'd otherwise add several GB + minutes per boot).
      networkVolumeId: process.env.RUNPOD_NETWORK_VOLUME_ID || undefined,
      volumeMountPath: "/workspace",
      dockerArgs: process.env.RUNPOD_STARTUP_CMD || undefined,
    };
    try {
      const data = await gql(mutation, { input });
      return data.podFindAndDeployOnDemand;
    } catch (err) {
      lastErr = err;
      if (!/SUPPLY_CONSTRAINT/.test(err.message)) throw err; // a real error, not just "this GPU type is out of stock"
      console.warn(`[runpod] ${gpuTypeId} out of stock, trying next type`);
    }
  }
  throw lastErr;
}

async function getPodStatus(podId) {
  const query = `
    query pod($input: PodFilter!) {
      pod(input: $input) {
        id
        desiredStatus
        runtime { ports { ip isIpPublic privatePort publicPort type } }
      }
    }`;
  const data = await gql(query, { input: { podId } });
  return data.pod;
}

async function terminatePod(podId) {
  const mutation = `mutation podTerminate($input: PodTerminateInput!) { podTerminate(input: $input) }`;
  await gql(mutation, { input: { podId } });
}

function endpointFromRuntime(runtime) {
  if (!runtime || !runtime.ports) return null;
  const p = runtime.ports.find((p) => p.privatePort === INFERENCE_PORT && p.isIpPublic);
  if (!p) return null;
  return `https://${p.ip}:${p.publicPort}`;
}

/** Ensure a pod is running + ready for inference. Starts one if needed, polls until the inference
 *  port is reachable. Called on-demand right before a document analysis job. Any failure resets
 *  the row back to "stopped" -- without this, a failed createPod() or a timed-out poll would
 *  leave status stuck at "starting" forever, and every later request would skip straight to
 *  polling a pod that never came up instead of ever trying to create a new one. */
async function ensurePodRunning({ maxWaitMs = 5 * 60 * 1000 } = {}) {
  try {
    return await ensurePodRunningInner(maxWaitMs);
  } catch (err) {
    await setPodRow({ status: "stopped", runpod_pod_id: null, endpoint_url: null });
    throw err;
  }
}

async function ensurePodRunningInner(maxWaitMs) {
  let row = await getPodRow();

  if (row.status === "ready" && row.runpod_pod_id) {
    const status = await getPodStatus(row.runpod_pod_id);
    const endpoint = endpointFromRuntime(status?.runtime);
    if (endpoint) {
      await setPodRow({ last_used_at: new Date(), endpoint_url: endpoint });
      return endpoint;
    }
    // pod died unexpectedly outside our control — fall through and recreate
  }

  if (row.status !== "starting") {
    const pod = await createPod();
    await setPodRow({ runpod_pod_id: pod.id, status: "starting", last_used_at: new Date() });
    row = await getPodRow();
  }

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await getPodStatus(row.runpod_pod_id);
    const endpoint = endpointFromRuntime(status?.runtime);
    if (endpoint) {
      const health = await fetch(`${endpoint}/health`).catch(() => null);
      if (health && health.ok) {
        await setPodRow({ status: "ready", endpoint_url: endpoint, last_used_at: new Date() });
        return endpoint;
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("The analysis GPU did not become available in time.");
}

async function markUsed() {
  await setPodRow({ last_used_at: new Date() });
}

/** Idle watcher: call periodically (setInterval). Terminates the pod once nobody has run an
 *  analysis for IDLE_TIMEOUT_MS, so GPU cost only accrues while actually in use. */
async function idleWatchTick() {
  const row = await getPodRow();
  if (row.status !== "ready" || !row.runpod_pod_id || !row.last_used_at) return;
  const idleMs = Date.now() - new Date(row.last_used_at).getTime();
  if (idleMs < IDLE_TIMEOUT_MS) return;
  await setPodRow({ status: "stopping" });
  try {
    await terminatePod(row.runpod_pod_id);
  } finally {
    await setPodRow({ status: "stopped", runpod_pod_id: null, endpoint_url: null });
  }
}

function startIdleWatcher() {
  setInterval(() => {
    idleWatchTick().catch((err) => console.error("[runpod] idle watcher error:", err.message));
  }, 60 * 1000);
}

module.exports = { ensurePodRunning, markUsed, idleWatchTick, startIdleWatcher, terminatePod, getPodRow };
