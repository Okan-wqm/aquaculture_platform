/**
 * Compiled AJV validators for the sensor-domain contracts — BACKEND-ONLY
 * subpath (`@platform/sensor-contracts/validators`). Kept out of the main
 * barrel so browser bundles importing types/upcasters never pull in `ajv`
 * (AJV-over-Zod rationale: libs/event-contracts/src/schemas/common.schema.ts).
 */

import Ajv, { type ValidateFunction } from 'ajv';

import { EDGE_SCADA_PACKAGE_DOC_SCHEMA } from './scada-package-doc/edge-scada-package-doc.schema';
import { SCADA_PACKAGE_DOC_V2_SCHEMA } from './scada-package-doc/scada-package-doc.schema';
import { COMMAND_ENVELOPE_SCHEMA } from './schemas/command-envelope.schema';
import {
  BUNDLE_MANIFEST_SCHEMA,
  DEPLOY_BUNDLE_PARAMS_SCHEMA,
} from './schemas/deploy-bundle.schema';
import { DEPLOY_PROCESS_PARAMS_SCHEMA } from './schemas/deploy-process.schema';
import { DEPLOY_PROGRAM_PARAMS_SCHEMA } from './schemas/deploy-program.schema';
import { DEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA } from './schemas/deploy-scada-package.schema';
import { TAG_REF_SCHEMA } from './schemas/tag-ref.schema';
import { UNDEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA } from './schemas/undeploy-scada-package.schema';

const ajv = new Ajv({ strict: false, allErrors: true });

/** Compiled validator for a single TagRef value. */
export const validateTagRef: ValidateFunction = ajv.compile(TAG_REF_SCHEMA);

/** Compiled validator for the V2 SCADA package document (save-time trust boundary). */
export const validateScadaPackageDocV2: ValidateFunction = ajv.compile(
  SCADA_PACKAGE_DOC_V2_SCHEMA,
);

/**
 * Compiled validator for the STRICT edge-deploy document (CONTRACT-H-002):
 * run AFTER `transformScadaDocForEdgeDeploy`, guarantees the payload
 * deserializes on the Rust edge with no widget in the Unknown bucket.
 */
export const validateEdgeScadaPackageDoc: ValidateFunction = ajv.compile(
  EDGE_SCADA_PACKAGE_DOC_SCHEMA,
);

/** Publish-boundary validators for the cloud→edge deploy commands (Faz 4). */
export const validateCommandEnvelope: ValidateFunction = ajv.compile(COMMAND_ENVELOPE_SCHEMA);
export const validateDeployProcessParams: ValidateFunction = ajv.compile(
  DEPLOY_PROCESS_PARAMS_SCHEMA,
);
export const validateDeployProgramParams: ValidateFunction = ajv.compile(
  DEPLOY_PROGRAM_PARAMS_SCHEMA,
);
export const validateDeployScadaPackageParams: ValidateFunction = ajv.compile(
  DEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA,
);
export const validateUndeployScadaPackageParams: ValidateFunction = ajv.compile(
  UNDEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA,
);
export const validateDeployBundleParams: ValidateFunction = ajv.compile(
  DEPLOY_BUNDLE_PARAMS_SCHEMA,
);
export const validateBundleManifest: ValidateFunction = ajv.compile(BUNDLE_MANIFEST_SCHEMA);

/** Human-readable rendering of the last validation failure. */
export function formatValidationErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
    .join('; ');
}
