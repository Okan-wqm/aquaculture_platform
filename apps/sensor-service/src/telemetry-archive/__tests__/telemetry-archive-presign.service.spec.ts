import { TelemetryArchivePresignService } from '../telemetry-archive-presign.service';

describe('TelemetryArchivePresignService', () => {
  it('mints only 15-minute GET URLs and records them for tenant erasure revocation', async () => {
    const signer = {
      signGet: jest.fn(async () => 'https://objects.invalid/signed'),
    };
    const registry = {
      record: jest.fn(async () => undefined),
      revokeTenant: jest.fn(async () => undefined),
    };
    const service = new TelemetryArchivePresignService(signer, registry, {
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    });

    const result = await service.createDownload({
      tenantId: '22222222-2222-4222-8222-222222222222',
      operationId: '11111111-1111-4111-8111-111111111111',
      bucket: 'aqua-telemetry-22222222222242228222222222222222',
      objectKey: '11111111-1111-4111-8111-111111111111.parquet',
      objectVersionId: 'version-1',
    });

    expect(signer.signGet).toHaveBeenCalledWith(
      'aqua-telemetry-22222222222242228222222222222222',
      '11111111-1111-4111-8111-111111111111.parquet',
      'version-1',
      900,
    );
    expect(result.expiresAt).toBe('2026-01-02T00:15:00.000Z');
    expect(registry.record).toHaveBeenCalledTimes(1);
    await service.revokeTenant('22222222-2222-4222-8222-222222222222');
    expect(registry.revokeTenant).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
  });
});
