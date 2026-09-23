-- Dedicated, scoped identity catalog. Apply this migration to the provider selected by routing.identities.
CREATE TABLE IF NOT EXISTS identities (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL,
  namespace text NOT NULL,
  name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, namespace, name)
);

CREATE TABLE IF NOT EXISTS identity_aliases (
  scope_id text NOT NULL,
  namespace text NOT NULL,
  alias text NOT NULL,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, namespace, alias),
  UNIQUE (scope_id, namespace, identity_id, alias)
);

CREATE TABLE IF NOT EXISTS identity_bindings (
  scope_id text NOT NULL,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, identity_id, provider_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS identity_bindings_identity_idx ON identity_bindings (scope_id, identity_id);
