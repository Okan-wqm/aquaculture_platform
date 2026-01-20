import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Process } from './entities/process.entity';
import { ProcessService } from './services/process.service';
import { ProcessResolver } from './resolvers/process.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([Process])],
  providers: [ProcessService, ProcessResolver],
  exports: [ProcessService],
})
export class ProcessModule {}
