-- Run with writers stopped. The migration fails closed for ambiguous legacy keys.

DO $scope_migration$
DECLARE
  table_name text;
  missing_key text;
  duplicate_key text;
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

  SELECT old_scope_id INTO missing_key
  FROM unknownplanet_scope_key_map
  WHERE tenant_id IS NULL
  LIMIT 1;
  IF missing_key IS NOT NULL THEN
    RAISE EXCEPTION 'Ambiguous legacy scope key %. Add its tenant/workspace mapping to unknownplanet_scope_key_map before running 014.', missing_key;
  END IF;

  SELECT new_key INTO duplicate_key FROM (
    SELECT 'v2:' || encode(convert_to(tenant_id, 'UTF8'), 'hex') || ':' || coalesce(encode(convert_to(nullif(workspace_id, ''), 'UTF8'), 'hex'), '-') AS new_key
    FROM unknownplanet_scope_key_map
    WHERE tenant_id IS NOT NULL
  ) AS mapped
  GROUP BY new_key HAVING count(*) > 1 LIMIT 1;
  IF duplicate_key IS NOT NULL THEN
    RAISE EXCEPTION 'Multiple legacy scope keys map to %. Resolve the mapping before running 014.', duplicate_key;
  END IF;

  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE %I AS records SET scope_id = ''v2:'' || encode(convert_to(mapping.tenant_id, ''UTF8''), ''hex'') || '':'' || coalesce(encode(convert_to(nullif(mapping.workspace_id, ''''), ''UTF8''), ''hex''), ''-'') FROM unknownplanet_scope_key_map AS mapping WHERE records.scope_id = mapping.old_scope_id',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN scope_id SET DEFAULT %L', table_name, 'v2:64656661756c74:-');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (scope_id LIKE ''v2:%%'')', table_name, table_name || '_scope_key_v2');
  END LOOP;
  ALTER TABLE unknownplanet_scope_key_map ALTER COLUMN tenant_id SET NOT NULL;
END
$scope_migration$;
