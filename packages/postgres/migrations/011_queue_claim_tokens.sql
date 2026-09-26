ALTER TABLE queue_messages ADD COLUMN IF NOT EXISTS lease_token uuid;
