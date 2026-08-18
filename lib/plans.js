const PLANS = {
  starter: {
    label: "Starter",
    priceEuroCents: 29500,
    includedComplex: 25,
    includedKlein: 50,
    extraComplexEuroCents: 1000,
    audience: "Kleine kantoren (1-5 fte)",
  },
  professional: {
    label: "Professional",
    priceEuroCents: 69500,
    includedComplex: 80,
    includedKlein: 150,
    extraComplexEuroCents: 750,
    audience: "Middelgrote kantoren (6-25 fte)",
  },
  enterprise: {
    label: "Enterprise",
    priceEuroCents: 149500,
    includedComplex: 200,
    includedKlein: Infinity,
    extraComplexEuroCents: 500,
    audience: "Grote kantoren / audit-praktijken",
  },
};

function currentMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function overageCents(plan, complexCount, kleinCount) {
  const p = PLANS[plan];
  if (!p) return 0;
  const extraComplex = Math.max(0, complexCount - p.includedComplex);
  return extraComplex * p.extraComplexEuroCents;
}

module.exports = { PLANS, currentMonthKey, overageCents };
