const { pool } = require("./db.js");

const API_BASE = "https://api.runpod.io/graphql";
const IDLE_TIMEOUT_MS = 60 * 1000; // shut the pod down 1 minute after the last analysis, per user preference
const MIN_GPU_MEMORY_GB = 40; // smallest card this model fits on in 4-bit
const TEMPLATE_ID = process.env.RUNPOD_TEMPLATE_ID || "";
// Clones the (private) hallucheck-scripts repo using a pod-local env var -- not baked into this
// string as a literal, so the token itself is never embedded in RunPod's stored pod config text,
// only passed at runtime via env. pod_startup.sh (in that repo) takes it from there: pip installs
// + loads the model + serves /analyze.
const DEFAULT_STARTUP_CMD =
  'bash -c "mkdir -p /workspace && cd /workspace && (git clone https://${GITHUB_PAT}@github.com/durand2511/hallucheck-scripts.git hallucheck || true) && cd hallucheck && bash pod_startup.sh"';
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

// Ranks every GPU type capable of running this model (>= 40GB) by live price across BOTH secure
// and community cloud, cheapest first, skipping anything reporting no stock right now. Checked
// fresh on every pod creation, never cached or hardcoded -- RunPod's pricing AND availability
// each move independently from one minute to the next (confirmed: every 48GB-class secure-cloud
// card was simultaneously out of stock at one point this session), so the only reliable approach
// is to ask live and cast as wide a net as the account can actually use, not guess a fixed order.
async function cheapestAvailableGpuOrder() {
  if (process.env.RUNPOD_GPU_TYPE) return [{ gpuTypeId: process.env.RUNPOD_GPU_TYPE, cloudType: "SECURE" }];
  const query = `
    query gpuTypes {
      gpuTypes {
        id
        memoryInGb
        secureCloud
        communityCloud
        securePrice: lowestPrice(input: { gpuCount: 1, secureCloud: true }) { uninterruptablePrice stockStatus }
        communityPrice: lowestPrice(input: { gpuCount: 1, secureCloud: false }) { uninterruptablePrice stockStatus }
      }
    }`;
  try {
    const data = await gql(query, {});
    const combos = [];
    for (const g of data.gpuTypes || []) {
      if ((g.memoryInGb || 0) < MIN_GPU_MEMORY_GB) continue;
      if (g.secureCloud && g.securePrice?.stockStatus && g.securePrice.uninterruptablePrice != null) {
        combos.push({ gpuTypeId: g.id, cloudType: "SECURE", price: g.securePrice.uninterruptablePrice });
      }
      if (g.communityCloud && g.communityPrice?.stockStatus && g.communityPrice.uninterruptablePrice != null) {
        combos.push({ gpuTypeId: g.id, cloudType: "COMMUNITY", price: g.communityPrice.uninterruptablePrice });
      }
    }
    combos.sort((a, b) => a.price - b.price);
    if (combos.length) return combos;
  } catch (err) {
    console.warn("[runpod] live pricing lookup failed:", err.message);
  }
  // Last-resort static fallback if the pricing query itself fails (network hiccup etc.) --
  // stock/cloudType still get discovered for real by createPod()'s own per-attempt try/catch.
  return ["NVIDIA RTX A6000", "NVIDIA A40", "NVIDIA L40", "NVIDIA L40S"].map((gpuTypeId) => ({ gpuTypeId, cloudType: "SECURE" }));
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
  for (const { gpuTypeId, cloudType } of gpuOrder) {
    const input = {
      cloudType,
      gpuCount: 1,
      volumeInGb: 40,
      // 40GB still hit 95% (38GB used) even with --no-cache-dir -- the "devel" CUDA base image
      // itself is large before any of our installs even start, and modern torch cu124 wheels bundle
      // their own full CUDA runtime (cublas/cudnn/cufft/nccl/etc, several GB on their own). 80GB
      // gives real headroom instead of chasing the exact minimum.
      containerDiskInGb: 80,
      gpuTypeId,
      name: "vankonijnenburg-analyzer",
      templateId: TEMPLATE_ID || undefined,
      imageName: TEMPLATE_ID ? undefined : "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
      ports: `${INFERENCE_PORT}/http,22/tcp`,
      startSsh: true,
      // volumeMountPath is required whenever volumeInGb is set, REGARDLESS of cloud type or
      // whether a network volume is attached -- making it conditional on cloudType earlier caused
      // "invalid mount config: field Target must not be empty" on every community-cloud pod,
      // since the (empty) mount path applies to the pod's own local disk, not just the network
      // volume. Network volume itself only attaches on secure cloud (they'd otherwise add several
      // GB + minutes of re-downloading the model+adapter on every cold start on secure cloud).
      networkVolumeId: cloudType === "SECURE" ? (process.env.RUNPOD_NETWORK_VOLUME_ID || undefined) : undefined,
      volumeMountPath: "/workspace",
      dockerArgs: process.env.RUNPOD_STARTUP_CMD || DEFAULT_STARTUP_CMD,
      // GITHUB_PAT lets the pod clone the private hallucheck-scripts repo (see DEFAULT_STARTUP_CMD
      // above and pod_startup.sh) -- passed as a real pod env var, not string-interpolated into
      // dockerArgs itself, so it never appears in RunPod's stored pod configuration as plain text.
      // MODEL/ADAPTER_PATH point model_server.py at the pre-downloaded local copies on the network
      // volume instead of re-fetching from the Hugging Face Hub -- transformers' from_pretrained()
      // treats a local directory identically to a hub ID, so this is what actually makes the seeded
      // volume pay off (skip re-downloading ~59GB on every cold start). Only set when a network
      // volume is actually attached (secure cloud) -- on community cloud these paths wouldn't
      // exist, so leave the env vars unset there and let model_server.py fall back to its own
      // defaults (the real HF hub IDs), which still works, just slower.
      env: cloudType === "SECURE"
        ? [
            { key: "GITHUB_PAT", value: process.env.GITHUB_PAT || "" },
            { key: "MODEL", value: process.env.RUNPOD_MODEL_PATH || "/workspace/model-cache/gemma-4-31B-it" },
            { key: "ADAPTER_PATH", value: process.env.RUNPOD_ADAPTER_PATH || "/workspace/dpo_gemma31b_grounding-adapter_v2" },
          ]
        : [{ key: "GITHUB_PAT", value: process.env.GITHUB_PAT || "" }],
    };
    try {
      const data = await gql(mutation, { input });
      return data.podFindAndDeployOnDemand;
    } catch (err) {
      lastErr = err;
      if (!/SUPPLY_CONSTRAINT/.test(err.message)) throw err; // a real error, not just "this GPU type is out of stock"
      console.warn(`[runpod] ${gpuTypeId} (${cloudType}) out of stock, trying next option`);
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

// RunPod exposes ports declared as "N/http" (see createPod()'s `ports` field) through its own
// HTTPS proxy domain, NOT a raw public ip:port -- the runtime port entry for 8000 correctly comes
// back with isIpPublic:false (it's only reachable on RunPod's internal network directly), which
// earlier looked like "the pod never becomes ready" when it was actually running fine the whole
// time; the endpoint URL itself was just being built wrong.
function endpointFromRuntime(podId, runtime) {
  if (!runtime || !runtime.ports) return null;
  const hasInferencePort = runtime.ports.some((p) => p.privatePort === INFERENCE_PORT);
  if (!hasInferencePort) return null;
  return `https://${podId}-${INFERENCE_PORT}.proxy.runpod.net`;
}

/** Ensure a pod is running + ready for inference. Starts one if needed, polls until the inference
 *  port is reachable. Called on-demand right before a document analysis job. Any failure both
 *  resets the row back to "stopped" AND actually terminates the real RunPod pod if one was
 *  created -- resetting only the local bookkeeping left a pod that failed to become healthy
 *  running (and billing) on RunPod's side indefinitely, invisible to the app itself. */
// 10 minutes -- long enough to cover a genuine worst-case first-ever cold start on a fresh volume
// (torch/torchvision/torchaudio install + transformers/peft/accelerate + model load can approach
// 8 minutes combined), while every subsequent pod is much faster since pod_startup.sh now reuses
// a persistent venv on the network volume instead of reinstalling packages from scratch each time.
async function ensurePodRunning({ maxWaitMs = 10 * 60 * 1000 } = {}) {
  try {
    return await ensurePodRunningInner(maxWaitMs);
  } catch (err) {
    const row = await getPodRow();
    if (row.runpod_pod_id) {
      await terminatePod(row.runpod_pod_id).catch((termErr) => console.error("[runpod] cleanup terminate failed:", termErr.message));
    }
    await setPodRow({ status: "stopped", runpod_pod_id: null, endpoint_url: null });
    throw err;
  }
}

async function ensurePodRunningInner(maxWaitMs) {
  let row = await getPodRow();

  if (row.status === "ready" && row.runpod_pod_id) {
    const status = await getPodStatus(row.runpod_pod_id);
    const endpoint = endpointFromRuntime(row.runpod_pod_id, status?.runtime);
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
    const endpoint = endpointFromRuntime(row.runpod_pod_id, status?.runtime);
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
  // Ticks well under the 1-minute idle timeout itself, so shutdown actually happens close to the
  // 1-minute mark instead of up to a full extra tick-interval late.
  setInterval(() => {
    idleWatchTick().catch((err) => console.error("[runpod] idle watcher error:", err.message));
  }, 15 * 1000);
}

// Recovery for when gpu_pod's bookkeeping and reality disagree -- e.g. a pod was terminated
// outside the app (RunPod-side eviction, or a human terminating it directly via the RunPod
// console) without the app ever seeing that happen. Without this, the DB row stays stuck at
// "starting" pointing at a pod that no longer exists, and every future request just polls a
// ghost until its own timeout, forever, since ensurePodRunning() only skips creating a new pod
// when status is already "starting". Best-effort terminates the stored pod id (fine if it's
// already gone) and always resets the row, regardless of outcome.
async function forceReset() {
  const row = await getPodRow();
  if (row.runpod_pod_id) {
    await terminatePod(row.runpod_pod_id).catch(() => {});
  }
  await setPodRow({ status: "stopped", runpod_pod_id: null, endpoint_url: null });
}

module.exports = { ensurePodRunning, markUsed, idleWatchTick, startIdleWatcher, terminatePod, getPodRow, forceReset };
