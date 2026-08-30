ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS source_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_import_id bigint REFERENCES imports(id);

CREATE INDEX IF NOT EXISTS cases_last_import_idx ON cases (last_import_id);
CREATE INDEX IF NOT EXISTS imports_status_finished_idx ON imports (status, finished_at DESC);
