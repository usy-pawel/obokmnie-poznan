ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS ever_published boolean NOT NULL DEFAULT false;

UPDATE cases
SET ever_published=true
WHERE published AND NOT ever_published;

CREATE OR REPLACE FUNCTION preserve_case_publication_history() RETURNS trigger AS $$
BEGIN
  IF NEW.published THEN
    NEW.ever_published := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cases_preserve_publication_history ON cases;
CREATE TRIGGER cases_preserve_publication_history
BEFORE INSERT OR UPDATE OF published ON cases
FOR EACH ROW EXECUTE FUNCTION preserve_case_publication_history();
