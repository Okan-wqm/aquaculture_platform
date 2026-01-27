import { Module, Global } from '@nestjs/common';
import { TracingService } from './tracing.service';
import { TracingController } from './tracing.controller';
import { InternalApiGuard } from '../guards/internal-api.guard';

@Global()
@Module({
  controllers: [TracingController],
  providers: [TracingService, InternalApiGuard],
  exports: [TracingService],
})
export class TracingModule {}
