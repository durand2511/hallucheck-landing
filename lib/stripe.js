const Stripe = require("stripe");

let _stripe = null;
function stripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY niet gezet.");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

module.exports = { stripe };
