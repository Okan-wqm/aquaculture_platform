import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Process } from './entities/process.entity';
import { ProcessResolver } from './resolvers/process.resolver';
import { ProcessService } from './services/process.service';

@Module({
  imports: [TypeOrmModule.forFeature([Process])],
  providers: [ProcessService, ProcessResolver],
  exports: [ProcessService],
})
export class ProcessModule {}
