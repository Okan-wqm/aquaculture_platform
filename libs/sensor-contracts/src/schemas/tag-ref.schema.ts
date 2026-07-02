/**
 * @module TagRefSchema
 *
 * JSON Schema fragment for the canonical TagRef wire format. Reusable by
 * any deploy-payload or document schema that carries tag references
 * (ScadaPackageDoc, bundle manifests, subscribe frames).
 *
 * The compiled AJV validator lives in `@platform/sensor-contracts/validators`
 * (backend-only subpath) so this module — and the main barrel — stay free of
 * the CommonJS `ajv` dependency for browser bundles.
 */

import { TAG_REF_PATTERN } from '../tag-ref';

/** Reusable schema fragment for a single TagRef string. */
export const TAG_REF_SCHEMA = {
  type: 'string',
  pattern: TAG_REF_PATTERN,
  minLength: 3,
  maxLength: 101,
} as const;
