const express = require("express");
const { pool } = require("../lib/db.js");
const { requireCeo } = require("../lib/auth.js");
const { stripe } = require("../lib/stripe.js");
const { PLANS } = require("../lib/plans.js");

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
  const { paymentMethodId } = req.body || {};
  if (!paymentMethodId) return res.status(400).json({ error: "Geen betaalmethode ontvangen." });

  const { rows: [company] } = await pool.query("SELECT * FROM companies WHERE id = $1", [req.user.company_id]);
  const plan = PLANS[company.plan];
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
