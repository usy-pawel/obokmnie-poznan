ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS ever_published boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION preserve_case_publication_history() RETURNS trigger AS $$
BEGIN
  IF NEW.published OR (TG_OP = 'UPDATE' AND OLD.published) THEN
    NEW.ever_published := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cases_preserve_publication_history ON cases;
CREATE TRIGGER cases_preserve_publication_history
BEFORE INSERT OR UPDATE OF published ON cases
FOR EACH ROW EXECUTE FUNCTION preserve_case_publication_history();
