/**
 * Compiled AJV validators for the sensor-domain contracts — BACKEND-ONLY
 * subpath (`@platform/sensor-contracts/validators`). Kept out of the main
 * barrel so browser bundles importing types/upcasters never pull in `ajv`
 * (AJV-over-Zod rationale: libs/event-contracts/src/schemas/common.schema.ts).
 */

import Ajv, { type ValidateFunction } from 'ajv';

import { SCADA_PACKAGE_DOC_V2_SCHEMA } from './scada-package-doc/scada-package-doc.schema';
import { TAG_REF_SCHEMA } from './schemas/tag-ref.schema';

const ajv = new Ajv({ strict: false, allErrors: true });

/** Compiled validator for a single TagRef value. */
export const validateTagRef: ValidateFunction = ajv.compile(TAG_REF_SCHEMA);

/** Compiled validator for the V2 SCADA package document (save-time trust boundary). */
export const validateScadaPackageDocV2: ValidateFunction = ajv.compile(
  SCADA_PACKAGE_DOC_V2_SCHEMA,
);

/** Human-readable rendering of the last validation failure. */
export function formatValidationErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
    .join('; ');
}
