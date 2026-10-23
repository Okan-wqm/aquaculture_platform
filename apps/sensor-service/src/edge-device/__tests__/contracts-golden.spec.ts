/**
 * The cloud's statement producers against the Suderra edge contract v1
 * (ADR-048 DEC-25; contracts/suderra-edge/v1/).
 *
 * Two properties, for every statement the cloud signs (provisioning
 * manifest, activation receipt, site config, RBAC manifest, device-lifecycle)
 * and for the provisioning delivery:
 *
 *   1. Golden: given the inputs a golden fixture was generated from — and the
 *      fixtures' TEST-ONLY keys, derived here from keyring.json at run time —
 *      the producer emits that fixture's envelope: the same payload bytes,
 *      keyid and signature, so the same statement digest.
 *   2. Verifies: what the cloud's services issue at run time (fresh nonces,
 *      windows, sequences, a rendered config.yaml) passes the contract's
 *      reference verifier for the device state the contract fixtures model.
 *
 * The reference verifier is the one the contract's own invariant runs
 * (tests/invariants/lib/suderra-edge-contract.ts), so this test and the
 * contract cannot disagree about what a device accepts.
 */
import { createHash, createPublicKey, verify } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ConfigService } from '@nestjs/config';

import {
  asObject,
  asString,
  contextOf,
  type Json,
  FIXTURES,
  type JsonObject,
  keyringFile,
  objects,
  readJson,
  ST_LIFE,
  ST_RBAC,
  ST_RECEIPT,
  STATEMENTS,
  verifyDeliveryDocument,
  verifyStatement,
} from '../../../../../tests/invariants/lib/suderra-edge-contract';
import { ActivationReceiptService, buildActivationReceipt } from '../activation-receipt.service';
import {
  CommandEnvelopeSignerService,
  envelopeCanonicalBytes,
} from '../command-envelope-signer.service';
import {
  buildEnterMaintenance,
  DeviceLifecycleStatementService,
} from '../device-lifecycle-statement.service';
import { type BoardRow, boardRow } from '../edge-boards';
import {
  BINDING_METHODS,
  canonicalJsonBytes,
  CLOUD_SIGNED_STATEMENTS,
  type CloudSigningPurpose,
  type ContractJson,
  type DeviceBinding,
  type DsseEnvelope,
  payloadTypeOf,
  type SitePath,
  STATEMENT,
  statementDigest,
} from '../edge-contract';
import {
  buildDelivery,
  buildProvisioningManifest,
  EdgeProvisioningManifestService,
  parseProvisioningRequest,
  type ProvisioningRequest,
  ProvisioningRefusal,
  serializeDelivery,
} from '../edge-provisioning-manifest.service';
import {
  EdgeReleaseCatalog,
  type ReleaseProvenanceVerifier,
} from '../edge-release-catalog.service';
import { DeviceModel, suderraOsBoardOf } from '../entities/edge-device.entity';
import { Ed25519SigningKey, ManifestSigner, StatementAdmissionError } from '../manifest-signer';
import {
  buildRbacManifest,
  PLATFORM_ROLE_PERMISSIONS,
  RbacManifestService,
} from '../rbac-manifest.service';
import {
  assertMonitoringOnlySite,
  buildSiteConfig,
  SG1_FIELD_WRITES_OPEN,
  SiteConfigManifestService,
  SiteGateClosedError,
} from '../site-config-manifest.service';
import {
  loadSuderraEdgeSettings,
  SuderraEdgeConfig,
  SuderraEdgeConfigError,
} from '../suderra-edge.config';
import {
  TenantOutOfBundleScopeError,
  TrustAnchorBundleService,
} from '../trust-anchor-bundle.service';

// ------------------------------------------------------------------ fixtures

const REL_160 = 'edge-release/valid/revpi-connect4-aarch64-1.6.0.dsse.json';
const TA1 = 'trust-anchors/valid/bundle-seq-1.dsse.json';
const RBAC1 = 'rbac-manifest/valid/platform-actor-policy-1.dsse.json';
const SITE_FIRST = 'site-config/valid/revpi-connect4-first.dsse.json';
const PROV_FIRST = 'edge-provisioning/valid/revpi-connect4-first.dsse.json';
const RECEIPT = 'edge-activation-receipt/valid/revpi-connect4.dsse.json';
const LIFE = 'device-lifecycle/valid/enter-maintenance-reprovision.dsse.json';
const DELIVERY_FIRST = 'edge-provisioning-delivery/valid/revpi-connect4-first.json';
const REQUEST_FIRST = 'edge-provisioning-request/valid/revpi-connect4-first.json';
const RELEASE_URL_TEMPLATE = 'https://edge-releases.example.com/agent/{version}/{asset}';

const fixtureText = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');
const fixtureBytes = (rel: string): Buffer => readFileSync(join(FIXTURES, rel));
const envelopeOf = (rel: string): DsseEnvelope => JSON.parse(fixtureText(rel)) as DsseEnvelope;
const payloadOf = (rel: string): Buffer => Buffer.from(envelopeOf(rel).payload, 'base64');
const bodyOf = (rel: string): JsonObject =>
  JSON.parse(payloadOf(rel).toString('utf8')) as JsonObject;
const field = (body: JsonObject, name: string): string => asString(body[name], name);
const intField = (body: JsonObject, name: string): number => {
  const value = body[name];
  if (typeof value !== 'number') throw new Error(`${name} is not a number`);
  return value;
};
function parseBinding(value: Json | undefined): DeviceBinding {
  const binding = asObject(value, 'device_binding');
  const method = asString(binding['method'], 'method');
  const known = BINDING_METHODS.find((m) => m === method);
  if (known === undefined) throw new Error(`unknown binding method ${method}`);
  return {
    method: known,
    digest: { sha256: asString(asObject(binding['digest'], 'digest')['sha256'], 'sha256') },
  };
}
const bindingOf = (body: JsonObject): DeviceBinding => parseBinding(body['device_binding']);

interface TestKeys {
  readonly provisioning: Ed25519SigningKey<'edge-provisioning'>;
  readonly configIntegrity: Ed25519SigningKey<'config-integrity'>;
  readonly rbacManifest: Ed25519SigningKey<'rbac-manifest'>;
  readonly deviceLifecycle: Ed25519SigningKey<'device-lifecycle'>;
  readonly command: Ed25519SigningKey<'command'>;
}

/** TEST-ONLY seed of a keyring entry: SHA-256 of its public seed label. */
function seedOf(purpose: string, epoch: number): Buffer {
  const entry = objects(keyringFile['keys'], 'keys').find(
    (key) => key['purpose'] === purpose && key['epoch'] === epoch,
  );
  if (entry === undefined) throw new Error(`keyring has no ${purpose} epoch ${epoch}`);
  return createHash('sha256').update(asString(entry['seed_label'], 'seed_label'), 'utf8').digest();
}

function testKey<P extends CloudSigningPurpose>(purpose: P): Ed25519SigningKey<P> {
  return Ed25519SigningKey.fromSeed(purpose, 1, seedOf(purpose, 1));
}

const KEYS: TestKeys = {
  provisioning: testKey('edge-provisioning'),
  configIntegrity: testKey('config-integrity'),
  rbacManifest: testKey('rbac-manifest'),
  deviceLifecycle: testKey('device-lifecycle'),
  command: testKey('command'),
};

function fleetRootEnv(): string {
  const entry = objects(keyringFile['keys'], 'keys').find((k) => k['purpose'] === 'fleet-root');
  if (entry === undefined) throw new Error('keyring has no fleet-root key');
  return `${String(entry['epoch'])}:${asString(entry['public_key'], 'public_key')}`;
}

const secret = (key: Ed25519SigningKey): string =>
  `ed25519:${key.epoch}:${seedOf(key.purpose, key.epoch).toString('hex')}`;

/**
 * The contract's release fixtures name a provenance digest no document can match, so
 * the golden tests of statements and manifests admit them with a verifier that accepts
 * the fixture's provenance. What the real verifier checks, and that the catalog asks it,
 * is proven against the release pipeline's own output in edge-release-provenance.spec.ts.
 */
const FIXTURE_PROVENANCE: ReleaseProvenanceVerifier = (_bytes, expected) => ({
  digestSha256: expected.digestSha256,
  repository: expected.repository,
  workflowRef: 'fixture',
  tag: `agent-v${expected.version}`,
  commit: '0'.repeat(40),
});

/** Serves the release fixture for its statement URL and a stand-in for its provenance. */
const servingFixture =
  (statement: string, onlyUrl?: string) =>
  async (url: string): Promise<string> => {
    if (url.endsWith('.intoto.jsonl')) return 'provenance fixture\n';
    if (onlyUrl !== undefined && url !== onlyUrl) throw new Error(`unexpected release URL ${url}`);
    return statement;
  };

/** A full channel configuration over the fixtures' TEST-ONLY keys and bundle 1. */
function channelEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const rbac = bodyOf(RBAC1);
  return {
    SUDERRA_EDGE_PROVISIONING_SIGNING_KEY: secret(KEYS.provisioning),
    SUDERRA_EDGE_CONFIG_INTEGRITY_SIGNING_KEY: secret(KEYS.configIntegrity),
    SUDERRA_EDGE_RBAC_MANIFEST_SIGNING_KEY: secret(KEYS.rbacManifest),
    SUDERRA_EDGE_DEVICE_LIFECYCLE_SIGNING_KEY: secret(KEYS.deviceLifecycle),
    SUDERRA_EDGE_COMMAND_SIGNING_KEY: secret(KEYS.command),
    SUDERRA_EDGE_TRUST_ANCHORS: fixtureText(TA1),
    SUDERRA_EDGE_FLEET_ROOT_KEYS: fleetRootEnv(),
    SUDERRA_EDGE_PLATFORM_ACTOR_ID: field(
      asObject((rbac['actors'] as JsonObject[])[0], 'actor'),
      'actor_id',
    ),
    SUDERRA_EDGE_RBAC_POLICY_VERSION: String(intField(rbac, 'policy_version')),
    SUDERRA_EDGE_RBAC_NOT_BEFORE: field(rbac, 'not_before'),
    SUDERRA_EDGE_RBAC_EXPIRES_AT: field(rbac, 'expires_at'),
    SUDERRA_EDGE_RELEASE_URL_TEMPLATE: RELEASE_URL_TEMPLATE,
    SUDERRA_EDGE_RELEASE_REPOSITORY: 'example-org/aquaculture',
    SUDERRA_EDGE_AGENT_VERSION: field(bodyOf(REL_160), 'version'),
    SUDERRA_EDGE_MQTT_HOST: 'mqtt-devices.example.com',
    SUDERRA_EDGE_API_URL: 'https://api.example.com',
    ...overrides,
  };
}

function services(env: Record<string, string> = channelEnv()): {
  config: SuderraEdgeConfig;
  bundles: TrustAnchorBundleService;
  catalog: EdgeReleaseCatalog;
  rbac: RbacManifestService;
  manifests: EdgeProvisioningManifestService;
} {
  const config = new SuderraEdgeConfig(new ConfigService(env));
  const bundles = new TrustAnchorBundleService(config);
  const expectedUrl = RELEASE_URL_TEMPLATE.replace('{version}', '1.6.0').replace(
    '{asset}',
    'suderra-agent-os-1.6.0-revpi-connect4-aarch64.tar.gz.release.dsse.json',
  );
  const catalog = new EdgeReleaseCatalog(
    config,
    bundles,
    servingFixture(fixtureText(REL_160), expectedUrl),
    FIXTURE_PROVENANCE,
  );
  const rbac = new RbacManifestService(config);
  const sites = new SiteConfigManifestService(config);
  const manifests = new EdgeProvisioningManifestService(config, catalog, bundles, rbac, sites);
  return { config, bundles, catalog, rbac, manifests };
}

/** The golden RBAC manifest, produced from its inputs (asserted equal to RBAC1 below). */
function goldenRbac(): ReturnType<ManifestSigner<'rbac-manifest'>['sign']> {
  const body = bodyOf(RBAC1);
  const actor = asObject((body['actors'] as JsonObject[])[0], 'actor');
  return new ManifestSigner(KEYS.rbacManifest).sign(
    STATEMENT.rbacManifest,
    buildRbacManifest({
      tenantId: field(body, 'tenant_id'),
      policyVersion: intField(body, 'policy_version'),
      notBefore: field(body, 'not_before'),
      expiresAt: field(body, 'expires_at'),
      actorId: field(actor, 'actor_id'),
      actorKeyid: KEYS.command.keyid,
      actorPublicKey: KEYS.command.publicKey,
      permissions: PLATFORM_ROLE_PERMISSIONS,
    }),
  );
}

// ------------------------------------------------------------- vocabulary

describe('contracts golden — the cloud speaks the contract vocabulary', () => {
  it('each cloud-held purpose signs exactly the statements statements.json assigns it', () => {
    const fromContract: Record<string, string[]> = {};
    for (const [type, spec] of Object.entries(STATEMENTS)) {
      const purpose = asString(asObject(spec, type)['signing_purpose'], 'signing_purpose');
      (fromContract[purpose] ??= []).push(type);
    }
    for (const [purpose, types] of Object.entries(CLOUD_SIGNED_STATEMENTS)) {
      expect({ purpose, types: [...types].sort() }).toEqual({
        purpose,
        types: (fromContract[purpose] ?? []).sort(),
      });
    }
  });

  it('payload types are the contract payload types', () => {
    for (const type of Object.values(STATEMENT)) {
      expect(payloadTypeOf(type)).toBe(
        asString(asObject(STATEMENTS[type], type)['payload_type'], 'pt'),
      );
    }
  });

  it('the canonical encoder reproduces every canonical fixture payload byte for byte', () => {
    for (const rel of [REL_160, TA1, RBAC1, SITE_FIRST, PROV_FIRST, RECEIPT, LIFE]) {
      const payload = payloadOf(rel);
      expect(
        canonicalJsonBytes(JSON.parse(payload.toString('utf8')) as ContractJson).equals(payload),
      ).toBe(true);
    }
  });

  it('the encoder refuses what the contract refuses: fractions, unsafe integers, lone surrogates', () => {
    expect(() => canonicalJsonBytes({ a: 1.5 })).toThrow(/safe integers/);
    expect(() => canonicalJsonBytes({ a: 2 ** 53 })).toThrow(/safe integers/);
    expect(() => canonicalJsonBytes({ a: '\ud800' })).toThrow(/surrogate/);
    expect(canonicalJsonBytes({ b: '😀', a: [] }).toString('utf8')).toBe('{"a":[],"b":"😀"}');
  });

  it('the board rows the cloud provisions come from boards.json; only open gates provision', () => {
    expect(boardRow('revpi-connect4')).toMatchObject({
      arch: 'aarch64',
      cloudProvisioningAllowed: true,
    });
    expect(boardRow('rpi4-cm4')?.cloudProvisioningAllowed).toBe(false);
    expect(boardRow('x86-ipc-anything')).toBeNull();
  });
});

// ------------------------------------------------------------------ golden

describe('contracts golden — byte-for-byte producers', () => {
  it('RBAC manifest: the platform actor, the command key and the P0 permission set', () => {
    expect(goldenRbac().envelope).toEqual(envelopeOf(RBAC1));
  });

  it('site config: device-bound, every site file by digest and size, the RBAC manifest by digest', () => {
    const body = bodyOf(SITE_FIRST);
    const files = new Map<SitePath, Buffer>([
      ['config.yaml', fixtureBytes('site-files/v1/config.yaml')],
      ['revpi/config.rsc', fixtureBytes('site-files/v1/revpi/config.rsc')],
    ]);
    const rbac = goldenRbac();
    const signed = new ManifestSigner(KEYS.configIntegrity).sign(
      STATEMENT.siteConfig,
      buildSiteConfig({
        tenantId: field(body, 'tenant_id'),
        deviceId: field(body, 'device_id'),
        binding: bindingOf(body),
        updateSeq: intField(body, 'update_seq'),
        notBefore: field(body, 'not_before'),
        expiresAt: field(body, 'expires_at'),
        files,
        rbac,
      }),
    );
    expect(signed.envelope).toEqual(envelopeOf(SITE_FIRST));
  });

  it('provisioning manifest: release, bundle and site config by statement digest', () => {
    const body = bodyOf(PROV_FIRST);
    const release = bodyOf(REL_160);
    const signed = new ManifestSigner(KEYS.provisioning).sign(
      STATEMENT.edgeProvisioning,
      buildProvisioningManifest({
        tenantId: field(body, 'tenant_id'),
        deviceId: field(body, 'device_id'),
        deviceCode: field(body, 'device_code'),
        binding: bindingOf(body),
        nonce: field(body, 'nonce'),
        keyEpoch: KEYS.provisioning.epoch,
        updateSeq: intField(body, 'update_seq'),
        notBefore: field(body, 'not_before'),
        expiresAt: field(body, 'expires_at'),
        release: {
          digest: statementDigest(payloadOf(REL_160)),
          version: field(release, 'version'),
          securityVersion: intField(release, 'security_version'),
          boardProfile: 'revpi-connect4',
          arch: 'aarch64',
          artifactUrl: field(body, 'artifact_url'),
        },
        siteConfig: {
          digest: statementDigest(payloadOf(SITE_FIRST)),
          updateSeq: intField(bodyOf(SITE_FIRST), 'update_seq'),
        },
        trustAnchors: {
          digest: statementDigest(payloadOf(TA1)),
          bundleSeq: intField(bodyOf(TA1), 'bundle_seq'),
        },
      }),
    );
    expect(signed.envelope).toEqual(envelopeOf(PROV_FIRST));
  });

  it('activation receipt: names the installed manifest by statement digest', () => {
    const body = bodyOf(RECEIPT);
    const signed = new ManifestSigner(KEYS.provisioning).sign(
      STATEMENT.activationReceipt,
      buildActivationReceipt({
        tenantId: field(body, 'tenant_id'),
        deviceId: field(body, 'device_id'),
        binding: bindingOf(body),
        manifestDigest: statementDigest(payloadOf(PROV_FIRST)),
        activationId: field(body, 'activation_id'),
        activatedAt: field(body, 'activated_at'),
        notBefore: field(body, 'not_before'),
        expiresAt: field(body, 'expires_at'),
      }),
    );
    expect(signed.envelope).toEqual(envelopeOf(RECEIPT));
  });

  it('device-lifecycle: enter-maintenance to re-provision', () => {
    const body = bodyOf(LIFE);
    const signed = new ManifestSigner(KEYS.deviceLifecycle).sign(
      STATEMENT.deviceLifecycle,
      buildEnterMaintenance({
        tenantId: field(body, 'tenant_id'),
        deviceId: field(body, 'device_id'),
        binding: bindingOf(body),
        updateSeq: intField(body, 'update_seq'),
        notBefore: field(body, 'not_before'),
        expiresAt: field(body, 'expires_at'),
      }),
    );
    expect(signed.envelope).toEqual(envelopeOf(LIFE));
  });

  it('delivery: the response body is the golden delivery document, member for member', () => {
    const delivery = buildDelivery({
      manifest: envelopeOf(PROV_FIRST),
      release: envelopeOf(REL_160),
      trustAnchors: envelopeOf(TA1),
      siteConfig: envelopeOf(SITE_FIRST),
      rbac: envelopeOf(RBAC1),
      siteFiles: new Map<SitePath, Buffer>([
        ['revpi/config.rsc', fixtureBytes('site-files/v1/revpi/config.rsc')],
        ['config.yaml', fixtureBytes('site-files/v1/config.yaml')],
      ]),
    });
    expect(JSON.parse(serializeDelivery(delivery))).toEqual(
      JSON.parse(fixtureText(DELIVERY_FIRST)),
    );
  });

  it('request: an os_version or agent_abi component of ten digits is refused, nine are read', () => {
    const request = readJson(join(FIXTURES, REQUEST_FIRST));
    for (const [member, value] of [
      ['os_version', '1000000000.0.0'],
      ['os_version', '1.1000000000.0'],
      ['os_version', '1.0.1000000000'],
      ['agent_abi', '1000000000-1'],
      ['agent_abi', '1-1000000000'],
    ] as const) {
      expect(parseProvisioningRequest({ ...request, [member]: value })).toBeNull();
    }
    expect(
      parseProvisioningRequest({
        ...request,
        os_version: '999999999.999999999.999999999',
        agent_abi: '999999999-999999999',
      }),
    ).not.toBeNull();
  });

  it('request: the golden request parses; a token in the query and a short nonce do not', () => {
    const request = readJson(join(FIXTURES, REQUEST_FIRST));
    expect(parseProvisioningRequest(request)).toMatchObject({ nonce: request['nonce'] });
    for (const rel of [
      'edge-provisioning-request/invalid/token-in-query.json',
      'edge-provisioning-request/invalid/short-nonce.json',
    ]) {
      expect(parseProvisioningRequest(readJson(join(FIXTURES, rel)))).toBeNull();
    }
  });
});

// ------------------------------------------------------- run-time issuance

describe('contracts golden — what the services issue verifies on the device', () => {
  const factory = contextOf('revpi-factory');
  const provisioning = contextOf('revpi-provisioning');
  const active = contextOf('revpi-active');
  if (factory === null || provisioning === null || active === null) throw new Error('contexts');
  const binding = parseBinding(factory['device_binding']);
  const tenantId = field(bodyOf(PROV_FIRST), 'tenant_id');
  const deviceId = field(bodyOf(PROV_FIRST), 'device_id');
  const revpiDevice = { tenantId, deviceModel: DeviceModel.REVOLUTION_PI_CONNECT_4 };
  const window = {
    notBefore: new Date('2026-10-20T11:00:00Z'),
    expiresAt: new Date('2026-10-20T13:00:00Z'),
  };
  const verifyAs = (
    envelope: DsseEnvelope,
    type: string,
    ctx: JsonObject,
    verifier: 'os-root' | 'agent',
    inputs: { trustAnchors?: Buffer } = {},
  ): string[] =>
    verifyStatement(Buffer.from(JSON.stringify(envelope), 'utf8'), type, ctx, inputs, {
      mode: 'accept',
      verifier,
      allChecks: true,
    }).reasons;

  it('a fresh provisioning delivery verifies end to end for a factory-fresh device', async () => {
    const { manifests } = services();
    const request = parseProvisioningRequest(readJson(join(FIXTURES, REQUEST_FIRST)));
    if (request === null) throw new Error('request');
    const nonce = 'f0'.repeat(24);
    const release = await manifests.preflight({ ...request, nonce }, revpiDevice);
    const issued = manifests.issue(
      {
        tenantId,
        deviceId,
        deviceCode: 'RPI-7E57C0DE',
        binding,
        provisioningToken: 'ab'.repeat(32),
        manifestSeq: 2,
        siteConfigSeq: 3,
        window,
      },
      release,
      nonce,
    );
    const document = JSON.parse(issued.body) as JsonObject;
    expect(verifyDeliveryDocument(document, nonce, factory, true)).toEqual([]);
    expect(verifyDeliveryDocument(document, 'f1'.repeat(24), factory, true)).toEqual([
      'nonce-mismatch',
    ]);
    const files = asObject(document['site_files'], 'site_files');
    const tampered = {
      ...document,
      site_files: { ...files, 'config.yaml': Buffer.from('device_id: other\n').toString('base64') },
    };
    expect(verifyDeliveryDocument(tampered, nonce, factory, true)).toEqual([
      'site-file-digest-mismatch',
    ]);
    const yaml = Buffer.from(asString(files['config.yaml'], 'config.yaml'), 'base64').toString(
      'utf8',
    );
    // The whole document: the agent's identity, endpoints and the token it
    // presents once; the broker is the 8883 TLS endpoint and nothing else.
    expect(yaml).toBe(
      [
        '# Suderra edge agent configuration, delivered in a signed site config (ADR-048 DEC-4.12).',
        `device_id: "${deviceId}"`,
        'device_code: "RPI-7E57C0DE"',
        `tenant_id: "${tenantId}"`,
        'api_url: "https://api.example.com"',
        `provisioning_token: "${'ab'.repeat(32)}"`,
        'mqtt:',
        '  broker: "mqtt-devices.example.com"',
        '  port: 8883',
        '  tls:',
        '    enabled: true',
        '    verify_hostname: true',
        '',
      ].join('\n'),
    );
  });

  it('a manifest for another device binding is refused by the device', async () => {
    const { manifests } = services();
    const request = parseProvisioningRequest(readJson(join(FIXTURES, REQUEST_FIRST)));
    if (request === null) throw new Error('request');
    const nonce = 'f2'.repeat(24);
    const release = await manifests.preflight(request, revpiDevice);
    const issued = manifests.issue(
      {
        tenantId,
        deviceId,
        deviceCode: 'RPI-7E57C0DE',
        binding: { method: 'tpm-ek-sha256', digest: { sha256: '00'.repeat(32) } },
        provisioningToken: 'ab'.repeat(32),
        manifestSeq: 2,
        siteConfigSeq: 3,
        window,
      },
      release,
      nonce,
    );
    expect(
      verifyDeliveryDocument(JSON.parse(issued.body) as JsonObject, nonce, factory, false),
    ).toEqual(['device-binding-mismatch']);
  });

  it('the RBAC manifest the service issues re-presents the installed one (identical-only gate)', () => {
    const { rbac } = services();
    const signed = rbac.forTenant(tenantId);
    expect(signed.envelope).toEqual(envelopeOf(RBAC1));
    for (const verifier of ['os-root', 'agent'] as const) {
      expect(
        verifyAs(signed.envelope, ST_RBAC, active, verifier, { trustAnchors: fixtureBytes(TA1) }),
      ).toEqual([]);
    }
  });

  it('the activation receipt the service issues is accepted by root and by the agent', () => {
    const config = new SuderraEdgeConfig(new ConfigService(channelEnv()));
    const activatedAt = new Date('2026-10-20T11:45:00Z');
    const receipt = new ActivationReceiptService(config).issue(
      {
        tenantId,
        deviceId,
        binding,
        manifestDigest: statementDigest(payloadOf(PROV_FIRST)),
        activationId: '7e570000-0000-4000-8000-0000000000a2',
        activatedAt,
      },
      activatedAt,
    );
    expect(receipt.envelope).toBe(JSON.stringify(receipt.statement.envelope));
    expect(receipt.expiresAt).toEqual(new Date('2026-10-21T11:45:00Z'));
    expect(verifyAs(receipt.statement.envelope, ST_RECEIPT, provisioning, 'os-root')).toEqual([]);
    expect(
      verifyAs(receipt.statement.envelope, ST_RECEIPT, provisioning, 'agent', {
        trustAnchors: fixtureBytes(TA1),
      }),
    ).toEqual([]);
    const other = new ActivationReceiptService(config).issue(
      {
        tenantId,
        deviceId,
        binding,
        manifestDigest: statementDigest(payloadOf(REL_160)),
        activationId: '7e570000-0000-4000-8000-0000000000a3',
        activatedAt,
      },
      activatedAt,
    );
    expect(verifyAs(other.statement.envelope, ST_RECEIPT, provisioning, 'os-root')).toEqual([
      'manifest-digest-mismatch',
    ]);
  });

  it('a receipt signed long ago is expired on root; re-signed it states the same activation and is accepted', () => {
    const config = new SuderraEdgeConfig(new ConfigService(channelEnv()));
    const activation = {
      tenantId,
      deviceId,
      binding,
      manifestDigest: statementDigest(payloadOf(PROV_FIRST)),
      activationId: '7e570000-0000-4000-8000-0000000000a4',
      // 30 hours before the fixtures' evaluation instant.
      activatedAt: new Date('2026-10-19T06:00:00Z'),
    };
    const receipts = new ActivationReceiptService(config);
    const first = receipts.issue(activation, activation.activatedAt);
    expect(verifyAs(first.statement.envelope, ST_RECEIPT, provisioning, 'os-root')).toEqual([
      'expired',
    ]);
    const resigned = receipts.issue(activation, new Date('2026-10-20T11:30:00Z'));
    expect(verifyAs(resigned.statement.envelope, ST_RECEIPT, provisioning, 'os-root')).toEqual([]);
    const { not_before: firstFrom, expires_at: firstUntil, ...firstRest } = first.statement.body;
    const { not_before: from, expires_at: until, ...rest } = resigned.statement.body;
    expect(rest).toEqual(firstRest);
    expect([from, firstFrom]).toEqual(['2026-10-19T06:00:00Z', '2026-10-19T06:00:00Z']);
    expect([firstUntil, until]).toEqual(['2026-10-20T06:00:00Z', '2026-10-21T11:30:00Z']);
  });

  it('a platform command the service signs is the RBAC manifest actor, key and policy version', () => {
    const { config, rbac } = services();
    const manifest = bodyOf(RBAC1);
    const actor = asObject((manifest['actors'] as JsonObject[])[0], 'actor');
    const actorKey = Buffer.from(field(actor, 'public_key'), 'base64');
    const uuidBytes = (uuid: string): number[] =>
      Array.from(Buffer.from(uuid.replace(/-/g, ''), 'hex'));
    const envelope = new CommandEnvelopeSignerService(config, rbac).signPlatformCommand({
      cmd: 'read_tag',
      params: { tag: 'pump_1.state' },
      tenantId,
      jti: '7e570000-0000-4000-8000-0000000000e1',
    });
    expect(createHash('sha256').update(actorKey).digest('hex')).toBe(field(actor, 'keyid'));
    expect(envelope.actor).toEqual(uuidBytes(field(actor, 'actor_id')));
    expect(envelope.tenant_id).toEqual(uuidBytes(field(manifest, 'tenant_id')));
    expect(envelope.claimed_policy_version).toBe(intField(manifest, 'policy_version'));
    expect(envelope.jti).toBe('7e570000-0000-4000-8000-0000000000e1');
    const transcript = envelopeCanonicalBytes({
      cmd: envelope.cmd,
      params: envelope.params,
      actor: Buffer.from(envelope.actor),
      tenantId: Buffer.from(envelope.tenant_id),
      iat: envelope.iat_unix_secs,
      exp: envelope.exp_unix_secs,
      claimedPolicyVersion: envelope.claimed_policy_version,
      coApproverActor: null,
      jti: envelope.jti,
      nonce: envelope.nonce,
      cmdHash: Buffer.from(envelope.cmd_hash),
    });
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), actorKey]),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, transcript, publicKey, Buffer.from(envelope.signature))).toBe(true);
  });

  it('the lifecycle statement the service issues moves an ACTIVE device to MAINTENANCE', () => {
    const config = new SuderraEdgeConfig(new ConfigService(channelEnv()));
    const service = new DeviceLifecycleStatementService(config);
    const issue = (updateSeq: number): DsseEnvelope =>
      service.enterMaintenanceForReprovisioning({ tenantId, deviceId, binding, updateSeq, window })
        .envelope;
    expect(verifyAs(issue(3), ST_LIFE, active, 'os-root')).toEqual([]);
    expect(verifyAs(issue(2), ST_LIFE, active, 'os-root')).toEqual(['sequence-replay']);
  });
});

// ------------------------------------------------------------- admission

describe('contracts golden — what the cloud forwards but does not sign', () => {
  it('the configured bundle must be fleet-root signed and anchor every cloud key', () => {
    expect(() => services()).not.toThrow();
    expect(() =>
      services(
        channelEnv({
          SUDERRA_EDGE_TRUST_ANCHORS: fixtureText(
            'trust-anchors/invalid/wrong-purpose-key.dsse.json',
          ),
        }),
      ),
    ).toThrow(SuderraEdgeConfigError);
    const strangerCommandKey = Ed25519SigningKey.fromSeed('command', 1, Buffer.alloc(32, 7));
    expect(() =>
      services(
        channelEnv({
          SUDERRA_EDGE_COMMAND_SIGNING_KEY: `ed25519:1:${Buffer.alloc(32, 7).toString('hex')}`,
        }),
      ),
    ).toThrow(new RegExp(`does not anchor the cloud's command key ${strangerCommandKey.keyid}`));
  });

  it('the bundle is delivered only to tenants in its tenant_scope (DEC-22)', () => {
    const { bundles } = services();
    expect(bundles.forTenant(field(bodyOf(PROV_FIRST), 'tenant_id')).digest).toEqual(
      statementDigest(payloadOf(TA1)),
    );
    expect(() => bundles.forTenant('7e570000-0000-4000-8000-000000000002')).toThrow(
      TenantOutOfBundleScopeError,
    );
  });

  it('a release statement is admitted only under the bundle edge-release anchor', async () => {
    const { catalog } = services();
    const board = boardRow('revpi-connect4');
    if (board === null) throw new Error('board');
    const release = await catalog.forBoard(board);
    expect(release.digest).toEqual(statementDigest(payloadOf(REL_160)));
    expect(release.artifactUrl).toBe(field(bodyOf(PROV_FIRST), 'artifact_url'));

    const env = channelEnv();
    const config = new SuderraEdgeConfig(new ConfigService(env));
    const forged = new EdgeReleaseCatalog(
      config,
      new TrustAnchorBundleService(config),
      servingFixture(fixtureText('edge-release/invalid/wrong-purpose-key.dsse.json')),
      FIXTURE_PROVENANCE,
    );
    await expect(forged.forBoard(board)).rejects.toThrow(StatementAdmissionError);
  });

  it('the channel configuration is all or nothing', () => {
    expect(loadSuderraEdgeSettings(() => undefined)).toBeNull();
    const partial = channelEnv();
    expect(() =>
      loadSuderraEdgeSettings((name) =>
        name === 'SUDERRA_EDGE_MQTT_HOST' ? undefined : partial[name],
      ),
    ).toThrow(/partially configured; missing: SUDERRA_EDGE_MQTT_HOST/);
    const shared = channelEnv({ SUDERRA_EDGE_COMMAND_SIGNING_KEY: secret(KEYS.rbacManifest) });
    expect(() => loadSuderraEdgeSettings((name) => shared[name])).toThrow(/share one key/);
    const fractional = channelEnv({ SUDERRA_EDGE_RBAC_NOT_BEFORE: '2026-10-01T00:00:00.500Z' });
    expect(() => loadSuderraEdgeSettings((name) => fractional[name])).toThrow(
      SuderraEdgeConfigError,
    );
  });

  it('the repository whose release workflow the cloud trusts is required and an owner/repo', () => {
    const without = channelEnv();
    expect(() =>
      loadSuderraEdgeSettings((name) =>
        name === 'SUDERRA_EDGE_RELEASE_REPOSITORY' ? undefined : without[name],
      ),
    ).toThrow(/partially configured; missing: SUDERRA_EDGE_RELEASE_REPOSITORY/);
    for (const bad of ['aquaculture', 'a/b/c', 'https://github.com/a/b', 'a b/c', '/c', 'a/']) {
      const env = channelEnv({ SUDERRA_EDGE_RELEASE_REPOSITORY: bad });
      expect(() => loadSuderraEdgeSettings((name) => env[name])).toThrow(/must be owner\/repo/);
    }
    const ok = channelEnv({ SUDERRA_EDGE_RELEASE_REPOSITORY: 'Okan-wqm/aquaculture_platform' });
    expect(loadSuderraEdgeSettings((name) => ok[name])?.release.repository).toBe(
      'Okan-wqm/aquaculture_platform',
    );
  });

  it('the recovery-escrow keys the cloud accepts are optional, distinct sha256 digests', () => {
    const none = channelEnv();
    expect(loadSuderraEdgeSettings((name) => none[name])?.recoveryEscrow).toEqual({
      recipientSpkiSha256: [],
    });
    const one = 'ab'.repeat(32);
    const two = 'cd'.repeat(32);
    const set = channelEnv({ SUDERRA_EDGE_RECOVERY_ESCROW_SPKI_SHA256: ` ${one} , ${two} ` });
    expect(loadSuderraEdgeSettings((name) => set[name])?.recoveryEscrow).toEqual({
      recipientSpkiSha256: [one, two],
    });
    for (const bad of [`${one},${one}`, 'abc', one.toUpperCase(), `${one},`, `${one};${two}`]) {
      const env = channelEnv({ SUDERRA_EDGE_RECOVERY_ESCROW_SPKI_SHA256: bad });
      expect(() => loadSuderraEdgeSettings((name) => env[name])).toThrow(
        /SUDERRA_EDGE_RECOVERY_ESCROW_SPKI_SHA256/,
      );
    }
  });
});

// ------------------------------------------------------------- refusals

/** The envelope with its signature's S replaced by S + L: same point, non-canonical S. */
function withMalleableS(text: string): string {
  const envelope = JSON.parse(text) as DsseEnvelope;
  const [signature] = envelope.signatures;
  const sig = Buffer.from(signature.sig, 'base64');
  let s = 0n;
  for (const byte of [...sig.subarray(32, 64)].reverse()) s = (s << 8n) | BigInt(byte);
  let lifted = s + 2n ** 252n + 27742317777372353535851937790883648493n;
  for (let i = 32; i < 64; i += 1) {
    sig[i] = Number(lifted & 0xffn);
    lifted >>= 8n;
  }
  return JSON.stringify({
    ...envelope,
    signatures: [{ keyid: signature.keyid, sig: sig.toString('base64') }],
  });
}

describe('contracts golden — what the cloud refuses to forward or issue', () => {
  const tenantId = field(bodyOf(PROV_FIRST), 'tenant_id');
  const revpiDevice = { tenantId, deviceModel: DeviceModel.REVOLUTION_PI_CONNECT_4 };
  const requestOf = (overrides: Record<string, string>): ProvisioningRequest => {
    const request = parseProvisioningRequest({
      ...(readJson(join(FIXTURES, REQUEST_FIRST)) as Record<string, string>),
      ...overrides,
    });
    if (request === null) throw new Error('request');
    return request;
  };
  const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ProvisioningRefusal) return error.reason;
      throw error;
    }
    throw new Error('expected a refusal');
  };
  const catalogServing = (text: string): EdgeReleaseCatalog => {
    const config = new SuderraEdgeConfig(new ConfigService(channelEnv()));
    return new EdgeReleaseCatalog(
      config,
      new TrustAnchorBundleService(config),
      servingFixture(text),
      FIXTURE_PROVENANCE,
    );
  };
  const revpi = (): BoardRow => {
    const board = boardRow('revpi-connect4');
    if (board === null) throw new Error('board');
    return board;
  };

  it('refuses a trust-anchors bundle whose fleet-root signature does not verify, or whose S is not canonical', () => {
    expect(() =>
      services(
        channelEnv({
          SUDERRA_EDGE_TRUST_ANCHORS: fixtureText('trust-anchors/invalid/bad-signature.dsse.json'),
        }),
      ),
    ).toThrow(/signature does not verify/);
    expect(() =>
      services(channelEnv({ SUDERRA_EDGE_TRUST_ANCHORS: withMalleableS(fixtureText(TA1)) })),
    ).toThrow(/malleable \(S >= L\)/);
  });

  it('refuses a release statement whose signature does not verify, or whose S is not canonical', async () => {
    await expect(
      catalogServing(fixtureText('edge-release/invalid/bad-signature.dsse.json')).forBoard(revpi()),
    ).rejects.toThrow(/signature does not verify/);
    await expect(
      catalogServing(withMalleableS(fixtureText(REL_160))).forBoard(revpi()),
    ).rejects.toThrow(/malleable \(S >= L\)/);
  });

  it('refuses a validly signed release for another board or another version', async () => {
    await expect(
      catalogServing(fixtureText('edge-release/valid/rpi4-cm4-aarch64-1.6.0.dsse.json')).forBoard(
        revpi(),
      ),
    ).rejects.toThrow(/does not describe this board, version and name/);
    await expect(
      catalogServing(
        fixtureText('edge-release/valid/revpi-connect4-aarch64-1.4.0.dsse.json'),
      ).forBoard(revpi()),
    ).rejects.toThrow(/does not describe this board, version and name/);
  });

  it('refuses the boards whose cloud gate is closed: rpi4-cm4 (EDGE-MEDIUM-120) and the CI-only qemu-x86_64', async () => {
    const { manifests } = services();
    expect(
      await refusalOf(
        manifests.preflight(
          requestOf({ board_profile: 'rpi4-cm4', binding_method: 'bcm2711-serial-otp-sha256' }),
          { tenantId, deviceModel: DeviceModel.RASPBERRY_PI_4 },
        ),
      ),
    ).toBe('board-not-provisionable');
    expect(
      await refusalOf(
        manifests.preflight(requestOf({ board_profile: 'qemu-x86_64' }), revpiDevice),
      ),
    ).toBe('board-not-provisionable');
  });

  it('refuses a board the device is not registered as, or a binding method the board does not use', async () => {
    const { manifests } = services();
    for (const deviceModel of [
      DeviceModel.RASPBERRY_PI_4,
      DeviceModel.REVOLUTION_PI_COMPACT,
      DeviceModel.INDUSTRIAL_PC,
      DeviceModel.CUSTOM,
    ]) {
      expect(await refusalOf(manifests.preflight(requestOf({}), { tenantId, deviceModel }))).toBe(
        'board-mismatch',
      );
    }
    for (const binding_method of ['dmi-product-uuid-sha256', 'bcm2711-serial-otp-sha256']) {
      expect(await refusalOf(manifests.preflight(requestOf({ binding_method }), revpiDevice))).toBe(
        'board-mismatch',
      );
    }
  });

  it('refuses an OS older than the release needs, or an agent ABI range the release is outside', async () => {
    const { manifests } = services();
    expect(
      await refusalOf(manifests.preflight(requestOf({ os_version: '0.9.9' }), revpiDevice)),
    ).toBe('release-incompatible');
    expect(await refusalOf(manifests.preflight(requestOf({ agent_abi: '2-3' }), revpiDevice))).toBe(
      'release-incompatible',
    );
    await expect(
      manifests.preflight(requestOf({ os_version: '1.0.0', agent_abi: '0-1' }), revpiDevice),
    ).resolves.toMatchObject({ version: '1.6.0' });
  });

  it('SG-1: no site config the cloud signs lets the agent write to the field', () => {
    const files = (yaml: string): Map<SitePath, Buffer> =>
      new Map<SitePath, Buffer>([['config.yaml', Buffer.from(yaml, 'utf8')]]);
    expect(SG1_FIELD_WRITES_OPEN).toBe(false);
    // Monitoring-only I/O passes: the fixtures' read-only Modbus device, an input pin.
    expect(() =>
      assertMonitoringOnlySite(files(fixtureText('site-files/v2/config.yaml'))),
    ).not.toThrow();
    expect(() =>
      assertMonitoringOnlySite(files('gpio:\n  - name: level\n    direction: input\n')),
    ).not.toThrow();
    for (const yaml of [
      'modbus:\n  - name: pond-1\n    allow_writes: true\n',
      'gpio:\n  - name: valve\n    pin: 5\n    direction: output\n',
      'gpio:\n  - pin: 6\n  - direction: "OUT"\n',
      'opcua:\n  writable: yes\n',
    ]) {
      expect(() => assertMonitoringOnlySite(files(yaml))).toThrow(SiteGateClosedError);
    }
    expect(() =>
      assertMonitoringOnlySite(
        new Map<SitePath, Buffer>([
          ['config.yaml', Buffer.from('device_id: "x"\n')],
          ['revpi/config.rsc', fixtureBytes('site-files/v1/revpi/config.rsc')],
        ]),
      ),
    ).toThrow(/revpi\/config\.rsc defines field outputs/);
  });

  it('a release the catalog cannot admit is release-unavailable, before any reservation', async () => {
    const config = new SuderraEdgeConfig(new ConfigService(channelEnv()));
    const bundles = new TrustAnchorBundleService(config);
    const manifests = new EdgeProvisioningManifestService(
      config,
      new EdgeReleaseCatalog(
        config,
        bundles,
        servingFixture(fixtureText('edge-release/valid/rpi4-cm4-aarch64-1.6.0.dsse.json')),
        FIXTURE_PROVENANCE,
      ),
      bundles,
      new RbacManifestService(config),
      new SiteConfigManifestService(config),
    );
    expect(await refusalOf(manifests.preflight(requestOf({}), revpiDevice))).toBe(
      'release-unavailable',
    );
  });
});

describe('the DeviceModel to board mapping is boards.json (ADR-048 DEC-8.4)', () => {
  it('maps every DeviceModel exactly as boards.json does, and leaves the rest on the generic channel', () => {
    const boards = readJson(join(FIXTURES, '..', 'boards.json')) as JsonObject;
    const mapped = new Map<string, string>();
    for (const row of objects(boards['boards'], 'boards')) {
      for (const model of row['cloud_device_models'] as string[]) {
        mapped.set(model, field(row, 'board_profile'));
      }
    }
    const unmapped = new Set(
      objects(boards['unmapped_device_models'], 'unmapped_device_models').map((row) =>
        field(row, 'device_model'),
      ),
    );
    const pending = new Set(
      objects(boards['pending_board_families'], 'pending_board_families').flatMap(
        (row) => row['cloud_device_models'] as string[],
      ),
    );
    for (const model of Object.values(DeviceModel)) {
      // Every model is accounted for by the contract, exactly once.
      expect([mapped.has(model), unmapped.has(model), pending.has(model)].filter(Boolean)).toEqual([
        true,
      ]);
      expect(suderraOsBoardOf(model)).toBe(mapped.get(model) ?? null);
    }
    expect(suderraOsBoardOf(DeviceModel.REVOLUTION_PI_CONNECT_4)).toBe('revpi-connect4');
    expect(suderraOsBoardOf(DeviceModel.INDUSTRIAL_PC)).toBeNull();
  });
});
