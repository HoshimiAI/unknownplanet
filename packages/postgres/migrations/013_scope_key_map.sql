-- Fill this table before 014 when a legacy scope_id contains ':'. Such keys
-- cannot be split safely into tenant and workspace identifiers.
CREATE TABLE IF NOT EXISTS unknownplanet_scope_key_map (
  old_scope_id text PRIMARY KEY,
  tenant_id text CHECK (tenant_id IS NULL OR length(trim(tenant_id)) > 0),
  workspace_id text
);

DO $scope_inventory$
DECLARE
  table_name text;
  tables text[] := ARRAY[
    'nodes', 'documents', 'document_chunks', 'edges', 'evidence', 'vectors',
    'memories', 'identities', 'identity_aliases', 'identity_bindings',
    'entity_merges', 'ingestion_jobs', 'queue_messages', 'stack_entries', 'key_values'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format(
      'INSERT INTO unknownplanet_scope_key_map (old_scope_id, tenant_id) SELECT DISTINCT scope_id, CASE WHEN position('':'' IN scope_id)=0 THEN scope_id ELSE NULL END FROM %I ON CONFLICT (old_scope_id) DO NOTHING',
      table_name
    );
  END LOOP;
END
$scope_inventory$;
