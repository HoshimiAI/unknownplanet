CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS nodes (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'default',
  type text NOT NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'default',
  external_id text,
  title text NOT NULL,
  content_uri text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, external_id)
);

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

CREATE TABLE IF NOT EXISTS edges (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'default',
  source_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  valid_from timestamptz,
  valid_to timestamptz,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','canonical','disputed','rejected','deprecated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS evidence (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'default',
  edge_id uuid NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE RESTRICT,
  source_id text,
  chunk_id text,
  source_type text,
  extractor text NOT NULL,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  direction text NOT NULL DEFAULT 'support' CHECK (direction IN ('support','contradict','neutral')),
  strength double precision CHECK (strength IS NULL OR strength BETWEEN 0 AND 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (document_id IS NOT NULL OR source_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS vectors (
  scope_id text NOT NULL DEFAULT 'default',
  id text NOT NULL,
  namespace text NOT NULL,
  model text,
  embedding vector NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, namespace, id)
);

CREATE TABLE IF NOT EXISTS memories (
  scope_id text NOT NULL DEFAULT 'default', id text NOT NULL, agent_id text NOT NULL,
  user_id text, session_id text, content text NOT NULL, memory_type text NOT NULL DEFAULT 'fact',
  importance double precision CHECK (importance IS NULL OR importance BETWEEN 0 AND 1),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  source jsonb, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id)
);

CREATE INDEX IF NOT EXISTS edges_source_id_idx ON edges (source_id);
CREATE INDEX IF NOT EXISTS edges_target_id_idx ON edges (target_id);
CREATE INDEX IF NOT EXISTS edges_relation_idx ON edges (relation);
CREATE INDEX IF NOT EXISTS evidence_edge_id_idx ON evidence (edge_id);
CREATE INDEX IF NOT EXISTS evidence_document_id_idx ON evidence (document_id);
CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx ON document_chunks (scope_id, document_id);
CREATE INDEX IF NOT EXISTS vectors_namespace_idx ON vectors (scope_id, namespace);
CREATE INDEX IF NOT EXISTS memories_owner_idx ON memories (scope_id, agent_id, user_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memories_content_idx ON memories USING gin (to_tsvector('simple', content));
