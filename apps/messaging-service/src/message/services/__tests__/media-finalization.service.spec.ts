/**
 * @module MediaFinalizationService Tests
 * @description MSG-HIGH-056 (populate dead media columns) + MSG-MEDIUM-056
 * (server-side EXIF/GPS strip at the trust boundary).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import sharp from 'sharp';
import { MediaFinalizationService } from '../media-finalization.service';
import { ThumbnailService } from '../thumbnail.service';

/**
 * Build a small JPEG carrying EXIF so we can prove it is stripped. Sharp models
 * the GPS directory as IFD3, so GPS-style tags ride there; camera make/model in
 * IFD0. Both are EXIF metadata and both must be gone after finalization.
 */
async function jpegWithExifAndGps(): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'X1' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' },
    })
    .jpeg()
    .toBuffer();
}

function streamOf(buf: Buffer): Readable {
  return Readable.from([buf]);
}

describe('MediaFinalizationService', () => {
  let service: MediaFinalizationService;
  let sendSpy: jest.SpyInstance;
  let probeImage: jest.Mock;
  let generateThumbnail: jest.Mock;

  const imageKey = 'messaging/tenant/ch/2026/06/abc.jpg';

  beforeEach(async () => {
    // ThumbnailService double: probeImage delegates to REAL sharp (so dimensions
    // are truthful); generateThumbnail returns a deterministic thumb key.
    probeImage = jest.fn(async (buf: Buffer) => {
      const meta = await sharp(buf).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    });
    generateThumbnail = jest.fn().mockResolvedValue(`${imageKey}_thumb.jpg`);

    const configService = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaFinalizationService,
        { provide: ConfigService, useValue: configService },
        { provide: ThumbnailService, useValue: { probeImage, generateThumbnail } },
      ],
    }).compile();

    service = module.get(MediaFinalizationService);
  });

  afterEach(() => jest.restoreAllMocks());

  // ── MSG-MEDIUM-056: EXIF/GPS strip ────────────────────────────────────────
  it('strips EXIF/GPS from a raster image and re-PUTs the cleaned bytes', async () => {
    const original = await jpegWithExifAndGps();
    // Pre-condition: the original DOES carry EXIF.
    expect((await sharp(original).metadata()).exif).toBeDefined();

    let putBody: Buffer | null = null;
    sendSpy = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async (command: unknown) => {
        if (command instanceof GetObjectCommand) {
          return { Body: streamOf(original) };
        }
        if (command instanceof PutObjectCommand) {
          const body = command.input.Body;
          putBody = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array);
          return {};
        }
        return {};
      });

    const result = await service.finalizeAttachment(imageKey, 'image/jpeg', null);

    // The re-PUT body must exist and carry NO EXIF/GPS.
    expect(putBody).not.toBeNull();
    if (putBody === null) {
      throw new Error('expected the EXIF-strip re-PUT to write a body');
    }
    // putBody is now narrowed to Buffer (no cast needed); Buffer is a valid sharp input.
    const cleanedMeta = await sharp(putBody).metadata();
    expect(cleanedMeta.exif).toBeUndefined();

    // Dimensions probed + thumbnail generated (dead columns now populated).
    expect(result.width).toBe(16);
    expect(result.height).toBe(10);
    expect(result.thumbnailKey).toBe(`${imageKey}_thumb.jpg`);
    expect(result.durationSeconds).toBeNull();
    expect(generateThumbnail).toHaveBeenCalledWith(imageKey, 'image/jpeg');
  });

  it('is a no-op for non-image MIME — passes through duration, no S3 calls', async () => {
    sendSpy = jest.spyOn(S3Client.prototype, 'send');
    const result = await service.finalizeAttachment(
      'messaging/t/ch/2026/06/voice.webm',
      'audio/webm',
      7.5,
    );
    expect(result).toEqual({
      width: null,
      height: null,
      durationSeconds: 7.5,
      thumbnailKey: null,
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(generateThumbnail).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED if the original object cannot be fetched (no leak path)', async () => {
    sendSpy = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async (command: unknown) => {
        if (command instanceof GetObjectCommand) {
          return { Body: undefined };
        }
        return {};
      });

    await expect(service.finalizeAttachment(imageKey, 'image/jpeg', null)).rejects.toThrow(
      /unreadable/,
    );
  });

  it('FAILS CLOSED when the image exceeds the pixel cap (SEC-MEDIUM-074 decode-bomb gate)', async () => {
    // 50,000,000 px > MAX_IMAGE_PIXELS (40,000,000) — a header-only claim;
    // the gate must reject BEFORE any strip/decode work happens.
    probeImage.mockResolvedValueOnce({ width: 10_000, height: 5_000 });

    const original = await jpegWithExifAndGps();
    sendSpy = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async (command: unknown) => {
        if (command instanceof GetObjectCommand) {
          return { Body: streamOf(original) };
        }
        return {};
      });

    await expect(
      service.finalizeAttachment('tenant/1/msg/boom.png', 'image/png', null),
    ).rejects.toThrow(/pixel cap/);
  });

  it('classifies raster image MIMEs (jpeg/png/webp/gif) as strippable', () => {
    expect(service.isStrippableImage('image/jpeg')).toBe(true);
    expect(service.isStrippableImage('image/png')).toBe(true);
    expect(service.isStrippableImage('image/webp')).toBe(true);
    expect(service.isStrippableImage('image/gif')).toBe(true);
    expect(service.isStrippableImage('application/pdf')).toBe(false);
    expect(service.isStrippableImage('audio/webm')).toBe(false);
    expect(service.isStrippableImage('image/svg+xml')).toBe(false);
  });
});
