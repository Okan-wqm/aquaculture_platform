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

/** How long root may accept a receipt after it is signed (it never re-derives ACTIVE). */
export const ACTIVATION_RECEIPT_VALIDITY_MS = 24 * 60 * 60 * 1000;

/**
 * A delivery re-signs a stored receipt with less than this left of its
 * window, so a redelivery never carries a receipt root must refuse as
 * expired (statements.json time_window) and a slow first hand-over does not
 * strand the device short of ACTIVE.
 */
export const ACTIVATION_RECEIPT_RESIGN_MARGIN_MS = 12 * 60 * 60 * 1000;

/** The committed activation a receipt states; a re-signed receipt states the same one. */
export interface CommittedActivation {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly binding: DeviceBinding;
  readonly manifestDigest: Sha256Digest;
  readonly activationId: string;
  /** Second-precision commit instant. */
  readonly activatedAt: Date;
}

export interface IssuedReceipt {
  readonly statement: SignedStatement<typeof STATEMENT.activationReceipt>;
  /** The envelope JSON exactly as delivered (the agent hands these bytes to root). */
  readonly envelope: string;
  readonly expiresAt: Date;
}

@Injectable()
export class ActivationReceiptService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  /**
   * Signs the receipt of `activation` at `signedAt`: valid from the activation
   * to ACTIVATION_RECEIPT_VALIDITY_MS after signing. Re-signing at a later
   * instant states the same activation (id, instant, manifest) under a later
   * window.
   */
  issue(activation: CommittedActivation, signedAt: Date): IssuedReceipt {
    const expiresAt = new Date(signedAt.getTime() + ACTIVATION_RECEIPT_VALIDITY_MS);
    const activatedAt = contractTimestamp(activation.activatedAt);
    const signer = new ManifestSigner(this.config.settings.keys.provisioning);
    const statement = signer.sign(
      STATEMENT.activationReceipt,
      buildActivationReceipt({
        tenantId: activation.tenantId,
        deviceId: activation.deviceId,
        binding: activation.binding,
        manifestDigest: activation.manifestDigest,
        activationId: activation.activationId,
        activatedAt,
        notBefore: activatedAt,
        expiresAt: contractTimestamp(expiresAt),
      }),
    );
    return { statement, envelope: JSON.stringify(statement.envelope), expiresAt };
  }
}
