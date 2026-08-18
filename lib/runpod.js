const { pool } = require("./db.js");

const API_BASE = "https://api.runpod.io/graphql";
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const GPU_TYPE = process.env.RUNPOD_GPU_TYPE || "NVIDIA RTX A6000"; // cheapest 48GB card that works for this inference workload ($0.33/hr secure cloud, checked live 2026-08-18)
const TEMPLATE_ID = process.env.RUNPOD_TEMPLATE_ID || "";
const INFERENCE_PORT = 8000;

function apiKey() {
  const k = process.env.RUNPOD_API_KEY;
  if (!k) throw new Error("RUNPOD_API_KEY niet gezet.");
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
  const input = {
    cloudType: "SECURE",
    gpuCount: 1,
    volumeInGb: 40,
    containerDiskInGb: 20,
    gpuTypeId: GPU_TYPE,
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
  const data = await gql(mutation, { input });
  return data.podFindAndDeployOnDemand;
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
 *  port is reachable. Called on-demand right before a document analysis job. */
async function ensurePodRunning({ maxWaitMs = 5 * 60 * 1000 } = {}) {
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
  throw new Error("RunPod pod werd niet op tijd beschikbaar.");
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
