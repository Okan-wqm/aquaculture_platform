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
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class UploadModule {}
