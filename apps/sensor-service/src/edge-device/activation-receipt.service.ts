import { Injectable } from '@nestjs/common';

import {
  type ActivationReceiptStatement,
  contractTimestamp,
  type DeviceBinding,
  type Sha256Digest,
  type SignedStatement,
  STATEMENT,
} from './edge-contract';
import { ManifestSigner } from './manifest-signer';
import { SuderraEdgeConfig } from './suderra-edge.config';

/**
 * The activation receipt (ADR-048 DEC-5.8): signed with the
 * `edge-provisioning` key after the device's first authenticated broker
 * session commits its activation (DEC-5.7). It names the manifest root
 * installed by statement digest; the agent checks it against the bundle's
 * edge-provisioning anchor and hands it to root, which verifies it again and
 * records ACTIVE. An agent-written marker is never evidence of registration.
 */

export interface ActivationReceiptInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly binding: DeviceBinding;
  readonly manifestDigest: Sha256Digest;
  readonly activationId: string;
  readonly activatedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
}

export function buildActivationReceipt(input: ActivationReceiptInput): ActivationReceiptStatement {
  return {
    _type: STATEMENT.activationReceipt,
    tenant_id: input.tenantId,
    device_id: input.deviceId,
    device_binding: input.binding,
    manifest_digest: input.manifestDigest,
    activation_id: input.activationId,
    activated_at: input.activatedAt,
    not_before: input.notBefore,
    expires_at: input.expiresAt,
  };
}

/** How long root may accept a receipt after the commit (it never re-derives ACTIVE). */
export const ACTIVATION_RECEIPT_VALIDITY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ActivationReceiptService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  issue(commit: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly binding: DeviceBinding;
    readonly manifestDigest: Sha256Digest;
    readonly activationId: string;
    /** Second-precision commit instant. */
    readonly activatedAt: Date;
  }): SignedStatement<typeof STATEMENT.activationReceipt> {
    const activatedAt = contractTimestamp(commit.activatedAt);
    const signer = new ManifestSigner(this.config.settings.keys.provisioning);
    return signer.sign(
      STATEMENT.activationReceipt,
      buildActivationReceipt({
        tenantId: commit.tenantId,
        deviceId: commit.deviceId,
        binding: commit.binding,
        manifestDigest: commit.manifestDigest,
        activationId: commit.activationId,
        activatedAt,
        notBefore: activatedAt,
        expiresAt: contractTimestamp(
          new Date(commit.activatedAt.getTime() + ACTIVATION_RECEIPT_VALIDITY_MS),
        ),
      }),
    );
  }
}
