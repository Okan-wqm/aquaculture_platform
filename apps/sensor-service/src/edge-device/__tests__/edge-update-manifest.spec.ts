/**
 * The device-bound update statements the cloud signs (ADR-048 DEC-2.4, DEC-2.9;
 * contract 1.2.0), against the contract:
 *
 *   1. Golden: given the inputs a golden fixture was generated from, and the
 *      fixtures' TEST-ONLY edge-provisioning key, the producer emits that fixture's
 *      envelope byte for byte — payload, keyid and signature.
 *   2. Verifies: what it signs for a window around the contract's evaluation time
 *      passes the contract's reference verifier on the revpi-active device.
 *   3. Floor: what the contract schema or the channel rules refuse is never signed.
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
import { boardRow } from '../edge-boards';
import { type DeviceBinding, type DsseEnvelope, STATEMENT } from '../edge-contract';
import { type AdmittedRelease } from '../edge-release-catalog.service';
import { ContractSchemaError } from '../edge-statement-schemas';
import {
  assertDeliverableWindow,
  buildEdgeUpdate,
  EdgeUpdateManifestService,
  type EdgeUpdateInput,
  type OsBundle,
  type OsUpdateInput,
  UpdateRefusedError,
  type UpdateTarget,
} from '../edge-update-manifest.service';
import { SuderraEdgeConfig } from '../suderra-edge.config';

import { channelEnvironment } from './support/edge-channel-env';
import { fixtureRelease } from './support/fixture-release';

const text = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');
const envelopeOf = (rel: string): DsseEnvelope => JSON.parse(text(rel)) as DsseEnvelope;
const bodyOf = (rel: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(envelopeOf(rel).payload, 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;

const REL_170 = 'edge-release/valid/revpi-connect4-aarch64-1.7.0.dsse.json';
const EDGE_UPDATE = 'edge-update/valid/revpi-connect4-1.7.0-seq-4.dsse.json';
const OS_UPDATE = 'os-update/valid/revpi-connect4-1.1.0-seq-3.dsse.json';

const config = new SuderraEdgeConfig(
  new ConfigService(channelEnvironment({ SUDERRA_EDGE_AGENT_VERSION: '1.7.0' })),
);
const service = new EdgeUpdateManifestService(config);

const board = ((): NonNullable<ReturnType<typeof boardRow>> => {
  const row = boardRow('revpi-connect4');
  if (row === null) throw new Error('board');
  return row;
})();

const editBody = bodyOf(EDGE_UPDATE);
const osBody = bodyOf(OS_UPDATE);
const binding = editBody['device_binding'] as DeviceBinding;
const target: UpdateTarget = {
  tenantId: editBody['tenant_id'] as string,
  deviceId: editBody['device_id'] as string,
  binding,
  board,
};
const GOLDEN_WINDOW = {
  notBefore: new Date('2026-10-20T00:00:00Z'),
  expiresAt: new Date('2026-10-21T00:00:00Z'),
};
const RUNNING = { osVersion: '1.0.0', installedAgentAbi: 1 };

const release170 = (): Promise<AdmittedRelease> => fixtureRelease(config, '1.7.0');

const edgeInput = async (over: Partial<EdgeUpdateInput> = {}): Promise<EdgeUpdateInput> => ({
  target,
  release: await release170(),
  updateSeq: 4,
  window: GOLDEN_WINDOW,
  terms: { localApproval: false, blockersOverride: false, maxOutageSeconds: 120 },
  running: RUNNING,
  ...over,
});

const bundle = (over: Partial<OsBundle> = {}): OsBundle => {
  const b = osBody['bundle'] as { url: string; digest: { sha256: string }; size_bytes: number };
  return {
    version: osBody['version'] as string,
    rollbackFloor: osBody['rollback_floor'] as string,
    minCurrentVersion: osBody['min_current_version'] as string,
    supportedAgentAbi: osBody['supported_agent_abi'] as string,
    url: b.url,
    sha256: b.digest.sha256,
    sizeBytes: b.size_bytes,
    ...over,
  };
};

const osInput = (over: Partial<OsUpdateInput> = {}): OsUpdateInput => ({
  target,
  bundle: bundle(),
  updateSeq: 3,
  window: GOLDEN_WINDOW,
  terms: { localApproval: true, blockersOverride: false, maxOutageSeconds: 600 },
  running: RUNNING,
  ...over,
});

describe("golden: the producers emit the contract's fixtures byte for byte", () => {
  it('edge-update 1.7.0 at update_seq 4', async () => {
    const signed = service.signEdgeUpdate(await edgeInput());
    expect(signed.envelope).toEqual(envelopeOf(EDGE_UPDATE));
    expect(signed.type).toBe(STATEMENT.edgeUpdate);
  });

  it('edge-update with the operator override at the outage limit', async () => {
    const signed = service.signEdgeUpdate(
      await edgeInput({
        terms: { localApproval: true, blockersOverride: true, maxOutageSeconds: 3600 },
      }),
    );
    expect(signed.envelope).toEqual(
      envelopeOf('edge-update/valid/revpi-connect4-1.7.0-override-at-outage-limit.dsse.json'),
    );
  });

  it('os-update 1.1.0 at update_seq 3', () => {
    expect(service.signOsUpdate(osInput()).envelope).toEqual(envelopeOf(OS_UPDATE));
  });

  it('os-update at the schema limits: override, 3600 s, a bundle of exactly 2 GiB', () => {
    const signed = service.signOsUpdate(
      osInput({
        terms: { localApproval: true, blockersOverride: true, maxOutageSeconds: 3600 },
        bundle: bundle({ sizeBytes: 2147483648 }),
      }),
    );
    expect(signed.envelope).toEqual(
      envelopeOf('os-update/valid/revpi-connect4-override-at-limits.dsse.json'),
    );
  });

  it('os-update with a version patch and an ABI maximum of nine digits', () => {
    const signed = service.signOsUpdate(
      osInput({ bundle: bundle({ version: '1.1.999999999', supportedAgentAbi: '1-999999999' }) }),
    );
    expect(signed.envelope).toEqual(
      envelopeOf('os-update/valid/revpi-connect4-version-and-abi-at-max.dsse.json'),
    );
  });
});

describe('the reference verifier accepts what the cloud signs for a window around the evaluation time', () => {
  const ctx = contextOf('revpi-active') as JsonObject;
  const window = {
    notBefore: new Date('2026-10-20T11:00:00Z'),
    expiresAt: new Date('2026-10-20T13:00:00Z'),
  };
  const verify = (
    envelope: DsseEnvelope,
    type: string,
    inputs: { release?: Buffer } = {},
  ): string[] =>
    verifyStatement(Buffer.from(JSON.stringify(envelope), 'utf8'), type, ctx, inputs, {
      mode: 'accept',
      verifier: 'os-root',
      allChecks: true,
    }).reasons;

  it('is evaluated inside the window', () => {
    expect(new Date(EVALUATION_TIME).getTime()).toBeGreaterThan(window.notBefore.getTime());
    expect(new Date(EVALUATION_TIME).getTime()).toBeLessThan(window.expiresAt.getTime());
  });

  it('an agent update, with and without the local approval', async () => {
    for (const localApproval of [false, true]) {
      const signed = service.signEdgeUpdate(
        await edgeInput({
          window,
          terms: { localApproval, blockersOverride: false, maxOutageSeconds: 300 },
        }),
      );
      expect(
        verify(signed.envelope, STATEMENT.edgeUpdate, {
          release: Buffer.from(text(REL_170), 'utf8'),
        }),
      ).toEqual([]);
    }
  });

  it('an OS update', () => {
    const signed = service.signOsUpdate(osInput({ window }));
    expect(verify(signed.envelope, STATEMENT.osUpdate)).toEqual([]);
  });

  it("refuses nothing the cloud signs for another device: the binding and ids are the target's", async () => {
    const other = { ...target, deviceId: '7e570000-0000-4000-8000-0000000000d2' };
    const signed = service.signEdgeUpdate(await edgeInput({ window, target: other }));
    expect(
      verify(signed.envelope, STATEMENT.edgeUpdate, {
        release: Buffer.from(text(REL_170), 'utf8'),
      }),
    ).toEqual(['device-id-mismatch']);
  });
});

describe('what the cloud does not sign', () => {
  it('a window it cannot deliver: not longer than the margin, nor longer than the agent keeps a request', () => {
    const start = new Date('2026-10-20T00:00:00Z');
    const after = (s: number): Date => new Date(start.getTime() + s * 1000);
    expect(() => assertDeliverableWindow({ notBefore: start, expiresAt: after(600) })).toThrow(
      /cannot be delivered/,
    );
    expect(() =>
      assertDeliverableWindow({ notBefore: start, expiresAt: after(601) }),
    ).not.toThrow();
    expect(() =>
      assertDeliverableWindow({ notBefore: start, expiresAt: after(86400) }),
    ).not.toThrow();
    expect(() => assertDeliverableWindow({ notBefore: start, expiresAt: after(86401) })).toThrow(
      /outlives/,
    );
    expect(() =>
      assertDeliverableWindow({
        notBefore: new Date(start.getTime() + 500),
        expiresAt: after(3600),
      }),
    ).toThrow(UpdateRefusedError);
  });

  it('blockers_override without the local approval it requires', async () => {
    await expect(
      edgeInput({
        terms: { localApproval: false, blockersOverride: true, maxOutageSeconds: 60 },
      }).then(buildEdgeUpdate),
    ).rejects.toMatchObject({ reason: 'terms-invalid' });
    expect(() =>
      service.signOsUpdate(
        osInput({ terms: { localApproval: false, blockersOverride: true, maxOutageSeconds: 60 } }),
      ),
    ).toThrow(/local_approval/);
  });

  it('an outage budget outside 1..3600', async () => {
    for (const maxOutageSeconds of [0, 3601, 1.5]) {
      const terms = { localApproval: false, blockersOverride: false, maxOutageSeconds };
      await expect(
        edgeInput({ terms }).then((input) => service.signEdgeUpdate(input)),
      ).rejects.toBeInstanceOf(ContractSchemaError);
      expect(() => service.signOsUpdate(osInput({ terms }))).toThrow(ContractSchemaError);
    }
  });

  it('a bundle of zero bytes or over 2 GiB, a fetch URL the device cannot reach', () => {
    for (const sizeBytes of [0, 2147483649]) {
      expect(() => service.signOsUpdate(osInput({ bundle: bundle({ sizeBytes }) }))).toThrow(
        ContractSchemaError,
      );
    }
    for (const url of [
      'http://edge-releases.example.com/os/1.1.0/b.raucb',
      'https://203.0.113.9/os/1.1.0/b.raucb',
      'https://edge-releases.example.com:8443/os/1.1.0/b.raucb',
      'https://user:pw@edge-releases.example.com/b.raucb',
    ]) {
      expect(() => service.signOsUpdate(osInput({ bundle: bundle({ url }) }))).toThrow(
        ContractSchemaError,
      );
    }
  });

  it('a release for another board or arch', async () => {
    const other = boardRow('rpi4-cm4');
    if (other === null) throw new Error('board');
    await expect(
      edgeInput({ target: { ...target, board: other } }).then((input) =>
        service.signEdgeUpdate(input),
      ),
    ).rejects.toMatchObject({ reason: 'release-for-another-board' });
  });

  it("an update the device's running OS is too old for", async () => {
    await expect(
      edgeInput({ running: { osVersion: '0.9.9', installedAgentAbi: 1 } }).then((input) =>
        service.signEdgeUpdate(input),
      ),
    ).rejects.toMatchObject({ reason: 'os-version-too-old' });
    expect(() =>
      service.signOsUpdate(osInput({ running: { osVersion: '0.9.9', installedAgentAbi: 1 } })),
    ).toThrow(/needs OS 1\.0\.0/);
  });

  it('an OS whose ABI range excludes the installed agent, or a floor above the version', () => {
    expect(() =>
      service.signOsUpdate(osInput({ running: { osVersion: '1.0.0', installedAgentAbi: 3 } })),
    ).toThrow(/ABI 3/);
    expect(() =>
      service.signOsUpdate(osInput({ bundle: bundle({ rollbackFloor: '1.2.0' }) })),
    ).toThrow(/rollback_floor/);
  });

  it('an unknown running state does not block (the root verifier decides), a known one does', async () => {
    expect(() =>
      service.signOsUpdate(osInput({ running: { osVersion: null, installedAgentAbi: null } })),
    ).not.toThrow();
  });

  it("the OS statement's compatible is the board's: a bundle cannot name another board's", () => {
    const signed = service.signOsUpdate(osInput());
    expect(signed.body.compatible).toBe(board.raucCompatible);
  });
});
