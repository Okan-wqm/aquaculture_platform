import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { MessageAttachment } from '../entities/message-attachment.entity';
import { MediaService } from '../services/media.service';
import { MessageAttachmentResolver } from './message-attachment.resolver';

/**
 * MSG-CRITICAL-052: the attachment download/thumbnail URLs had no resolver and
 * silently returned null. These tests lock the resolver in: it must sign the
 * storageKey for the REQUESTING tenant, never throw out of a field resolution,
 * and return null when there is no key.
 */
describe('MessageAttachmentResolver', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';
  let resolver: MessageAttachmentResolver;
  let generateDownloadUrl: jest.Mock;

  beforeEach(async () => {
    generateDownloadUrl = jest.fn();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MessageAttachmentResolver,
        { provide: MediaService, useValue: { generateDownloadUrl } },
      ],
    }).compile();
    resolver = moduleRef.get(MessageAttachmentResolver);
  });

  function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
    const base = new MessageAttachment();
    base.id = 'att-1';
    base.tenantId = tenantId;
    base.storageKey = `messaging/${tenantId}/chan/2026/06/file.jpg`;
    base.thumbnailKey = null;
    return Object.assign(base, overrides);
  }

  it('signs the storageKey for the requesting tenant', async () => {
    generateDownloadUrl.mockResolvedValue('https://minio/signed/download');
    const url = await resolver.downloadUrl(attachment(), tenantId);
    expect(generateDownloadUrl).toHaveBeenCalledWith(
      tenantId,
      `messaging/${tenantId}/chan/2026/06/file.jpg`,
    );
    expect(url).toBe('https://minio/signed/download');
  });

  it('returns null (and does not call the signer) when there is no storageKey', async () => {
    const url = await resolver.downloadUrl(attachment({ storageKey: '' }), tenantId);
    expect(url).toBeNull();
    expect(generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing on a cross-tenant ForbiddenException', async () => {
    generateDownloadUrl.mockRejectedValue(new ForbiddenException('cross tenant'));
    await expect(resolver.downloadUrl(attachment(), tenantId)).resolves.toBeNull();
  });

  it('thumbnailUrl is null without a thumbnailKey and signed with one', async () => {
    expect(await resolver.thumbnailUrl(attachment({ thumbnailKey: null }), tenantId)).toBeNull();

    generateDownloadUrl.mockResolvedValue('https://minio/signed/thumb');
    const url = await resolver.thumbnailUrl(
      attachment({ thumbnailKey: `messaging/${tenantId}/chan/2026/06/thumb.jpg` }),
      tenantId,
    );
    expect(url).toBe('https://minio/signed/thumb');
  });
});
