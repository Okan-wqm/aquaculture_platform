import { Controller, Get, Param, Query } from '@nestjs/common';
import { TracingService, TraceSpan } from './tracing.service';

@Controller('traces')
export class TracingController {
  constructor(private readonly tracingService: TracingService) {}

  @Get()
  getRecentTraces(@Query('limit') limit?: string): TraceSpan[][] {
    return this.tracingService.getRecentTraces(
      limit ? parseInt(limit, 10) : 100,
    );
  }

  @Get('slow')
  getSlowTraces(
    @Query('threshold') threshold?: string,
    @Query('limit') limit?: string,
  ): TraceSpan[][] {
    return this.tracingService.getSlowTraces(
      threshold ? parseInt(threshold, 10) : 1000,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('errors')
  getErrorTraces(@Query('limit') limit?: string): TraceSpan[][] {
    return this.tracingService.getErrorTraces(limit ? parseInt(limit, 10) : 50);
  }

  @Get('stats')
  getTraceStats() {
    return {
      activeSpans: this.tracingService.getActiveSpanCount(),
      completedSpans: this.tracingService.getCompletedSpanCount(),
    };
  }

  @Get(':traceId')
  getTrace(@Param('traceId') traceId: string): TraceSpan[] {
    return this.tracingService.getTrace(traceId);
  }
}
