import { Injectable } from '@nestjs/common';

import {
  type DsseEnvelope,
  payloadTypeOf,
  type Sha256Digest,
  STATEMENT,
  statementDigest,
} from './edge-contract';
import {
  admitEnvelope,
  keyidOf,
  type StatementSigningKey,
  type VerificationKey,
} from './manifest-signer';
import {
  SuderraEdgeConfig,
  SuderraEdgeConfigError,
  type SuderraEdgeSettings,
} from './suderra-edge.config';

/**
 * The trust-anchors bundle the cloud delivers (ADR-048 DEC-3.7, DEC-22).
 *
 * The bundle is signed by fleet-root, which stays offline (dev/CI: Suderra-OS
 * scripts/gen-dev-keys.sh; production: the P1 ceremony). The cloud never
 * signs it and never edits it: it delivers the envelope exactly as the
 * ceremony produced it, so the statement digest the manifest names is the
 * digest of the ceremony's bytes. At boot the cloud admits the bundle — a
 * fleet-root signature, and an anchor for every key the cloud signs with —
 * because a bundle that does not anchor the cloud's own keys makes every
 * site config, RBAC manifest, receipt and command the cloud signs one the
 * device refuses.
 */

export interface DeliveredTrustAnchors {
  readonly envelope: DsseEnvelope;
  readonly payloadBytes: Buffer;
  readonly digest: Sha256Digest;
  readonly bundleSeq: number;
}

/** The device's tenant is not in the bundle's tenant_scope (DEC-22). */
export class TenantOutOfBundleScopeError extends Error {
  constructor() {
    super('The trust-anchors bundle does not serve this tenant');
    this.name = 'TenantOutOfBundleScopeError';
  }
}

interface Ed25519Anchor {
  readonly purpose: string;
  readonly keyid: string;
  readonly epoch: number;
  readonly publicKey: Buffer;
}

interface AdmittedBundle extends DeliveredTrustAnchors {
  readonly tenantScope: ReadonlySet<string>;
  readonly ed25519: readonly Ed25519Anchor[];
}

function field(record: Record<string, unknown>, name: string): unknown {
  if (!(name in record)) {
    throw new SuderraEdgeConfigError(`The trust-anchors bundle has no ${name}`);
  }
  return record[name];
}

/** Parses and admits a bundle against the fleet-root keys and the cloud's keys. */
export function admitTrustAnchors(
  envelope: DsseEnvelope,
  fleetRootKeys: readonly VerificationKey[],
  cloudKeys: readonly StatementSigningKey[],
): AdmittedBundle {
  let payloadBytes: Buffer;
  try {
    payloadBytes = admitEnvelope(
      'The trust-anchors bundle',
      envelope,
      payloadTypeOf(STATEMENT.trustAnchors),
      'fleet-root',
      fleetRootKeys,
    );
  } catch (error) {
    throw new SuderraEdgeConfigError((error as Error).message);
  }
  const payload = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>;
  if (field(payload, '_type') !== STATEMENT.trustAnchors) {
    throw new SuderraEdgeConfigError('The trust-anchors bundle is not suderra.trust-anchors.v1');
  }
  const bundleSeq = field(payload, 'bundle_seq');
  const scope = field(payload, 'tenant_scope');
  const anchors = field(payload, 'anchors');
  if (
    typeof bundleSeq !== 'number' ||
    !Number.isSafeInteger(bundleSeq) ||
    bundleSeq < 1 ||
    !Array.isArray(scope) ||
    !scope.every((t): t is string => typeof t === 'string') ||
    !Array.isArray(anchors)
  ) {
    throw new SuderraEdgeConfigError('The trust-anchors bundle payload is malformed');
  }

  const ed25519: Ed25519Anchor[] = [];
  for (const raw of anchors as Record<string, unknown>[]) {
    if (raw['algorithm'] !== 'ed25519') continue;
    const publicKey = Buffer.from(String(raw['public_key']), 'base64');
    const anchor: Ed25519Anchor = {
      purpose: String(raw['purpose']),
      keyid: String(raw['keyid']),
      epoch: Number(raw['epoch']),
      publicKey,
    };
    if (keyidOf(publicKey) !== anchor.keyid) {
      throw new SuderraEdgeConfigError(
        `The trust-anchors bundle anchors ${anchor.purpose} under a keyid that is not its key's`,
      );
    }
    ed25519.push(anchor);
  }

  // Every key the cloud signs with that a device checks against the bundle
  // must be anchored there under its own purpose and epoch. device-lifecycle
  // is anchored only in the OS image (statements.json purposes), so it is not
  // looked for here.
  for (const key of cloudKeys) {
    if (key.purpose === 'device-lifecycle') continue;
    const anchored = ed25519.some(
      (a) =>
        a.purpose === key.purpose &&
        a.keyid === key.keyid &&
        a.epoch === key.epoch &&
        a.publicKey.equals(key.publicKey),
    );
    if (!anchored) {
      throw new SuderraEdgeConfigError(
        `The trust-anchors bundle does not anchor the cloud's ${key.purpose} key ${key.keyid} (epoch ${key.epoch}); devices would refuse what it signs`,
      );
    }
  }

  return {
    envelope,
    payloadBytes,
    digest: statementDigest(payloadBytes),
    bundleSeq,
    tenantScope: new Set(scope),
    ed25519,
  };
}

@Injectable()
export class TrustAnchorBundleService {
  private readonly bundle: AdmittedBundle | null;

  constructor(config: SuderraEdgeConfig) {
    this.bundle = config.enabled ? TrustAnchorBundleService.admit(config.settings) : null;
  }

  private static admit(settings: SuderraEdgeSettings): AdmittedBundle {
    return admitTrustAnchors(settings.trustAnchors, settings.fleetRootKeys, [
      settings.keys.provisioning,
      settings.keys.configIntegrity,
      settings.keys.rbacManifest,
      settings.keys.deviceLifecycle,
      settings.keys.command,
    ]);
  }

  private admitted(): AdmittedBundle {
    if (this.bundle === null) {
      throw new SuderraEdgeConfigError('The Suderra OS edge channel is not configured');
    }
    return this.bundle;
  }

  /** The bundle to deliver to a device of `tenantId` (DEC-22 tenant_scope). */
  forTenant(tenantId: string): DeliveredTrustAnchors {
    const bundle = this.admitted();
    if (!bundle.tenantScope.has(tenantId)) {
      throw new TenantOutOfBundleScopeError();
    }
    return {
      envelope: bundle.envelope,
      payloadBytes: bundle.payloadBytes,
      digest: bundle.digest,
      bundleSeq: bundle.bundleSeq,
    };
  }

  /** edge-release anchors, which admit the release statements the cloud names. */
  edgeReleaseKeys(): readonly VerificationKey[] {
    return this.admitted().ed25519.filter((a) => a.purpose === 'edge-release');
  }
}
