// Genereert echte, herkenbare accountancy-Excel-templates (Nederlandse boekhoudpraktijk) als
// seed-data voor de Excel-tool -- gebaseerd op de standaard NL-jaarrekeningstructuur
// (categorale model) en de officiële Belastingdienst BTW-aangifte-rubrieken (1a/1b/1e/5a/5b/5c).
// Draai eenmalig: node scripts/generate-templates.js -- schrijft .xlsx-bestanden naar
// data/seed-templates/, met bijbehorend field_map (welk veld hoort bij welke cel).
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");

const OUT_DIR = path.join(__dirname, "..", "data", "seed-templates");
fs.mkdirSync(OUT_DIR, { recursive: true });

const CURRENCY_FMT = '#,##0.00 "€"';

function styleHeader(cell, text, size = 14) {
  cell.value = text;
  cell.font = { bold: true, size, color: { argb: "FF1345C0" } };
}
function styleSectionLabel(cell, text) {
  cell.value = text;
  cell.font = { bold: true, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FC" } };
}
function styleLineLabel(cell, text) {
  cell.value = text;
  cell.font = { size: 10.5 };
}
function styleInputCell(cell) {
  cell.numFmt = CURRENCY_FMT;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFDE7" } }; // lichtgeel = invoerveld
  cell.border = { bottom: { style: "thin", color: { argb: "FFC7D2E0" } } };
}
function styleFormulaCell(cell) {
  cell.numFmt = CURRENCY_FMT;
  cell.font = { bold: true };
  cell.border = { top: { style: "thin", color: { argb: "FF0B1220" } } };
}

// ---------------------------------------------------------------------------
// TEMPLATE 1: Winst- en verliesrekening (categorale model, standaard NL-indeling)
// ---------------------------------------------------------------------------
async function buildWinstVerlies() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Winst- en verliesrekening");
  ws.columns = [{ width: 42 }, { width: 18 }];

  styleHeader(ws.getCell("A1"), "Winst- en verliesrekening");
  styleLineLabel(ws.getCell("A2"), "Bedrijfsnaam en periode invullen in het bedrijfsblad zelf.");

  let r = 4;
  styleSectionLabel(ws.getCell(`A${r}`), "BEDRIJFSOPBRENGSTEN"); r++;
  const omzetRow = r; styleLineLabel(ws.getCell(`A${r}`), "Netto-omzet"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const overigeOpbrRow = r; styleLineLabel(ws.getCell(`A${r}`), "Overige bedrijfsopbrengsten"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const totOpbrRow = r; styleLineLabel(ws.getCell(`A${r}`), "Totaal bedrijfsopbrengsten");
  ws.getCell(`B${r}`).value = { formula: `SUM(B${omzetRow}:B${overigeOpbrRow})` }; styleFormulaCell(ws.getCell(`B${r}`)); r += 2;

  styleSectionLabel(ws.getCell(`A${r}`), "KOSTPRIJS VAN DE OMZET"); r++;
  const inkoopRow = r; styleLineLabel(ws.getCell(`A${r}`), "Inkoopwaarde van de omzet"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const brutoRow = r; styleLineLabel(ws.getCell(`A${r}`), "Bruto marge");
  ws.getCell(`B${r}`).value = { formula: `B${totOpbrRow}-B${inkoopRow}` }; styleFormulaCell(ws.getCell(`B${r}`)); r += 2;

  styleSectionLabel(ws.getCell(`A${r}`), "BEDRIJFSKOSTEN"); r++;
  const personeelRow = r; styleLineLabel(ws.getCell(`A${r}`), "Personeelskosten (salarissen + sociale lasten + pensioen)"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const afschrRow = r; styleLineLabel(ws.getCell(`A${r}`), "Afschrijvingen"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const huisvestRow = r; styleLineLabel(ws.getCell(`A${r}`), "Huisvestingskosten"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const verkoopRow = r; styleLineLabel(ws.getCell(`A${r}`), "Verkoopkosten"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const algemeenRow = r; styleLineLabel(ws.getCell(`A${r}`), "Algemene kosten"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const totKostenRow = r; styleLineLabel(ws.getCell(`A${r}`), "Totaal bedrijfskosten");
  ws.getCell(`B${r}`).value = { formula: `SUM(B${personeelRow}:B${algemeenRow})` }; styleFormulaCell(ws.getCell(`B${r}`)); r += 2;

  const ebitRow = r; styleLineLabel(ws.getCell(`A${r}`), "Bedrijfsresultaat (EBIT)");
  ws.getCell(`B${r}`).value = { formula: `B${brutoRow}-B${totKostenRow}` }; styleFormulaCell(ws.getCell(`B${r}`)); r += 2;

  styleSectionLabel(ws.getCell(`A${r}`), "FINANCIËLE BATEN EN LASTEN"); r++;
  const renteBatenRow = r; styleLineLabel(ws.getCell(`A${r}`), "Rentebaten"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const renteLastenRow = r; styleLineLabel(ws.getCell(`A${r}`), "Rentelasten"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const finSaldoRow = r; styleLineLabel(ws.getCell(`A${r}`), "Saldo financiële baten en lasten");
  ws.getCell(`B${r}`).value = { formula: `B${renteBatenRow}-B${renteLastenRow}` }; styleFormulaCell(ws.getCell(`B${r}`)); r += 2;

  const voorBelRow = r; styleLineLabel(ws.getCell(`A${r}`), "Resultaat voor belasting");
  ws.getCell(`B${r}`).value = { formula: `B${ebitRow}+B${finSaldoRow}` }; styleFormulaCell(ws.getCell(`B${r}`)); r++;
  const vpbRow = r; styleLineLabel(ws.getCell(`A${r}`), "Vennootschapsbelasting"); styleInputCell(ws.getCell(`B${r}`)); r++;
  const nettoRow = r; ws.getCell(`A${r}`).font = { bold: true, size: 12 }; ws.getCell(`A${r}`).value = "NETTORESULTAAT";
  ws.getCell(`B${r}`).value = { formula: `B${voorBelRow}-B${vpbRow}` };
  ws.getCell(`B${r}`).numFmt = CURRENCY_FMT; ws.getCell(`B${r}`).font = { bold: true, size: 12, color: { argb: "FF1345C0" } };
  ws.getCell(`B${r}`).border = { top: { style: "double", color: { argb: "FF0B1220" } } };

  const outPath = path.join(OUT_DIR, "winst-en-verliesrekening.xlsx");
  await wb.xlsx.writeFile(outPath);

  const fieldMap = [
    { field: "netto_omzet", cell: `B${omzetRow}` },
    { field: "overige_bedrijfsopbrengsten", cell: `B${overigeOpbrRow}` },
    { field: "inkoopwaarde_omzet", cell: `B${inkoopRow}` },
    { field: "personeelskosten", cell: `B${personeelRow}` },
    { field: "afschrijvingen", cell: `B${afschrRow}` },
    { field: "huisvestingskosten", cell: `B${huisvestRow}` },
    { field: "verkoopkosten", cell: `B${verkoopRow}` },
    { field: "algemene_kosten", cell: `B${algemeenRow}` },
    { field: "rentebaten", cell: `B${renteBatenRow}` },
    { field: "rentelasten", cell: `B${renteLastenRow}` },
    { field: "vennootschapsbelasting", cell: `B${vpbRow}` },
  ];
  return { name: "Winst- en verliesrekening", file: outPath, originalFilename: "winst-en-verliesrekening.xlsx", fieldMap };
}

// ---------------------------------------------------------------------------
// TEMPLATE 2: BTW-aangifte hulpblad (officiële Belastingdienst-rubrieken)
// ---------------------------------------------------------------------------
async function buildBtwAangifte() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("BTW-aangifte");
  ws.columns = [{ width: 46 }, { width: 16 }, { width: 16 }];

  styleHeader(ws.getCell("A1"), "BTW-aangifte hulpblad");
  styleLineLabel(ws.getCell("A2"), "Rubrieken volgens de officiële indeling van de Belastingdienst.");

  let r = 4;
  ws.getCell(`B${r}`).value = "Omzet (excl. btw)"; ws.getCell(`B${r}`).font = { bold: true, size: 9.5 };
  ws.getCell(`C${r}`).value = "Btw-bedrag"; ws.getCell(`C${r}`).font = { bold: true, size: 9.5 }; r++;

  styleSectionLabel(ws.getCell(`A${r}`), "RUBRIEK 1 — PRESTATIES BINNENLAND"); r++;
  const omzet21Row = r; styleLineLabel(ws.getCell(`A${r}`), "1a — Leveringen/diensten belast met 21%"); styleInputCell(ws.getCell(`B${r}`));
  ws.getCell(`C${r}`).value = { formula: `B${r}*0.21` }; styleFormulaCell(ws.getCell(`C${r}`)); const btw21Row = r; r++;
  const omzet9Row = r; styleLineLabel(ws.getCell(`A${r}`), "1b — Leveringen/diensten belast met 9%"); styleInputCell(ws.getCell(`B${r}`));
  ws.getCell(`C${r}`).value = { formula: `B${r}*0.09` }; styleFormulaCell(ws.getCell(`C${r}`)); const btw9Row = r; r++;
  const omzet0Row = r; styleLineLabel(ws.getCell(`A${r}`), "1e — Leveringen belast met 0% / vrijgesteld"); styleInputCell(ws.getCell(`B${r}`)); r += 2;

  styleSectionLabel(ws.getCell(`A${r}`), "RUBRIEK 5 — VOORBELASTING EN SALDO"); r++;
  const verschuldigdRow = r; styleLineLabel(ws.getCell(`A${r}`), "5a — Verschuldigde omzetbelasting");
  ws.getCell(`C${r}`).value = { formula: `C${btw21Row}+C${btw9Row}` }; styleFormulaCell(ws.getCell(`C${r}`)); r++;
  const voorbelastingRow = r; styleLineLabel(ws.getCell(`A${r}`), "5b — Voorbelasting (btw op inkoop/kosten)"); styleInputCell(ws.getCell(`C${r}`)); r++;
  const saldoRow = r; ws.getCell(`A${r}`).font = { bold: true, size: 12 }; ws.getCell(`A${r}`).value = "5c — TE BETALEN / TERUG TE VRAGEN";
  ws.getCell(`C${r}`).value = { formula: `C${verschuldigdRow}-C${voorbelastingRow}` };
  ws.getCell(`C${r}`).numFmt = CURRENCY_FMT; ws.getCell(`C${r}`).font = { bold: true, size: 12, color: { argb: "FF1345C0" } };
  ws.getCell(`C${r}`).border = { top: { style: "double", color: { argb: "FF0B1220" } } };

  const outPath = path.join(OUT_DIR, "btw-aangifte.xlsx");
  await wb.xlsx.writeFile(outPath);

  const fieldMap = [
    { field: "omzet_21_procent", cell: `B${omzet21Row}` },
    { field: "omzet_9_procent", cell: `B${omzet9Row}` },
    { field: "omzet_0_procent_vrijgesteld", cell: `B${omzet0Row}` },
    { field: "voorbelasting", cell: `C${voorbelastingRow}` },
  ];
  return { name: "BTW-aangifte hulpblad", file: outPath, originalFilename: "btw-aangifte.xlsx", fieldMap };
}

async function main() {
  const w = await buildWinstVerlies();
  const b = await buildBtwAangifte();
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify([w, b], null, 2));
  console.log("Templates gegenereerd:");
  console.log(" -", w.file);
  console.log(" -", b.file);
}
main();
