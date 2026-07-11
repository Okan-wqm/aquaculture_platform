import { KeyObject, createPrivateKey, sign } from 'crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cloud-side ed25519 signer for deploy artifacts (enterprise plan Faz 4).
 *
 * Mirrors the edge verifier `sens-api-gateway/src/scripting/deploy_sig.rs`
 * byte-for-byte: the signature covers `MAGIC + wire version + tenant binding
 * + artifact sha256 hex + per-kind domain tag`. The edge verifies against the
 * SAME trust anchor it already uses for ST bytecode/source signatures
 * (`firmware_signing_pubkey`) — one anchor, four domain tags. The pinned
 * cross-language test vector in `__tests__/deploy-signing.service.spec.ts`
 * and the Rust `cross_language_pinned_vector` test share identical constants,
 * so an encoding drift on either side breaks exactly one build.
 *
 * Key material: `SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX` — the 32-byte ed25519
 * seed as 64 lowercase hex chars (the raw seed the edge fleet's
 * `signing_pubkey_hex` was derived from). Unset ⇒ deploys ship unsigned and
 * the edge logs an operator-visible warning (signature enforcement arrives
 * with the Faz 5 bundle gate — tracked plan phase); a MALFORMED seed fails
 * the boot instead of silently downgrading to unsigned.
 */

/**
 * Artifact kind under signature — selects the trailing domain tag.
 * `bundle` (Faz 5) signs a release-bundle manifest sha256; the manifest
 * pins each member artifact's content sha256, so one signature
 * transitively covers the whole bundle.
 */
export type DeploySignatureKind = 'scada-package' | 'process' | 'bundle';

/**
 * The one slice of ConfigService this signer consumes. Narrow structural
 * type so unit tests provide a plain object instead of casting through
 * the ConfigService class type.
 */
export interface SigningSeedConfig {
  get<T = string>(key: string, defaultValue: T): T;
}

const MAGIC = Buffer.from('SDEP', 'ascii');
const WIRE_VERSION_V1 = 1;

const DOMAIN_TAGS: Record<DeploySignatureKind, Buffer> = {
  'scada-package': Buffer.from('scada-pkg-v1', 'ascii'),
  process: Buffer.from('process-v1', 'ascii'),
  bundle: Buffer.from('bundle-v1', 'ascii'),
};

/**
 * PKCS8 DER wrapper for a raw ed25519 seed (RFC 8410): the fixed
 * `PrivateKeyInfo` prefix followed by the 32 seed bytes.
 */
const ED25519_PKCS8_SEED_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

const SEED_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Canonical byte transcript for a deploy-artifact signature. MUST stay
 * byte-identical to `deploy_sig::canonical_bytes` on the Rust side:
 *
 * ```text
 *   magic               "SDEP" (4 bytes)
 *   wire_version        u16 big-endian = 1
 *   tenant_id           u8 presence + u32 BE len + bytes (len=0 when null)
 *   artifact_sha256_hex u32 BE len + 64 lowercase-hex ASCII bytes
 *   domain_tag          "scada-pkg-v1" | "process-v1" (trailing, no length)
 * ```
 */
export function canonicalDeploySigBytes(
  kind: DeploySignatureKind,
  tenantId: string | null,
  artifactSha256Hex: string,
): Buffer {
  if (!SHA256_HEX_PATTERN.test(artifactSha256Hex)) {
    throw new Error(
      'deploy signature canonicalization requires a 64-char lowercase-hex sha256',
    );
  }

  const parts: Buffer[] = [MAGIC];

  const version = Buffer.alloc(2);
  version.writeUInt16BE(WIRE_VERSION_V1);
  parts.push(version);

  if (tenantId !== null) {
    parts.push(Buffer.from([1]));
    const tenantBytes = Buffer.from(tenantId, 'utf8');
    const tenantLen = Buffer.alloc(4);
    tenantLen.writeUInt32BE(tenantBytes.length);
    parts.push(tenantLen, tenantBytes);
  } else {
    // Presence byte + zero length — same unambiguous pair shape as the
    // Rust encoder emits for `tenant_id: None`.
    parts.push(Buffer.from([0]), Buffer.alloc(4));
  }

  const shaBytes = Buffer.from(artifactSha256Hex, 'utf8');
  const shaLen = Buffer.alloc(4);
  shaLen.writeUInt32BE(shaBytes.length);
  parts.push(shaLen, shaBytes);

  parts.push(DOMAIN_TAGS[kind]);

  return Buffer.concat(parts);
}

@Injectable()
export class DeploySigningService {
  private readonly logger = new Logger(DeploySigningService.name);
  private readonly signingKey: KeyObject | null;

  constructor(@Inject(ConfigService) configService: SigningSeedConfig) {
    const seedHex = configService.get<string>(
      'SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX',
      '',
    );
    if (!seedHex) {
      this.signingKey = null;
      this.logger.warn(
        'SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX not set — SCADA package / process deploys ship UNSIGNED (edge warns; enforcement arrives with the Faz 5 bundle gate)',
      );
      return;
    }
    if (!SEED_HEX_PATTERN.test(seedHex)) {
      // Fail the boot: a present-but-malformed key is an operator error,
      // and silently downgrading to unsigned would mask it in production.
      throw new Error(
        'SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX must be exactly 64 lowercase hex chars (32-byte ed25519 seed)',
      );
    }
    this.signingKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(seedHex, 'hex')]),
      format: 'der',
      type: 'pkcs8',
    });
    this.logger.log('Deploy artifact signing enabled (ed25519, domain tags scada-pkg-v1 / process-v1)');
  }

  get isConfigured(): boolean {
    return this.signingKey !== null;
  }

  /**
   * Sign `tenantId + artifactSha256Hex` under the per-kind domain tag.
   * Returns the 128-char lowercase-hex detached signature the edge's
   * `gate_deploy_signature` verifies, or null when signing is not
   * configured (unsigned deploy — edge warns).
   */
  signDeployArtifact(
    kind: DeploySignatureKind,
    tenantId: string,
    artifactSha256Hex: string,
  ): string | null {
    if (!this.signingKey) return null;
    const canonical = canonicalDeploySigBytes(kind, tenantId, artifactSha256Hex);
    return sign(null, canonical, this.signingKey).toString('hex');
  }
}
