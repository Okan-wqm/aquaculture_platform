import { createHash } from 'crypto';

import commonSchema from '../../../../contracts/suderra-edge/v1/schemas/common.schema.json';

/**
 * The cloud's view of the Suderra edge contract v1 (ADR-048 DEC-25;
 * `contracts/suderra-edge/v1/`). The contract directory is the SSoT; this
 * module is the TypeScript shape of the statements the cloud PRODUCES and the
 * byte rules every producer must follow (statements.json `dsse`). It never
 * decides acceptance — the OS root installer and the agent do — and
 * `__tests__/contracts-golden.spec.ts` proves that what it produces verifies
 * against the contract's reference verifier and equals the golden fixtures
 * byte for byte where the inputs are deterministic.
 */

// ------------------------------------------------------------------ statements

export const STATEMENT = {
  edgeProvisioning: 'suderra.edge-provisioning.v1',
  activationReceipt: 'suderra.edge-activation-receipt.v1',
  siteConfig: 'suderra.site-config.v1',
  rbacManifest: 'suderra.rbac-manifest.v1',
  deviceLifecycle: 'suderra.device-lifecycle.v1',
  trustAnchors: 'suderra.trust-anchors.v1',
  edgeRelease: 'suderra.edge-release.v1',
  edgeUpdate: 'suderra.edge-update.v1',
  osUpdate: 'suderra.os-update.v1',
  siteNetpolicy: 'suderra.site-netpolicy.v1',
} as const;

export type StatementType = (typeof STATEMENT)[keyof typeof STATEMENT];

/** Purposes whose private keys the cloud holds (DEC-3.3, EDGE-HIGH-119). */
export type CloudSigningPurpose =
  | 'edge-provisioning'
  | 'config-integrity'
  | 'rbac-manifest'
  | 'device-lifecycle'
  | 'command';

/**
 * Statements each cloud-held purpose signs (statements.json `signing_purpose`).
 * A purpose maps to the statement types it may sign and nothing else, so
 * signing a site config with the provisioning key is a compile error
 * (`signStatement` below). `command` signs command envelopes, never a DSSE
 * statement. The golden spec asserts this table equals statements.json.
 */
export interface StatementsByPurpose {
  'edge-provisioning':
    | typeof STATEMENT.edgeProvisioning
    | typeof STATEMENT.activationReceipt
    | typeof STATEMENT.edgeUpdate
    | typeof STATEMENT.osUpdate;
  'config-integrity': typeof STATEMENT.siteConfig | typeof STATEMENT.siteNetpolicy;
  'rbac-manifest': typeof STATEMENT.rbacManifest;
  'device-lifecycle': typeof STATEMENT.deviceLifecycle;
  command: never;
}

export const CLOUD_SIGNED_STATEMENTS: {
  readonly [P in CloudSigningPurpose]: readonly StatementsByPurpose[P][];
} = {
  'edge-provisioning': [
    STATEMENT.edgeProvisioning,
    STATEMENT.activationReceipt,
    STATEMENT.edgeUpdate,
    STATEMENT.osUpdate,
  ],
  'config-integrity': [STATEMENT.siteConfig, STATEMENT.siteNetpolicy],
  'rbac-manifest': [STATEMENT.rbacManifest],
  'device-lifecycle': [STATEMENT.deviceLifecycle],
  command: [],
};

/** `application/vnd.suderra.<kind>.v1+json` (DEC-3.2). */
export function payloadTypeOf(type: StatementType): string {
  const kind = type.slice('suderra.'.length, type.length - '.v1'.length);
  return `application/vnd.suderra.${kind}.v1+json`;
}

// ---------------------------------------------------------------- identifiers

/**
 * The device code of the contract (`common.schema.json` `$defs.device_code`),
 * compiled from the schema itself: the controller, the generator and the DTOs
 * ask this one pattern, so the cloud cannot admit fewer codes than the contract
 * (SENSOR-LOW-238) or mint one that a device would refuse.
 */
export const DEVICE_CODE_PATTERN: RegExp = new RegExp(commonSchema.$defs.device_code.pattern);

/** True when `value` is a device code of the contract. */
export function isDeviceCode(value: string): boolean {
  return DEVICE_CODE_PATTERN.test(value);
}

// ------------------------------------------------------------------- JSON rules

/** A JSON value the contract admits: integers only (statements.json dsse.json). */
export type ContractJson =
  | string
  | number
  | boolean
  | null
  | readonly ContractJson[]
  | { readonly [key: string]: ContractJson };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** Rejects an unpaired UTF-16 surrogate (statements.json dsse.json). */
export function assertWellFormed(text: string, where: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      throw new ContractEncodingError(`${where} holds an unpaired UTF-16 surrogate`);
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ContractEncodingError(`${where} holds an unpaired UTF-16 surrogate`);
    }
  }
}

/** A value that cannot be encoded under the contract's JSON rules. */
export class ContractEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractEncodingError';
  }
}

function encode(value: ContractJson, where: string): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Math.abs(value) > MAX_SAFE) {
      throw new ContractEncodingError(
        `${where} is ${value}; the contract admits safe integers only`,
      );
    }
    return String(value);
  }
  if (typeof value === 'string') {
    assertWellFormed(value, where);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: readonly ContractJson[] = value;
    return `[${items.map((item, index) => encode(item, `${where}[${index}]`)).join(',')}]`;
  }
  const object = value as { readonly [key: string]: ContractJson };
  const members = Object.keys(object)
    .sort(compareCodePoints)
    .map((key) => {
      assertWellFormed(key, `${where} member name`);
      const member = object[key];
      if (member === undefined) {
        throw new ContractEncodingError(`${where}.${key} is undefined`);
      }
      return `${JSON.stringify(key)}:${encode(member, `${where}.${key}`)}`;
    });
  return `{${members.join(',')}}`;
}

/**
 * The exact payload bytes the cloud signs: UTF-8, members sorted by code
 * point, no insignificant whitespace — the form of the contract generator's
 * `canonical()`. Verifiers never re-canonicalize (they verify the bytes they
 * received), so this form matters only for reproducible statements and for
 * the golden fixtures matching byte for byte.
 */
export function canonicalJsonBytes(value: ContractJson): Buffer {
  return Buffer.from(encode(value, '$'), 'utf8');
}

/** Second-precision UTC with a literal Z (common.schema.json timestamp). */
export function contractTimestamp(instant: Date): string {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) {
    throw new ContractEncodingError('timestamp is not a valid instant');
  }
  if (ms % 1000 !== 0) {
    throw new ContractEncodingError(
      `timestamp ${instant.toISOString()} has a fractional second; the contract has second precision`,
    );
  }
  return instant.toISOString().replace('.000Z', 'Z');
}

/** Truncates an instant to its second, for windows computed from "now". */
export function wholeSecond(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / 1000) * 1000);
}

// ---------------------------------------------------------------------- shapes

export type Sha256Digest = { readonly sha256: string };

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** statements.json `statement_digest`: SHA-256 over the decoded payload bytes. */
export function statementDigest(payloadBytes: Buffer): Sha256Digest {
  return { sha256: sha256Hex(payloadBytes) };
}

export const BINDING_METHODS = [
  'tpm-ek-sha256',
  'bcm2711-serial-otp-sha256',
  'dmi-product-uuid-sha256',
] as const;
export type BindingMethod = (typeof BINDING_METHODS)[number];

export type DeviceBinding = {
  readonly method: BindingMethod;
  readonly digest: Sha256Digest;
};

export const BOARD_PROFILES = ['revpi-connect4', 'rpi4-cm4', 'qemu-x86_64'] as const;
export type BoardProfile = (typeof BOARD_PROFILES)[number];
export type Arch = 'aarch64' | 'x86_64';

export const SITE_PATHS = [
  'config.yaml',
  'io-config.yaml',
  'site-policy.json',
  'hardware-inventory.yaml',
  'revpi/config.rsc',
] as const;
export type SitePath = (typeof SITE_PATHS)[number];

export type EdgeProvisioningStatement = {
  readonly _type: typeof STATEMENT.edgeProvisioning;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly device_code: string;
  readonly device_binding: DeviceBinding;
  readonly nonce: string;
  readonly board: BoardProfile;
  readonly arch: Arch;
  readonly agent_profile: 'suderra-os';
  readonly version: string;
  readonly security_version: number;
  readonly key_epoch: number;
  readonly update_seq: number;
  readonly not_before: string;
  readonly expires_at: string;
  readonly release_statement: { readonly digest: Sha256Digest };
  readonly artifact_url: string;
  readonly site_config: { readonly digest: Sha256Digest; readonly update_seq: number };
  readonly trust_anchors: { readonly digest: Sha256Digest; readonly bundle_seq: number };
};

export type SiteFileRef = { readonly digest: Sha256Digest; readonly size_bytes: number };

export type SiteConfigStatement = {
  readonly _type: typeof STATEMENT.siteConfig;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly device_binding: DeviceBinding;
  readonly update_seq: number;
  readonly not_before: string;
  readonly expires_at: string;
  readonly files: { readonly [path: string]: SiteFileRef };
  /** Where root fetches the site bundle when the statement travels the update channel. */
  readonly site_bundle_url?: string;
  readonly rbac_manifest: { readonly digest: Sha256Digest; readonly policy_version: number };
};

/**
 * suderra.edge-update.v1 (DEC-2.4): device-bound, one release statement by
 * digest. contract 1.x has no `approvals` member, so none can be written.
 */
export type EdgeUpdateStatement = {
  readonly _type: typeof STATEMENT.edgeUpdate;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly device_binding: DeviceBinding;
  readonly board: BoardProfile;
  readonly arch: Arch;
  readonly agent_profile: 'suderra-os';
  readonly version: string;
  readonly security_version: number;
  readonly update_seq: number;
  readonly not_before: string;
  readonly expires_at: string;
  readonly release_statement: { readonly digest: Sha256Digest; readonly url: string };
  readonly artifact_url: string;
  /** Required: a statement without it is schema-invalid, never read as no approval. */
  readonly local_approval: boolean;
  /**
   * Present, and then always true, when an operator asked this update to ignore the
   * maintenance gate's blockers; the schema allows it only with `local_approval: true`
   * (channels.json update_channel.maintenance.blockers.override).
   */
  readonly blockers_override?: true;
  readonly max_outage_seconds: number;
};

/** suderra.os-update.v1 (DEC-2.9, DEC-23): one RAUC bundle by digest and size. */
export type OsUpdateStatement = {
  readonly _type: typeof STATEMENT.osUpdate;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly device_binding: DeviceBinding;
  readonly version: string;
  readonly compatible: string;
  readonly min_current_version: string;
  readonly rollback_floor: string;
  /** `MIN-MAX`, the agent ABI range of the new OS. */
  readonly supported_agent_abi: string;
  readonly update_seq: number;
  readonly not_before: string;
  readonly expires_at: string;
  readonly bundle: {
    readonly url: string;
    readonly digest: Sha256Digest;
    readonly size_bytes: number;
  };
  /** Required: a statement without it is schema-invalid, never read as no approval. */
  readonly local_approval: boolean;
  /** As on the edge-update: only together with `local_approval: true`. */
  readonly blockers_override?: true;
  readonly max_outage_seconds: number;
};

export type NetRole = 'wan' | 'ot';

/** An interface role: matched by MAC address or by PCI path, never both. */
export type InterfaceRole =
  | { readonly role: NetRole; readonly mac: string }
  | { readonly role: NetRole; readonly pci_path: string };

export type OtRule = {
  readonly id: string;
  readonly proto: 'tcp' | 'udp';
  /** CIDR with no host bits; a prefix shorter than /16 carries `wide: true`, a longer one never does. */
  readonly dst: string;
  readonly ports: readonly { readonly from: number; readonly to: number }[];
  readonly wide?: true;
};

/** A site NTP server: plain NTP only with the explicit unauthenticated mark (DEC-7.1). */
export type TimeSource =
  | { readonly id: string; readonly host: string; readonly nts: true }
  | {
      readonly id: string;
      readonly host: string;
      readonly nts: false;
      readonly unauthenticated: true;
    };

/** suderra.site-netpolicy.v1 (DEC-11.7): the site's OT allowlist, interface roles and NTP servers. */
export type SiteNetpolicyStatement = {
  readonly _type: typeof STATEMENT.siteNetpolicy;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly device_binding: DeviceBinding;
  readonly update_seq: number;
  readonly not_before: string;
  readonly expires_at: string;
  readonly interfaces: readonly InterfaceRole[];
  readonly ot_rules: readonly OtRule[];
  readonly time_sources: readonly TimeSource[];
};

/**
 * The permissions contract 1.x lets the platform actor hold: the agent's
 * Permission enum minus its two-person-integrity set (rbac-manifest.schema.json
 * `permission`; DEC-9.4). Firmware, deploy, force, safe-state, reboot, OPC UA
 * and S7 writes are not in this union, so no cloud-produced manifest can grant
 * them — they stay refused fail-closed on the device until P2 co-signing.
 */
export type PlatformPermission =
  | 'ReadTag'
  | 'ReadAuditLog'
  | 'FailoverControl'
  | 'ManagePolicy'
  | 'ManageIoConfig'
  | 'ManageCertPinning'
  | 'ManageLicense'
  | 'ManageUserTokenManifest'
  | 'WatchSubscribe'
  | 'DebugStep';

export type RbacManifestStatement = {
  readonly _type: typeof STATEMENT.rbacManifest;
  readonly tenant_id: string;
  readonly policy_version: number;
  readonly not_before: string;
  readonly expires_at: string;
  readonly actors: readonly [
    {
      readonly actor_id: string;
      readonly kind: 'platform';
      readonly keyid: string;
      readonly public_key: string;
      readonly roles: readonly ['platform-authenticated'];
    },
  ];
  readonly roles: readonly [
    {
      readonly name: 'platform-authenticated';
      readonly permissions: readonly PlatformPermission[];
      readonly not_before: string;
      readonly expires_at: string;
    },
  ];
};

export type DeviceLifecycleStatement = {
  readonly _type: typeof STATEMENT.deviceLifecycle;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly device_binding: DeviceBinding;
  /** P0 issues enter-maintenance for re-provisioning only (DEC-5.14, DEC-12). */
  readonly action: 'enter-maintenance';
  readonly purpose: 'reprovision';
  readonly update_seq: number;
  readonly not_before: string;
  readonly expires_at: string;
};

export type ActivationReceiptStatement = {
  readonly _type: typeof STATEMENT.activationReceipt;
  readonly tenant_id: string;
  readonly device_id: string;
  readonly device_binding: DeviceBinding;
  readonly manifest_digest: Sha256Digest;
  readonly activation_id: string;
  readonly activated_at: string;
  readonly not_before: string;
  readonly expires_at: string;
};

export interface StatementBodies {
  [STATEMENT.edgeProvisioning]: EdgeProvisioningStatement;
  [STATEMENT.activationReceipt]: ActivationReceiptStatement;
  [STATEMENT.siteConfig]: SiteConfigStatement;
  [STATEMENT.rbacManifest]: RbacManifestStatement;
  [STATEMENT.deviceLifecycle]: DeviceLifecycleStatement;
  [STATEMENT.edgeUpdate]: EdgeUpdateStatement;
  [STATEMENT.osUpdate]: OsUpdateStatement;
  [STATEMENT.siteNetpolicy]: SiteNetpolicyStatement;
}

// ------------------------------------------------------------------------- DSSE

export type DsseEnvelope = {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly [{ readonly keyid: string; readonly sig: string }];
};

/** DSSE v1 pre-authentication encoding (statements.json `dsse.pae`). */
export function pae(payloadType: string, body: Buffer): Buffer {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, 'utf8'),
    type,
    Buffer.from(` ${body.length} `, 'utf8'),
    body,
  ]);
}

/**
 * One signed statement as the cloud produced it: the envelope, the exact
 * signed payload bytes and their statement digest. Consumers that reference
 * a statement (manifest → site config → RBAC manifest) take the digest from
 * here, never from a re-serialization.
 */
export interface SignedStatement<T extends keyof StatementBodies = keyof StatementBodies> {
  readonly type: T;
  readonly body: StatementBodies[T];
  readonly payloadBytes: Buffer;
  readonly digest: Sha256Digest;
  readonly envelope: DsseEnvelope;
}
