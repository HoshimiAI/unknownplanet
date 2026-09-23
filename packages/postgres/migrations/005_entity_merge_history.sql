CREATE TABLE IF NOT EXISTS entity_merges (
  scope_id text NOT NULL,
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  source_node jsonb NOT NULL,
  target_before jsonb NOT NULL,
  target_after jsonb NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, source_id)
);

CREATE INDEX IF NOT EXISTS entity_merges_target_idx ON entity_merges (scope_id, target_id, merged_at DESC);
