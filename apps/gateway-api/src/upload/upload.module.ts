/**
 * Upload Module
 * Provides file upload functionality via REST endpoints
 * @module Upload
 */
import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';

@Module({
  controllers: [UploadController],
})
export class UploadModule {}
