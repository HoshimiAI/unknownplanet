ALTER TABLE evidence ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'support' CHECK (direction IN ('support','contradict','neutral'));
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS strength double precision CHECK (strength IS NULL OR strength BETWEEN 0 AND 1);
ALTER TABLE edges ADD COLUMN IF NOT EXISTS valid_from timestamptz;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS valid_to timestamptz;
ALTER TABLE edges ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','canonical','disputed','rejected','deprecated'));
DO $$ BEGIN
  ALTER TABLE edges ADD CONSTRAINT edges_valid_interval_check CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS evidence_source_idx ON evidence (scope_id, source_id);

CREATE TABLE IF NOT EXISTS memories (
  scope_id text NOT NULL DEFAULT 'default', id text NOT NULL, agent_id text NOT NULL,
  user_id text, session_id text, content text NOT NULL, memory_type text NOT NULL DEFAULT 'fact',
  importance double precision CHECK (importance IS NULL OR importance BETWEEN 0 AND 1),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  source jsonb, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id)
);
CREATE INDEX IF NOT EXISTS memories_owner_idx ON memories (scope_id, agent_id, user_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memories_content_idx ON memories USING gin (to_tsvector('simple', content));
