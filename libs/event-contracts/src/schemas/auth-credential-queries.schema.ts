import Ajv, { type ValidateFunction } from 'ajv';

import { UUID_SCHEMA } from './common.schema';

/**
 * Trust-boundary schema for the credential-confirmation query
 * (request.auth.verifyPassword). NATS payloads are a trust boundary
 * (compromised-container threat model), so the AJV schema rejects the
 * payload BEFORE any field reaches the peppered-bcrypt pipeline.
 *
 * `additionalProperties: false` stops a compromised peer from smuggling
 * extra keys; the `password` bound (1..128) mirrors the login DTO so this
 * surface cannot be used to feed pathological inputs to bcrypt.
 */
const VERIFY_PASSWORD_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'password'],
  properties: {
    userId: UUID_SCHEMA,
    password: { type: 'string', minLength: 1, maxLength: 128 },
    correlationId: UUID_SCHEMA,
  },
} as const;

const ajv = new Ajv({ strict: false, allErrors: true });

export const verifyPasswordQuerySchema: ValidateFunction = ajv.compile(
  VERIFY_PASSWORD_QUERY_SCHEMA,
);
