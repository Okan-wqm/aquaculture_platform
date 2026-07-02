/**
 * @module TagRefSchema
 *
 * JSON Schema fragment + compiled AJV validator for the canonical TagRef
 * wire format. Reusable by any deploy-payload or document schema that
 * carries tag references (ScadaPackageDoc, bundle manifests, subscribe
 * frames). AJV over Zod per the platform decision documented in
 * `libs/event-contracts/src/schemas/common.schema.ts`.
 */

import Ajv, { type ValidateFunction } from 'ajv';

import { TAG_REF_PATTERN } from '../tag-ref';

/** Reusable schema fragment for a single TagRef string. */
export const TAG_REF_SCHEMA = {
  type: 'string',
  pattern: TAG_REF_PATTERN,
  minLength: 3,
  maxLength: 101,
} as const;

const ajv = new Ajv({ strict: false, allErrors: true });

/** Compiled validator for a single TagRef value. */
export const validateTagRef: ValidateFunction = ajv.compile(TAG_REF_SCHEMA);
