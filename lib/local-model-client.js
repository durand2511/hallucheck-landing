// LOKALE testversie van analyzeDocument(question, documentText) -> {answer, citations} --
// praat met het 1,5B unified G-schema-model dat op de Dell laptop draait (via SSH-tunnel naar
// 127.0.0.1:8206), in plaats van de echte RunPod-productie-endpoint. Zelfde interface als
// serverless-client.js, zodat routes/excel.js niet hoeft te weten welke van de twee actief is.
const LOCAL_SERVER = process.env.LOCAL_MODEL_URL || "http://127.0.0.1:8206";

const SYSTEM = `You answer questions truthfully using ONLY the information given to you in the DOCUMENT. Do not use outside knowledge.

Always use EXACTLY this format:
<schema>
Question: <the question, short>
First instinct: <your first guess, before checking the source carefully>
Check: <go through the source carefully and verify your first instinct against what the source actually says>
Revised answer: <the answer fully grounded in the source -- correct your first instinct if the check showed it was wrong>
</schema>
<answer>
<your final answer in natural prose, consistent with the revised answer above>
</answer>

Rules:
- If the source has no relevant information for this specific value, honestly say "not mentioned" -- never fill the gap with outside knowledge or a guess.
- Copy numbers exactly as written (digits/format), never round or respell.
- Write your ENTIRE answer in English. Stop immediately after </answer> -- no closing remarks.`;

const NOT_FOUND_RE = /\b(not mentioned|not found|no information|not stated|not specified|not provided|unknown|niet vermeld|niet gevonden)\b/i;

async function analyzeDocument(question, documentText) {
  const payload = {
    model: "qwen",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `QUESTION: ${question}\n\nDOCUMENT:\n${documentText}` },
    ],
    max_tokens: 400,
    temperature: 0,
  };
  const res = await fetch(`${LOCAL_SERVER}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Lokaal model gaf ${res.status} terug`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";

  const answerMatch = raw.match(/<answer>([\s\S]*?)<\/answer>/);
  const answer = (answerMatch ? answerMatch[1] : raw).trim();
  const checkMatch = raw.match(/Check:\s*([\s\S]*?)(?:\nRevised answer:|$)/);
  const check = checkMatch ? checkMatch[1].trim() : "";

  const ungrounded = NOT_FOUND_RE.test(answer) || !answer;
  // "citation" hier = het Check-fragment als pseudo-bewijs dat het model iets in de bron heeft
  // gevonden -- geen letterlijk citaat-mechanisme zoals de productie-RunPod-pipeline heeft, maar
  // voldoende voor lokaal testen zonder RunPod-kosten te maken.
  return { answer, citations: ungrounded ? [] : [check.slice(0, 300) || answer] };
}

// Same surface as modal-client.js so the route-level client switch stays a one-liner. There is
// no batching win to have here (the local 1.5B server handles one chat completion at a time), so
// this is a plain sequential loop -- correct, just not faster.
async function analyzeBatch(items) {
  const out = [];
  for (const item of items) out.push(await analyzeDocument(item.question, item.document));
  return out;
}

// Nothing to pre-warm: the local model server is already running or it isn't.
module.exports = { analyzeDocument, analyzeBatch, warmUp: () => {}, getStatus: async () => "ready" };
