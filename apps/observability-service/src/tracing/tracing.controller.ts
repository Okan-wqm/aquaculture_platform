import { Controller, Get, Param, Query, BadRequestException } from '@nestjs/common';
import { TracingService, TraceSpan } from './tracing.service';

const MAX_LIMIT = 1000;
const MIN_LIMIT = 1;

/**
 * Parse and validate an integer query parameter.
 * Returns the default value when the param is absent.
 * Throws BadRequestException for non-numeric or out-of-range values.
 */
function parseIntParam(
  raw: string | undefined,
  defaultValue: number,
  min: number = MIN_LIMIT,
  max: number = MAX_LIMIT,
): number {
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || !isFinite(parsed)) {
    throw new BadRequestException(`Query parameter must be a valid integer`);
  }
  if (parsed < min || parsed > max) {
    throw new BadRequestException(
      `Query parameter must be between ${min} and ${max}`,
    );
  }
  return parsed;
}

@Controller('traces')
export class TracingController {
  constructor(private readonly tracingService: TracingService) {}

  @Get()
  getRecentTraces(@Query('limit') limit?: string): TraceSpan[][] {
    return this.tracingService.getRecentTraces(parseIntParam(limit, 100));
  }

  @Get('slow')
  getSlowTraces(
    @Query('threshold') threshold?: string,
    @Query('limit') limit?: string,
  ): TraceSpan[][] {
    return this.tracingService.getSlowTraces(
      parseIntParam(threshold, 1000, 1, 600_000),
      parseIntParam(limit, 50),
    );
  }

  @Get('errors')
  getErrorTraces(@Query('limit') limit?: string): TraceSpan[][] {
    return this.tracingService.getErrorTraces(parseIntParam(limit, 50));
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
