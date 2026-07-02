import { createPrivateKey, createPublicKey, verify } from 'crypto';

import {
  DeploySigningService,
  SigningSeedConfig,
  canonicalDeploySigBytes,
} from '../deploy-signing.service';

/**
 * Cross-language pinned vector — MUST match the Rust
 * `deploy_sig::tests::cross_language_pinned_vector` constants
 * byte-for-byte (sens-api-gateway/src/scripting/deploy_sig.rs).
 * Vector: seed = 0x01×32, kind = scada-package, tenant "tenant-42",
 * sha256 = 'a'×64. ed25519 is deterministic, so both stacks produce
 * the identical signature; an encoding drift on either side breaks
 * exactly one build.
 */
const PINNED_SEED_HEX = '01'.repeat(32);
const PINNED_TENANT = 'tenant-42';
const PINNED_SHA = 'a'.repeat(64);
const PINNED_CANONICAL_HEX =
  '534445500001' + // magic "SDEP" + wire version 1
  '0100000009' + // tenant presence + len 9
  '74656e616e742d3432' + // "tenant-42"
  '00000040' + // sha len 64
  Buffer.from(PINNED_SHA, 'utf8').toString('hex') +
  '73636164612d706b672d7631'; // domain tag "scada-pkg-v1"
const PINNED_SIGNATURE_HEX =
  'cf5e386d472b0d2af37a04093d670f75e96e46c548df9574c4dabb27ae605573' +
  'b0e0de262f62fbbe5f947136b4ce300478a8247b9c1cfa9737fac2a16d79be06';

function configWith(seedHex: string | undefined): SigningSeedConfig {
  return {
    get<T>(_key: string, defaultValue: T): T {
      return (seedHex ?? defaultValue) as T;
    },
  };
}

describe('DeploySigningService — cloud↔edge ed25519 contract', () => {
  it('canonical bytes match the Rust encoder byte-for-byte (pinned vector)', () => {
    const canonical = canonicalDeploySigBytes('scada-package', PINNED_TENANT, PINNED_SHA);
    expect(canonical.toString('hex')).toBe(PINNED_CANONICAL_HEX);
  });

  it('signature matches the Rust pinned vector (deterministic ed25519)', () => {
    const service = new DeploySigningService(configWith(PINNED_SEED_HEX));
    expect(service.isConfigured).toBe(true);
    const signature = service.signDeployArtifact('scada-package', PINNED_TENANT, PINNED_SHA);
    expect(signature).toBe(PINNED_SIGNATURE_HEX);
  });

  it('per-kind domain tags produce distinct signatures for identical content', () => {
    const service = new DeploySigningService(configWith(PINNED_SEED_HEX));
    const scada = service.signDeployArtifact('scada-package', PINNED_TENANT, PINNED_SHA);
    const process = service.signDeployArtifact('process', PINNED_TENANT, PINNED_SHA);
    const bundle = service.signDeployArtifact('bundle', PINNED_TENANT, PINNED_SHA);
    expect(scada).not.toBe(process);
    expect(scada).not.toBe(bundle);
    expect(process).not.toBe(bundle);
  });

  it('bundle canonical bytes end with the bundle-v1 domain tag (Rust parity)', () => {
    const canonical = canonicalDeploySigBytes('bundle', PINNED_TENANT, PINNED_SHA);
    const tag = Buffer.from('bundle-v1', 'ascii');
    expect(canonical.subarray(canonical.length - tag.length).equals(tag)).toBe(true);
  });

  it('signatures verify against the raw ed25519 public key derived from the seed', () => {
    const service = new DeploySigningService(configWith(PINNED_SEED_HEX));
    const signature = service.signDeployArtifact('process', PINNED_TENANT, PINNED_SHA);
    expect(signature).not.toBeNull();

    // Derive the public key the edge's signing_pubkey_hex encodes.
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(PINNED_SEED_HEX, 'hex'),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey(privateKey);
    const canonical = canonicalDeploySigBytes('process', PINNED_TENANT, PINNED_SHA);
    const valid = verify(
      null,
      canonical,
      publicKey,
      Buffer.from(signature as string, 'hex'),
    );
    expect(valid).toBe(true);
  });

  it('tenant binding participates in the transcript (different tenant → different signature)', () => {
    const service = new DeploySigningService(configWith(PINNED_SEED_HEX));
    const a = service.signDeployArtifact('scada-package', 'tenant-42', PINNED_SHA);
    const b = service.signDeployArtifact('scada-package', 'tenant-99', PINNED_SHA);
    expect(a).not.toBe(b);
  });

  it('null tenant encodes presence byte 0 + zero length (Rust Option::None parity)', () => {
    const canonical = canonicalDeploySigBytes('process', null, PINNED_SHA);
    // magic(4) + version(2) then presence 00 + len 00000000
    expect(canonical.subarray(6, 11).toString('hex')).toBe('0000000000');
  });

  it('rejects a malformed artifact sha256 before signing', () => {
    const service = new DeploySigningService(configWith(PINNED_SEED_HEX));
    expect(() =>
      service.signDeployArtifact('scada-package', PINNED_TENANT, 'A'.repeat(64)),
    ).toThrow('lowercase-hex sha256');
    expect(() =>
      service.signDeployArtifact('scada-package', PINNED_TENANT, 'abc'),
    ).toThrow('lowercase-hex sha256');
  });

  it('unset seed → unsigned mode (null signature), never a throw', () => {
    const service = new DeploySigningService(configWith(undefined));
    expect(service.isConfigured).toBe(false);
    expect(service.signDeployArtifact('scada-package', PINNED_TENANT, PINNED_SHA)).toBeNull();
  });

  it('present-but-malformed seed fails the boot instead of downgrading to unsigned', () => {
    expect(() => new DeploySigningService(configWith('not-hex'))).toThrow(
      'SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX',
    );
    expect(() => new DeploySigningService(configWith('01'.repeat(31)))).toThrow(
      'SENSOR_DEPLOY_SIGNING_KEY_SEED_HEX',
    );
  });
});
