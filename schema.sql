CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  -- 'accountancy' = Excel-invultool + documentanalyse (bundle, duurdere plans); 'general' =
  -- alleen documentanalyse (goedkopere standalone plans). Gekozen op de landingpagina vóór
  -- registratie; bepaalt welke nav-items en welk plan-rooster iemand te zien krijgt.
  track TEXT NOT NULL DEFAULT 'accountancy' CHECK (track IN ('accountancy', 'general')),
  plan TEXT NOT NULL DEFAULT 'starter',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'incomplete',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS track TEXT NOT NULL DEFAULT 'accountancy' CHECK (track IN ('accountancy', 'general'));
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_check; -- plan keys now differ per track; validated in lib/plans.js instead

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('ceo', 'employee')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  complexity TEXT NOT NULL CHECK (complexity IN ('complex', 'klein')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'analyzing', 'done', 'failed')),
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  analyzed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_counters (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- 'YYYY-MM'
  complex_count INTEGER NOT NULL DEFAULT 0,
  klein_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, month)
);

CREATE TABLE IF NOT EXISTS gpu_pod (
  id INTEGER PRIMARY KEY DEFAULT 1,
  runpod_pod_id TEXT,
  status TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped', 'starting', 'ready', 'stopping')),
  endpoint_url TEXT,
  last_used_at TIMESTAMPTZ,
  CHECK (id = 1)
);
INSERT INTO gpu_pod (id, status) VALUES (1, 'stopped') ON CONFLICT (id) DO NOTHING;

-- A document gets uploaded once (billable) but can be asked many follow-up questions over time --
-- each question+answer+citation-set is its own row so the UI can show a running Q&A thread.
CREATE TABLE IF NOT EXISTS document_queries (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  asked_by INTEGER NOT NULL REFERENCES users(id),
  question TEXT NOT NULL,
  answer TEXT,
  citations_json JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE document_queries ADD COLUMN IF NOT EXISTS error_message TEXT;
-- Marks a row that reused an identical earlier answer instead of running the model (see
-- routes/documents.js). Such a row is a real entry in the user's thread, but it cost no
-- analysis, so billing must not count it as one.
ALTER TABLE document_queries ADD COLUMN IF NOT EXISTS reused_from_query_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_documents_company ON documents(company_id);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_queries_document ON document_queries(document_id);

-- Single-row key/value config so operational settings (like the cost-per-click) can be changed
-- from one place without a code deploy.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO app_settings (key, value) VALUES ('cost_per_click_cents', '50') ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS advertisers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  stripe_customer_id TEXT,
  stripe_payment_method_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advertiser_sessions (
  token TEXT PRIMARY KEY,
  advertiser_id INTEGER NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ads (
  id SERIAL PRIMARY KEY,
  advertiser_id INTEGER NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL,
  sector TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per click, so billing is auditable (sum of unbilled rows) instead of just a running
-- counter -- lets us retry/verify a charge without losing the underlying record of what happened.
CREATE TABLE IF NOT EXISTS ad_clicks (
  id SERIAL PRIMARY KEY,
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  advertiser_id INTEGER NOT NULL REFERENCES advertisers(id) ON DELETE CASCADE,
  document_query_id INTEGER REFERENCES document_queries(id) ON DELETE SET NULL,
  charged_cents INTEGER NOT NULL,
  billed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ads_advertiser ON ads(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_ad ON ad_clicks(ad_id);
CREATE INDEX IF NOT EXISTS idx_ad_clicks_advertiser_billed ON ad_clicks(advertiser_id, billed);

-- The CEO's message center: any employee (or the CEO) can forward an ad they see while reviewing
-- a document, so the CEO doesn't have to be the one who happened to be looking at that document.
CREATE TABLE IF NOT EXISTS ad_forwards (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ad_id INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
  document_query_id INTEGER REFERENCES document_queries(id) ON DELETE SET NULL,
  forwarded_by INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ad_forwards_company ON ad_forwards(company_id, read);

-- Excel templates an accountant uploads once, then reuses many times. field_map is the human-
-- defined mapping of named fields to input cells (e.g. [{"field":"omzet_januari","cell":"B4"}]) --
-- deliberately NOT inferred by the model. Any formulas already in the template file do the actual
-- calculation in Excel itself once opened; this app only ever writes plain input values, never a
-- computed number, into a cell.
CREATE TABLE IF NOT EXISTS excel_templates (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  field_map_json JSONB NOT NULL,
  is_favorite BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per generated fill, so the accountant's review ("did the AI get this right") stays
-- auditable after the fact instead of only existing in the moment the file was downloaded.
CREATE TABLE IF NOT EXISTS excel_fills (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES excel_templates(id) ON DELETE CASCADE,
  filled_by INTEGER NOT NULL REFERENCES users(id),
  input_text TEXT NOT NULL,
  result_json JSONB NOT NULL, -- per-field: {value, grounded (bool), citation}
  output_storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_excel_templates_company ON excel_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_excel_fills_template ON excel_fills(template_id);

-- Simple, general-purpose employee -> CEO contact channel (any employee can flag something to
-- the CEO, e.g. "this fill kept coming back ungrounded, can you check the template?") --
-- deliberately NOT tied to documents or ads (that whole feature is gone); a plain message.
CREATE TABLE IF NOT EXISTS team_messages (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_team_messages_company ON team_messages(company_id, read);
