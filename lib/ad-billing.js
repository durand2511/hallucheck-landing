const { pool } = require("./db.js");
const { stripe } = require("./stripe.js");

const TICK_MS = 30 * 60 * 1000;
const MIN_CHARGE_CENTS = 200; // batch small click charges rather than paying Stripe's per-transaction fee on every €0.50
const MAX_UNBILLED_AGE_MS = 24 * 60 * 60 * 1000; // flush even a small balance once a day so it never stalls indefinitely

// Charges each advertiser for their accumulated, unbilled clicks -- batched rather than charged
// per-click, since Stripe's per-transaction fee would eat a large share of a single €0.50 charge.
async function billAdvertiser(advertiser) {
  const { rows: clicks } = await pool.query(
    "SELECT * FROM ad_clicks WHERE advertiser_id = $1 AND billed = false ORDER BY created_at",
    [advertiser.id],
  );
  if (!clicks.length) return;

  const totalCents = clicks.reduce((sum, c) => sum + c.charged_cents, 0);
  const oldestAgeMs = Date.now() - new Date(clicks[0].created_at).getTime();
  if (totalCents < MIN_CHARGE_CENTS && oldestAgeMs < MAX_UNBILLED_AGE_MS) return;

  if (!advertiser.stripe_customer_id || !advertiser.stripe_payment_method_id) {
    console.warn(`[ad-billing] advertiser ${advertiser.id} has ${clicks.length} unbilled clicks but no card on file`);
    return;
  }

  try {
    await stripe().paymentIntents.create({
      amount: totalCents,
      currency: "eur",
      customer: advertiser.stripe_customer_id,
      payment_method: advertiser.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `vanKonijnenburg ad clicks (${clicks.length})`,
    });
    const ids = clicks.map((c) => c.id);
    await pool.query("UPDATE ad_clicks SET billed = true WHERE id = ANY($1)", [ids]);
    console.log(`[ad-billing] charged advertiser ${advertiser.id} €${(totalCents / 100).toFixed(2)} for ${clicks.length} clicks`);
  } catch (err) {
    console.error(`[ad-billing] charge failed for advertiser ${advertiser.id}:`, err.message);
  }
}

async function billingTick() {
  const { rows: advertisers } = await pool.query(
    `SELECT DISTINCT a.* FROM advertisers a JOIN ad_clicks c ON c.advertiser_id = a.id WHERE c.billed = false`,
  );
  for (const advertiser of advertisers) {
    await billAdvertiser(advertiser);
  }
}

function startAdBillingTicker() {
  setInterval(() => {
    billingTick().catch((err) => console.error("[ad-billing] tick error:", err.message));
  }, TICK_MS);
}

module.exports = { startAdBillingTicker, billingTick };
