# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Employees and CEOs at financial-sector firms — accounting & audit, banking & compliance, insurance, wealth management, fintech & risk — who need to verify claims in financial documents (annual accounts, credit files, policy terms, prospectuses, contracts, risk reports) quickly and without rereading everything by hand. Multi-tenant: each company account has a `ceo` role and `employee` role.

## Product Purpose

vanKonijnenburg analyzes financial documents and answers questions about them, backing every statement with an exact citation from the source passage — or flagging it as unsupported when it isn't in the document. The user verifies the answer themselves instead of having to trust it.

## Positioning

Citation-grounded document Q&A: every claim in every answer links to the exact passage it came from, verifiable in one click, rather than asking the user to trust an opaque model. Scored under Google's own FACTS Grounding methodology at ~99% on an internal 643-answer benchmark (4/643 residual reasoning errors, zero fabricated facts, 100% citation coverage) — a materially different accuracy class than general-purpose models on the same kind of grounding task.

## Operating Context

- Company signs up, uploads financial documents once, then asks unlimited follow-up questions per document (running Q&A thread per doc).
- Documents are billed by complexity tier (`complex` vs `klein`/small), tracked via monthly usage counters per company.
- Backed by a RunPod-hosted GPU model (internal name: HalluCheck) that autostarts/autostops per pod status.
- Stripe-billed subscriptions across three tiers.

## Capabilities and Constraints

- Upload once, ask many questions over time against the same document.
- Every answer must carry a citation per claim; unsupported claims are flagged, not guessed.
- Plans (current, confirmed in code): Starter €295/mo (25 complex + 50 small docs, €10/extra complex) — Professional €695/mo, featured (80 complex + 150 small docs, €7.50/extra complex) — Enterprise €1,495/mo (200 complex + unlimited small docs, €5/extra complex).
- Roles: `ceo`, `employee`, scoped per company (`company_id`).

## Brand Commitments

- Product/company name shown to customers: **vanKonijnenburg**. ("HalluCheck" is the internal model name, not customer-facing.)
- Existing tagline: "factual grounding for the financial sector."

## Evidence on Hand

- ~99% score under Google's official FACTS Grounding methodology, measured on an internal 643-answer benchmark.
- 4/643 answers had a residual reasoning error; no fabricated facts across the benchmark.
- 100% of answers ship with a citation per claim.
- Public comparison point (confirmed with user 2026-08-19): Google's **Gemini** models score roughly 82% on the public FACTS Grounding benchmark data available (DeepMind's own published range for Gemini variants is ~81–84%). Do not attribute this figure to Gemma — no public FACTS Grounding score for Gemma could be confirmed.
- No customer logos, testimonials, or case studies on hand — do not fabricate any.

## Product Principles

- Verifiability beats trust: every claim must be independently checkable against the source, always.
- Report honestly, never overclaim (per user's standing methodology for HalluCheck evaluation work).
- Built for high-stakes financial review workflows, not casual chat.
- Multi-tenant with real role separation between company decision-makers (CEO) and staff (employee).
