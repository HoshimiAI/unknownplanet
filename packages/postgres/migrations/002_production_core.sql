-- Compatibility migration from the original V1 schema. Existing records remain in the default scope.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS scope_id text NOT NULL DEFAULT 'default';
ALTER TABLE edges ADD COLUMN IF NOT EXISTS scope_id text NOT NULL DEFAULT 'default';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS scope_id text NOT NULL DEFAULT 'default';
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS scope_id text NOT NULL DEFAULT 'default';
ALTER TABLE vectors ADD COLUMN IF NOT EXISTS scope_id text NOT NULL DEFAULT 'default';
ALTER TABLE vectors ADD COLUMN IF NOT EXISTS model text;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_external_id_key;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_scope_external_id_key;
ALTER TABLE documents ADD CONSTRAINT documents_scope_external_id_key UNIQUE (scope_id, external_id);

ALTER TABLE vectors DROP CONSTRAINT IF EXISTS vectors_pkey;
ALTER TABLE vectors ADD CONSTRAINT vectors_pkey PRIMARY KEY (scope_id, namespace, id);

CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'default',
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content_uri text,
  text_content text,
  start_offset integer,
  end_offset integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (text_content IS NOT NULL OR content_uri IS NOT NULL),
  CHECK (start_offset IS NULL OR start_offset >= 0),
  CHECK (end_offset IS NULL OR end_offset >= start_offset)
);
CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON document_chunks (scope_id, document_id);
CREATE INDEX IF NOT EXISTS vectors_namespace_idx ON vectors (scope_id, namespace);
