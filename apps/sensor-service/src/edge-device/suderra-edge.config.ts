import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type DeviceBrokerEndpoint,
  deviceBrokerEndpoint,
  isDeviceBrokerHost,
} from './device-broker';
import { contractTimestamp, type DsseEnvelope } from './edge-contract';
import { Ed25519SigningKey, keyidOf, type VerificationKey } from './manifest-signer';

/**
 * The Suderra OS edge channel's configuration (ADR-048 DEC-3.9, DEC-5,
 * DEC-9.4, DEC-10): the cloud's signing keys, the fleet-root-signed
 * trust-anchors bundle it delivers, the platform actor, the RBAC policy, the
 * release it provisions and the device-facing broker.
 *
 * All or nothing. A deployment that sets none of these runs without the
 * Suderra OS channel: the manifest endpoint refuses every request with the
 * uniform refusal and no command is published to a Suderra OS device. A
 * deployment that sets some but not all — or sets one malformed — does not
 * boot, so a half-configured signer can never issue statements a device must
 * then refuse. Private keys are read once, here, from service secrets
 * (`<NAME>` or `<NAME>_FILE`, resolved by bootstrapSecrets); that they live
 * outside a KMS until P2 is the accepted risk EDGE-HIGH-119.
 */

export const SUDERRA_EDGE_SECRET_ENV = [
  'SUDERRA_EDGE_PROVISIONING_SIGNING_KEY',
  'SUDERRA_EDGE_CONFIG_INTEGRITY_SIGNING_KEY',
  'SUDERRA_EDGE_RBAC_MANIFEST_SIGNING_KEY',
  'SUDERRA_EDGE_DEVICE_LIFECYCLE_SIGNING_KEY',
  'SUDERRA_EDGE_COMMAND_SIGNING_KEY',
] as const;

const REQUIRED_ENV = [
  ...SUDERRA_EDGE_SECRET_ENV,
  'SUDERRA_EDGE_TRUST_ANCHORS',
  'SUDERRA_EDGE_FLEET_ROOT_KEYS',
  'SUDERRA_EDGE_PLATFORM_ACTOR_ID',
  'SUDERRA_EDGE_RBAC_POLICY_VERSION',
  'SUDERRA_EDGE_RBAC_NOT_BEFORE',
  'SUDERRA_EDGE_RBAC_EXPIRES_AT',
  'SUDERRA_EDGE_RELEASE_URL_TEMPLATE',
  'SUDERRA_EDGE_RELEASE_REPOSITORY',
  'SUDERRA_EDGE_AGENT_VERSION',
  'SUDERRA_EDGE_MQTT_HOST',
  'SUDERRA_EDGE_API_URL',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/;

export interface SuderraEdgeSettings {
  readonly keys: {
    readonly provisioning: Ed25519SigningKey<'edge-provisioning'>;
    readonly configIntegrity: Ed25519SigningKey<'config-integrity'>;
    readonly rbacManifest: Ed25519SigningKey<'rbac-manifest'>;
    readonly deviceLifecycle: Ed25519SigningKey<'device-lifecycle'>;
    readonly command: Ed25519SigningKey<'command'>;
  };
  /** The fleet-root-signed bundle, exactly as the ceremony produced it. */
  readonly trustAnchors: DsseEnvelope;
  readonly fleetRootKeys: readonly VerificationKey[];
  readonly platformActorId: string;
  readonly rbac: {
    readonly policyVersion: number;
    readonly notBefore: string;
    readonly expiresAt: string;
  };
  readonly release: {
    /** HTTPS URL with `{version}` and `{asset}` placeholders. */
    readonly urlTemplate: string;
    /**
     * `owner/repo` whose release workflow builds and states the releases the cloud
     * names: release admission refuses a release whose provenance says another
     * repository built it (DEC-3.8, DEC-20).
     */
    readonly repository: string;
    readonly agentVersion: string;
  };
  /**
   * The offline recovery-escrow keys whose envelopes the cloud accepts (DEC-14.3),
   * by the SHA-256 of the DER SubjectPublicKeyInfo of each public key, as an envelope's
   * `recipient_spki_sha256` names it. Empty until the key ceremony produced the
   * production key: the cloud then accepts no envelope, because an envelope encrypted to
   * a key nobody holds escrows nothing.
   */
  readonly recoveryEscrow: { readonly recipientSpkiSha256: readonly string[] };
  /** The broker a Suderra OS device connects to: 8883 TLS only (DEC-10.1). */
  readonly deviceBroker: DeviceBrokerEndpoint;
  /** The api_url the agent activates against (HTTPS). */
  readonly apiUrl: string;
  /** How long a manifest reservation and its statements stay valid. */
  readonly reservationTtlMs: number;
}

/** The channel is not configured, or the configuration is inconsistent. */
export class SuderraEdgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuderraEdgeConfigError';
  }
}

/** A Suderra OS operation was asked of a deployment without the channel. */
export class SuderraEdgeUnavailableError extends Error {
  constructor() {
    super('The Suderra OS edge channel is not configured on this deployment');
    this.name = 'SuderraEdgeUnavailableError';
  }
}

const TIMESTAMP =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

function parseTimestamp(name: string, value: string): string {
  const instant = new Date(value);
  if (
    !TIMESTAMP.test(value) ||
    Number.isNaN(instant.getTime()) ||
    contractTimestamp(instant) !== value
  ) {
    throw new SuderraEdgeConfigError(`${name} must be a UTC timestamp like 2026-10-20T12:00:00Z`);
  }
  return value;
}

function parseEnvelope(value: string): DsseEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_TRUST_ANCHORS is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_TRUST_ANCHORS is not a DSSE envelope');
  }
  const record = parsed as Record<string, unknown>;
  const signatures = record['signatures'];
  if (
    typeof record['payloadType'] !== 'string' ||
    typeof record['payload'] !== 'string' ||
    !Array.isArray(signatures) ||
    signatures.length !== 1 ||
    Object.keys(record).length !== 3
  ) {
    throw new SuderraEdgeConfigError(
      'SUDERRA_EDGE_TRUST_ANCHORS is not a single-signature DSSE envelope',
    );
  }
  const signature = signatures[0] as Record<string, unknown>;
  if (
    typeof signature['keyid'] !== 'string' ||
    typeof signature['sig'] !== 'string' ||
    Object.keys(signature).length !== 2
  ) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_TRUST_ANCHORS carries a malformed signature');
  }
  return {
    payloadType: record['payloadType'],
    payload: record['payload'],
    signatures: [{ keyid: signature['keyid'], sig: signature['sig'] }],
  };
}

/** `<epoch>:<base64 raw key>[,<epoch>:<base64 raw key>…]` */
function parseFleetRootKeys(value: string): VerificationKey[] {
  return value.split(',').map((entry) => {
    const [epochText, b64, ...rest] = entry.trim().split(':');
    const publicKey = Buffer.from(b64 ?? '', 'base64');
    if (
      rest.length > 0 ||
      !/^[1-9][0-9]{0,4}$/.test(epochText ?? '') ||
      publicKey.length !== 32 ||
      publicKey.toString('base64') !== b64
    ) {
      throw new SuderraEdgeConfigError(
        'SUDERRA_EDGE_FLEET_ROOT_KEYS must list <epoch>:<base64 32-byte Ed25519 key> entries',
      );
    }
    return {
      purpose: 'fleet-root',
      epoch: Number(epochText),
      keyid: keyidOf(publicKey),
      publicKey,
    };
  });
}

/** Reads and validates the channel's configuration from a key/value source. */
export function loadSuderraEdgeSettings(
  get: (name: string) => string | undefined,
): SuderraEdgeSettings | null {
  const present = REQUIRED_ENV.filter((name) => (get(name) ?? '').trim() !== '');
  if (present.length === 0) return null;
  if (present.length !== REQUIRED_ENV.length) {
    const missing = REQUIRED_ENV.filter((name) => !present.includes(name));
    throw new SuderraEdgeConfigError(
      `The Suderra OS edge channel is partially configured; missing: ${missing.join(', ')}`,
    );
  }
  const value = (name: (typeof REQUIRED_ENV)[number]): string => (get(name) ?? '').trim();

  const keys = {
    provisioning: Ed25519SigningKey.fromSecret(
      'edge-provisioning',
      value('SUDERRA_EDGE_PROVISIONING_SIGNING_KEY'),
    ),
    configIntegrity: Ed25519SigningKey.fromSecret(
      'config-integrity',
      value('SUDERRA_EDGE_CONFIG_INTEGRITY_SIGNING_KEY'),
    ),
    rbacManifest: Ed25519SigningKey.fromSecret(
      'rbac-manifest',
      value('SUDERRA_EDGE_RBAC_MANIFEST_SIGNING_KEY'),
    ),
    deviceLifecycle: Ed25519SigningKey.fromSecret(
      'device-lifecycle',
      value('SUDERRA_EDGE_DEVICE_LIFECYCLE_SIGNING_KEY'),
    ),
    command: Ed25519SigningKey.fromSecret('command', value('SUDERRA_EDGE_COMMAND_SIGNING_KEY')),
  };
  // DEC-3.3: one key per purpose. A shared key would let a statement of one
  // purpose verify as another wherever both are anchored.
  const keyids = Object.values(keys).map((k) => k.keyid);
  if (new Set(keyids).size !== keyids.length) {
    throw new SuderraEdgeConfigError('Two Suderra edge signing purposes share one key');
  }

  const platformActorId = value('SUDERRA_EDGE_PLATFORM_ACTOR_ID');
  if (!UUID.test(platformActorId)) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_PLATFORM_ACTOR_ID must be a lowercase UUID');
  }
  const policyText = value('SUDERRA_EDGE_RBAC_POLICY_VERSION');
  const policyVersion = Number(policyText);
  if (!/^[1-9][0-9]{0,15}$/.test(policyText) || !Number.isSafeInteger(policyVersion)) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_RBAC_POLICY_VERSION must be a positive integer');
  }
  const notBefore = parseTimestamp(
    'SUDERRA_EDGE_RBAC_NOT_BEFORE',
    value('SUDERRA_EDGE_RBAC_NOT_BEFORE'),
  );
  const expiresAt = parseTimestamp(
    'SUDERRA_EDGE_RBAC_EXPIRES_AT',
    value('SUDERRA_EDGE_RBAC_EXPIRES_AT'),
  );
  if (notBefore >= expiresAt) {
    throw new SuderraEdgeConfigError(
      'SUDERRA_EDGE_RBAC_NOT_BEFORE must precede SUDERRA_EDGE_RBAC_EXPIRES_AT',
    );
  }

  const urlTemplate = value('SUDERRA_EDGE_RELEASE_URL_TEMPLATE');
  if (
    !urlTemplate.includes('{version}') ||
    !urlTemplate.includes('{asset}') ||
    !HTTPS_URL.test(urlTemplate.replace('{version}', '1.0.0').replace('{asset}', 'a'))
  ) {
    throw new SuderraEdgeConfigError(
      'SUDERRA_EDGE_RELEASE_URL_TEMPLATE must be an https URL with {version} and {asset}',
    );
  }
  const repository = value('SUDERRA_EDGE_RELEASE_REPOSITORY');
  if (!GITHUB_REPOSITORY.test(repository)) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_RELEASE_REPOSITORY must be owner/repo');
  }
  const agentVersion = value('SUDERRA_EDGE_AGENT_VERSION');
  if (!SEMVER.test(agentVersion)) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_AGENT_VERSION must be a path-safe semver');
  }
  const mqttHost = value('SUDERRA_EDGE_MQTT_HOST');
  if (!isDeviceBrokerHost(mqttHost)) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_MQTT_HOST must be a DNS host name');
  }
  const apiUrl = value('SUDERRA_EDGE_API_URL');
  if (!HTTPS_URL.test(apiUrl) || apiUrl.endsWith('/')) {
    throw new SuderraEdgeConfigError(
      'SUDERRA_EDGE_API_URL must be an https URL without a trailing slash',
    );
  }
  const escrowRaw = (get('SUDERRA_EDGE_RECOVERY_ESCROW_SPKI_SHA256') ?? '').trim();
  const recipientSpkiSha256 =
    escrowRaw === '' ? [] : escrowRaw.split(',').map((entry) => entry.trim());
  if (
    recipientSpkiSha256.some((entry) => !/^[0-9a-f]{64}$/.test(entry)) ||
    new Set(recipientSpkiSha256).size !== recipientSpkiSha256.length
  ) {
    throw new SuderraEdgeConfigError(
      'SUDERRA_EDGE_RECOVERY_ESCROW_SPKI_SHA256 must be distinct lowercase sha256 hex digests, comma separated',
    );
  }
  const ttlRaw = (get('SUDERRA_EDGE_RESERVATION_TTL_MINUTES') ?? '').trim();
  const ttlText = ttlRaw === '' ? '30' : ttlRaw;
  if (!/^[1-9][0-9]{0,2}$/.test(ttlText) || Number(ttlText) > 240) {
    throw new SuderraEdgeConfigError('SUDERRA_EDGE_RESERVATION_TTL_MINUTES must be 1..240');
  }

  return {
    keys,
    trustAnchors: parseEnvelope(value('SUDERRA_EDGE_TRUST_ANCHORS')),
    fleetRootKeys: parseFleetRootKeys(value('SUDERRA_EDGE_FLEET_ROOT_KEYS')),
    platformActorId,
    rbac: { policyVersion, notBefore, expiresAt },
    release: { urlTemplate, repository, agentVersion },
    recoveryEscrow: { recipientSpkiSha256 },
    deviceBroker: deviceBrokerEndpoint(mqttHost, 'SUDERRA_EDGE_MQTT_HOST'),
    apiUrl,
    reservationTtlMs: Number(ttlText) * 60_000,
  };
}

@Injectable()
export class SuderraEdgeConfig {
  private readonly logger = new Logger(SuderraEdgeConfig.name);
  private readonly loaded: SuderraEdgeSettings | null;

  constructor(configService: ConfigService) {
    this.loaded = loadSuderraEdgeSettings((name) => configService.get<string>(name));
    if (this.loaded === null) {
      this.logger.warn(
        'Suderra OS edge channel not configured: Suderra OS provisioning and commands are refused',
      );
    } else {
      this.logger.log({
        event: 'suderra_edge_channel_configured',
        keyids: Object.fromEntries(
          Object.entries(this.loaded.keys).map(([name, key]) => [
            name,
            `${key.keyid}@${key.epoch}`,
          ]),
        ),
      });
    }
  }

  get enabled(): boolean {
    return this.loaded !== null;
  }

  /** The settings; throws when the channel is not configured. */
  get settings(): SuderraEdgeSettings {
    if (this.loaded === null) throw new SuderraEdgeUnavailableError();
    return this.loaded;
  }
}
