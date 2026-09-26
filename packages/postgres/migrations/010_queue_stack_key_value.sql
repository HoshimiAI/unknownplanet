CREATE TABLE IF NOT EXISTS queue_messages (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'default',
  queue_name text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','leased')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_messages_claim_idx ON queue_messages(scope_id,queue_name,status,available_at,id);

CREATE TABLE IF NOT EXISTS stack_entries (
  id bigserial PRIMARY KEY,
  scope_id text NOT NULL DEFAULT 'default',
  stack_name text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stack_entries_order_idx ON stack_entries(scope_id,stack_name,id DESC);

CREATE TABLE IF NOT EXISTS key_values (
  scope_id text NOT NULL DEFAULT 'default',
  namespace text NOT NULL DEFAULT 'default',
  key text NOT NULL,
  value jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope_id,namespace,key)
);
CREATE INDEX IF NOT EXISTS key_values_expiry_idx ON key_values(expires_at) WHERE expires_at IS NOT NULL;
