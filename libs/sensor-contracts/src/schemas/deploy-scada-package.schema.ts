/**
 * Canonical schema for the `deploy_scada_package` command params — the full
 * ScadaPackageDocV2 document plus the server-stamped deploy meta fields
 * (version, deployedAt, edgeDeviceId, artifact checksum/signature).
 */

import { SCADA_PACKAGE_DOC_V2_SCHEMA } from '../scada-package-doc/scada-package-doc.schema';

export const DEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    ...SCADA_PACKAGE_DOC_V2_SCHEMA.properties,
    meta: {
      type: 'object',
      properties: {
        schemaVersion: { const: 2 },
        version: { type: 'integer', minimum: 1 },
        packageVersion: { type: 'string' },
        deployedBy: { type: 'string' },
        deployedAt: { type: 'string' },
        edgeDeviceId: { type: 'string' },
        artifactSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        /** ed25519 deploy signature over the artifact checksum (Faz 4). */
        signature: { type: 'string' },
        rollback: { type: 'boolean' },
      },
      required: ['schemaVersion', 'version', 'deployedAt', 'edgeDeviceId'],
      additionalProperties: true,
    },
  },
  required: ['meta', 'screens'],
  additionalProperties: true,
} as const;
