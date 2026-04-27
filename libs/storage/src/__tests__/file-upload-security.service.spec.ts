/**
 * FileUploadSecurityService Unit Tests
 *
 * Covers every pre-flight gate:
 *   - unknown document type → reject
 *   - empty buffer → reject
 *   - size > per-policy limit → reject
 *   - size > global cap → reject
 *   - declared mime not in whitelist → reject
 *   - magic-byte contradicts declared mime → reject
 *   - happy path → delegates to MinioClientService.uploadFile
 *     with (tenantId, entityType, entityId, filename, buffer, options)
 *
 * Uses hand-rolled MinioClientService double — no MinIO in tests.
 */
import { BadRequestException } from '@nestjs/common';

import { FileUploadSecurityService } from '../file-upload-security.service';
import { MinioClientService } from '../minio-client.service';

interface MinioDouble {
  uploadFile: jest.Mock;
}

function makeService(): {
  service: FileUploadSecurityService;
  minio: MinioDouble;
} {
  const minio: MinioDouble = {
    uploadFile: jest.fn().mockResolvedValue({
      path: 'some/path',
      internalUrl: 'http://minio/aqua/some/path',
      etag: 'etag',
      size: 1,
      contentType: 'application/pdf',
    }),
  };
  const service = new FileUploadSecurityService(
    minio as unknown as MinioClientService,
  );
  return { service, minio };
}

const PDF_BUF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
const JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const WEBP_BUF = Buffer.from([
  0x52, 0x49, 0x46, 0x46,
  0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);

const baseReq = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  entityType: 'health-event',
  entityId: 'hev-1',
  filename: 'doc.pdf',
};

describe('FileUploadSecurityService', () => {
  describe('preflight', () => {
    it('rejects unknown document type', () => {
      const { service } = makeService();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'MYSTERY_DOCUMENT',
          buffer: PDF_BUF,
          declaredMime: 'application/pdf',
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects an empty buffer', () => {
      const { service } = makeService();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'HEALTH_CERTIFICATE',
          buffer: Buffer.alloc(0),
          declaredMime: 'application/pdf',
        }),
      ).toThrow(/empty file/i);
    });

    it('rejects size above the per-policy limit', () => {
      const { service } = makeService();
      const big = Buffer.concat([PDF_BUF, Buffer.alloc(6 * 1024 * 1024)]);
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'HEALTH_CERTIFICATE',
          buffer: big,
          declaredMime: 'application/pdf',
        }),
      ).toThrow(/exceeds policy limit/i);
    });

    it('rejects size above the global cap', () => {
      const { service } = makeService();
      const big = Buffer.concat([JPEG_BUF, Buffer.alloc(21 * 1024 * 1024)]);
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'TREATMENT_PHOTO',
          buffer: big,
          declaredMime: 'image/jpeg',
        }),
      ).toThrow(/exceeds (policy limit|global cap)/i);
    });

    it('rejects declared mime outside the whitelist', () => {
      const { service } = makeService();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'HEALTH_CERTIFICATE',
          buffer: PDF_BUF,
          declaredMime:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ).toThrow(/not in the whitelist/i);
    });

    it('rejects when magic-byte signature contradicts declared mime', () => {
      const { service } = makeService();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'TREATMENT_PHOTO',
          filename: 'x.jpg',
          buffer: PDF_BUF,
          declaredMime: 'image/jpeg',
        }),
      ).toThrow(/contradicts magic-byte signature/i);
    });

    it('passes a valid PDF declared as application/pdf', () => {
      const { service } = makeService();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'HEALTH_CERTIFICATE',
          filename: 'health.pdf',
          buffer: PDF_BUF,
          declaredMime: 'application/pdf',
        }),
      ).not.toThrow();
    });

    it('passes PNG / JPEG / WEBP photos', () => {
      const { service } = makeService();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'TREATMENT_PHOTO',
          filename: 'p.png',
          buffer: PNG_BUF,
          declaredMime: 'image/png',
        }),
      ).not.toThrow();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'TREATMENT_PHOTO',
          filename: 'p.jpg',
          buffer: JPEG_BUF,
          declaredMime: 'image/jpeg',
        }),
      ).not.toThrow();
      expect(() =>
        service.preflight({
          ...baseReq,
          documentType: 'TREATMENT_PHOTO',
          filename: 'p.webp',
          buffer: WEBP_BUF,
          declaredMime: 'image/webp',
        }),
      ).not.toThrow();
    });
  });

  describe('uploadSecure', () => {
    it('delegates to MinioClientService.uploadFile after pre-flight', async () => {
      const { service, minio } = makeService();
      await service.uploadSecure({
        ...baseReq,
        documentType: 'HEALTH_CERTIFICATE',
        filename: 'health.pdf',
        buffer: PDF_BUF,
        declaredMime: 'application/pdf',
      });
      expect(minio.uploadFile).toHaveBeenCalledTimes(1);
      const call = minio.uploadFile.mock.calls[0];
      expect(call[0]).toBe(baseReq.tenantId);
      expect(call[1]).toBe(baseReq.entityType);
      expect(call[2]).toBe(baseReq.entityId);
      expect(call[3]).toBe('health.pdf');
      expect(call[4]).toBe(PDF_BUF);
      expect(call[5]).toMatchObject({ contentType: 'application/pdf' });
    });

    it('does NOT call uploadFile when pre-flight rejects', async () => {
      const { service, minio } = makeService();
      await expect(
        service.uploadSecure({
          ...baseReq,
          documentType: 'HEALTH_CERTIFICATE',
          buffer: Buffer.alloc(0),
          declaredMime: 'application/pdf',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(minio.uploadFile).not.toHaveBeenCalled();
    });
  });
});
