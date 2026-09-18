/**
 * Upload Controller
 * Handles file upload operations for the platform
 * @module Upload
 */
import { randomUUID } from 'crypto';

import { toError } from '../common/error-normalization';
import {
  Controller,
  Post,
  Delete,
  Param,
  Body,
  Inject,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { FileUploadSecurityService, MinioClientService } from '@platform/storage';
import { Request } from 'express';
import { ApiStandardErrors, ApiNotFoundError } from '@platform/shared';

import { AuthenticatedRequest } from '../guards/auth.guard';
import { UploadBatchDocumentDto, BatchDocumentCategory } from './dto/upload-batch-document.dto';
import {
  UploadChemicalDocumentDto,
  ChemicalDocumentType,
} from './dto/upload-chemical-document.dto';

/**
 * SECURITY: Magic byte signatures for allowed file types.
 * Validates actual file content rather than trusting client-supplied MIME type,
 * which can be spoofed to upload malicious files (e.g., HTML with JS, PHP scripts).
 */
const FILE_MAGIC_BYTES: { ext: string; signatures: Buffer[] }[] = [
  { ext: 'pdf', signatures: [Buffer.from([0x25, 0x50, 0x44, 0x46])] }, // %PDF
  { ext: 'png', signatures: [Buffer.from([0x89, 0x50, 0x4e, 0x47])] }, // .PNG
  { ext: 'jpg', signatures: [Buffer.from([0xff, 0xd8, 0xff])] }, // JPEG SOI
  { ext: 'jpeg', signatures: [Buffer.from([0xff, 0xd8, 0xff])] },
  // DOC/DOCX/XLS/XLSX are OLE2 or ZIP-based (OOXML)
  { ext: 'doc', signatures: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])] }, // OLE2 Compound
  { ext: 'xls', signatures: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0])] },
  { ext: 'docx', signatures: [Buffer.from([0x50, 0x4b, 0x03, 0x04])] }, // ZIP (OOXML)
  { ext: 'xlsx', signatures: [Buffer.from([0x50, 0x4b, 0x03, 0x04])] },
];

/**
 * SECURITY: Validate file content matches claimed type using magic bytes.
 * Returns true if the file buffer matches any known signature for allowed types.
 */
function validateFileMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  return FILE_MAGIC_BYTES.some(({ signatures }) =>
    signatures.some((sig) => buffer.subarray(0, sig.length).equals(sig)),
  );
}

/**
 * SECURITY: Sanitize filename to prevent path injection and extension confusion.
 * - Extracts only the last extension after the final dot
 * - Rejects null bytes and multiple extensions
 * - Returns lowercase, alphanumeric extension only
 */
function sanitizeFileExtension(originalname: string): string {
  // Reject null bytes
  if (originalname.includes('\0')) {
    throw new BadRequestException('Invalid filename: null bytes not allowed');
  }
  // Extract only the final extension
  const parts = originalname.split('.');
  if (parts.length < 2) return 'bin';
  const ext = (parts.pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ext) return 'bin';
  return ext;
}

/**
 * Multer file interface
 */
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Response for chemical document upload
 */
interface ChemicalDocumentUploadResponse {
  documentId: string;
  documentName: string;
  documentType: ChemicalDocumentType;
  path: string;
  etag: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  uploadedBy: string;
}

/**
 * Response for batch document upload
 */
interface BatchDocumentUploadResponse {
  documentId: string;
  documentName: string;
  documentCategory: BatchDocumentCategory;
  documentNumber?: string;
  path: string;
  etag: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  uploadedBy: string;
}

@ApiTags('Upload')
@ApiBearerAuth()
@Controller('upload')
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  /**
   * Upload write paths route through `FileUploadSecurityService`
   * (Scope B Phase V0 — closes FARM-HIGH-003). The security wrapper
   * runs size + mime + magic-byte gates and (when sharp is available)
   * strips EXIF metadata from image uploads BEFORE bytes reach MinIO.
   *
   * Read / delete / presign paths still call `MinioClientService`
   * directly because they don't process bytes — they manipulate
   * storage paths. A future Phase V0.5 may introduce a similar
   * wrapper for read-side audit (presigned URL request logging) but
   * that's a separate architectural concern from the upload-time
   * gates Scope B Phase V0 closes.
   */
  constructor(
    @Inject(MinioClientService) private readonly minioClient: MinioClientService,
    @Inject(FileUploadSecurityService)
    private readonly fileUploadSecurity: FileUploadSecurityService,
  ) {}

  /**
   * Upload a document for a chemical
   * POST /upload/chemical-document
   */
  @Post('chemical-document')
  @UseInterceptors(
    // SEC-MEDIUM-071 (2026-08-23 scan №16): parser-level cap — memoryStorage
    // buffers the WHOLE body before ParseFilePipe's MaxFileSizeValidator
    // runs, so without multer limits each request buffers up to the nginx
    // ceiling (50m) in gateway RAM.
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1, parts: 5 } }),
  )
  @ApiOperation({
    summary: 'Upload a document for a chemical',
    description: 'Accepts PDF, DOC, DOCX, XLS, XLSX, PNG, JPG, JPEG files up to 10 MB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'chemicalId', 'documentName', 'documentType'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'File to upload (max 10 MB)' },
        chemicalId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the chemical this document belongs to',
        },
        documentName: {
          type: 'string',
          maxLength: 255,
          description: 'Display name for the document',
        },
        documentType: {
          type: 'string',
          enum: ['msds', 'label', 'protocol', 'certificate', 'other'],
          description: 'Category of the chemical document',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Document uploaded successfully',
    schema: {
      properties: {
        documentId: { type: 'string', format: 'uuid' },
        documentName: { type: 'string' },
        documentType: { type: 'string' },
        path: {
          type: 'string',
          description: 'Storage path — use with /upload/presigned-url to get a download link',
        },
        etag: { type: 'string' },
        size: { type: 'number' },
        contentType: { type: 'string' },
        uploadedAt: { type: 'string', format: 'date-time' },
        uploadedBy: { type: 'string' },
      },
    },
  })
  @ApiStandardErrors()
  async uploadChemicalDocument(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 }), // 10MB max
          new FileTypeValidator({ fileType: /(pdf|doc|docx|xls|xlsx|png|jpg|jpeg)$/ }),
        ],
      }),
    )
    file: MulterFile,
    @Body() body: UploadChemicalDocumentDto,
    @Req() req: Request,
  ): Promise<ChemicalDocumentUploadResponse> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const tenantId = user.tenantId;
    const userId = user.sub;

    if (!tenantId) {
      throw new ForbiddenException('Tenant context required');
    }

    // SECURITY: Validate file content via magic bytes, not just MIME type header
    // Client-supplied Content-Type can be spoofed to upload malicious files
    if (!validateFileMagicBytes(file.buffer)) {
      throw new BadRequestException(
        'Invalid file content: file does not match any allowed type (pdf, doc, docx, xls, xlsx, png, jpg, jpeg)',
      );
    }

    this.logger.log(
      `Uploading chemical document: ${body.documentName} for chemical ${body.chemicalId}`,
    );

    // Generate unique document ID
    const documentId = randomUUID();

    // Create a unique filename with the document ID
    // SECURITY: Sanitize extension to prevent path injection and extension confusion
    const fileExtension = sanitizeFileExtension(file.originalname);
    const safeDocName = body.documentName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filename = `${documentId}_${safeDocName}.${fileExtension}`;

    try {
      // Phase V0 — every byte goes through FileUploadSecurityService
      // so the size/mime/magic-byte/EXIF policies live in ONE place.
      // The chemical document type comes off the wire lowercased
      // (msds | label | protocol | certificate | other); the policy
      // registry uses uppercase keys with a 'CHEMICAL_'-prefixed
      // 'OTHER' to keep chemical mime whitelists tighter than the
      // generic 'OTHER' policy.
      const policyKey =
        body.documentType.toUpperCase() === 'OTHER'
          ? 'CHEMICAL_OTHER'
          : body.documentType.toUpperCase();
      const uploadResult = await this.fileUploadSecurity.uploadSecure({
        documentType: policyKey,
        tenantId,
        entityType: 'chemicals',
        entityId: body.chemicalId,
        filename,
        buffer: file.buffer,
        declaredMime: file.mimetype,
        options: {
          contentType: file.mimetype,
          metadata: {
            'x-amz-meta-document-id': documentId,
            'x-amz-meta-document-name': body.documentName,
            'x-amz-meta-document-type': body.documentType,
            'x-amz-meta-chemical-id': body.chemicalId,
            'x-amz-meta-uploaded-by': userId,
          },
        },
      });

      const now = new Date().toISOString();

      this.logger.log(
        `Successfully uploaded document ${documentId} for chemical ${body.chemicalId}`,
      );

      return {
        documentId,
        documentName: body.documentName,
        documentType: body.documentType,
        path: uploadResult.path,
        etag: uploadResult.etag,
        size: uploadResult.size,
        contentType: uploadResult.contentType,
        uploadedAt: now,
        uploadedBy: userId,
      };
    } catch (error) {
      // BadRequestException flows through unmodified so the operator
      // sees the policy violation message (size limit, mime mismatch,
      // magic-byte conflict). Other failures map to a generic 500 to
      // avoid leaking storage-backend details.
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `Failed to upload document for chemical ${body.chemicalId}: ${toError(error).message}`,
      );
      throw new InternalServerErrorException('Document storage temporarily unavailable');
    }
  }

  /**
   * Delete a document from a chemical
   * DELETE /upload/chemical-document/:chemicalId/:documentId/:filename
   */
  @Delete('chemical-document/:chemicalId/:documentId/:filename')
  @ApiOperation({ summary: 'Delete a chemical document' })
  @ApiParam({
    name: 'chemicalId',
    type: 'string',
    format: 'uuid',
    description: 'UUID of the chemical',
  })
  @ApiParam({
    name: 'documentId',
    type: 'string',
    format: 'uuid',
    description: 'UUID of the document to delete',
  })
  @ApiParam({
    name: 'filename',
    type: 'string',
    description: 'Filename as returned by the upload endpoint',
  })
  @ApiOkResponse({
    schema: {
      properties: { success: { type: 'boolean', example: true }, message: { type: 'string' } },
    },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Document')
  async deleteChemicalDocument(
    @Param('chemicalId') chemicalId: string,
    @Param('documentId') documentId: string,
    @Param('filename') filename: string,
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('Tenant context required');
    }

    // SECURITY: Validate filename starts with documentId to prevent
    // deleting arbitrary files by manipulating the filename parameter
    if (!filename.startsWith(documentId + '_')) {
      throw new BadRequestException('Invalid filename: must match the document ID');
    }

    this.logger.log(`Deleting document ${documentId} from chemical ${chemicalId}`);

    try {
      // Build the file path
      const path = this.minioClient.generateFilePath(tenantId, 'chemicals', chemicalId, filename);

      // Check if file exists
      const exists = await this.minioClient.fileExists(path);
      if (!exists) {
        throw new NotFoundException('Document not found');
      }

      // Delete from MinIO
      await this.minioClient.deleteFile(path);

      this.logger.log(`Successfully deleted document ${documentId} from chemical ${chemicalId}`);

      return {
        success: true,
        message: 'Document deleted successfully',
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(
        `Failed to delete document ${documentId} from chemical ${chemicalId}: ${toError(error).message}`,
      );
      throw new InternalServerErrorException('Document storage temporarily unavailable');
    }
  }

  /**
   * Upload a document for a batch (health certificates, import documents)
   * POST /upload/batch-document
   */
  @Post('batch-document')
  @UseInterceptors(
    // SEC-MEDIUM-071 (2026-08-23 scan №16): parser-level cap, see chemical-document.
    FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1, parts: 5 } }),
  )
  @ApiOperation({
    summary: 'Upload a document for a batch',
    description: 'Accepts PDF, DOC, DOCX, PNG, JPG, JPEG files up to 15 MB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'documentName', 'documentCategory'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'File to upload (max 15 MB)' },
        documentName: { type: 'string', description: 'Display name for the document' },
        documentCategory: {
          type: 'string',
          enum: [
            'health_certificate',
            'import_document',
            'origin_certificate',
            'quarantine_permit',
            'transport_document',
            'veterinary_certificate',
            'customs_declaration',
            'other',
          ],
          description: 'Category of the batch document',
        },
        documentNumber: {
          type: 'string',
          description: 'Optional reference number for the document',
        },
        batchId: {
          type: 'string',
          format: 'uuid',
          description: 'Optional batch UUID — document is stored in temp location if omitted',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Document uploaded successfully',
    schema: {
      properties: {
        documentId: { type: 'string', format: 'uuid' },
        documentName: { type: 'string' },
        documentCategory: { type: 'string' },
        documentNumber: { type: 'string' },
        path: {
          type: 'string',
          description: 'Storage path — use with /upload/presigned-url to get a download link',
        },
        etag: { type: 'string' },
        size: { type: 'number' },
        contentType: { type: 'string' },
        uploadedAt: { type: 'string', format: 'date-time' },
        uploadedBy: { type: 'string' },
      },
    },
  })
  @ApiStandardErrors()
  async uploadBatchDocument(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 15 * 1024 * 1024 }), // 15MB max
          new FileTypeValidator({ fileType: /(pdf|doc|docx|png|jpg|jpeg)$/ }),
        ],
      }),
    )
    file: MulterFile,
    @Body() body: UploadBatchDocumentDto,
    @Req() req: Request,
  ): Promise<BatchDocumentUploadResponse> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const tenantId = user.tenantId;
    const userId = user.sub;

    if (!tenantId) {
      throw new ForbiddenException('Tenant context required');
    }

    // SECURITY: Validate file content via magic bytes, not just MIME type header
    if (!validateFileMagicBytes(file.buffer)) {
      throw new BadRequestException(
        'Invalid file content: file does not match any allowed type (pdf, doc, docx, png, jpg, jpeg)',
      );
    }

    this.logger.log(`Uploading batch document: ${body.documentName} (${body.documentCategory})`);

    // Generate unique document ID
    const documentId = randomUUID();

    // Create a unique filename with the document ID
    // SECURITY: Sanitize extension to prevent path injection and extension confusion
    const fileExtension = sanitizeFileExtension(file.originalname);
    const safeDocName = body.documentName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filename = `${documentId}_${safeDocName}.${fileExtension}`;

    // Use batchId if provided, otherwise use temp storage with documentId
    const entityId = body.batchId || `temp_${documentId}`;

    try {
      // Phase V0 — route through FileUploadSecurityService. The
      // BatchDocumentCategory enum on the wire is lowercase + snake
      // case (e.g. 'health_certificate'); the policy registry uses
      // SCREAMING_SNAKE_CASE keys (HEALTH_CERTIFICATE), so a
      // toUpperCase() on the wire value is sufficient to look up
      // the policy.
      //
      // 'other' maps to 'BATCH_OTHER' rather than the generic
      // 'OTHER' policy so the batch document path keeps a tighter
      // mime whitelist than the catch-all (PDF + JPEG + PNG only,
      // no DOC/DOCX) — distinct from the chemical 'OTHER' for the
      // same operator-workflow-drift reason.
      const policyKey =
        body.documentCategory.toUpperCase() === 'OTHER'
          ? 'BATCH_OTHER'
          : body.documentCategory.toUpperCase();
      const uploadResult = await this.fileUploadSecurity.uploadSecure({
        documentType: policyKey,
        tenantId,
        entityType: 'batch-documents',
        entityId,
        filename,
        buffer: file.buffer,
        declaredMime: file.mimetype,
        options: {
          contentType: file.mimetype,
          metadata: {
            'x-amz-meta-document-id': documentId,
            'x-amz-meta-document-name': body.documentName,
            'x-amz-meta-document-category': body.documentCategory,
            'x-amz-meta-document-number': body.documentNumber || '',
            'x-amz-meta-batch-id': body.batchId || '',
            'x-amz-meta-uploaded-by': userId,
          },
        },
      });

      const now = new Date().toISOString();

      this.logger.log(`Successfully uploaded batch document ${documentId}`);

      return {
        documentId,
        documentName: body.documentName,
        documentCategory: body.documentCategory,
        documentNumber: body.documentNumber,
        path: uploadResult.path,
        etag: uploadResult.etag,
        size: uploadResult.size,
        contentType: uploadResult.contentType,
        uploadedAt: now,
        uploadedBy: userId,
      };
    } catch (error) {
      // Same passthrough pattern as the chemical-document path:
      // FileUploadSecurityService policy violations are
      // BadRequestException with structured messages (size limit,
      // mime mismatch, magic-byte conflict). Let those flow back to
      // the operator unmodified; only mask actual server failures
      // behind the generic 500.
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Failed to upload batch document: ${toError(error).message}`);
      throw new InternalServerErrorException('Document storage temporarily unavailable');
    }
  }

  /**
   * Delete a batch document
   * DELETE /upload/batch-document/:entityId/:documentId/:filename
   */
  @Delete('batch-document/:entityId/:documentId/:filename')
  @ApiOperation({ summary: 'Delete a batch document' })
  @ApiParam({
    name: 'entityId',
    type: 'string',
    description: 'Batch UUID or temp entity ID from the upload response path',
  })
  @ApiParam({
    name: 'documentId',
    type: 'string',
    format: 'uuid',
    description: 'UUID of the document to delete',
  })
  @ApiParam({
    name: 'filename',
    type: 'string',
    description: 'Filename as returned by the upload endpoint',
  })
  @ApiOkResponse({
    schema: {
      properties: { success: { type: 'boolean', example: true }, message: { type: 'string' } },
    },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Document')
  async deleteBatchDocument(
    @Param('entityId') entityId: string,
    @Param('documentId') documentId: string,
    @Param('filename') filename: string,
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('Tenant context required');
    }

    // SECURITY: Validate filename starts with documentId to prevent
    // deleting arbitrary files by manipulating the filename parameter
    if (!filename.startsWith(documentId + '_')) {
      throw new BadRequestException('Invalid filename: must match the document ID');
    }

    this.logger.log(`Deleting batch document ${documentId}`);

    try {
      // Build the file path
      const path = this.minioClient.generateFilePath(
        tenantId,
        'batch-documents',
        entityId,
        filename,
      );

      // Check if file exists
      const exists = await this.minioClient.fileExists(path);
      if (!exists) {
        throw new NotFoundException('Document not found');
      }

      // Delete from MinIO
      await this.minioClient.deleteFile(path);

      this.logger.log(`Successfully deleted batch document ${documentId}`);

      return {
        success: true,
        message: 'Document deleted successfully',
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(`Failed to delete batch document ${documentId}: ${toError(error).message}`);
      throw new InternalServerErrorException('Document storage temporarily unavailable');
    }
  }

  /**
   * Get a presigned URL for downloading a document
   * POST /upload/presigned-url
   */
  @Post('presigned-url')
  @ApiOperation({
    summary: 'Generate a presigned download URL for a stored document',
    description:
      'Returns a time-limited presigned URL for client-side file download. ' +
      'The `path` must be a storage path returned by an upload endpoint and must belong to the authenticated tenant. ' +
      'Maximum expiry is 86400 seconds (24 hours).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description:
            'Storage path as returned by the upload endpoint (format: {tenantId}/{entityType}/{entityId}/{filename})',
        },
        expirySeconds: {
          type: 'number',
          minimum: 1,
          maximum: 86400,
          default: 3600,
          description: 'URL validity duration in seconds (default: 3600, max: 86400)',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Presigned URL generated successfully',
    schema: {
      properties: {
        url: { type: 'string', format: 'uri', description: 'Time-limited presigned download URL' },
        expiresAt: {
          type: 'string',
          format: 'date-time',
          description: 'UTC timestamp when the URL expires',
        },
      },
    },
  })
  @ApiStandardErrors()
  async getPresignedUrl(
    @Body() body: { path: string; expirySeconds?: number },
    @Req() req: Request,
  ): Promise<{ url: string; expiresAt: string }> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('Tenant context required');
    }

    const requestedPath = body.path;

    // SECURITY: URL-decode the path BEFORE traversal checks
    // to prevent %2e%2e bypasses
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestedPath);
    } catch {
      throw new BadRequestException('Invalid path: malformed URL encoding');
    }

    // SECURITY: Block null bytes that could be used for path injection
    if (decodedPath.includes('\0')) {
      throw new BadRequestException('Invalid path: null bytes not allowed');
    }

    // SECURITY: Path traversal prevention (after URL-decode)
    if (decodedPath.includes('..')) {
      this.logger.warn(
        `SECURITY: Path traversal attempt detected for tenant ${tenantId}: ${requestedPath}`,
      );
      throw new BadRequestException('Invalid path: path traversal not allowed');
    }

    // SECURITY: Normalize the path
    const normalizedPath = decodedPath.replace(/\/+/g, '/').replace(/^\//, '');

    // SECURITY: Validate path structure matches {tenantId}/{entityType}/{entityId}/{filename}
    const pathPattern = /^[\w-]+\/[\w-]+\/[\w-]+\/[\w._-]+$/;
    if (!pathPattern.test(normalizedPath)) {
      throw new BadRequestException(
        'Invalid path: must match {tenantId}/{entityType}/{entityId}/{filename}',
      );
    }

    // Ensure the path belongs to the tenant (security check)
    if (!normalizedPath.startsWith(tenantId + '/')) {
      throw new ForbiddenException('Access denied to this resource');
    }

    const expirySeconds = Math.min(body.expirySeconds || 3600, 86400); // Max 24 hours

    try {
      const url = await this.minioClient.getPresignedUrl(normalizedPath, {
        expirySeconds,
      });

      const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

      return { url, expiresAt };
    } catch (error) {
      this.logger.error(`Failed to generate presigned URL: ${toError(error).message}`);
      throw new InternalServerErrorException('Failed to generate download URL');
    }
  }
}
