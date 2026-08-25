#!/usr/bin/env python3
# One-off job: bake the DPO grounding adapter into the base weights and park the result on the
# shared model volume, so the serving app (modal_app.py) can load ONE plain checkpoint.
#
# Why merge instead of applying the LoRA at runtime, as modal_app.py used to via PeftModel:
#   1. vLLM is the whole point of this change, and its runtime-LoRA path wants a single uniform
#      rank. This adapter does not have one -- adapter_config.json carries a rank_pattern with
#      r=8 (q/k/gate), 12 (v/up) and 16 (o/down) plus a matching alpha_pattern. Merging sidesteps
#      that mismatch entirely instead of trying to talk vLLM into a shape it doesn't model.
#   2. A merged checkpoint has zero per-token LoRA overhead -- the adapter maths is folded into
#      the base matrices once, here, rather than re-run on every forward pass forever.
# Same conclusion the llama.cpp work reached independently: merge fully, don't ship a runtime LoRA.
#
# Run with:  python3 -m modal run modal_merge.py
import os
import modal

APP_NAME = "vk-merge-adapter"
MODEL = os.environ.get("MODAL_GEMMA_MODEL", "google/gemma-4-31B-it")
ADAPTER_DIR = os.path.expanduser("~/hallucheck/models/dpo_gemma31b_grounding-adapter_v2")
# Kept in sync with MERGED_PATH in modal_app.py -- that's the only consumer of this output.
OUT = "/cache/merged/gemma4-31b-grounding-v2"

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name("vk-model-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch", "transformers", "peft", "accelerate", "safetensors", "huggingface_hub")
    .add_local_dir(ADAPTER_DIR, remote_path="/adapter")
)

secrets = []
if os.environ.get("HF_TOKEN"):
    secrets.append(modal.Secret.from_dict({"HF_TOKEN": os.environ["HF_TOKEN"]}))


@app.function(
    image=image, volumes={"/cache": model_cache}, secrets=secrets,
    cpu=8.0,
    # Deliberately CPU-only: merging is a handful of tiny (r<=16) B@A products folded into the big
    # matrices, so it's bound by moving 62GB of bf16 weights around, not by compute. Renting an
    # 80GB GPU to hold weights we'd only add to would cost more and still not fit bf16 comfortably.
    # 128GiB covers the ~62GB checkpoint in host RAM plus peft's merge and the shard-by-shard save.
    memory=131072,
    # 62GB down from HF, then 62GB back up to the volume, with a full model load in between.
    timeout=3 * 60 * 60,
)
def merge():
    import shutil
    import time
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    os.environ["HF_HOME"] = "/cache/huggingface"
    t0 = time.time()

    print(f"=== Base laden ({MODEL}) op CPU in bf16 ===", flush=True)
    base = AutoModelForCausalLM.from_pretrained(
        MODEL, dtype=torch.bfloat16, device_map="cpu", low_cpu_mem_usage=True,
    )
    print(f"[merge] base geladen als {type(base).__name__} in {time.time()-t0:.0f}s", flush=True)

    print("=== Adapter toepassen + mergen ===", flush=True)
    merged = PeftModel.from_pretrained(base, "/adapter").merge_and_unload()
    print(f"[merge] gemerged als {type(merged).__name__} in {time.time()-t0:.0f}s", flush=True)

    print(f"=== Wegschrijven naar {OUT} ===", flush=True)
    # A half-written checkpoint from an earlier crashed attempt would silently load as a model with
    # missing shards, so start from a clean directory every time rather than writing over one.
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)
    merged.save_pretrained(OUT, safe_serialization=True, max_shard_size="5GB")

    # Tokenizer files are byte-identical between base and adapter (verified by md5 on tokenizer.json
    # and chat_template.jinja), so which one we take doesn't matter -- base is the canonical copy.
    AutoTokenizer.from_pretrained(MODEL).save_pretrained(OUT)
    adapter_template = "/adapter/chat_template.jinja"
    if os.path.exists(adapter_template):
        shutil.copy(adapter_template, os.path.join(OUT, "chat_template.jinja"))

    model_cache.commit()
    files = sorted(os.listdir(OUT))
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in files)
    print(f"=== Klaar in {time.time()-t0:.0f}s: {len(files)} files, {total/1e9:.1f} GB ===", flush=True)
    return {"path": OUT, "files": files, "gigabytes": round(total / 1e9, 1),
            "arch": type(merged).__name__, "seconds": round(time.time() - t0)}


@app.local_entrypoint()
def main():
    print(merge.remote())
