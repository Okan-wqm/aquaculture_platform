import { Module, Global } from '@nestjs/common';
import { TracingService } from './tracing.service';
import { TracingController } from './tracing.controller';

@Global()
@Module({
  controllers: [TracingController],
  providers: [TracingService],
  exports: [TracingService],
})
export class TracingModule {}
