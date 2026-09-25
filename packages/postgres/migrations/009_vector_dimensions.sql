ALTER TABLE vectors ADD COLUMN IF NOT EXISTS dimensions integer;
UPDATE vectors SET dimensions = vector_dims(embedding) WHERE dimensions IS NULL;
ALTER TABLE vectors ALTER COLUMN dimensions SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vectors_dimensions_positive') THEN
    ALTER TABLE vectors ADD CONSTRAINT vectors_dimensions_positive CHECK (dimensions > 0);
  END IF;
END $$;
