/**
 * Upload Controller
 * Handles file upload operations for the platform
 * @module Upload
 */
import { randomUUID } from 'crypto';

import {
  Controller,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
  NotFoundException,
  Logger,
  Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MinioClientService, UploadResult } from '@platform/storage';
import { Request } from 'express';

import { AuthGuard, AuthenticatedRequest } from '../guards/auth.guard';

import {
  UploadBatchDocumentDto,
  BatchDocumentCategory,
} from './dto/upload-batch-document.dto';
import {
  UploadChemicalDocumentDto,
  ChemicalDocumentType,
} from './dto/upload-chemical-document.dto';

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
interface ChemicalDocumentUploadResponse extends UploadResult {
  documentId: string;
  documentName: string;
  documentType: ChemicalDocumentType;
  uploadedAt: string;
  uploadedBy: string;
}

/**
 * Response for batch document upload
 */
interface BatchDocumentUploadResponse extends UploadResult {
  documentId: string;
  documentName: string;
  documentCategory: BatchDocumentCategory;
  documentNumber?: string;
  uploadedAt: string;
  uploadedBy: string;
}

@Controller('upload')
@UseGuards(AuthGuard)
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  constructor(private readonly minioClient: MinioClientService) {}

  /**
   * Upload a document for a chemical
   * POST /upload/chemical-document
   */
  @Post('chemical-document')
  @UseInterceptors(FileInterceptor('file'))
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
      throw new BadRequestException('User not authenticated');
    }

    const tenantId = user.tenantId;
    const userId = user.sub;

    if (!tenantId) {
      throw new BadRequestException('Tenant context required');
    }

    this.logger.log(
      `Uploading chemical document: ${body.documentName} for chemical ${body.chemicalId}`,
    );

    // Generate unique document ID
    const documentId = randomUUID();

    // Create a unique filename with the document ID
    const fileExtension = file.originalname.split('.').pop() || 'pdf';
    const safeDocName = body.documentName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filename = `${documentId}_${safeDocName}.${fileExtension}`;

    try {
      // Upload to MinIO
      const uploadResult = await this.minioClient.uploadFile(
        tenantId,
        'chemicals',
        body.chemicalId,
        filename,
        file.buffer,
        {
          contentType: file.mimetype,
          metadata: {
            'x-amz-meta-document-id': documentId,
            'x-amz-meta-document-name': body.documentName,
            'x-amz-meta-document-type': body.documentType,
            'x-amz-meta-chemical-id': body.chemicalId,
            'x-amz-meta-uploaded-by': userId,
          },
        },
      );

      const now = new Date().toISOString();

      this.logger.log(
        `Successfully uploaded document ${documentId} for chemical ${body.chemicalId}`,
      );

      return {
        ...uploadResult,
        documentId,
        documentName: body.documentName,
        documentType: body.documentType,
        uploadedAt: now,
        uploadedBy: userId,
      };
    } catch (error) {
      this.logger.error(
        `Failed to upload document for chemical ${body.chemicalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('Failed to upload document');
    }
  }

  /**
   * Delete a document from a chemical
   * DELETE /upload/chemical-document/:chemicalId/:documentId
   */
  @Delete('chemical-document/:chemicalId/:documentId/:filename')
  async deleteChemicalDocument(
    @Param('chemicalId') chemicalId: string,
    @Param('documentId') documentId: string,
    @Param('filename') filename: string,
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new BadRequestException('User not authenticated');
    }

    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new BadRequestException('Tenant context required');
    }

    this.logger.log(
      `Deleting document ${documentId} from chemical ${chemicalId}`,
    );

    try {
      // Build the file path
      const path = this.minioClient.generateFilePath(
        tenantId,
        'chemicals',
        chemicalId,
        filename,
      );

      // Check if file exists
      const exists = await this.minioClient.fileExists(path);
      if (!exists) {
        throw new NotFoundException('Document not found');
      }

      // Delete from MinIO
      await this.minioClient.deleteFile(path);

      this.logger.log(
        `Successfully deleted document ${documentId} from chemical ${chemicalId}`,
      );

      return {
        success: true,
        message: 'Document deleted successfully',
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(
        `Failed to delete document ${documentId} from chemical ${chemicalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('Failed to delete document');
    }
  }

  /**
   * Upload a document for a batch (health certificates, import documents)
   * POST /upload/batch-document
   */
  @Post('batch-document')
  @UseInterceptors(FileInterceptor('file'))
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
      throw new BadRequestException('User not authenticated');
    }

    const tenantId = user.tenantId;
    const userId = user.sub;

    if (!tenantId) {
      throw new BadRequestException('Tenant context required');
    }

    this.logger.log(
      `Uploading batch document: ${body.documentName} (${body.documentCategory})`,
    );

    // Generate unique document ID
    const documentId = randomUUID();

    // Create a unique filename with the document ID
    const fileExtension = file.originalname.split('.').pop() || 'pdf';
    const safeDocName = body.documentName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filename = `${documentId}_${safeDocName}.${fileExtension}`;

    // Use batchId if provided, otherwise use temp storage with documentId
    const entityId = body.batchId || `temp_${documentId}`;

    try {
      // Upload to MinIO
      const uploadResult = await this.minioClient.uploadFile(
        tenantId,
        'batch-documents',
        entityId,
        filename,
        file.buffer,
        {
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
      );

      const now = new Date().toISOString();

      this.logger.log(
        `Successfully uploaded batch document ${documentId}`,
      );

      return {
        ...uploadResult,
        documentId,
        documentName: body.documentName,
        documentCategory: body.documentCategory,
        documentNumber: body.documentNumber,
        uploadedAt: now,
        uploadedBy: userId,
      };
    } catch (error) {
      this.logger.error(
        `Failed to upload batch document: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('Failed to upload document');
    }
  }

  /**
   * Delete a batch document
   * DELETE /upload/batch-document/:entityId/:documentId/:filename
   */
  @Delete('batch-document/:entityId/:documentId/:filename')
  async deleteBatchDocument(
    @Param('entityId') entityId: string,
    @Param('documentId') documentId: string,
    @Param('filename') filename: string,
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new BadRequestException('User not authenticated');
    }

    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new BadRequestException('Tenant context required');
    }

    this.logger.log(
      `Deleting batch document ${documentId}`,
    );

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

      this.logger.log(
        `Successfully deleted batch document ${documentId}`,
      );

      return {
        success: true,
        message: 'Document deleted successfully',
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      this.logger.error(
        `Failed to delete batch document ${documentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException('Failed to delete document');
    }
  }

  /**
   * Get a presigned URL for downloading a document
   * POST /upload/presigned-url
   */
  @Post('presigned-url')
  async getPresignedUrl(
    @Body() body: { path: string; expirySeconds?: number },
    @Req() req: Request,
  ): Promise<{ url: string; expiresAt: string }> {
    const authReq = req as AuthenticatedRequest;
    const user = authReq.user;

    if (!user) {
      throw new BadRequestException('User not authenticated');
    }

    const tenantId = user.tenantId;
    const requestedPath = body.path;

    // SECURITY: Path traversal prevention
    // Block any path containing ".." to prevent directory traversal attacks
    if (requestedPath.includes('..')) {
      this.logger.warn(
        `SECURITY: Path traversal attempt detected for tenant ${tenantId}: ${requestedPath}`,
      );
      throw new BadRequestException('Invalid path: path traversal not allowed');
    }

    // SECURITY: Block null bytes that could be used for path injection
    if (requestedPath.includes('\0')) {
      throw new BadRequestException('Invalid path: null bytes not allowed');
    }

    // SECURITY: Normalize and validate the path
    const normalizedPath = requestedPath.replace(/\/+/g, '/').replace(/^\//, '');

    // Ensure the path belongs to the tenant (security check)
    if (!normalizedPath.startsWith(tenantId + '/')) {
      throw new BadRequestException('Access denied to this resource');
    }

    const expirySeconds = Math.min(body.expirySeconds || 3600, 86400); // Max 24 hours

    try {
      const url = await this.minioClient.getPresignedUrl(normalizedPath, {
        expirySeconds,
      });

      const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

      return { url, expiresAt };
    } catch (error) {
      this.logger.error(`Failed to generate presigned URL: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException('Failed to generate download URL');
    }
  }
}
