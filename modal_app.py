#!/usr/bin/env python3
# Modal deployment of the same extract-then-compose grounding pipeline that model_server.py runs
# on RunPod -- ported here because RunPod's raw pod-creation was unreliable this whole session
# (broken drivers, missing SSH ports, slow uploads). Modal keeps the container warm for a short
# window after the last request and scales to zero when idle, so there's no idle cost.
#
# Same /analyze request/response shape as model_server.py's FastAPI route, so lib/modal-client.js
# doesn't need to change its contract.
#
# ---------------------------------------------------------------------------------------------
# ENGINE: HF transformers over a MERGED bf16 checkpoint, batched (was: bnb-NF4 + runtime LoRA).
#
# The old path took ~5-6 minutes per question, and stage timings put essentially all of it in
# decode, not prefill. Three separate things were fighting us:
#   1. bitsandbytes NF4 dequantizes weights per token during decode. It buys VRAM at a large,
#      permanent throughput cost -- the wrong trade once the model actually fits without it.
#   2. PeftModel kept the LoRA as separate matrices, so every forward pass re-ran the adapter
#      maths. modal_merge.py now folds it into the base weights once, offline.
#   3. Every chunk (and, from routes/excel.js, every field x sentence lookup) was its own
#      sequential generate() call on a container that takes one input at a time.
# So: bf16 weights on an 80GB card, one plain merged checkpoint, and every prompt of a stage
# submitted as ONE padded batch.
#
# Note bf16 is strictly HIGHER fidelity than the NF4 the validated pipeline ran on, so this swap
# cannot trade grounding accuracy for speed -- the one direction that would not be worth it.
#
# vLLM was the obvious engine and was tried FIRST. Recording what was actually established, so
# nobody repeats the investigation and nobody over-reads the conclusion:
#   * Gemma 4 has heterogeneous attention -- its 60 layers alternate sliding_attention (head_dim
#     256, 16 kv heads) with full_attention (head_dim 512, 4 kv heads).
#   * vLLM's own gemma4.py builds those correctly, per layer, reading `global_head_dim` for the
#     global ones. The MODEL support was never the problem.
#   * ModelConfig.get_head_size() reads one global `head_dim`, and transformers 5 refuses that on
#     a heterogeneous config (AmbiguousGlobalPerLayerAttributeError) instead of silently returning
#     one of the two. Our merged checkpoint also records the geometry in transformers 5's newer
#     `per_layer_config` form, so the `global_head_dim` key gemma4.py looks for is absent.
#   * Supplying both in memory via hf_overrides (never touching the checkpoint, which this
#     deployment also reads) makes ModelConfig build, and it then reports head_size 512 -- vLLM
#     sizes the KV cache for the LARGER of the two, which was the specific correctness worry.
# So vLLM is NOT ruled out; it is unfinished. What has not been done is running a token through it
# and comparing the output against this engine's verified answers, which is the only thing that
# would justify switching. modal_vllm_test.py is that experiment, ready to run as a separate app.
# It was parked because the faster engine also has a slower cold start, which was judged the worse
# trade at the time -- a call worth revisiting now that GPU seconds are ~15% of revenue.
# ---------------------------------------------------------------------------------------------
import os
import re
import modal

APP_NAME = "vankonijnenburg-grounding"
# Written by modal_merge.py (base weights + DPO grounding adapter, already folded together).
MERGED_PATH = os.environ.get("MODAL_MERGED_PATH", "/cache/merged/gemma4-31b-grounding-v2")
# H100 80GB, not the L40S the bnb build used. Two reasons, and the first is non-negotiable:
# dropping NF4 means the weights are 62GB of bf16, which simply does not fit the L40S's 48GB.
# The second is that it is also CHEAPER per request. Decode is memory-bandwidth-bound, so
# throughput tracks HBM bandwidth (H100 ~3.35 TB/s vs L40S ~0.86 TB/s). The H100 costs ~2x/hr
# ($0.001097/sec vs $0.000542/sec) but finishes the same work several times sooner, and Modal
# bills by the second. The one place it loses is cold starts, which are I/O-bound on the 62GB
# volume read and so cost 2x for no speedup -- hence the pre-warming added on the app side. Counter-intuitively this is also the CHEAPER option per
# request: decode here is memory-bandwidth-bound, so throughput tracks HBM bandwidth (H100 ~3.35
# TB/s vs L40S ~0.86 TB/s). The H100 costs ~2x/hr but finishes the same ~1400 decoded tokens
# several times faster, and Modal bills by the second. Overridable if H100s are ever short.
GPU = os.environ.get("MODAL_GPU", "H100")
CHUNK_CHARS = int(os.environ.get("MODAL_CHUNK_CHARS", "16000"))
# How many prompts may share one generate() call. This is the whole batching win, but it is bounded
# by KV cache, and a fixed count is the wrong knob for it: the two callers have wildly different
# prompt sizes. routes/excel.js asks about ONE SENTENCE at a time (~50 tokens), where a batch of 8
# is trivially safe; a document chunk is up to CHUNK_CHARS, roughly 4.5k tokens, where 8 at once
# would want more KV than the card has. The 62GB of bf16 weights leave only ~18GB of the 80GB for
# cache and activations, and Gemma 4's full_attention layers carry a 512 head_dim, so per-sequence
# cost is not small. So both a count cap AND a token budget apply, and the token budget is what
# actually protects the document path -- an OOM mid-analysis costs far more than an extra pass.
# Raised from 300 after a real run hit that ceiling exactly. Extract has no continuation round to
# recover a cut-off list, so the ceiling has to be generous enough that it is never the thing that
# ends the output -- the model's own stop token should be. Costs nothing on documents that finish
# early, because generation stops when the model stops.
# The ceiling was 300, and a real run generated exactly 300 -- which looked like truncation. It
# was not: the required </self_described> terminator was present, so the extraction had finished
# and the model simply kept going afterwards. Raising the ceiling to 900 only bought more of that
# trailing text (88s instead of 30s, all of it discarded by the trim below).
#
# So the ceiling is kept generous but is no longer what ends the output: generation stops at the
# terminator itself. A long document that genuinely needs 700 tokens of facts still gets them,
# while the normal case stops as soon as the format is complete. If the ceiling is ever reached
# with no terminator, THAT is real truncation, and it now says so in the log.
EXTRACT_MAX_TOKENS = int(os.environ.get("MODAL_EXTRACT_MAX_TOKENS", "900"))
# Everything after </self_described> is discarded by _answers() anyway, so generating it is pure
# cost. Kept alongside the shared marker so a stage that ends early still ends cleanly.
DEFAULT_STOP_STRINGS = ("\nthought",)
EXTRACT_STOP_STRINGS = ("\nthought", "</self_described>")
MICRO_BATCH = int(os.environ.get("MODAL_MICRO_BATCH", "8"))
MAX_BATCH_TOKENS = int(os.environ.get("MODAL_MAX_BATCH_TOKENS", "12000"))

app = modal.App(APP_NAME)

# Holds both the HF download cache and the merged checkpoint modal_merge.py produced. Without it
# every cold start would re-download tens of GB, which defeats a scale-to-zero deployment.
model_cache = modal.Volume.from_name("vk-model-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch", "transformers", "accelerate", "fastapi[standard]",
                 "sentencepiece", "protobuf",
                 # _load_prompts() execs the top of eval_extract_compose_gemma.py to pull out
                 # EXTRACT_SYSTEM/COMPOSE_SYSTEM, so every module that file imports at module
                 # level has to be installed here -- even the ones only its unrelated
                 # DeepSeek-judge helpers use, which this deployment never calls. Scanned from the
                 # file rather than guessed: datasets, peft, transformers (plus stdlib). `requests`
                 # arrives transitively with datasets but is named explicitly so a future slimmer
                 # datasets can't silently take it away. Missing any of these crashes
                 # @modal.enter() on every cold start with a bare ModuleNotFoundError -- run
                 # check_prompts (below) after touching this list.
                 "requests", "datasets", "peft")
    .add_local_file(
        os.path.expanduser("~/hallucheck/scripts/eval_extract_compose_gemma.py"),
        remote_path="/eval_extract_compose_gemma.py",
    )
)

secrets = []
if os.environ.get("HF_TOKEN"):
    secrets.append(modal.Secret.from_dict({"HF_TOKEN": os.environ["HF_TOKEN"]}))


# COMPOSE_SYSTEM ends with a hard "write your ENTIRE final answer in English" rule. This product
# serves Dutch accountants, so a per-request line asking for the question's language was added on
# top of it -- which put two contradicting instructions in the same prompt and produced exactly
# what you would expect: the SAME Dutch question answered in Dutch on one run and in English on
# the next. That is not cosmetic. The cite pass matches an exact substring of the source document,
# so a language slip costs the citation as well as the reading experience.
#
# Rewriting the rule rather than arguing with it leaves ONE instruction. And it is safe against
# the FACTS-860 validation this prompt carries: that benchmark is English, so "the language of the
# QUESTION" resolves to English for every case it covers -- the validated behaviour is unchanged
# where it was measured, and only Dutch questions behave differently.
COMPOSE_LANGUAGE_RULE_ORIGINAL = (
    "write your ENTIRE final answer in English, with no words or sentences in any other language "
    "mixed in -- if you notice yourself about to write a word in a different language, replace it "
    "with the correct English word instead."
)
COMPOSE_LANGUAGE_RULE_PATCHED = (
    "write your ENTIRE final answer in the SAME LANGUAGE AS THE QUESTION -- a Dutch question gets "
    "a fully Dutch answer, an English question gets a fully English answer, with no words or "
    "sentences from a different language mixed in. If you notice yourself about to write a word in "
    "a language other than the QUESTION's, replace it with the correct word in the QUESTION's "
    "language instead."
)


def _load_prompts():
    # same trick model_server.py uses -- pull the exact, already-tested EXTRACT_SYSTEM /
    # COMPOSE_SYSTEM strings out of the eval script instead of copy-pasting them, so this can
    # never silently drift from the pipeline that was actually validated against FACTS-860.
    with open("/eval_extract_compose_gemma.py", encoding="utf-8") as f:
        lines = f.readlines()
    cutoff = next(i for i, l in enumerate(lines) if l.startswith('print(f"=== Extract-then-compose'))
    ns = {}
    exec("".join(lines[:cutoff]), ns)
    extract_system, compose_system = ns["EXTRACT_SYSTEM"], ns["COMPOSE_SYSTEM"]

    # Patched here rather than in the shared eval script, which the HalluCheck evaluations also
    # read -- their English-only runs must keep the original wording. Asserting rather than doing
    # a best-effort replace: if the upstream rule is ever reworded, silently serving the English
    # rule again would bring back the language flapping with nothing in the logs to explain it.
    if COMPOSE_LANGUAGE_RULE_ORIGINAL not in compose_system:
        raise RuntimeError(
            "COMPOSE_SYSTEM's language rule no longer matches the text this deployment patches. "
            "Re-check eval_extract_compose_gemma.py before deploying, or Dutch questions will "
            "silently be answered in English again."
        )
    compose_system = compose_system.replace(
        COMPOSE_LANGUAGE_RULE_ORIGINAL, COMPOSE_LANGUAGE_RULE_PATCHED, 1)
    return extract_system, compose_system


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


@app.function(image=image, timeout=600)
def check_prompts():
    """CPU-only smoke test for the one part of startup that has non-obvious dependencies.

    _load_prompts() only reads a local text file, but it execs it, so it inherits that file's
    module-level imports -- and getting that list wrong is invisible until a cold start dies.
    Discovering that on an H100 costs GPU minutes; discovering it here costs a CPU container.
    Run with:  python3 -m modal run modal_app.py::check_prompts
    """
    extract, compose = _load_prompts()
    result = {"extract_chars": len(extract), "compose_chars": len(compose),
              "extract_head": extract[:80], "compose_head": compose[:80]}
    print("PROMPTS OK:", result, flush=True)
    return result


@app.cls(
    gpu=GPU, image=image, volumes={"/cache": model_cache}, secrets=secrets,
    # Idle time is billed, and at 240s it was the single largest line in the cost of one isolated
    # question: 240s of doing nothing against ~115s of actually answering. That made a lone
    # question cost about EUR 0.50 in GPU, which is more than the overage price charged for it.
    # 60s still rides over the pause between two questions in a real back-and-forth -- the case
    # this window exists for -- while cutting roughly EUR 0.23 off every session that ends after
    # one question. The pre-warm on the app side is what keeps cold starts off the user's clock,
    # so a shorter window costs latency far less than it used to.
    scaledown_window=int(os.environ.get("MODAL_SCALEDOWN_WINDOW", "60")),
    # The app now pings /health to pre-warm the GPU while the user is still typing their question
    # (see warmUp() in lib/modal-client.js). Without a cap, a warm ping arriving while an analyze
    # is already running would look to Modal like queue pressure and start a SECOND container --
    # paying a full cold start and an extra GPU-hour to answer a request that was already covered.
    # One container also keeps prefix-cache hits real: consecutive questions about the same
    # document only reuse the cached document prefix if they land on the same engine.
    max_containers=int(os.environ.get("MODAL_MAX_CONTAINERS", "1")),
    # vLLM streams safetensors shards straight to the GPU rather than materialising the whole
    # checkpoint in host RAM the way the bnb quantization path did, but the mmap'd page cache
    # still counts against the cgroup while 62GB is read. Kept generous: a host-RAM shortfall
    # shows up as an opaque "function was terminated by signal" (the OOM-killer), not a traceback.
    memory=65536,
    # Reading the merged checkpoint off the volume plus CUDA-graph capture is slower to start than
    # the old NF4 load, even though steady-state decode is far faster. The old 900s was already
    # tight for a from-HF download; 1800s covers a cold volume read with margin.
    startup_timeout=1800,
    # analyze_batch can legitimately carry a couple of dozen independent lookups (routes/excel.js
    # caps a call at MAX_BATCH_ITEMS=24), and a three-stage pass over 24 measures at roughly 900s.
    # 1200s left almost no margin over that; 1800s means a slow batch degrades into a slow answer
    # instead of a timeout that throws away every lookup in the request.
    timeout=1800,
)
# vLLM's offline LLM engine is driven from a single process loop and isn't safe to call from two
# requests at once. It does its own batching INSIDE a call (see _chat_batch), which is where the
# parallelism we actually want comes from -- so serialising at the container edge costs nothing.
# A pasted, timestamped log previously showed a concurrent "GET / -> 500" racing the analyze POST
# on the same container and killing it; this keeps that impossible. (Was allow_concurrent_inputs=1
# on @app.cls, which Modal 1.0 deprecated in favour of this decorator.)
@modal.concurrent(max_inputs=1)
class Grounding:
    @modal.enter()
    def load(self):
        # Must happen before `import torch` -- PyTorch sizes its OpenMP/MKL thread pools from these
        # at import time. Without a cap it reads the HOST's core count rather than the container's
        # actual cgroup quota, which on RunPod made generation look "hung" at 0% GPU util (CPU-side
        # tokenization/sampling thrashed hundreds of threads across a handful of real cores).
        torch_threads = int(os.environ.get("TORCH_NUM_THREADS", "8"))
        os.environ.setdefault("OMP_NUM_THREADS", str(torch_threads))
        os.environ.setdefault("MKL_NUM_THREADS", str(torch_threads))

        import time
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        torch.set_num_threads(torch_threads)
        torch.set_num_interop_threads(1)
        os.environ["HF_HOME"] = "/cache/huggingface"

        t0 = time.time()
        # Deliberately FIRST. This only reads and execs a local text file, but it has non-obvious
        # import requirements (see the image comment), and when it failed it did so after the
        # 62GB weight load -- three minutes of H100 time to discover a missing pure-Python
        # dependency. Cheap and fallible goes before expensive and reliable.
        self.extract_system, self.compose_system = _load_prompts()

        print(f"=== Model laden ({MERGED_PATH}) op {GPU} in bf16 ===", flush=True)
        self.tok = AutoTokenizer.from_pretrained(MERGED_PATH)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        # Decoder-only batching only works with LEFT padding: with right padding the pad tokens sit
        # between the prompt and the first generated token, so every sequence shorter than the
        # longest one in the batch would be continued from padding instead of from its own prompt.
        self.tok.padding_side = "left"

        # No quantization_config and no PeftModel: the adapter is already inside these weights
        # (modal_merge.py), and bf16 is what the checkpoint is stored in.
        self.model = AutoModelForCausalLM.from_pretrained(
            MERGED_PATH, dtype=torch.bfloat16, device_map={"": 0}, attn_implementation="sdpa",
        )
        self.model.eval()

        eot_id = self.tok.convert_tokens_to_ids("<end_of_turn>")
        self.stop_ids = {self.tok.eos_token_id}
        if isinstance(eot_id, int) and eot_id >= 0:
            self.stop_ids.add(eot_id)
        model_cache.commit()
        free, total = torch.cuda.mem_get_info()
        print(f"=== Model klaar in {time.time()-t0:.0f}s "
              f"({(total-free)/1e9:.0f}GB VRAM in gebruik, {free/1e9:.0f}GB vrij) ===", flush=True)

    def _encode_one(self, conversation):
        text = self.tok.apply_chat_template(conversation, tokenize=False, add_generation_prompt=True)
        # add_special_tokens=False: the chat template already emits bos_token itself.
        return self.tok(text, add_special_tokens=False)["input_ids"]

    def _generate(self, conversations, max_new, stop_strings=None):
        """One padded generate() over a slice of conversations.

        Returns (text, hit_ceiling) per conversation, in input order.
        """
        import torch
        texts = [
            self.tok.apply_chat_template(c, tokenize=False, add_generation_prompt=True)
            for c in conversations
        ]
        # add_special_tokens=False: the chat template already emits bos_token itself, and letting
        # the tokenizer prepend a second one shifts every position by a token the model never saw
        # during training.
        enc = self.tok(texts, return_tensors="pt", padding=True, add_special_tokens=False).to(self.model.device)
        with torch.no_grad():
            out = self.model.generate(
                **enc, max_new_tokens=max_new, do_sample=False, repetition_penalty=1.15,
                eos_token_id=list(self.stop_ids), pad_token_id=self.tok.pad_token_id,
                # Observed live on every stage: after a complete, correct reply the model fails to
                # emit an end-of-turn token and instead starts a new line reading exactly
                # "thought", then repeats its whole reply -- over and over until max_new_tokens
                # cuts it off mid-repeat. That single behaviour caused three separate symptoms:
                # citations were dropped (the repeats made the JSON unparseable), Excel field
                # values came out as "128.400 euro\nthought\n128.400 euro" instead of a number,
                # and roughly 30 of the 37 seconds each cite call took were spent generating text
                # that was thrown away. Stopping at the marker fixes the cause rather than
                # cleaning up after it. A newline followed by exactly "thought" is a shape real
                # answers do not have, so this cannot truncate a legitimate reply.
                stop_strings=list(stop_strings or DEFAULT_STOP_STRINGS), tokenizer=self.tok,
            )
        results = []
        generated = 0
        for row in out[:, enc["input_ids"].shape[1]:]:
            ids = row.tolist()
            # Whether this sequence stopped on its own or ran into max_new_tokens. In a batch,
            # generate() keeps stepping until the LAST sequence finishes and pads the rest, so
            # length alone can't tell the two apart -- the presence of a stop token can.
            hit_ceiling = not any(i in self.stop_ids for i in ids)
            generated += len(ids)
            results.append((self.tok.decode(ids, skip_special_tokens=True).strip(), hit_ceiling))
        # Token counts separate "the model wrote a lot" from "each token was slow" -- without them
        # a slow stage looks the same whether it generated 400 tokens or 40.
        print(f"    (batch van {len(conversations)}: {generated} tokens gegenereerd)", flush=True)
        return results

    def _group(self, indices, conversations):
        """Slice indices into batches that fit both MICRO_BATCH and the KV token budget.

        Padding makes a batch cost (longest prompt x batch size), not the sum of its prompts, so
        the budget is checked against the longest member -- one 4k-token chunk in a group of short
        sentences would otherwise quietly cost as much as eight of them.
        """
        # Measured through the SAME encode path _generate uses, so the number here is the number
        # that will actually be padded and cached. (apply_chat_template(tokenize=True) can hand
        # back a BatchEncoding rather than a token list depending on version, and len() on that
        # counts its KEYS -- a silent way to get a budget check that always passes.)
        lengths = {i: len(self._encode_one(conversations[i])) for i in indices}
        batch, longest = [], 0
        for i in indices:
            candidate = max(longest, lengths[i])
            if batch and (len(batch) >= MICRO_BATCH or candidate * (len(batch) + 1) > MAX_BATCH_TOKENS):
                yield batch
                batch, longest = [i], lengths[i]
            else:
                batch.append(i)
                longest = candidate
        if batch:
            yield batch

    def _chat_batch(self, system, users, max_new, max_continuations=0, tag="", stop_strings=None):
        # Every prompt of a stage goes through generate() together, in slices of MICRO_BATCH,
        # instead of one call each. This is what turns the Excel filler (fields x sentences
        # independent lookups) from hundreds of sequential passes into a handful.
        import time
        if not users:
            return []
        t0 = time.time()
        # Each entry is its own independent conversation -- prompts are never bundled into one
        # context. Batching here is purely a scheduling detail; what the model is asked stays
        # exactly what the validated pipeline asked, one question against one text at a time.
        conversations = [
            [{"role": "system", "content": system}, {"role": "user", "content": u}] for u in users
        ]
        texts = [""] * len(users)
        pending = list(range(len(users)))

        for _round in range(1 + max_continuations):
            print(f"[{tag}] round {_round}: {len(pending)} prompt(s) te verdelen over batches "
                  f"(max {MICRO_BATCH} stuks, {MAX_BATCH_TOKENS} tokens)...", flush=True)
            outputs = []
            for group in self._group(pending, conversations):
                outputs.extend(self._generate([conversations[j] for j in group], max_new, stop_strings))

            still_pending = []
            for idx, (chunk, hit_ceiling) in zip(pending, outputs):
                texts[idx] += (" " if texts[idx] else "") + chunk
                # Live test found the model invents a bizarre trailing artifact (a fake JS function
                # like `get_net_profit_fy2025() { return "..."; }`) when told to "continue" after an
                # answer that already reads as complete -- the trigger was a "did it stop?" check
                # that missed the model's real end-of-turn token, not the model running out of
                # things to say. Treating clean sentence-ending punctuation as "done" too stops
                # that spurious continuation from firing at all; the code-artifact regex in
                # _clean_answer is only a safety net.
                ends_cleanly = bool(re.search(r"[.!?][\"')\]]?\s*$", chunk))
                if hit_ceiling and not ends_cleanly:
                    conversations[idx] = conversations[idx] + [
                        {"role": "assistant", "content": chunk},
                        {"role": "user", "content": "Ga door precies waar je gebleven was, zonder iets te herhalen."},
                    ]
                    still_pending.append(idx)
            pending = still_pending
            # Only the genuinely-truncated entries go round again, still batched, so one long
            # answer never drags the whole batch through an extra pass.
            if not pending:
                break

        print(f"[{tag}] klaar in {time.time()-t0:.1f}s", flush=True)
        return [t.strip() for t in texts]

    @staticmethod
    def _quote_is_in_source(quote, chunks):
        """Check that a quote the model produced actually occurs in the source text.

        Until this existed, `grounded` meant "the model handed back a quote", not "the quote is
        real" -- nothing ever compared it against the document. For a product whose entire claim
        is that answers are checkable, that is the wrong direction to trust: a plausible-sounding
        invented quote would have been shown to the user under a green "Onderbouwd" badge.

        Matching is not byte-for-byte, deliberately. CITE_SYSTEM asks for a character-for-character
        copy, but a real reply showed the model returning a space where the source file had a line
        break mid-sentence (documents are hard-wrapped; PDF extraction does the same thing). That
        is the same sentence, and rejecting it would produce false "not grounded" verdicts on
        genuine citations. So whitespace is collapsed, curly quotes and dashes are folded to their
        ASCII forms, and case is ignored -- every word must still be present, in order, with
        nothing added. A fabricated quote does not survive that; a re-wrapped real one does.
        """
        def norm(s):
            s = (s.replace("\u2019", "'").replace("\u2018", "'")
                  .replace("\u201c", '"').replace("\u201d", '"')
                  .replace("\u2013", "-").replace("\u2014", "-"))
            return re.sub(r"\s+", " ", s).strip().lower()

        needle = norm(quote)
        # A lone common word is not evidence -- "goodwill" appears in this document and would
        # "verify" perfectly while proving nothing about the claim. But a plain length floor is
        # the wrong test, because the most valuable citations in a financial document are short:
        # "EUR 18,400,000" is 14 characters and is exactly the proof you want. Digits are what
        # separates the two cases, so a figure only needs to be substantial enough to be specific,
        # while prose has to be long enough to be a real phrase rather than a single word.
        if any(ch.isdigit() for ch in needle):
            if len(needle) < 3:
                return False
        elif len(needle) < 15:
            return False
        return any(needle in norm(chunk) for chunk in chunks)

    @staticmethod
    def _first_json_array(raw):
        r"""Parse the FIRST complete JSON array in the model's reply, ignoring anything after it.

        The obvious `re.search(r"\[.*\]", raw, re.DOTALL)` is greedy: it spans from the first
        "[" to the LAST "]" anywhere in the text. That only holds when the reply is exactly one
        array and nothing else -- and it is not. Observed live: the model emits a perfectly
        correct array and then, having produced no end-of-turn token, repeats it several more
        times wrapped in ``` fences with the word "thought" between them, until the token ceiling
        cuts it off mid-repeat. The greedy match swallowed all of that, failed to parse, and the
        citation was silently dropped -- so correct, properly-quoted answers were being reported
        to the user as "niet onderbouwd" while the evidence sat in the very first line.
        A non-greedy `\[.*?\]` would fix this case but break on any quote containing "]", which
        is legal in a document substring. raw_decode consumes exactly one well-formed value and
        leaves the rest alone, so neither the repeats nor brackets inside quotes matter.
        """
        import json
        start = raw.find("[")
        if start < 0:
            return None
        try:
            value, _ = json.JSONDecoder().raw_decode(raw[start:])
        except ValueError:
            return None
        return value if isinstance(value, list) else None

    def _clean_answer(self, answer):
        matches = list(re.finditer(r"\*{0,2}final answer\*{0,2}:?", answer, flags=re.IGNORECASE))
        if matches:
            answer = answer[matches[-1].end():].lstrip(" :\n")
        # A line consisting only of "thought" is the model's repeat marker (see stop_strings in
        # _generate), never part of an answer, so it is cut wherever it appears. The >30 guard
        # below deliberately does NOT apply to it: that guard exists so an answer legitimately
        # opening with "Wait," isn't truncated to nothing, but it also meant short answers -- the
        # normal case for an Excel field lookup -- kept the marker and everything after it,
        # because at ~13 characters in it never cleared the threshold.
        marker = re.search(r"\n\s*thought\s*(\n|$)", answer, flags=re.IGNORECASE)
        if marker:
            answer = answer[:marker.start()].rstrip()
        leak = re.search(r"\bthought\b|\bwait\b[*_]{0,2}[,.\-—]|\blet me restart\b", answer, flags=re.IGNORECASE)
        if leak and leak.start() > 30:
            answer = answer[:leak.start()].rstrip()
        # Compose sometimes opens with a stray bold marker ("** Three stores were closed...").
        answer = re.sub(r"^\s*\*{1,2}\s*", "", answer)
        degenerate = re.search(r"(.{2,80}?)\1{3,}", answer, flags=re.DOTALL)
        if degenerate and degenerate.start() > 30:
            answer = answer[:degenerate.start()].rstrip()
        # Safety net for the continuation-artifact bug above (fixed at the source in _chat_one, but
        # this catches it regardless of cause) -- a function-call-like construct never belongs in
        # a natural-language financial answer, so truncate the moment one shows up.
        code_artifact = re.search(r"\w+\([^)]*\)\s*\{", answer)
        if code_artifact and code_artifact.start() > 10:
            answer = answer[:code_artifact.start()].rstrip()
        return answer.strip()

    def _split_into_chunks(self, text, size=CHUNK_CHARS):
        paras = text.split("\n\n")
        chunks, cur = [], ""
        for p in paras:
            if len(cur) + len(p) + 2 > size and cur:
                chunks.append(cur)
                cur = p
            else:
                cur = cur + "\n\n" + p if cur else p
        if cur:
            chunks.append(cur)
        return chunks or [text]

    def _pipeline(self, items):
        """extract -> compose -> cite over N independent (question, document) pairs.

        Every item still gets its own prompts and its own answer -- nothing is bundled into a
        shared context, which is the property routes/excel.js depends on (bundling several facts
        into one prompt is exactly what caused the multi-fact confusion that per-sentence lookups
        were introduced to fix). The only thing that changes with N > 1 is that the GPU sees the
        work as batches per stage rather than 3*N sequential generations.
        """
        import time
        t0 = time.time()
        answers, combined_facts, per_item_chunks = self._answers(items)
        citations = self._citations(per_item_chunks, answers)
        print(f"[pipeline] TOTAAL {time.time()-t0:.1f}s", flush=True)
        return [
            {"answer": answers[i], "citations": citations[i],
             "chunk_count": len(per_item_chunks[i]), "extraction": combined_facts[i]}
            for i in range(len(items))
        ]

    def _answers(self, items):
        """The extract + compose half, callable on its own.

        Split from _citations so the app can put an answer on screen the moment compose finishes
        rather than holding it until the quotes are checked. On a real browser question that was
        34s of finished work sitting behind a 70s total wait. Neither half's behaviour changes.
        """
        import time
        t0 = time.time()
        per_item_chunks = [self._split_into_chunks(it["document"]) for it in items]

        # --- EXTRACT: every (item, chunk) pair in one batch --------------------------------
        # The ceiling was 300, on the reasoning that a facts list is "a handful of short lines".
        # Measured on a real one-page annual report, extraction generated exactly 300 tokens --
        # it was hitting the ceiling, not finishing. Unlike compose, extract runs with no
        # continuation round, so there was nothing to complete it: the facts list was silently
        # cut off mid-way and compose then answered from a truncated list. That failure is
        # invisible in the final answer, which is what makes it worth spending tokens on.
        # EXTRACT_SYSTEM's own COMPLETENESS-OVER-VERBOSITY rule assumes room to list every entry.
        users, owners = [], []
        for idx, (it, chunks) in enumerate(zip(items, per_item_chunks)):
            for chunk in chunks:
                users.append(f"QUESTION: {it['question']}\n\nDOCUMENT:\n{chunk}")
                owners.append(idx)
        per_item_extractions = [[] for _ in items]
        truncated = 0
        extractions = self._chat_batch(self.extract_system, users, max_new=EXTRACT_MAX_TOKENS,
                                       tag="extract", stop_strings=EXTRACT_STOP_STRINGS)
        for owner, extraction in zip(owners, extractions):
            # EXTRACT_SYSTEM specifies an exact output shape ending in </self_described>. Its
            # absence is the one reliable signal that the extraction did not finish -- before,
            # such an output was passed on to compose unchanged and unremarked.
            end = re.search(r"</self_described>", extraction, flags=re.IGNORECASE)
            if end is None:
                truncated += 1
                print(f"[extract] ONVOLLEDIG (geen </self_described> na {len(extraction)} tekens) -- "
                      f"compose bouwt zijn antwoord op een afgekapte feitenlijst", flush=True)
            per_item_extractions[owner].append(extraction[: end.end()] if end else extraction)
        if truncated:
            print(f"[extract] {truncated} van {len(users)} extractie(s) onvolledig", flush=True)
        print(f"[answers] extract done at {time.time()-t0:.1f}s", flush=True)

        # --- COMPOSE: one per item, in one batch ------------------------------------------
        combined_facts = [
            "\n\n".join(f"[Deel {i+1}/{len(parts)}]\n{e}" for i, e in enumerate(parts))
            for parts in per_item_extractions
        ]
        # No language instruction here any more. It used to be bolted on twice, which contradicted
        # COMPOSE_SYSTEM's own "answer in English" rule and made the output language a coin flip.
        # The rule itself is now rewritten once, at load time -- see COMPOSE_LANGUAGE_RULE_PATCHED.
        compose_users = [
            f"QUESTION: {it['question']}\n\nFACTS LIST (extracted earlier):\n{facts}"
            for it, facts in zip(items, combined_facts)
        ]
        answers = [
            self._clean_answer(a)
            for a in self._chat_batch(self.compose_system, compose_users, max_new=700, max_continuations=1, tag="compose")
        ]
        print(f"[answers] compose done at {time.time()-t0:.1f}s", flush=True)
        return answers, combined_facts, per_item_chunks

    def _citations(self, per_item_chunks, answers):
        """The cite half of the pipeline, callable on its own.

        Split out so the app can show an answer the moment compose finishes instead of holding it
        until citations are checked. On a real browser question that was 34s of work already done
        against ~80s of total wait -- more than half the wait was spent on a result the user could
        already have been reading. What the stage DOES is unchanged; only when it can run is.
        """
        import json
        import time
        t0 = time.time()
        items_count = len(answers)
        # --- CITE: every (item, chunk) pair in one batch -----------------------------------
        # max_new=400: output is a short JSON array (claim index + quote), same reasoning as extract.
        per_item_sentences, users, owners = [], [], []
        for idx, (answer, chunks) in enumerate(zip(answers, per_item_chunks)):
            sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", answer) if s.strip()]
            per_item_sentences.append(sentences)
            if not sentences:
                continue
            numbered_claims = "\n".join(f"{i}. {s}" for i, s in enumerate(sentences))
            for chunk in chunks:
                users.append(f"DOCUMENT CHUNK:\n{chunk}\n\nCLAIMS:\n{numbered_claims}")
                owners.append(idx)

        per_item_hits = [[] for _ in range(items_count)]
        for owner, raw in zip(owners, self._chat_batch(CITE_SYSTEM, users, max_new=400, tag="cite")):
            match = self._first_json_array(raw)
            hits = {}
            # An unparseable cite reply and a genuinely unsupported claim both used to end up as
            # an empty dict here, which surfaces to the user as the same "Niet onderbouwd" badge.
            # Those are completely different failures -- one is the model correctly declining to
            # invent a quote, the other is us throwing away an answer it did give -- so say which.
            if match is None:
                print(f"[cite] GEEN JSON-array in antwoord ({len(raw)} tekens): {raw[:400]!r}", flush=True)
            else:
                hits = {
                    int(item["index"]): str(item["quote"]) for item in match
                    if isinstance(item, dict) and item.get("quote") and "index" in item
                }
                if not hits:
                    print(f"[cite] JSON zonder bruikbare quotes: {str(match)[:400]!r}", flush=True)
            per_item_hits[owner].append(hits)
        print(f"[citations] klaar in {time.time()-t0:.1f}s", flush=True)

        results = []
        rejected = 0
        for idx in range(items_count):
            citations = []
            for i, sentence in enumerate(per_item_sentences[idx]):
                quote = next((hits[i] for hits in per_item_hits[idx] if i in hits), None)
                # The verification step. A quote that cannot be found in the source is dropped
                # entirely rather than shown with a "not grounded" note, because the frontend keys
                # its citation rendering off the presence of a quote -- keeping an unverified one
                # would display it as though it were evidence.
                if quote is not None and not self._quote_is_in_source(quote, per_item_chunks[idx]):
                    print(f"[citations] AFGEKEURD, niet terug te vinden in de bron: {quote[:200]!r}", flush=True)
                    rejected += 1
                    quote = None
                citations.append({"claim": sentence, "quote": quote, "grounded": quote is not None})
            results.append(citations)
        if rejected:
            print(f"[citations] {rejected} citaat/citaten afgekeurd na verificatie", flush=True)
        return results

    @modal.fastapi_endpoint(method="POST")
    def analyze(self, req: dict):
        import time
        t0 = time.time()
        result = self._pipeline([{"question": req["question"], "document": req["document"]}])[0]
        return {**result, "seconds": round(time.time() - t0, 1)}

    @modal.fastapi_endpoint(method="POST")
    def analyze_batch(self, req: dict):
        """N independent lookups in one round trip, results in input order.

        routes/excel.js asks the same document one question per (field, sentence) pair. As one
        call per pair those queued up behind each other -- the container takes one input at a time,
        so a template with a dozen fields against a page of text meant hundreds of sequential
        cold-ish round trips. Handing the whole set over at once lets vLLM run them concurrently.
        """
        import time
        t0 = time.time()
        items = [{"question": it["question"], "document": it["document"]} for it in req["items"]]
        print(f"[analyze_batch] {len(items)} item(s)", flush=True)
        results = self._pipeline(items)
        print(f"[analyze_batch] TOTAL {time.time()-t0:.1f}s voor {len(items)} item(s)", flush=True)
        return {"results": results, "seconds": round(time.time() - t0, 1)}

    @modal.fastapi_endpoint(method="POST")
    def analyze_answer(self, req: dict):
        """Extract + compose only -- the answer, without waiting for its quotes to be checked.

        Paired with analyze_citations below. routes/documents.js calls this first, stores the
        answer immediately, then calls the other one; the browser is already polling, so the
        answer appears roughly twice as fast while the quotes fill in behind it. The Excel path
        keeps using analyze_batch, which needs both halves before it can decide anything anyway.
        """
        import time
        t0 = time.time()
        answers, facts, chunks = self._answers([{"question": req["question"], "document": req["document"]}])
        return {"answer": answers[0], "extraction": facts[0], "chunk_count": len(chunks[0]),
                "seconds": round(time.time() - t0, 1)}

    @modal.fastapi_endpoint(method="POST")
    def analyze_cite(self, req: dict):
        """The cite half, for an answer analyze_answer produced earlier.

        Re-splits the document rather than having the caller pass chunks back: _split_into_chunks
        is deterministic, so this reproduces exactly the chunks the answer was built from, and it
        keeps the wire format to plain {document, answer}.

        Named "cite" and not "citations" for a boring but load-bearing reason: Modal builds each
        endpoint's hostname as {workspace}--{app}-{class}-{method}.modal.run, and a DNS label
        cannot exceed 63 characters. With this workspace and app name, "analyze_citations" lands
        on 65 and Modal silently truncates the label, so the derived URL resolves to nothing --
        the caller sees a bare "fetch failed" with no hint that the name is the problem.
        "analyze_cite" is 60. Check the length before renaming any endpoint here.
        """
        import time
        t0 = time.time()
        chunks = self._split_into_chunks(req["document"])
        citations = self._citations([chunks], [req["answer"]])[0]
        return {"citations": citations, "seconds": round(time.time() - t0, 1)}

    @modal.fastapi_endpoint(method="GET")
    def health(self):
        return {"ok": True}
