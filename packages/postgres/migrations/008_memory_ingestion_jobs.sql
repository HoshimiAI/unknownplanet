ALTER TABLE ingestion_jobs DROP CONSTRAINT IF EXISTS ingestion_jobs_kind_check;
ALTER TABLE ingestion_jobs ADD CONSTRAINT ingestion_jobs_kind_check CHECK (kind IN ('document', 'memory'));
