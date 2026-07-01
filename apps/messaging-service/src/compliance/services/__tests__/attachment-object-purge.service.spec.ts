import { ConfigService } from '@nestjs/config';
import { DeleteObjectsCommand } from '@aws-sdk/client-s3';

const mockSend = jest.fn();
jest.mock('../../../shared/messaging-s3-client.factory', () => ({
  createMessagingS3: (): { client: { send: jest.Mock }; bucket: string } => ({
    client: { send: mockSend },
    bucket: 'messaging',
  }),
}));

import { AttachmentObjectPurgeService } from '../attachment-object-purge.service';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const prefix = `messaging/${tenantId}/`;

function keysOf(commandInput: unknown): string[] {
  const del = (commandInput as { Delete?: { Objects?: Array<{ Key?: string }> } }).Delete;
  return (del?.Objects ?? []).map((o) => o.Key ?? '');
}

describe('AttachmentObjectPurgeService (MSG-CRITICAL-058)', () => {
  let service: AttachmentObjectPurgeService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ Errors: [] });
    service = new AttachmentObjectPurgeService(new ConfigService());
  });

  it('deletes the tenant-owned object + thumbnail keys via one DeleteObjectsCommand', async () => {
    const result = await service.purgeObjects(tenantId, [
      `${prefix}ch/2026/06/img.png`,
      `${prefix}ch/2026/06/img_thumb.png`,
    ]);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0] as DeleteObjectsCommand;
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    expect((command.input as { Bucket?: string }).Bucket).toBe('messaging');
    expect(keysOf(command.input).sort()).toEqual(
      [`${prefix}ch/2026/06/img.png`, `${prefix}ch/2026/06/img_thumb.png`].sort(),
    );
    expect(result).toMatchObject({ requested: 2, deleted: 2, skipped: 0, failed: 0 });
  });

  it('REFUSES a key outside the tenant prefix (isolation) and never sends it to the store', async () => {
    const result = await service.purgeObjects(tenantId, [
      `${prefix}ch/mine.png`,
      'messaging/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/ch/not-mine.png',
    ]);

    const sentKeys = keysOf((mockSend.mock.calls[0][0] as DeleteObjectsCommand).input);
    expect(sentKeys).toEqual([`${prefix}ch/mine.png`]);
    expect(sentKeys).not.toContain('messaging/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/ch/not-mine.png');
    expect(result).toMatchObject({ requested: 2, deleted: 1, skipped: 1, failed: 0 });
  });

  it('dedups and drops null/undefined/empty keys', async () => {
    const result = await service.purgeObjects(tenantId, [
      `${prefix}a.png`,
      `${prefix}a.png`,
      null,
      undefined,
      '',
    ]);

    expect(keysOf((mockSend.mock.calls[0][0] as DeleteObjectsCommand).input)).toEqual([`${prefix}a.png`]);
    expect(result).toMatchObject({ requested: 1, deleted: 1, skipped: 0, failed: 0 });
  });

  it('does not call the store when there are no tenant-owned keys', async () => {
    const result = await service.purgeObjects(tenantId, [null, '', 'messaging/other-tenant/x.png']);
    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requested: 1, deleted: 0, skipped: 1, failed: 0 });
  });

  it('counts per-key store errors as failed (orphan residue surfaced to the caller)', async () => {
    mockSend.mockResolvedValue({
      Errors: [{ Key: `${prefix}b.png`, Code: 'InternalError', Message: 'boom' }],
    });

    const result = await service.purgeObjects(tenantId, [`${prefix}a.png`, `${prefix}b.png`]);
    expect(result).toMatchObject({ requested: 2, deleted: 1, skipped: 0, failed: 1 });
  });

  it('does not throw when the store batch fails entirely (best-effort post-commit)', async () => {
    mockSend.mockRejectedValue(new Error('minio down'));

    const result = await service.purgeObjects(tenantId, [`${prefix}a.png`, `${prefix}b.png`]);
    expect(result).toMatchObject({ requested: 2, deleted: 0, skipped: 0, failed: 2 });
  });
});
