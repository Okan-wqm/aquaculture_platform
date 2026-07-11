/**
 * Canonical schema for the `deploy_program` command params — the JSON
 * ProgramDefinition consumed by the Rust automation engine (Yol A).
 * Mirrors `translateProgramToEdgeScript()` output and the agent's
 * `ProgramDefinition` serde struct.
 *
 * Casing is asymmetric BY THE AGENT'S DESIGN: the top-level
 * `ProgramDefinition` carries `rename_all = "camelCase"`, but the nested
 * scripting types (`ScriptDefinition`, `Trigger`, `Action`,
 * `FBDefinition`, `FBParams`) predate the deploy path and carry NO
 * rename — their multi-word fields are snake_case on the wire
 * (`on_error`, `interval_secs`, `delay_ms`, `fb_type`, `pt_ms`, …).
 * The shared fixtures + the Rust `contract_fixtures` integration test
 * pin this asymmetry so neither side can drift silently again.
 */

const FUNCTION_BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    /** snake_case — REQUIRED field on the agent's FBDefinition. */
    fb_type: { type: 'string', minLength: 1 },
    params: { type: 'object' },
    inputs: { type: 'object', additionalProperties: { type: 'string' } },
    outputs: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['id', 'fb_type'],
  additionalProperties: false,
} as const;

const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    description: { type: 'string' },
    version: { type: 'string' },
    enabled: { type: 'boolean' },
    priority: { type: 'string' },
    triggers: { type: 'array', items: { type: 'object' }, minItems: 1 },
    conditions: { type: 'array' },
    actions: { type: 'array', items: { type: 'object' }, minItems: 1 },
    /** snake_case — the agent's ScriptDefinition field is `on_error`. */
    on_error: { type: 'array' },
  },
  required: ['id', 'name', 'enabled', 'triggers', 'actions'],
  additionalProperties: false,
} as const;

export const DEPLOY_PROGRAM_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    description: { type: 'string' },
    version: { type: 'integer', minimum: 1 },
    executionMode: { enum: ['scan_cycle', 'event_driven'] },
    scanCycleMs: { type: 'integer', minimum: 1 },
    functionBlocks: { type: 'array', items: FUNCTION_BLOCK_SCHEMA },
    script: SCRIPT_SCHEMA,
    ioMappings: { type: 'object', additionalProperties: { type: 'string' } },
    replaceExisting: { type: 'boolean' },
    /** ed25519 deploy signature over the artifact checksum (Faz 4). */
    signature: { type: 'string' },
    artifactSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
  required: ['id', 'version', 'executionMode', 'scanCycleMs', 'functionBlocks', 'script'],
  additionalProperties: true,
} as const;
