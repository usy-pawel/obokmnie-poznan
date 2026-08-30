CREATE INDEX IF NOT EXISTS cases_published_received_date_idx
  ON cases (received_date DESC)
  WHERE published;

CREATE INDEX IF NOT EXISTS cases_published_voivodeship_date_idx
  ON cases (voivodeship, received_date DESC)
  WHERE published;
