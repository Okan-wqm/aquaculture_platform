import {
  TelemetryArchiveBucketProvisionerService,
  type TelemetryArchiveStoragePrincipals,
} from '../telemetry-archive-bucket-provisioner.service';
import type { TelemetryArchiveS3Port } from '../s3-telemetry-archive-object-store.service';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPALS: TelemetryArchiveStoragePrincipals = {
  exporter: 'arn:aws:iam::minio:user/telemetry-archive-exporter',
  verifier: 'arn:aws:iam::minio:user/telemetry-archive-verifier',
  restore: 'arn:aws:iam::minio:user/telemetry-archive-restore',
  erasure: 'arn:aws:iam::minio:user/telemetry-archive-erasure',
};

describe('TelemetryArchiveBucketProvisionerService', () => {
  it('creates one versioned bucket per tenant with identity-specific policy', async () => {
    const commands: unknown[] = [];
    const client: TelemetryArchiveS3Port = {
      send: jest.fn(async (command) => {
        commands.push(command);
        return {};
      }),
    };
    const service = new TelemetryArchiveBucketProvisionerService(client, PRINCIPALS);

    const bucket = await service.provisionTenant(TENANT_ID);

    expect(bucket).toBe('aqua-telemetry-22222222222242228222222222222222');
    expect(commands.map(commandName)).toEqual([
      'CreateBucketCommand',
      'PutBucketVersioningCommand',
      'PutBucketPolicyCommand',
    ]);
    const policyCommand = commands[2];
    expect(JSON.stringify(policyCommand)).toContain(PRINCIPALS.exporter);
    expect(JSON.stringify(policyCommand)).toContain(PRINCIPALS.verifier);
    expect(JSON.stringify(policyCommand)).toContain(PRINCIPALS.restore);
    expect(JSON.stringify(policyCommand)).toContain(PRINCIPALS.erasure);
    expect(JSON.stringify(policyCommand)).toContain('s3:GetObjectVersion');
    expect(JSON.stringify(policyCommand)).not.toContain('aqua-telemetry-*');
  });

  it('cannot collide tenants that share the first half of their UUID', async () => {
    const service = new TelemetryArchiveBucketProvisionerService(
      { send: jest.fn(async () => ({})) },
      PRINCIPALS,
    );

    const first = await service.provisionTenant('22222222-2222-4222-8222-111111111111');
    const second = await service.provisionTenant('22222222-2222-4222-8222-999999999999');

    expect(first).not.toBe(second);
  });

  it('rejects reused identities because exporter/verifier/restore separation is mandatory', () => {
    expect(
      () =>
        new TelemetryArchiveBucketProvisionerService(
          { send: jest.fn(async () => ({})) },
          { ...PRINCIPALS, verifier: PRINCIPALS.exporter },
        ),
    ).toThrow(/distinct/i);
  });

  it.each(['*', 'arn:aws:iam::minio:user/archive-*', 'not-an-arn', ' arn:aws:iam::minio:user/a'])(
    'rejects unsafe storage principal %s before mutating a bucket',
    (unsafePrincipal) => {
      const send = jest.fn(async () => ({}));
      expect(
        () =>
          new TelemetryArchiveBucketProvisionerService(
            { send },
            { ...PRINCIPALS, verifier: unsafePrincipal },
          ),
      ).toThrow(/principal/i);
      expect(send).not.toHaveBeenCalled();
    },
  );
});

function commandName(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  return value.constructor.name;
}
