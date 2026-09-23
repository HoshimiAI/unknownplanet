CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid NOT NULL,
  scope_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('document')),
  status text NOT NULL CHECK (status IN ('queued','processing','retry_wait','succeeded','failed')),
  checkpoint text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  input jsonb NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id)
);

CREATE INDEX IF NOT EXISTS ingestion_jobs_due_idx ON ingestion_jobs (scope_id, status, next_attempt_at, id);
