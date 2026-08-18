const { ensurePodRunning, markUsed } = require("./runpod.js");

async function analyzeDocument(question, documentText) {
  const endpoint = await ensurePodRunning();
  const res = await fetch(`${endpoint}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, document: documentText }),
  });
  if (!res.ok) throw new Error(`Model server gaf ${res.status} terug`);
  await markUsed();
  return res.json();
}

module.exports = { analyzeDocument };
