import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FarmDocument } from './entities/farm-document.entity';

@Module({
  imports: [TypeOrmModule.forFeature([FarmDocument])],
  exports: [TypeOrmModule],
})
export class FarmDocumentModule {}
