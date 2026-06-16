/**
 * @module MediaService Tests
 * @description Unit tests for the media trust-boundary: MIME allowlist
 * enforcement (MSG-MEDIUM-057 SSoT) and voice-duration metadata key alignment
 * (MSG-HIGH-055).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MESSAGING_MEDIA_MIME_ALLOWLIST } from '@aquaculture/shared-contracts';
import {
  MediaService,
  VOICE_DURATION_METADATA_KEY,
} from '../media.service';
import {
  STORAGE_OBJECT_VERIFIER,
  StorageObjectVerifier,
} from '../storage-object-verifier.port';

describe('MediaService', () => {
  let service: MediaService;

  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const channelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  const verifier: jest.Mocked<StorageObjectVerifier> = {
    verifyObject: jest.fn().mockResolvedValue({
      contentLength: 1024,
      contentType: 'image/png',
    }),
  };

  beforeEach(async () => {
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => fallback),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: ConfigService, useValue: configService },
        { provide: STORAGE_OBJECT_VERIFIER, useValue: verifier },
      ],
    }).compile();

    service = module.get(MediaService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── MSG-MEDIUM-057: MIME allowlist is the single shared SSoT ──────────────
  describe('MIME allowlist (MSG-MEDIUM-057)', () => {
    it('accepts every MIME in the shared SSoT allowlist', async () => {
      for (const mime of MESSAGING_MEDIA_MIME_ALLOWLIST) {
        await expect(
          service.generateUploadUrl(tenantId, channelId, `file.bin`, mime),
        ).resolves.toMatchObject({ storageKey: expect.any(String) });
      }
    });

    it('REJECTS image/svg+xml (stored-XSS vector) — server boundary', async () => {
      await expect(
        service.generateUploadUrl(tenantId, channelId, 'evil.svg', 'image/svg+xml'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REJECTS an arbitrary disallowed MIME', async () => {
      await expect(
        service.generateUploadUrl(tenantId, channelId, 'x.exe', 'application/x-msdownload'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('the server-enforced allowlist is byte-identical to the SSoT (no drift)', () => {
      // The service builds its Set from MESSAGING_MEDIA_MIME_ALLOWLIST, so every
      // SSoT entry must be accepted and svg (absent from the SSoT) rejected — the
      // accept/reject cases above prove the Set IS the SSoT with no extra members.
      expect(MESSAGING_MEDIA_MIME_ALLOWLIST).not.toContain('image/svg+xml');
    });
  });

  // ── MSG-HIGH-055: voice duration metadata key SSoT ────────────────────────
  describe('extractVoiceDuration (MSG-HIGH-055)', () => {
    it('reads the duration from the SSoT key the client actually sends', () => {
      expect(VOICE_DURATION_METADATA_KEY).toBe('durationSeconds');
      const duration = service.extractVoiceDuration({ [VOICE_DURATION_METADATA_KEY]: 12.345 });
      expect(duration).toBe(12.35); // rounded to 2 dp
    });

    it('returns null for the OLD server-only key (client never sent it)', () => {
      expect(service.extractVoiceDuration({ voiceDurationSeconds: 9 })).toBeNull();
    });

    it('returns null for absent/invalid duration', () => {
      expect(service.extractVoiceDuration(null)).toBeNull();
      expect(service.extractVoiceDuration({})).toBeNull();
      expect(service.extractVoiceDuration({ durationSeconds: -1 })).toBeNull();
    });
  });
});
