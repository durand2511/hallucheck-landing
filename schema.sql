CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'professional', 'enterprise')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'incomplete',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
