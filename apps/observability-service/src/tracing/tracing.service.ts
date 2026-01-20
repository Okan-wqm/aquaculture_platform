import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  service: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  status: 'started' | 'completed' | 'error';
  tags: Record<string, string>;
  logs: SpanLog[];
}

export interface SpanLog {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);
  private activeSpans: Map<string, TraceSpan> = new Map();
  private completedSpans: TraceSpan[] = [];
  private readonly maxCompletedSpans = 10000;

  /**
   * Start a new trace
   */
  startTrace(operationName: string, service: string): TraceContext {
    const traceId = randomUUID();
    const spanId = randomUUID();

    const span: TraceSpan = {
      traceId,
      spanId,
      operationName,
      service,
      startTime: new Date(),
      status: 'started',
      tags: {},
      logs: [],
    };

    this.activeSpans.set(spanId, span);
    this.logger.debug(`Started trace ${traceId}, span ${spanId}: ${operationName}`);

    return {
      traceId,
      spanId,
      sampled: true,
    };
  }

  /**
   * Start a child span
   */
  startSpan(
    context: TraceContext,
    operationName: string,
    service: string,
  ): TraceContext {
    const spanId = randomUUID();

    const span: TraceSpan = {
      traceId: context.traceId,
      spanId,
      parentSpanId: context.spanId,
      operationName,
      service,
      startTime: new Date(),
      status: 'started',
      tags: {},
      logs: [],
    };

    this.activeSpans.set(spanId, span);
    this.logger.debug(`Started span ${spanId}: ${operationName}`);

    return {
      traceId: context.traceId,
      spanId,
      sampled: context.sampled,
    };
  }

  /**
   * Add tags to a span
   */
  addTags(spanId: string, tags: Record<string, string>): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.tags = { ...span.tags, ...tags };
    }
  }

  /**
   * Add a log entry to a span
   */
  addLog(
    spanId: string,
    level: SpanLog['level'],
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.logs.push({
        timestamp: new Date(),
        level,
        message,
        fields,
      });
    }
  }

  /**
   * Mark span as error
   */
  setError(spanId: string, error: Error): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.status = 'error';
      span.tags['error'] = 'true';
      span.tags['error.message'] = error.message;
      this.addLog(spanId, 'error', error.message, {
        stack: error.stack,
      });
    }
  }

  /**
   * Complete a span
   */
  finishSpan(spanId: string): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.endTime = new Date();
      span.duration = span.endTime.getTime() - span.startTime.getTime();
      if (span.status !== 'error') {
        span.status = 'completed';
      }

      this.activeSpans.delete(spanId);
      this.completedSpans.push(span);

      // Trim completed spans if too many
      if (this.completedSpans.length > this.maxCompletedSpans) {
        this.completedSpans = this.completedSpans.slice(-this.maxCompletedSpans / 2);
      }

      this.logger.debug(
        `Finished span ${spanId}: ${span.operationName} (${span.duration}ms)`,
      );
    }
  }

  /**
   * Get trace by ID
   */
  getTrace(traceId: string): TraceSpan[] {
    const activeInTrace = Array.from(this.activeSpans.values()).filter(
      (s) => s.traceId === traceId,
    );
    const completedInTrace = this.completedSpans.filter(
      (s) => s.traceId === traceId,
    );
    return [...activeInTrace, ...completedInTrace].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );
  }

  /**
   * Get recent traces
   */
  getRecentTraces(limit: number = 100): TraceSpan[][] {
    const traceIds = new Set<string>();
    const traces: Map<string, TraceSpan[]> = new Map();

    // Collect unique trace IDs from completed spans (newest first)
    for (let i = this.completedSpans.length - 1; i >= 0 && traceIds.size < limit; i--) {
      const span = this.completedSpans[i];
      if (span) {
        traceIds.add(span.traceId);
      }
    }

    // Group spans by trace ID
    traceIds.forEach((traceId) => {
      traces.set(traceId, this.getTrace(traceId));
    });

    return Array.from(traces.values());
  }

  /**
   * Get slow traces (duration > threshold)
   */
  getSlowTraces(thresholdMs: number, limit: number = 50): TraceSpan[][] {
    const slowTraceIds = new Set<string>();

    // Find root spans that exceeded threshold
    this.completedSpans
      .filter(
        (s) =>
          !s.parentSpanId && s.duration !== undefined && s.duration > thresholdMs,
      )
      .slice(-limit)
      .forEach((s) => slowTraceIds.add(s.traceId));

    return Array.from(slowTraceIds).map((traceId) => this.getTrace(traceId));
  }

  /**
   * Get error traces
   */
  getErrorTraces(limit: number = 50): TraceSpan[][] {
    const errorTraceIds = new Set<string>();

    this.completedSpans
      .filter((s) => s.status === 'error')
      .slice(-limit)
      .forEach((s) => errorTraceIds.add(s.traceId));

    return Array.from(errorTraceIds).map((traceId) => this.getTrace(traceId));
  }

  /**
   * Parse trace context from headers
   */
  parseTraceContext(headers: Record<string, string>): TraceContext | null {
    const traceparent = headers['traceparent'];
    if (!traceparent) {
      return null;
    }

    // W3C Trace Context format: version-traceId-spanId-flags
    const parts = traceparent.split('-');
    if (parts.length < 4) {
      return null;
    }

    return {
      traceId: parts[1] || randomUUID(),
      spanId: parts[2] || randomUUID(),
      sampled: parts[3] === '01',
    };
  }

  /**
   * Create traceparent header
   */
  createTraceparentHeader(context: TraceContext): string {
    return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
  }

  /**
   * Get active span count
   */
  getActiveSpanCount(): number {
    return this.activeSpans.size;
  }

  /**
   * Get completed span count
   */
  getCompletedSpanCount(): number {
    return this.completedSpans.length;
  }
}
