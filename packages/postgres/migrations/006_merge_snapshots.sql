ALTER TABLE entity_merges ADD COLUMN IF NOT EXISTS source_node jsonb;
ALTER TABLE entity_merges ADD COLUMN IF NOT EXISTS target_before jsonb;
ALTER TABLE entity_merges ADD COLUMN IF NOT EXISTS target_after jsonb;

UPDATE entity_merges
SET source_node = COALESCE(source_node, '{}'::jsonb),
    target_before = COALESCE(target_before, '{}'::jsonb),
    target_after = COALESCE(target_after, '{}'::jsonb)
WHERE source_node IS NULL OR target_before IS NULL OR target_after IS NULL;

ALTER TABLE entity_merges ALTER COLUMN source_node SET NOT NULL;
ALTER TABLE entity_merges ALTER COLUMN target_before SET NOT NULL;
ALTER TABLE entity_merges ALTER COLUMN target_after SET NOT NULL;
