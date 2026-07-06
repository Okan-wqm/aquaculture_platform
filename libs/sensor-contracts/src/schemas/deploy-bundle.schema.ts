/**
 * Canonical schema for the `deploy_bundle` command params (enterprise plan
 * Faz 5 — two-phase apply).
 *
 * Content addressing rides as STRINGS on purpose: `manifest` is the exact
 * canonical-JSON byte sequence whose sha256 is `manifestSha256` (and which
 * the ed25519 signature covers), and each `contents` value is the exact
 * canonical-JSON byte sequence of one artifact whose sha256 is its key.
 * The edge hashes the received bytes DIRECTLY — no cross-language JSON
 * canonicalization exists to drift (tier 1: the mismatch class is
 * structurally impossible), then parses.
 */

import { UUID_PATTERN } from './command-envelope.schema';

export const SHA256_HEX_PATTERN = '^[0-9a-f]{64}$';
export const ED25519_SIGNATURE_HEX_PATTERN = '^[0-9a-f]{128}$';

/** The parsed shape of the canonical `manifest` string. */
export const BUNDLE_MANIFEST_SCHEMA = {
  type: 'object',
  properties: {
    bundleId: { type: 'string', pattern: UUID_PATTERN },
    artifacts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          artifactId: { type: 'string', pattern: UUID_PATTERN },
          kind: { enum: ['scada_package', 'process', 'automation_program'] },
          sha256: { type: 'string', pattern: SHA256_HEX_PATTERN },
          sourceEntityId: { type: 'string', pattern: UUID_PATTERN },
          /** Cloud-internal deploy-log correlation id; the edge ignores it. */
          logCommandId: { type: 'string', pattern: UUID_PATTERN },
          /** Source entity version — the edge stamps it into applied meta. */
          version: { type: 'integer', minimum: 0 },
        },
        required: ['artifactId', 'kind', 'sha256'],
        additionalProperties: false,
      },
    },
  },
  required: ['bundleId', 'artifacts'],
  additionalProperties: false,
} as const;

export const DEPLOY_BUNDLE_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    bundleId: { type: 'string', pattern: UUID_PATTERN },
    /** Exact canonical-JSON bytes of the manifest (see module docstring). */
    manifest: { type: 'string', minLength: 2 },
    manifestSha256: { type: 'string', pattern: SHA256_HEX_PATTERN },
    /**
     * ed25519 over tenant + manifestSha256, domain tag `bundle-v1`.
     * REQUIRED — unsigned bundles do not exist (greenfield command, no
     * legacy senders to stay compatible with).
     */
    signature: { type: 'string', pattern: ED25519_SIGNATURE_HEX_PATTERN },
    /** sha256(hex) → exact canonical-JSON bytes of that artifact's content. */
    contents: {
      type: 'object',
      minProperties: 1,
      additionalProperties: { type: 'string', minLength: 2 },
    },
  },
  required: ['bundleId', 'manifest', 'manifestSha256', 'signature', 'contents'],
  additionalProperties: false,
} as const;
