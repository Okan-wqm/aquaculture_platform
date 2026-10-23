/**
 * The site statements the cloud signs for the update channel (ADR-048 DEC-4.12,
 * DEC-11.7; contract 1.2.0), against the contract:
 *
 *   1. Golden: given the inputs a golden fixture was generated from, and the fixtures'
 *      TEST-ONLY config-integrity key, the producers emit that fixture's envelope byte
 *      for byte, and the site bundle the fixture ships.
 *   2. Verifies: what they sign for a window around the contract's evaluation time
 *      passes the contract's reference verifier on the revpi-active device, together
 *      with the bundle and RBAC manifest root would fetch.
 *   3. Floor: what the contract schema, its constraints or the SG-1 gate refuse is never
 *      signed — checked against the contract's own invalid fixtures.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { ConfigService } from '@nestjs/config';

import {
  contextOf,
  EVALUATION_TIME,
  FIXTURES,
  type JsonObject,
  verifyStatement,
} from '../../../../../tests/invariants/lib/suderra-edge-contract';
import {
  type DeviceBinding,
  type DsseEnvelope,
  type SignedStatement,
  type SitePath,
  statementDigest,
  STATEMENT,
} from '../edge-contract';
import { ContractSchemaError } from '../edge-statement-schemas';
import { UpdateRefusedError } from '../edge-update-manifest.service';
import { RbacManifestService } from '../rbac-manifest.service';
import {
  buildSiteBundle,
  SiteConfigManifestService,
  siteBundleUrl,
} from '../site-config-manifest.service';
import {
  assertNetpolicyConstraints,
  buildSiteNetpolicy,
  type NetpolicyBody,
  SiteNetpolicyManifestService,
} from '../site-netpolicy-manifest.service';
import { SuderraEdgeConfig } from '../suderra-edge.config';

import { channelEnvironment } from './support/edge-channel-env';

const text = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');
const envelopeOf = (rel: string): DsseEnvelope => JSON.parse(text(rel)) as DsseEnvelope;
const bodyOfEnvelope = (envelope: DsseEnvelope): Record<string, unknown> =>
  JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as Record<string, unknown>;
const bodyOf = (rel: string): Record<string, unknown> => bodyOfEnvelope(envelopeOf(rel));

const SITE_CONFIG_3 = 'site-config/valid/revpi-connect4-seq-3-io-config.dsse.json';
const SITE_BUNDLE_3 = 'site-bundle/valid/revpi-connect4-seq-3.json';
const NETPOLICY_1 = 'site-netpolicy/valid/policy-seq-1.dsse.json';
const NETPOLICY_2 = 'site-netpolicy/valid/policy-seq-2.dsse.json';
const TRUST_ANCHORS_1 = 'trust-anchors/valid/bundle-seq-1.dsse.json';

const config = new SuderraEdgeConfig(
  new ConfigService(channelEnvironment({ SUDERRA_EDGE_AGENT_VERSION: '1.7.0' })),
);
const siteConfigs = new SiteConfigManifestService(config);
const netpolicies = new SiteNetpolicyManifestService(config);
const rbacService = new RbacManifestService(config);

const configBody = bodyOf(SITE_CONFIG_3);
const target = {
  tenantId: configBody['tenant_id'] as string,
  deviceId: configBody['device_id'] as string,
  binding: configBody['device_binding'] as DeviceBinding,
};
const GOLDEN_WINDOW = {
  notBefore: new Date('2026-10-20T00:00:00Z'),
  expiresAt: new Date('2026-10-21T00:00:00Z'),
};
const WINDOW = {
  notBefore: new Date('2026-10-20T11:00:00Z'),
  expiresAt: new Date('2026-10-20T13:00:00Z'),
};

/** The RBAC manifest the cloud signs for the fixture tenant, which is the contract's golden one. */
const rbac = (): SignedStatement<typeof STATEMENT.rbacManifest> =>
  rbacService.forTenant(target.tenantId);

const bundleFixture = JSON.parse(text(SITE_BUNDLE_3)) as {
  rbac_manifest: DsseEnvelope;
  site_files: Record<string, string>;
};
const fixtureFiles = (): Map<SitePath, Buffer> =>
  new Map(
    Object.entries(bundleFixture.site_files).map(([path, b64]) => [
      path as SitePath,
      Buffer.from(b64, 'base64'),
    ]),
  );

const verify = (
  envelope: DsseEnvelope,
  type: string,
  inputs: Parameters<typeof verifyStatement>[3],
): string[] =>
  verifyStatement(
    Buffer.from(JSON.stringify(envelope), 'utf8'),
    type,
    contextOf('revpi-active') as JsonObject,
    inputs,
    { mode: 'accept', verifier: 'os-root', allChecks: true },
  ).reasons;

describe("golden: the producers emit the contract's fixtures byte for byte", () => {
  it('the RBAC manifest the cloud signs for the fixture tenant is the fixture bundle’s', () => {
    expect(rbac().envelope).toEqual(bundleFixture.rbac_manifest);
  });

  it('site-config at update_seq 3, naming a site bundle URL', () => {
    const signed = siteConfigs.signUpdate({
      target,
      files: fixtureFiles(),
      rbac: rbac(),
      updateSeq: 3,
      window: GOLDEN_WINDOW,
      siteBundleUrl: configBody['site_bundle_url'] as string,
    });
    expect(signed.envelope).toEqual(envelopeOf(SITE_CONFIG_3));
  });

  it('the site bundle of that update, as the fixture ships it', () => {
    expect(JSON.parse(buildSiteBundle(fixtureFiles(), rbac()))).toEqual(bundleFixture);
  });

  it.each([
    ['policy-seq-1', NETPOLICY_1],
    ['policy-seq-2', NETPOLICY_2],
  ])('site-netpolicy %s', (_name, rel) => {
    const body = bodyOf(rel);
    const signed = netpolicies.sign({
      target,
      updateSeq: body['update_seq'] as number,
      window: {
        notBefore: new Date(body['not_before'] as string),
        expiresAt: new Date(body['expires_at'] as string),
      },
      policy: {
        interfaces: body['interfaces'] as NetpolicyBody['interfaces'],
        ot_rules: body['ot_rules'] as NetpolicyBody['ot_rules'],
        time_sources: body['time_sources'] as NetpolicyBody['time_sources'],
      },
    });
    expect(signed.envelope).toEqual(envelopeOf(rel));
  });
});

describe('the reference verifier accepts what the cloud signs for a window around the evaluation time', () => {
  it('is evaluated inside the window', () => {
    expect(new Date(EVALUATION_TIME).getTime()).toBeGreaterThan(WINDOW.notBefore.getTime());
    expect(new Date(EVALUATION_TIME).getTime()).toBeLessThan(WINDOW.expiresAt.getTime());
  });

  it('a site config of an activated device, with the bundle and RBAC manifest it names', () => {
    const rbacSigned = rbac();
    const prepared = siteConfigs.prepareUpdate(
      {
        ...target,
        deviceCode: 'REVPI-D1',
        extraFiles: new Map<SitePath, Buffer>([
          ['io-config.yaml', Buffer.from('tags:\n  - name: level\n    channel: ai1\n', 'utf8')],
        ]),
      },
      rbacSigned,
    );
    const signed = siteConfigs.signUpdate({
      target,
      files: prepared.files,
      rbac: rbacSigned,
      updateSeq: 5,
      window: WINDOW,
      siteBundleUrl: siteBundleUrl(
        'https://api.example.com',
        target.tenantId,
        '11111111-1111-4111-8111-111111111111',
      ),
    });
    const served = JSON.parse(prepared.bundle) as { rbac_manifest: DsseEnvelope };
    expect(
      verify(signed.envelope, STATEMENT.siteConfig, {
        trustAnchors: readFileSync(join(FIXTURES, TRUST_ANCHORS_1)),
        rbac: Buffer.from(JSON.stringify(served.rbac_manifest), 'utf8'),
        siteFiles: new Map(prepared.files),
      }),
    ).toEqual([]);
  });

  it('a site policy', () => {
    const body = bodyOf(NETPOLICY_2);
    const signed = netpolicies.sign({
      target,
      updateSeq: 5,
      window: WINDOW,
      policy: {
        interfaces: body['interfaces'] as NetpolicyBody['interfaces'],
        ot_rules: body['ot_rules'] as NetpolicyBody['ot_rules'],
        time_sources: body['time_sources'] as NetpolicyBody['time_sources'],
      },
    });
    expect(
      verify(signed.envelope, STATEMENT.siteNetpolicy, {
        trustAnchors: readFileSync(join(FIXTURES, TRUST_ANCHORS_1)),
      }),
    ).toEqual([]);
  });
});

describe('the update bundle is what the statement names, and what SG-1 allows', () => {
  const prepare = (extra: Array<[SitePath, string]> = []) =>
    siteConfigs.prepareUpdate(
      {
        ...target,
        deviceCode: 'REVPI-D1',
        extraFiles: new Map(extra.map(([path, content]) => [path, Buffer.from(content, 'utf8')])),
      },
      rbac(),
    );

  it('names every file of the bundle by digest and size, and the RBAC manifest by digest', () => {
    const rbacSigned = rbac();
    const prepared = siteConfigs.prepareUpdate(
      {
        ...target,
        deviceCode: 'REVPI-D1',
        extraFiles: new Map<SitePath, Buffer>([['io-config.yaml', Buffer.from('tags: []\n')]]),
      },
      rbacSigned,
    );
    const signed = siteConfigs.signUpdate({
      target,
      files: prepared.files,
      rbac: rbacSigned,
      updateSeq: 6,
      window: WINDOW,
      siteBundleUrl: 'https://api.example.com/api/devices/site-bundles/t/r',
    });
    const served = JSON.parse(prepared.bundle) as {
      site_files: Record<string, string>;
      rbac_manifest: DsseEnvelope;
    };
    expect(Object.keys(served.site_files).sort()).toEqual(Object.keys(signed.body.files).sort());
    for (const [path, ref] of Object.entries(signed.body.files)) {
      const bytes = Buffer.from(served.site_files[path] ?? '', 'base64');
      expect(statementDigest(bytes)).toEqual(ref.digest);
      expect(bytes.length).toBe(ref.size_bytes);
    }
    expect(signed.body.rbac_manifest.digest).toEqual(
      statementDigest(Buffer.from(served.rbac_manifest.payload, 'base64')),
    );
  });

  it('config.yaml is the cloud’s own and carries no provisioning token of a device already activated', () => {
    const yaml = prepare().files.get('config.yaml')?.toString('utf8') ?? '';
    expect(yaml).toContain(`device_id: "${target.deviceId}"`);
    expect(yaml).toContain(`tenant_id: "${target.tenantId}"`);
    expect(yaml).toContain('device_code: "REVPI-D1"');
    expect(yaml).not.toContain('provisioning_token');
  });

  it.each([
    [
      'an operator-supplied config.yaml',
      [['config.yaml', 'device_id: "x"\n']] as Array<[SitePath, string]>,
      /not a site file an operator supplies/,
    ],
    [
      'a PiCtory process image',
      [['revpi/config.rsc', '{}']] as Array<[SitePath, string]>,
      /defines field outputs/,
    ],
    [
      'the per-output policy',
      [['site-policy.json', '{}']] as Array<[SitePath, string]>,
      /per-output policy/,
    ],
    [
      'an I/O map that enables a write',
      [['io-config.yaml', 'modbus:\n  - allow_writes: true\n']] as Array<[SitePath, string]>,
      /io-config\.yaml: a Modbus device allows writes/,
    ],
    [
      'a hardware inventory with an output pin',
      [['hardware-inventory.yaml', 'gpio:\n  - direction: output\n']] as Array<[SitePath, string]>,
      /hardware-inventory\.yaml: a GPIO pin is an output/,
    ],
  ])('refuses %s while SG-1 is closed', (_name, extra, message) => {
    expect(() => prepare(extra)).toThrow(UpdateRefusedError);
    expect(() => prepare(extra)).toThrow(message);
  });

  it('refuses a site file over the 1 MiB root installs', () => {
    const files = new Map<SitePath, Buffer>([
      ['config.yaml', Buffer.from('device_id: "x"\n')],
      ['io-config.yaml', Buffer.alloc(1_048_577, 0x61)],
    ]);
    expect(() => buildSiteBundle(files, rbac())).toThrow(/over the 1048576 bytes of a site file/);
    expect(() => buildSiteBundle(files, rbac())).toThrow(UpdateRefusedError);
  });

  it('refuses a bundle URL root would not fetch', () => {
    const rbacSigned = rbac();
    const prepared = prepare();
    for (const url of [
      'http://api.example.com/api/devices/site-bundles/t/r',
      'https://192.0.2.10/api/devices/site-bundles/t/r',
      'https://api.example.com:8443/api/devices/site-bundles/t/r',
      'https://user@api.example.com/api/devices/site-bundles/t/r',
    ]) {
      expect(() =>
        siteConfigs.signUpdate({
          target,
          files: prepared.files,
          rbac: rbacSigned,
          updateSeq: 7,
          window: WINDOW,
          siteBundleUrl: url,
        }),
      ).toThrow(ContractSchemaError);
    }
  });
});

describe('a site policy the contract refuses is never signed', () => {
  const base = bodyOf(NETPOLICY_2);
  const sign = (policy: Record<string, unknown>): unknown =>
    buildSiteNetpolicy({
      target,
      updateSeq: 9,
      window: WINDOW,
      policy: {
        interfaces: (policy['interfaces'] ?? base['interfaces']) as NetpolicyBody['interfaces'],
        ot_rules: (policy['ot_rules'] ?? base['ot_rules']) as NetpolicyBody['ot_rules'],
        time_sources: (policy['time_sources'] ??
          base['time_sources']) as NetpolicyBody['time_sources'],
      },
    });

  // Every invalid fixture the cloud can recognize from the policy alone: the contract's own
  // `schema-invalid` cases. (`interface-mapping-invalid` needs the device's interfaces, so
  // root decides it.)
  const SCHEMA_INVALID = [
    'dst-host-bits',
    'all-addresses-without-flag',
    'wide-prefix-without-flag',
    'wide-flag-on-narrow-prefix',
    'port-range-reversed',
    'duplicate-rule-id',
    'duplicate-interface-mac',
    'plain-ntp-without-mark',
    'duplicate-time-source-id',
    'duplicate-time-source-host',
    'interfaces-over-limit',
    'rules-over-limit',
    'ports-over-limit',
    'time-sources-over-limit',
    'dst-slash-16-with-wide',
    'dst-slash-15-without-wide',
    'dst-prefix-33',
    'dst-leading-zero',
    'port-zero',
    'port-65536',
    'time-source-host-without-dot',
  ];

  it.each(SCHEMA_INVALID)('%s', (name) => {
    const body = bodyOf(`site-netpolicy/invalid/${name}.dsse.json`);
    expect(() =>
      sign({
        interfaces: body['interfaces'],
        ot_rules: body['ot_rules'],
        time_sources: body['time_sources'],
      }),
    ).toThrow(/does not satisfy the contract schema|The update was not signed \(policy-invalid\)/);
  });

  it('names the constraint the schema cannot state', () => {
    const rule = (over: Record<string, unknown>): NetpolicyBody => ({
      interfaces: [],
      time_sources: [],
      ot_rules: [
        { id: 'plc', proto: 'tcp', dst: '10.0.0.0/24', ports: [{ from: 502, to: 502 }], ...over },
      ] as NetpolicyBody['ot_rules'],
    });
    expect(() => assertNetpolicyConstraints(rule({ dst: '10.0.0.5/24' }))).toThrow(/host bits/);
    expect(() => assertNetpolicyConstraints(rule({ ports: [{ from: 600, to: 500 }] }))).toThrow(
      /reversed/,
    );
    expect(() => assertNetpolicyConstraints(rule({}))).not.toThrow();
    expect(() => assertNetpolicyConstraints(rule({ dst: '10.0.0.4/30' }))).not.toThrow();
    expect(() => assertNetpolicyConstraints(rule({ dst: '10.0.0.6/30' }))).toThrow(/host bits/);
    expect(() => assertNetpolicyConstraints(rule({ dst: '255.255.255.255/32' }))).not.toThrow();
  });
});
