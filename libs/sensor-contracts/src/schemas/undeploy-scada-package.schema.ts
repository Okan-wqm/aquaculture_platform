/**
 * Canonical schema for the `undeploy_scada_package` command params
 * (WF-011). Sent when a SCADA package is deleted in the cloud: every
 * device the package was deployed to receives this command so the local
 * HMI is cleared (`clear_package`) and the SQLite active row deactivated
 * — a deleted package must not keep running physical screens.
 *
 * `additionalProperties: false` on purpose: the command carries identity
 * + audit reason only; the edge already holds the content.
 */

import { UUID_PATTERN } from './command-envelope.schema';

export const UNDEPLOY_SCADA_PACKAGE_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    packageId: { type: 'string', pattern: UUID_PATTERN },
    /** Audit context, e.g. 'package_deleted' (the default the cloud sends). */
    reason: { type: 'string', minLength: 1 },
  },
  required: ['packageId'],
  additionalProperties: false,
} as const;
