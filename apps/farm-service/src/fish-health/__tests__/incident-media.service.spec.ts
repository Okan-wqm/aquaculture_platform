/**
 * IncidentMediaService — presigned-upload minting + finalize-into-table.
 *
 * Security-critical surface: the MIME allowlist is enforced at request time AND
 * on finalize, keys are tenant-first, and a key not carrying THIS tenant's
 * prefix is rejected before any row is written (cross-tenant key injection).
 */
import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MinioClientService } from '@platform/storage';

const tenantManagerRepo = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  tenantManagerRepo: (manager: unknown, entity: unknown, tenantId: string) =>
    tenantManagerRepo(manager, entity, tenantId),
}));

import { IncidentMediaService } from '../services/incident-media.service';
import { IncidentMediaType } from '../entities/farm-incident-media.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_TENANT = 'bbbbbbbb-1111-4222-8333-444444444444';
const USER = 'uuuuuuuu-1111-4222-8333-444444444444';
const REF = 'rrrrrrrr-1111-4222-8333-444444444444';

interface FakeRepo {
  create: jest.Mock;
  save: jest.Mock;
}

function setup(): {
  service: IncidentMediaService;
  repo: FakeRepo;
  getPresignedUploadUrl: jest.Mock;
  getFileStats: jest.Mock;
  manager: Partial<EntityManager>;
} {
  const repo: FakeRepo = {
    create: jest.fn((values: object) => values),
    save: jest.fn(async (values: object) => ({ id: 'media-1', ...values })),
  };
  tenantManagerRepo.mockReturnValue(repo);

  const getPresignedUploadUrl = jest
    .fn()
    .mockResolvedValue('https://minio.local/incident-media/put?sig=abc');
  const getFileStats = jest.fn();
  const manager: Partial<EntityManager> = {};

  const service = new IncidentMediaService({
    getPresignedUploadUrl,
    getFileStats,
  } as Partial<MinioClientService> as MinioClientService);

  return { service, repo, getPresignedUploadUrl, getFileStats, manager };
}

describe('IncidentMediaService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('requestUpload', () => {
    it('rejects a non-image MIME (svg is an XSS vector) with BadRequestException', async () => {
      const { service, getPresignedUploadUrl } = setup();

      await expect(
        service.requestUpload(TENANT, {
          incidentType: IncidentMediaType.ESCAPE,
          filename: 'evil.svg',
          mimeType: 'image/svg+xml',
          fileSize: 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Never sign a URL for a disallowed type.
      expect(getPresignedUploadUrl).not.toHaveBeenCalled();
    });

    it('accepts image/jpeg: returns a tenant-first key under the incident type and signs it', async () => {
      const { service, getPresignedUploadUrl } = setup();

      const res = await service.requestUpload(TENANT, {
        incidentType: IncidentMediaType.ESCAPE,
        filename: 'net-hole.jpeg',
        mimeType: 'image/jpeg',
        fileSize: 2048,
      });

      expect(res.storageKey.startsWith(`incident-media/${TENANT}/ESCAPE/`)).toBe(true);
      expect(res.storageKey.endsWith('.jpeg')).toBe(true);
      expect(res.uploadUrl).toBe('https://minio.local/incident-media/put?sig=abc');
      expect(res.expiresAt).toBeInstanceOf(Date);

      // Signed for the exact key, 15-min TTL, content-type bound where possible.
      expect(getPresignedUploadUrl).toHaveBeenCalledWith(res.storageKey, 900, 'image/jpeg');
    });
  });

  describe('attach', () => {
    it('early-returns on empty mediaKeys — no stat, no persist', async () => {
      const { service, repo, getFileStats, manager } = setup();

      await service.attach(manager as EntityManager, TENANT, IncidentMediaType.ESCAPE, REF, [], USER);

      expect(getFileStats).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects a cross-tenant key (prefix mismatch) and persists NOTHING', async () => {
      const { service, repo, getFileStats, manager } = setup();
      const crossKey = `incident-media/${OTHER_TENANT}/ESCAPE/2026/07/x.jpg`;

      await expect(
        service.attach(manager as EntityManager, TENANT, IncidentMediaType.ESCAPE, REF, [crossKey], USER),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Rejected on the prefix check — before any object stat or write.
      expect(getFileStats).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects when the object does not exist / upload never completed', async () => {
      const { service, repo, getFileStats, manager } = setup();
      getFileStats.mockResolvedValue(null);
      const key = `incident-media/${TENANT}/ESCAPE/2026/07/a.jpg`;

      await expect(
        service.attach(manager as EntityManager, TENANT, IncidentMediaType.ESCAPE, REF, [key], USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects when the stored object is not an allowed image type', async () => {
      const { service, repo, getFileStats, manager } = setup();
      getFileStats.mockResolvedValue({
        size: 1000,
        lastModified: new Date(),
        contentType: 'application/pdf',
        etag: 'e',
      });
      const key = `incident-media/${TENANT}/ESCAPE/2026/07/a.jpg`;

      await expect(
        service.attach(manager as EntityManager, TENANT, IncidentMediaType.ESCAPE, REF, [key], USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects when the stored object exceeds the size limit', async () => {
      const { service, repo, getFileStats, manager } = setup();
      getFileStats.mockResolvedValue({
        size: 10 * 1024 * 1024 + 1,
        lastModified: new Date(),
        contentType: 'image/png',
        etag: 'e',
      });
      const key = `incident-media/${TENANT}/ESCAPE/2026/07/a.png`;

      await expect(
        service.attach(manager as EntityManager, TENANT, IncidentMediaType.ESCAPE, REF, [key], USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('persists a row with the real stat-derived fields on a valid key', async () => {
      const { service, repo, getFileStats, manager } = setup();
      getFileStats.mockResolvedValue({
        size: 4242,
        lastModified: new Date(),
        contentType: 'image/png',
        etag: 'e',
      });
      const key = `incident-media/${TENANT}/WELFARE/2026/07/valid.png`;

      await service.attach(
        manager as EntityManager,
        TENANT,
        IncidentMediaType.WELFARE,
        REF,
        [key],
        USER,
      );

      expect(tenantManagerRepo).toHaveBeenCalledWith(manager, expect.any(Function), TENANT);
      expect(repo.create).toHaveBeenCalledWith({
        tenantId: TENANT,
        incidentType: IncidentMediaType.WELFARE,
        referenceId: REF,
        storageKey: key,
        mimeType: 'image/png',
        fileSizeBytes: '4242',
        createdBy: USER,
      });
      expect(repo.save).toHaveBeenCalledTimes(1);
    });
  });
});
