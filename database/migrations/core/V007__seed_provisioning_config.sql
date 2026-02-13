-- V007: Seed default provisioning configuration values
-- These values are used by the edge device provisioning system
-- and can be updated via Admin Panel > Global Settings > Provisioning
--
-- Note: Column names are camelCase (no SnakeNamingStrategy in admin-api-service).
-- The value column is jsonb, so string values must be JSON-encoded (double-quoted).

INSERT INTO public.global_configs (
  id, key, name, description, category, "valueType", value, "defaultValue",
  "isSecret", "isReadOnly", "requiresRestart", "isEnvironmentSpecific",
  "maxHistoryEntries", "sortOrder", "createdAt", "updatedAt"
)
VALUES
  (
    gen_random_uuid(),
    'provisioning.api_url',
    'Provisioning API URL',
    'Base URL for the provisioning API that edge devices connect to for activation',
    'provisioning',
    'url',
    '"http://localhost:3000"',
    '"http://localhost:3000"',
    false, false, true, true,
    10, 10, NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    'provisioning.mqtt_broker_host',
    'MQTT Broker Host',
    'MQTT broker hostname for edge device connections',
    'provisioning',
    'string',
    '"localhost"',
    '"localhost"',
    false, false, true, true,
    10, 20, NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    'provisioning.mqtt_broker_port',
    'MQTT Broker Port',
    'MQTT broker port number',
    'provisioning',
    'number',
    '1883',
    '1883',
    false, false, true, false,
    10, 30, NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    'provisioning.github_release_url',
    'GitHub Release URL',
    'GitHub Releases URL for edge agent binary downloads',
    'provisioning',
    'url',
    '"https://github.com/Okan-wqm/sens/releases"',
    '"https://github.com/Okan-wqm/sens/releases"',
    false, false, false, false,
    10, 40, NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    'provisioning.agent_default_version',
    'Default Agent Version',
    'Default edge agent version to install (latest or pinned version tag like agent-v1.3.0)',
    'provisioning',
    'string',
    '"latest"',
    '"latest"',
    false, false, false, false,
    10, 50, NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    'provisioning.github_repo',
    'GitHub Repository',
    'GitHub repository path for edge agent releases',
    'provisioning',
    'string',
    '"Okan-wqm/sens"',
    '"Okan-wqm/sens"',
    false, false, false, false,
    10, 60, NOW(), NOW()
  )
ON CONFLICT (key) DO NOTHING;
