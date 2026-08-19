---
name: vanKonijnenburg
description: Audit-ledger precision meets modern SaaS — a citation-grounded financial document verification product.
colors:
  ground: "#F5F8FC"
  surface: "#FFFFFF"
  border: "#E1E7F0"
  border-strong: "#C7D2E0"
  ink: "#0B1220"
  muted: "#4B5563"
  muted-quiet: "#6B7684"
  engineered-blue: "#1345C0"
  engineered-blue-dark: "#0D3391"
  blue-tint: "#EAF0FC"
  verified-green: "#16A34A"
  verified-green-text: "#166534"
  verified-tint: "#E9F7EE"
  comparison-gray: "#C7CFDA"
typography:
  display:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(2.125rem, 4.6vw, 3.25rem)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "29px"
    fontWeight: 800
    letterSpacing: "-0.02em"
  emphasis-numeral:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "26px"
    fontWeight: 800
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "-0.011em"
  label:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14.5px"
    fontWeight: 700
  data:
    fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace"
    fontWeight: 700
    letterSpacing: "-0.02em"
  caption:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
rounded:
  pill: "999px"
  lg: "14px"
  md: "12px"
  sm: "8px"
  xs: "6px"
spacing:
  section-y: "64px"
  section-y-mobile: "48px"
  card-padding: "24px"
components:
  button-primary:
    backgroundColor: "{colors.engineered-blue}"
    textColor: "#FFFFFF"
    rounded: "{rounded.pill}"
    padding: "14px 30px"
  button-primary-hover:
    backgroundColor: "{colors.engineered-blue-dark}"
    textColor: "#FFFFFF"
    rounded: "{rounded.pill}"
    padding: "14px 30px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "14px 30px"
---

# Design System: vanKonijnenburg

## Overview

**Creative North Star: "The Audit Trail"**

vanKonijnenburg reads financial documents and answers questions about them, backing every claim with an exact citation from the source — the product's entire pitch is that you verify it yourself instead of trusting a black box. The visual system takes that literally: it borrows the grammar of an audit workpaper — precise rows, tabular numerals, a single functional color reserved for "verified" marks — and renders it in a crisp, modern SaaS register rather than a literal paper/ledger pastiche. Nothing about the page tries to look old or textured; the ledger reference is structural (rows, hairlines, tabular alignment), not material.

The system deliberately refuses two category defaults: the dark-navy-plus-neon-gradient "AI product" look (the incumbent site's previous identity), and the generic three-stat hero-metric wall. Proof lives in one committed comparison chart and a single-row data strip instead, and the marketing page practices what the product preaches — its own headline stat carries a "see methodology" citation, the same mechanism the product sells.

**Key Characteristics:**
- One committed engineered blue carries brand, primary actions, links, and the chart's "us" bar — never diluted into a rainbow of accent colors.
- A single reserved green exists only for verified/citation marks — a functional color code the reader learns once and recognizes everywhere, never used decoratively.
- Tabular monospace numerals for every stat, price, and quoted citation; proportional Manrope for everything else.
- Comparison and association (pricing, market segments) render as rows and tables, never as grids of identical icon-cards.

## Colors

Cool, near-white ground with one committed saturated blue; a single reserved green functions as a status color, not a palette color.

### Primary
- **Engineered Blue** (`#1345C0`): brand mark, primary CTA fill, links, the headline's one emphasized word, the "vanKonijnenburg" bar in the comparison chart, numeric emphasis (ledger numbers, section bullets). Sampled directly from the approved hero comp's rendered pixels, not eyeballed.
- **Engineered Blue Dark** (`#0D3391`): hover state for the primary button only.

### Neutral
- **Ground** (`#F5F8FC`): page background. A cool near-white, not pure white — gives surfaces something to sit on.
- **Surface** (`#FFFFFF`): cards, the chart panel, the pricing table, the worked-example panel.
- **Ink** (`#0B1220`): headings and primary text. Near-black, not pure black.
- **Muted** (`#4B5563`): body copy, subheads.
- **Muted Quiet** (`#6B7684`): captions, footnotes, secondary labels, the methodology block.
- **Border** (`#E1E7F0`) / **Border Strong** (`#C7D2E0`): hairline dividers between rows and cards; border-strong is reserved for interactive outlines (ghost button, focus-adjacent states).
- **Comparison Gray** (`#C7CFDA`): the non-vanKonijnenburg bar in the comparison chart. Deliberately neutral, not a "losing" red — the page states a fact, it doesn't disparage a named competitor's product.

### Status (functional, not decorative)
- **Verified Green** (`#16A34A`): icon fill only (checkmark badges). Contrast against white is 3.3:1 — sufficient for a graphical icon, not for text.
- **Verified Green Text** (`#166534`): the only green ever used as actual text (the worked-example citation block). 7.1:1 against white — chosen specifically because the icon green fails text contrast.
- **Verified Tint** (`#E9F7EE`): background wash behind a citation/quote block, replacing a colored left-border accent (the craft floor bans colored borders over 1px on cards and callouts).

### Named Rules
**The One Blue Rule.** Exactly one saturated color carries brand and action. A second accent is never introduced for "variety" — differentiation between elements comes from weight, size, and position, not additional hues.
**The Green-Means-Verified Rule.** Green never appears for anything except a citation or verification mark. It is a status code the reader learns once; using it decoratively anywhere else breaks that association.

## Typography

**Display Font:** Manrope (with -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)
**Body Font:** Manrope (same stack)
**Data/Mono Font:** JetBrains Mono (with ui-monospace, Menlo, monospace)

**Character:** Manrope is a confident geometric grotesk — modern without leaning on any of the current AI-default display faces. JetBrains Mono is used exclusively where the product's mechanism is literally "exact, unfudged data": every number, price, and quoted citation renders in mono with tabular numerals, so the reader's eye learns to associate that register with "this is a verifiable fact," never used as a generic "technical" costume.

### Hierarchy
- **Display / H1** (800, `clamp(2.125rem, 4.6vw, 3.25rem)`, 1.1 line-height, -0.025em tracking): the hero headline only. The brand wordmark (19px, 800) is this same weight at a fixed small size — a logotype, not a ramp step.
- **Section Title** (800, 29px, -0.02em tracking): one per section, centered.
- **Emphasis Numeral** (800, 26px, -0.02em tracking): the one number a component exists to sell (pricing figures). Distinct from Data/Label below — this is prose-weight emphasis, not a measured quantity.
- **Body** (500, 15-18px, 1.5-1.65 line-height): paragraph copy, capped around 60-70ch measure. Varies slightly by container (hero sub vs. card body vs. list description) rather than snapping to one fixed size.
- **Label** (700, 14-14.5px): nav links, buttons, chart row labels — short, high-emphasis UI text that isn't a paragraph.
- **Data** (700, mono, tabular-nums, -0.02em tracking, 13-17px depending on role): every stat, price, percentage, and quoted citation. Sized to context (a chart's 17px percentage vs. a ledger's 16px count vs. a step number's 13px), never to a paragraph scale.
- **Caption** (500-600, 11-13.5px, muted-quiet): footnotes, methodology text, ledger labels, the "illustrative example" tag. The type ramp's quietest band spans a wider range than the others by design — captions serve many small unrelated roles (a tag, a footnote, a step number) that share a register, not a single reusable size.

### Named Rules
**The Mono-Means-Measured Rule.** JetBrains Mono is reserved for numbers, prices, and direct quotes — data with a verifiable source. It never dresses plain UI copy to look "technical"; that use is explicitly banned by the craft floor.

## Layout

Single-column, centered content column (`max-width: 1120px`, 24px side padding, 18px under 640px). Sections use generous vertical rhythm (64px top/bottom, 48px on mobile) with a hairline border between logical zones instead of background-color blocking. Comparison/association content (market segments, pricing) renders as rows or a table rather than a grid of cards, preserving row-to-label association at every width.

**Responsive rule for data tables:** a comparison table (pricing) never collapses to a single stacked column — that breaks the row-label-to-column association (a plan's price separated from its own feature values reads as a flat, meaningless list). Below 820px it becomes a horizontally scrollable table at a fixed minimum width (600px) instead.

### Named Rules
**The Row-Survives Rule.** Any layout organizing comparable items (segments, plans, features) must keep the row/column relationship legible at every breakpoint — collapse to horizontal scroll before collapsing to a flat unlabeled stack.

## Elevation & Depth

Mostly flat. The one card that carries a shadow (the hero comparison chart) uses a soft, dual-layer shadow with real offset and blur — never a hard, zero-blur block shadow. Everything else (pricing table, flow steps, worked-example card) uses a 1px hairline border on a white surface against the tinted ground instead of a shadow; depth comes from surface-vs-ground color contrast, not elevation.

### Shadow Vocabulary
- **Hero-lift** (`box-shadow: 0 1px 2px rgba(15,23,42,.04), 0 12px 32px -16px rgba(19,69,192,.16)`): the comparison chart card only — a tight contact shadow plus a soft, blue-tinted ambient glow. Reserved for the single most important proof element on the page.

### Named Rules
**The One Shadow Rule.** Only the page's single most important card (the comparison chart) lifts off the ground. Every other card sits flush, bordered, flat — so the one shadow that exists still means something.

## Shapes

Corner radius scales with a component's weight: pills (`999px`) for every button, `14px` (`lg`) for major cards (chart, pricing table, flow container, worked example), `12px` (`md`) for the methodology footnote card, `8px` (`sm`) for the citation-tint block, `6px` (`xs`) for small interior elements (chart track, chart fill). Below `xs`, a handful of micro decorations (the 4px focus-ring corner, the 3px brand-mark square, the 2px segment-row bullet) scale with their own tiny footprint rather than the card scale — a radius roughly a third of the element's own size, not a system step. Squares stay sharp only at that micro scale; everything a visitor touches or reads at length gets a soft corner from the five-step scale above.

## Components

### Buttons
- **Shape:** full pill (`999px`), `1.5px` border on the ghost variant.
- **Primary:** engineered blue fill, white text, `14px 30px` padding at hero scale / `10px 20px` in the header, 700 weight.
- **Ghost:** transparent fill, `border-strong` outline, ink text; hover shifts border and text to engineered blue.
- **Hover / Active:** primary darkens to `#0D3391`; both variants scale to `0.98` on `:active`. All transitions are background/border/transform only — never layout properties.

### Cards / Containers
- **Corner Style:** `14px` (major cards), `8px` (citation tint block).
- **Background:** white surface on the tinted ground; the citation block uses `verified-tint` instead of a colored border.
- **Shadow Strategy:** flat + bordered by default; only the chart card lifts (see Elevation & Depth).
- **Border:** `1px solid` `border` token throughout — never a colored or thick (>1px) border-left as an accent device.

### Data Table (Pricing)
- **Style:** bordered grid, hairline dividers between rows and columns, no per-plan card shells.
- **Featured column:** `blue-tint` background wash spanning the full column (header through CTA row) — the only way a plan is marked "recommended," no badge or ribbon.
- **Mobile:** horizontally scrollable at `min-width: 600px` rather than collapsing columns.

### List Rows (Market Segments)
- **Style:** two-column row (`230px` label / flex description) separated by hairlines, no card shell. A small `7px` filled square precedes each label instead of an icon, keeping the row lightweight and consistent with the ledger's row grammar.

### Comparison Chart (Signature Component)
The page's proof mechanism made visual: two horizontal tracks, engineered-blue fill for vanKonijnenburg, comparison-gray for the named competitor figure, both ending in a bold mono percentage. Bars animate once via `transform: scaleX()` (never `width`, which thrashes layout) from a left `transform-origin` when the card scrolls into view, respecting `prefers-reduced-motion`. A footer line below the bars carries a citation link ("see methodology") pointing to an on-page footnote — the marketing page dogfoods the product's own citation mechanism on its headline claim.

### Navigation
Flush header, no shadow, single hairline border-bottom. Brand mark (11px rounded-square dot + wordmark, brand name split with the second half in engineered blue) left; ghost "Log in" + solid "Register" right. Shrinks font size and button padding under 640px rather than wrapping or stacking.

## Do's and Don'ts

### Do:
- **Do** reserve engineered blue for brand, action, and the "us" data series — one blue, used with intent, never split across multiple shades for "hierarchy."
- **Do** render every number, price, and quoted source in JetBrains Mono with tabular numerals.
- **Do** keep comparison content (pricing, segments) in row/table form, collapsing to horizontal scroll rather than a flat stack on narrow screens.
- **Do** use `verified-tint` background washes for citation/quote emphasis instead of colored borders.
- **Do** label any illustrative/demo content explicitly (e.g. "Illustrative example") — the product's own honesty claim means the marketing page can't show unmarked synthetic data.

### Don't:
- **Don't** add a kicker or eyebrow badge above a heading — banned outright by the craft floor, no exception even though the approved comp included one.
- **Don't** use a colored `border-left`/`border-right` heavier than 1px on any card, list item, or callout.
- **Don't** render market segments, features, or any comparable set as identical icon-plus-heading-plus-text cards — use rows or tables so comparison stays legible.
- **Don't** animate `width`/`height`/`padding`/`margin` for any data visualization or transition — use `transform` and `opacity`.
- **Don't** introduce a second saturated accent color; every non-blue, non-green color in the system is a neutral.
- **Don't** use the verified green (`#16A34A`) as text color — it fails text contrast by design; text uses `#166534` instead.
