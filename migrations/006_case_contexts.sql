CREATE TABLE IF NOT EXISTS case_contexts (
  case_id bigint PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  source_fingerprint text NOT NULL,
  context jsonb NOT NULL,
  model text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS case_contexts_generated_at_idx
  ON case_contexts (generated_at DESC);
