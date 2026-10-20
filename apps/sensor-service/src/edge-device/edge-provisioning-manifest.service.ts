import { Injectable } from '@nestjs/common';

import { type DeviceBrokerEndpoint } from './device-broker';
import {
  BINDING_METHODS,
  BOARD_PROFILES,
  type BindingMethod,
  type BoardProfile,
  contractTimestamp,
  type DeviceBinding,
  type DsseEnvelope,
  type EdgeProvisioningStatement,
  type Sha256Digest,
  type SignedStatement,
  type SitePath,
  STATEMENT,
} from './edge-contract';
import { boardRow } from './edge-boards';
import {
  abiSupported,
  type AdmittedRelease,
  EdgeReleaseCatalog,
  osVersionAtLeast,
} from './edge-release-catalog.service';
import { ManifestSigner } from './manifest-signer';
import { RbacManifestService } from './rbac-manifest.service';
import { SiteConfigManifestService } from './site-config-manifest.service';
import { SuderraEdgeConfig } from './suderra-edge.config';
import {
  type DeliveredTrustAnchors,
  TrustAnchorBundleService,
} from './trust-anchor-bundle.service';

/**
 * The device-bound provisioning manifest and the delivery that carries it
 * (ADR-048 DEC-3.1, DEC-5.5, DEC-5.6, DEC-22; delivery.json,
 * edge-provisioning.schema.json, edge-provisioning-delivery.schema.json).
 *
 * The manifest binds one device (binding, id, tenant, the request's nonce)
 * to one release statement, one trust-anchors bundle and one site config by
 * statement digest, for a short window, under a per-device update_seq. It is
 * signed with the `edge-provisioning` key. The delivery document carries the
 * manifest and every statement and site file it names, so root verifies the
 * whole set in one pass and nothing else needs fetching but the artifact.
 */

export const DELIVERY_CONTENT_TYPE = 'application/vnd.suderra.edge-provisioning-delivery.v1+json';

/** GET /install/{device_code}/suderra-os query (edge-provisioning-request.schema.json). */
export interface ProvisioningRequest {
  readonly binding: DeviceBinding;
  readonly nonce: string;
  readonly boardProfile: BoardProfile;
  readonly osVersion: string;
  readonly agentAbi: string;
}

const REQUEST_KEYS = [
  'binding_method',
  'binding_sha256',
  'nonce',
  'board_profile',
  'os_version',
  'agent_abi',
] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32,128}$/;
const OS_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const ABI_RANGE = /^(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/;

/**
 * Parses the request query exactly as the schema states it: these six
 * strings and nothing else (a `token` parameter is refused — the token
 * travels only in X-Provisioning-Token). Returns null for anything else.
 */
export function parseProvisioningRequest(
  query: Readonly<Record<string, unknown>>,
): ProvisioningRequest | null {
  const keys = Object.keys(query);
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((k) => keys.includes(k))) {
    return null;
  }
  const text = (key: (typeof REQUEST_KEYS)[number]): string | null => {
    const value = query[key];
    return typeof value === 'string' ? value : null;
  };
  const method = text('binding_method');
  const digest = text('binding_sha256');
  const nonce = text('nonce');
  const board = text('board_profile');
  const osVersion = text('os_version');
  const agentAbi = text('agent_abi');
  if (
    method === null ||
    !(BINDING_METHODS as readonly string[]).includes(method) ||
    digest === null ||
    !SHA256_HEX.test(digest) ||
    nonce === null ||
    !NONCE.test(nonce) ||
    board === null ||
    !(BOARD_PROFILES as readonly string[]).includes(board) ||
    osVersion === null ||
    !OS_VERSION.test(osVersion) ||
    agentAbi === null ||
    !ABI_RANGE.test(agentAbi)
  ) {
    return null;
  }
  return {
    binding: { method: method as BindingMethod, digest: { sha256: digest } },
    nonce,
    boardProfile: board as BoardProfile,
    osVersion,
    agentAbi,
  };
}

export interface ProvisioningManifestInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly binding: DeviceBinding;
  readonly nonce: string;
  readonly keyEpoch: number;
  readonly updateSeq: number;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly release: {
    readonly digest: Sha256Digest;
    readonly version: string;
    readonly securityVersion: number;
    readonly boardProfile: BoardProfile;
    readonly arch: 'aarch64' | 'x86_64';
    readonly artifactUrl: string;
  };
  readonly siteConfig: { readonly digest: Sha256Digest; readonly updateSeq: number };
  readonly trustAnchors: { readonly digest: Sha256Digest; readonly bundleSeq: number };
}

export function buildProvisioningManifest(
  input: ProvisioningManifestInput,
): EdgeProvisioningStatement {
  return {
    _type: STATEMENT.edgeProvisioning,
    tenant_id: input.tenantId,
    device_id: input.deviceId,
    device_code: input.deviceCode,
    device_binding: input.binding,
    nonce: input.nonce,
    board: input.release.boardProfile,
    arch: input.release.arch,
    agent_profile: 'suderra-os',
    version: input.release.version,
    security_version: input.release.securityVersion,
    key_epoch: input.keyEpoch,
    update_seq: input.updateSeq,
    not_before: input.notBefore,
    expires_at: input.expiresAt,
    release_statement: { digest: input.release.digest },
    artifact_url: input.release.artifactUrl,
    site_config: { digest: input.siteConfig.digest, update_seq: input.siteConfig.updateSeq },
    trust_anchors: { digest: input.trustAnchors.digest, bundle_seq: input.trustAnchors.bundleSeq },
  };
}

/** suderra.edge-provisioning-delivery.v1, members in the schema's order. */
export interface ProvisioningDelivery {
  readonly _type: 'suderra.edge-provisioning-delivery.v1';
  readonly manifest: DsseEnvelope;
  readonly release_statement: DsseEnvelope;
  readonly trust_anchors: DsseEnvelope;
  readonly site_config: DsseEnvelope;
  readonly rbac_manifest: DsseEnvelope;
  readonly site_files: Readonly<Record<string, string>>;
}

export function buildDelivery(parts: {
  readonly manifest: DsseEnvelope;
  readonly release: DsseEnvelope;
  readonly trustAnchors: DsseEnvelope;
  readonly siteConfig: DsseEnvelope;
  readonly rbac: DsseEnvelope;
  readonly siteFiles: ReadonlyMap<SitePath, Buffer>;
}): ProvisioningDelivery {
  const siteFiles: Record<string, string> = {};
  for (const [path, bytes] of [...parts.siteFiles.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    siteFiles[path] = bytes.toString('base64');
  }
  return {
    _type: 'suderra.edge-provisioning-delivery.v1',
    manifest: parts.manifest,
    release_statement: parts.release,
    trust_anchors: parts.trustAnchors,
    site_config: parts.siteConfig,
    rbac_manifest: parts.rbac,
    site_files: siteFiles,
  };
}

/**
 * The response body. Its formatting is free (the root installer parses it,
 * and every digest is over a statement's decoded payload, not the envelope
 * text), so it is compact JSON.
 */
export function serializeDelivery(delivery: ProvisioningDelivery): string {
  return JSON.stringify(delivery);
}

/**
 * Why a manifest was not issued. The controller answers every one of these
 * with the same uniform refusal (delivery.json `refusal`, DEC-22); the reason
 * is logged and shown only in the authenticated panel.
 */
export type ProvisioningRefusalReason =
  | 'request-invalid'
  | 'device-unknown'
  | 'token-invalid'
  | 'token-expired'
  | 'token-spent'
  | 'device-terminal'
  | 'binding-reserved-elsewhere'
  | 'binding-differs-from-device'
  | 'board-not-provisionable'
  | 'board-mismatch'
  | 'tenant-out-of-bundle-scope'
  | 'release-unavailable'
  | 'release-incompatible'
  | 'channel-unconfigured';

export class ProvisioningRefusal extends Error {
  constructor(readonly reason: ProvisioningRefusalReason) {
    super(`provisioning refused: ${reason}`);
    this.name = 'ProvisioningRefusal';
  }
}

/** One reserved issuance: what the reservation fixed for this manifest. */
export interface ManifestIssuance {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly binding: DeviceBinding;
  readonly provisioningToken: string;
  /** update_seq of the manifest; the site config takes `siteConfigSeq`. */
  readonly manifestSeq: number;
  readonly siteConfigSeq: number;
  readonly window: { readonly notBefore: Date; readonly expiresAt: Date };
}

export interface IssuedDelivery {
  readonly body: string;
  readonly manifest: SignedStatement<typeof STATEMENT.edgeProvisioning>;
}

@Injectable()
export class EdgeProvisioningManifestService {
  constructor(
    private readonly config: SuderraEdgeConfig,
    private readonly releases: EdgeReleaseCatalog,
    private readonly bundles: TrustAnchorBundleService,
    private readonly rbac: RbacManifestService,
    private readonly siteConfigs: SiteConfigManifestService,
  ) {}

  /** How long a manifest reservation and the statements issued under it stay valid. */
  get reservationTtlMs(): number {
    return this.config.settings.reservationTtlMs;
  }

  /** The broker a Suderra OS device is told about: 8883 TLS only (DEC-10.1, DEC-10.2). */
  deviceBroker(): DeviceBrokerEndpoint {
    return this.config.settings.deviceBroker;
  }

  /**
   * Checks what can be decided before a reservation is taken: the board is
   * provisionable, a release for it exists and the device's OS can run it,
   * and the bundle serves the tenant. Refusing here keeps a reservation from
   * binding a device the cloud cannot serve.
   */
  async preflight(request: ProvisioningRequest, tenantId: string): Promise<AdmittedRelease> {
    if (!this.config.enabled) throw new ProvisioningRefusal('channel-unconfigured');
    const board = boardRow(request.boardProfile);
    if (board === null || !board.cloudProvisioningAllowed) {
      throw new ProvisioningRefusal('board-not-provisionable');
    }
    let release: AdmittedRelease;
    try {
      release = await this.releases.forBoard(board);
    } catch {
      throw new ProvisioningRefusal('release-unavailable');
    }
    if (
      !osVersionAtLeast(request.osVersion, release.minOsVersion) ||
      !abiSupported(request.agentAbi, release.agentAbi)
    ) {
      throw new ProvisioningRefusal('release-incompatible');
    }
    this.bundleFor(tenantId);
    return release;
  }

  private bundleFor(tenantId: string): DeliveredTrustAnchors {
    try {
      return this.bundles.forTenant(tenantId);
    } catch {
      throw new ProvisioningRefusal('tenant-out-of-bundle-scope');
    }
  }

  /** Signs the manifest, site config and RBAC manifest of one issuance. */
  issue(issuance: ManifestIssuance, release: AdmittedRelease, nonce: string): IssuedDelivery {
    const settings = this.config.settings;
    const bundle = this.bundleFor(issuance.tenantId);
    const rbac = this.rbac.forTenant(issuance.tenantId);
    const site = this.siteConfigs.forDevice({
      tenantId: issuance.tenantId,
      deviceId: issuance.deviceId,
      deviceCode: issuance.deviceCode,
      binding: issuance.binding,
      updateSeq: issuance.siteConfigSeq,
      window: issuance.window,
      provisioningToken: issuance.provisioningToken,
      rbac,
    });
    const board = boardRow(release.boardProfile);
    if (board === null) throw new ProvisioningRefusal('board-not-provisionable');
    const signer = new ManifestSigner(settings.keys.provisioning);
    const manifest = signer.sign(
      STATEMENT.edgeProvisioning,
      buildProvisioningManifest({
        tenantId: issuance.tenantId,
        deviceId: issuance.deviceId,
        deviceCode: issuance.deviceCode,
        binding: issuance.binding,
        nonce,
        keyEpoch: settings.keys.provisioning.epoch,
        updateSeq: issuance.manifestSeq,
        notBefore: contractTimestamp(issuance.window.notBefore),
        expiresAt: contractTimestamp(issuance.window.expiresAt),
        release: {
          digest: release.digest,
          version: release.version,
          securityVersion: release.securityVersion,
          boardProfile: board.boardProfile,
          arch: board.arch,
          artifactUrl: release.artifactUrl,
        },
        siteConfig: { digest: site.statement.digest, updateSeq: issuance.siteConfigSeq },
        trustAnchors: { digest: bundle.digest, bundleSeq: bundle.bundleSeq },
      }),
    );
    const body = serializeDelivery(
      buildDelivery({
        manifest: manifest.envelope,
        release: release.envelope,
        trustAnchors: bundle.envelope,
        siteConfig: site.statement.envelope,
        rbac: rbac.envelope,
        siteFiles: site.files,
      }),
    );
    return { body, manifest };
  }
}
