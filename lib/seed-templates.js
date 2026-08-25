// Seedt de twee ingebouwde, echte accountancy-templates (winst- en verliesrekening,
// BTW-aangifte) voor een bedrijf -- gegenereerd door scripts/generate-templates.js. Idempotent:
// slaat een bedrijf over als het de template al heeft (op naam), zodat dit veilig zowel bij
// registratie als bij elke server-boot (voor bestaande bedrijven die nog niets hadden) kan draaien.
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("./db.js");

const MANIFEST_PATH = path.join(__dirname, "..", "data", "seed-templates", "manifest.json");

async function seedTemplatesForCompany(companyId, userId) {
  if (!fs.existsSync(MANIFEST_PATH)) return; // scripts/generate-templates.js not run yet -- skip quietly
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));

  for (const tpl of manifest) {
    const { rows: existing } = await pool.query(
      "SELECT id FROM excel_templates WHERE company_id = $1 AND name = $2",
      [companyId, tpl.name],
    );
    if (existing.length) continue;

    const companyDir = path.join(__dirname, "..", "data", "excel-templates", String(companyId));
    fs.mkdirSync(companyDir, { recursive: true });
    const storagePath = path.join(companyDir, `seed-${Date.now()}-${path.basename(tpl.file)}`);
    fs.copyFileSync(tpl.file, storagePath);

    await pool.query(
      `INSERT INTO excel_templates (company_id, created_by, name, original_filename, storage_path, field_map_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [companyId, userId, tpl.name, tpl.originalFilename, storagePath, JSON.stringify(tpl.fieldMap)],
    );
  }
}

async function seedTemplatesForAllCompanies() {
  if (!fs.existsSync(MANIFEST_PATH)) return;
  const { rows: companies } = await pool.query(
    `SELECT c.id AS company_id, (SELECT id FROM users u WHERE u.company_id = c.id ORDER BY u.id LIMIT 1) AS user_id
     FROM companies c`,
  );
  for (const c of companies) {
    if (!c.user_id) continue; // no user yet to attribute created_by to -- skip, will seed once one exists
    await seedTemplatesForCompany(c.company_id, c.user_id).catch((err) =>
      console.error(`[seed-templates] failed for company ${c.company_id}:`, err.message),
    );
  }
}

module.exports = { seedTemplatesForCompany, seedTemplatesForAllCompanies };
