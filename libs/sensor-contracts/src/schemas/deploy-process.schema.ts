/**
 * Canonical schema for the `deploy_process` command params — the ReactFlow
 * process diagram + resolved tag mappings the Rust agent persists to
 * `/var/lib/suderra/scada/process.json`.
 */

const TAG_MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    tagName: { type: 'string', minLength: 1 },
    equipmentId: { type: 'string', minLength: 1 },
    sensorType: { type: 'string' },
    unit: { type: 'string' },
  },
  required: ['tagName', 'equipmentId'],
  additionalProperties: true,
} as const;

export const DEPLOY_PROCESS_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    processId: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    nodes: { type: 'array' },
    edges: { type: 'array' },
    tagMappings: { type: 'array', items: TAG_MAPPING_SCHEMA },
    version: { type: 'integer', minimum: 1 },
    /** ed25519 deploy signature over the artifact checksum (Faz 4). */
    signature: { type: 'string' },
    artifactSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
  required: ['processId', 'name', 'nodes', 'edges', 'tagMappings', 'version'],
  additionalProperties: true,
} as const;
