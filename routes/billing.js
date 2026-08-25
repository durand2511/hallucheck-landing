const express = require("express");
const { pool } = require("../lib/db.js");
const { requireCeo, requireAuth } = require("../lib/auth.js");
const { stripe } = require("../lib/stripe.js");
const { plansForTrack } = require("../lib/plans.js");

const router = express.Router();

async function ensureStripeCustomer(company, email) {
  if (company.stripe_customer_id) return company.stripe_customer_id;
  const customer = await stripe().customers.create({ email, name: company.name, metadata: { companyId: String(company.id) } });
  await pool.query("UPDATE companies SET stripe_customer_id = $1 WHERE id = $2", [customer.id, company.id]);
  return customer.id;
}

// Returns a SetupIntent client_secret so the frontend's custom Stripe Elements card form can
// securely collect + save a card without the card details ever touching our own server.
router.post("/api/billing/setup-intent", requireCeo, async (req, res) => {
  const { rows: [company] } = await pool.query("SELECT * FROM companies WHERE id = $1", [req.user.company_id]);
  const customerId = await ensureStripeCustomer(company, req.user.email);
  const intent = await stripe().setupIntents.create({ customer: customerId, payment_method_types: ["card"] });
  res.json({ clientSecret: intent.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// Called once the card is saved (SetupIntent succeeded client-side): attaches it as the default
// payment method and starts the monthly subscription for the company's chosen plan.
router.post("/api/billing/subscribe", requireCeo, async (req, res) => {
  const { paymentMethodId, plan: chosenPlanKey } = req.body || {};
  if (!paymentMethodId) return res.status(400).json({ error: "No payment method received." });

  let { rows: [company] } = await pool.query("SELECT * FROM companies WHERE id = $1", [req.user.company_id]);
  const plans = plansForTrack(company.track);
  if (chosenPlanKey && plans[chosenPlanKey] && chosenPlanKey !== company.plan) {
    await pool.query("UPDATE companies SET plan = $1 WHERE id = $2", [chosenPlanKey, company.id]);
    company = { ...company, plan: chosenPlanKey };
  }
  const plan = plans[company.plan];
  const customerId = await ensureStripeCustomer(company, req.user.email);

  await stripe().paymentMethods.attach(paymentMethodId, { customer: customerId });
  await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });

  const subscription = await stripe().subscriptions.create({
    customer: customerId,
    items: [{
      price_data: {
        currency: "eur",
        unit_amount: plan.priceEuroCents,
        recurring: { interval: "month" },
        product_data: { name: `vanKonijnenburg — ${plan.label}` },
      },
    }],
    default_payment_method: paymentMethodId,
    expand: ["latest_invoice.payment_intent"],
  });

  await pool.query(
    "UPDATE companies SET stripe_subscription_id = $1, subscription_status = $2 WHERE id = $3",
    [subscription.id, subscription.status, company.id],
  );

  res.json({ status: subscription.status });
});

router.post("/api/billing/cancel", requireCeo, async (req, res) => {
  const { rows: [company] } = await pool.query("SELECT * FROM companies WHERE id = $1", [req.user.company_id]);
  if (!company.stripe_subscription_id) return res.status(400).json({ error: "No active subscription to cancel." });

  const subscription = await stripe().subscriptions.update(company.stripe_subscription_id, { cancel_at_period_end: true });
  await pool.query("UPDATE companies SET subscription_status = $1 WHERE id = $2", [subscription.status, company.id]);
  res.json({ status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end });
});

// This month's usage, broken down by feature so the CEO can see exactly what they've used (not
// just a combined total) against the plan's included amount before an overage charge applies.
// Accountancy track's included-units cap covers both Excel-fills and document analyses combined
// (one bundled unit type per lib/plans.js); general track only has document analyses.
router.get("/api/billing/usage", requireAuth, async (req, res) => {
  const { rows: [company] } = await pool.query("SELECT track, plan FROM companies WHERE id = $1", [req.user.company_id]);
  // Only analyses that actually delivered something count against the allowance:
  //   * status <> 'done' means the customer got no answer -- a failed run is our problem, not
  //     billable usage. Three of this month's rows failed on infrastructure errors alone.
  //   * reused_from_query_id marks a repeat of a question this document already answered, served
  //     straight from the stored answer without touching the model (routes/documents.js). It
  //     costs us no analysis, so charging for it would be charging for nothing.
  const { rows: [{ count: docCount }] } = await pool.query(
    `SELECT COUNT(*) FROM document_queries dq
     JOIN documents d ON d.id = dq.document_id
     WHERE d.company_id = $1 AND dq.created_at >= date_trunc('month', now())
       AND dq.status = 'done' AND dq.reused_from_query_id IS NULL`,
    [req.user.company_id],
  );
  let fillCount = 0;
  if (company.track === "accountancy") {
    const { rows: [{ count }] } = await pool.query(
      // Same rule as document analyses: a fill that errored out produced no filled sheet, so it
      // is not billable usage.
      `SELECT COUNT(*) FROM excel_fills ef
       JOIN excel_templates et ON et.id = ef.template_id
       WHERE et.company_id = $1 AND ef.created_at >= date_trunc('month', now())
         AND ef.result_json->>'status' = 'done'`,
      [req.user.company_id],
    );
    fillCount = Number(count);
  }
  // The allowance travels with the usage instead of being scraped out of the plan's marketing
  // copy. billing.html used to find the cap by regexing the first number out of whichever feature
  // line contained "inbegrepen" -- which silently produced the wrong cap the moment a plan's
  // wording changed, and no cap at all for plans that had no number in that line.
  const plan = plansForTrack(company.track)[company.plan];
  res.json({
    fillsThisMonth: fillCount + Number(docCount),
    excelFillsThisMonth: fillCount,
    documentAnalysesThisMonth: Number(docCount),
    includedUnits: plan ? plan.includedUnits : null,
    extraUnitEuroCents: plan ? plan.extraUnitEuroCents : null,
  });
});

router.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret
      ? stripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    await pool.query(
      "UPDATE companies SET subscription_status = $1 WHERE stripe_subscription_id = $2",
      [sub.status, sub.id],
    );
  }
  res.json({ received: true });
});

module.exports = router;
