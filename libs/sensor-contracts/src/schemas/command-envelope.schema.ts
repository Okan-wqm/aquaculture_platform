/**
 * Canonical wire schema for the MQTT command envelope shared by every
 * cloud→edge command (`tenants/{t}/devices/{d}/commands`). The Rust agent
 * parses this exact shape in its dispatch layer; the contract-parity CI job
 * (`tools/scripts/check-sensor-contract-parity.ts`) keeps the two sides
 * from drifting.
 */

export const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const COMMAND_ENVELOPE_SCHEMA = {
  type: 'object',
  properties: {
    commandId: { type: 'string', pattern: UUID_PATTERN },
    command: { type: 'string', minLength: 1, maxLength: 64 },
    params: { type: 'object' },
    timestamp: { type: 'string', minLength: 20, maxLength: 40 },
  },
  required: ['commandId', 'command', 'params', 'timestamp'],
  additionalProperties: false,
} as const;
