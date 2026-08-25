// PRIJSSTELLING -- op waarde geprijsd, met de gemeten kosten als ondergrens.
//
// Eerdere versies waren op kostprijs geankerd, en dat is het verkeerde anker: het leverde een
// gemiddelde van ~EUR 75 per kantoor op voor een dienst die een middelgroot kantoor tien uur per
// maand scheelt (~EUR 950 aan declarabele tijd). Wat dit product onderscheidt van een generieke
// AI-chat is niet snelheid maar bewijsbaarheid: elk antwoord draagt een letterlijk citaat dat de
// server verifieert tegen de bron, het weigert te antwoorden als het document het niet zegt, en
// de klantdossiers verlaten de eigen infrastructuur niet -- bij geheimhoudingsplicht en AVG is
// dat een inkoopvoorwaarde, geen extraatje. Die drie samen zetten dit naast de vakspecifieke
// software waar kantoren honderden euro's per maand voor betalen, niet naast een EUR 20-tool.
//
// De prijzen vangen nu ruwweg een derde van de bespaarde uren. De inbegrepen aantallen houden de
// GPU-kosten onder ~20% van de omzet (85-90% brutomarge), zodat rekentijd geen rem op groei is.
//
// Eén analyse kost ~EUR 0,17 aan GPU (H100 op Modal, gemeten op de volledige pipeline bij een
// realistische sessie van ~4 vragen en een afkoelvenster van 60s; een losse koude vraag kost
// ~EUR 0,28). De inbegrepen tegoeden zijn zo gekozen dat de GPU-kosten bij VOLLEDIG gebruik
// onder ~28% van de abonnementsprijs blijven -- oftewel 72-80% brutomarge, wat voor SaaS de
// normale bandbreedte is en ruimte laat voor hosting, support en ontwikkeling.
//
// Dat was hard nodig: de vorige aantallen waren op de general-track verliesgevend (Pro gaf 300
// analyses weg voor EUR 49, wat EUR 51 aan GPU kost; Business 1500 voor EUR 129, oftewel EUR 255)
// en op Enterprise stond "onbeperkt", wat bij een dienst met echte rekentijd per gebruik geen
// belofte is die je kunt nakomen.
//
// De prijs per extra eenheid ligt bewust BOVEN de effectieve prijs per inbegrepen eenheid: wie
// over zijn tegoed gaat, gebruikt capaciteit waar niet op geplanned is.
//
// Marktconform gemaakt (2026-08-24), nu gesplitst per track:
// - accountancy: Excel-invultool + documentanalyse gebundeld -- duurder, maar dat is de bewuste
//   "goeie deal" positionering (je krijgt beide tools voor minder dan losse aanschaf zou kosten).
// - general: alleen documentanalyse (grounded Q&A) -- vergelijkbare AI-documentanalyse-tools
//   liggen tussen ~€15-25 (instap) en ~€100-150/mnd (team-tier), dus goedkoper dan het bundle-track.
const ACCOUNTANCY_PLANS = {
  starter: {
    label: "Starter",
    priceEuroCents: 9900,
    includedUnits: 60,
    extraUnitEuroCents: 200,
    audience: "Kleine kantoren (1-3 fte)",
    unitLabel: "Excel-invullingen + documentanalyses",
  },
  professional: {
    label: "Professional",
    priceEuroCents: 29900,
    includedUnits: 250,
    extraUnitEuroCents: 150,
    audience: "Middelgrote kantoren (4-15 fte)",
    unitLabel: "Excel-invullingen + documentanalyses",
  },
  enterprise: {
    label: "Enterprise",
    priceEuroCents: 74900,
    // Was Infinity, daarna 750. Onbeperkt is bij een dienst met rekentijd per gebruik geen
    // houdbare belofte, en 750 was met EUR 128 aan GPU nog altijd de helft van de omzet.
    includedUnits: 700,
    extraUnitEuroCents: 125,
    audience: "Grote kantoren / meerdere vestigingen",
    unitLabel: "Excel-invullingen + documentanalyses",
  },
};

const GENERAL_PLANS = {
  basic: {
    label: "Basic",
    priceEuroCents: 3900,
    includedUnits: 40,
    extraUnitEuroCents: 125,
    audience: "Kleine teams",
    unitLabel: "documentanalyses",
  },
  pro: {
    label: "Pro",
    priceEuroCents: 9900,
    includedUnits: 120,
    extraUnitEuroCents: 100,
    audience: "Groeiende bedrijven",
    unitLabel: "documentanalyses",
  },
  business: {
    label: "Business",
    priceEuroCents: 24900,
    // 1500 analyses voor EUR 129 kostte EUR 255 aan GPU -- dit plan legde per klant geld toe.
    includedUnits: 300,
    extraUnitEuroCents: 90,
    audience: "Grote organisaties",
    unitLabel: "documentanalyses",
  },
};

function plansForTrack(track) {
  return track === "general" ? GENERAL_PLANS : ACCOUNTANCY_PLANS;
}

function defaultPlanForTrack(track) {
  return track === "general" ? "basic" : "starter";
}

function currentMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function overageCents(track, plan, unitCount) {
  const p = plansForTrack(track)[plan];
  if (!p) return 0;
  const extra = Math.max(0, unitCount - p.includedUnits);
  return extra * p.extraUnitEuroCents;
}

module.exports = { ACCOUNTANCY_PLANS, GENERAL_PLANS, plansForTrack, defaultPlanForTrack, currentMonthKey, overageCents };
