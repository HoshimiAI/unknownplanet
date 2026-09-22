CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS nodes (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  external_id text UNIQUE,
  title text NOT NULL,
  content_uri text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS edges (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY,
  edge_id uuid NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  chunk_id text,
  source_type text,
  extractor text NOT NULL,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vectors (
  id text PRIMARY KEY,
  namespace text NOT NULL,
  embedding vector NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS edges_source_id_idx ON edges (source_id);
CREATE INDEX IF NOT EXISTS edges_target_id_idx ON edges (target_id);
CREATE INDEX IF NOT EXISTS edges_relation_idx ON edges (relation);
CREATE INDEX IF NOT EXISTS evidence_edge_id_idx ON evidence (edge_id);
CREATE INDEX IF NOT EXISTS evidence_document_id_idx ON evidence (document_id);
CREATE INDEX IF NOT EXISTS vectors_namespace_idx ON vectors (namespace);
