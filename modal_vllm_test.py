#!/usr/bin/env python3
# Side-by-side trial of the vLLM engine for the SAME pipeline modal_app.py runs on transformers.
#
# Deliberately a SEPARATE Modal app: the transformers deployment works, produces verified
# citations, and is what the product currently runs on. This one gets to fail without taking that
# down, and only replaces it if it reproduces its answers.
#
# The blocker vLLM hit before was config plumbing, not model support:
#   * Gemma 4 alternates sliding_attention (head_dim 256, 16 kv heads) with full_attention
#     (head_dim 512, 4 kv heads). vLLM's gemma4.py builds those per layer correctly -- it reads
#     `global_head_dim` for the global layers -- so the MODEL code was never the problem.
#   * ModelConfig.get_head_size() reads one global `head_dim`, and transformers 5 refuses that
#     read on a heterogeneous config (AmbiguousGlobalPerLayerAttributeError) rather than silently
#     returning one of the two values.
#   * Our merged checkpoint records the geometry as `per_layer_config` (transformers 5's format)
#     and so no longer carries the `global_head_dim` key gemma4.py looks for.
# The fix supplies both in memory via hf_overrides, touching no file: the working deployment reads
# the same checkpoint directory and must not be disturbed. Verified on CPU first -- ModelConfig
# builds and reports head_size 512, i.e. vLLM sizes the KV cache for the LARGER of the two head
# dims rather than quietly picking 256, which was the specific correctness risk worth checking.
import os
import re
import modal

APP_NAME = "vk-grounding-vllm-test"
MERGED_PATH = "/cache/merged/gemma4-31b-grounding-v2"
GPU = os.environ.get("MODAL_GPU", "H100")

app = modal.App(APP_NAME)
model_cache = modal.Volume.from_name("vk-model-cache")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm==0.27.1", "requests", "datasets", "peft")
    .add_local_file(os.path.expanduser("~/hallucheck/scripts/eval_extract_compose_gemma.py"),
                    remote_path="/eval_extract_compose_gemma.py")
)

CITE_SYSTEM = (
    "You are a citation-checking assistant. You will be given ONE CHUNK of a larger document and a "
    "numbered list of CLAIMS taken from an answer written about the full document. For each claim, "
    "check ONLY whether THIS CHUNK contains an exact supporting quote for it -- the supporting text "
    "may be in a different chunk you don't see, and that is expected and fine. If this chunk supports "
    "a claim, copy the shortest exact substring from this chunk that proves it, character-for-"
    "character (never paraphrase). If this chunk does NOT support a claim, simply omit that claim's "
    "index from your output entirely -- do not guess or invent a quote.\n\n"
    "Reply with ONLY a JSON array, no other text, containing one entry per claim THIS CHUNK supports:\n"
    '[{"index": <claim number>, "quote": "<exact substring from this chunk>"}]'
)


def _load_prompts():
    with open("/eval_extract_compose_gemma.py", encoding="utf-8") as f:
        lines = f.readlines()
    cutoff = next(i for i, l in enumerate(lines) if l.startswith('print(f"=== Extract-then-compose'))
    ns = {}
    exec("".join(lines[:cutoff]), ns)
    return ns["EXTRACT_SYSTEM"], ns["COMPOSE_SYSTEM"]


@app.function(image=image, gpu=GPU, volumes={"/cache": model_cache}, memory=65536,
              timeout=3600, max_containers=1)
def trial(cases: list):
    import json
    import time
    from vllm import LLM, SamplingParams

    hub_geometry = {"global_head_dim": 512, "num_global_key_value_heads": 4}

    def inject(cfg):
        # Called once with a dummy config before the real one, so every step tolerates absence.
        targets = [cfg]
        t = getattr(cfg, "text_config", None)
        if t is not None and t is not cfg:
            targets.append(t)
        for obj in targets:
            try:
                object.__setattr__(obj, "allow_global_per_layer_attribute_access", True)
            except Exception:
                pass
        target = t if t is not None else cfg
        for k, v in hub_geometry.items():
            try:
                if getattr(target, k, None) is None:
                    setattr(target, k, v)
            except Exception:
                pass
        return cfg

    t0 = time.time()
    print(f"=== vLLM laden ({MERGED_PATH}) op {GPU} ===", flush=True)
    llm = LLM(model=MERGED_PATH, dtype="bfloat16", max_model_len=16384,
              gpu_memory_utilization=0.90, enable_prefix_caching=True,
              hf_overrides=inject, limit_mm_per_prompt={"image": 0})
    load_s = time.time() - t0
    print(f"=== vLLM klaar in {load_s:.0f}s ===", flush=True)

    extract_system, compose_system = _load_prompts()
    tok = llm.get_tokenizer()
    eot = tok.convert_tokens_to_ids("<end_of_turn>")
    stop_ids = [tok.eos_token_id] + ([eot] if isinstance(eot, int) and eot >= 0 else [])

    def gen(system, users, max_new, tag):
        # Same decoding settings the transformers pipeline uses, so a difference in output is a
        # difference in ENGINE and not in what the model was asked to do.
        sp = SamplingParams(temperature=0.0, max_tokens=max_new, repetition_penalty=1.15,
                            stop_token_ids=stop_ids, stop=["\nthought"])
        t = time.time()
        outs = llm.chat([[{"role": "system", "content": system}, {"role": "user", "content": u}]
                         for u in users], sp, use_tqdm=False)
        n = sum(len(o.outputs[0].token_ids) for o in outs)
        print(f"[{tag}] {len(users)} prompt(s) in {time.time()-t:.1f}s, {n} tokens", flush=True)
        return [o.outputs[0].text.strip() for o in outs], time.time() - t

    language_rule = ("Schrijf je antwoord in dezelfde taal als de QUESTION hierboven. "
                     "Is de vraag Nederlands, dan is je hele antwoord Nederlands.")
    results = []
    for case in cases:
        q, doc = case["question"], case["document"]
        t_case = time.time()
        ext, t_ext = gen(extract_system, [f"QUESTION: {q}\n\nDOCUMENT:\n{doc}"], 300, "extract")
        facts = ext[0]
        compose_user = (f"QUESTION: {q}\n\n{language_rule}\n\n"
                        f"FACTS LIST (extracted earlier):\n{facts}\n\n{language_rule}")
        ans, t_com = gen(compose_system, [compose_user], 700, "compose")
        answer = ans[0]
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", answer) if s.strip()]
        claims = "\n".join(f"{i}. {s}" for i, s in enumerate(sentences))
        raw, t_cite = gen(CITE_SYSTEM, [f"DOCUMENT CHUNK:\n{doc}\n\nCLAIMS:\n{claims}"], 400, "cite")
        quotes = {}
        start = raw[0].find("[")
        if start >= 0:
            try:
                for item in json.JSONDecoder().raw_decode(raw[0][start:])[0]:
                    if isinstance(item, dict) and item.get("quote") and "index" in item:
                        quotes[int(item["index"])] = str(item["quote"])
            except ValueError:
                pass
        results.append({"question": q, "answer": answer, "quotes": quotes,
                        "extract_s": round(t_ext, 1), "compose_s": round(t_com, 1),
                        "cite_s": round(t_cite, 1), "total_s": round(time.time() - t_case, 1)})
    return {"load_s": round(load_s), "results": results}


@app.local_entrypoint()
def main():
    import json
    small = ("Jaarverslag 2025 - Van Dalen Retail B.V.\n\n"
             "De netto-omzet bedroeg in 2025 128.400 euro, tegen 115.200 euro in 2024.\n"
             "In de loop van 2025 zijn drie winkels gesloten: de vestigingen in Almelo, Gorinchem en Sneek.\n"
             "Het nettoresultaat na belasting kwam uit op 21.300 euro.")
    big = open(os.path.expanduser("~/Downloads/test-annual-report.txt"), encoding="utf-8").read()
    out = trial.remote([
        {"question": "Hoeveel winkels zijn er in 2025 gesloten en welke?", "document": small},
        {"question": "What discount rate was used in the goodwill impairment review?", "document": big},
    ])
    print(json.dumps(out, indent=1, ensure_ascii=False))
