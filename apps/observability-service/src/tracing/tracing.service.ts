import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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

// W3C traceparent validation: 32 hex chars for traceId, 16 hex chars for spanId
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/;

const MAX_LIMIT = 1000;
const MIN_LIMIT = 1;
const MAX_ERROR_STACK_LENGTH = 4096;

@Injectable()
export class TracingService implements OnModuleDestroy {
  private readonly logger = new Logger(TracingService.name);
  private activeSpans: Map<string, TraceSpan> = new Map();
  // Index completed spans by traceId for O(1) lookups
  private completedSpansByTrace: Map<string, TraceSpan[]> = new Map();
  // Track insertion order for recent-trace queries
  private completedTraceIds: string[] = [];
  private totalCompletedSpans = 0;
  private readonly maxCompletedSpans = 10000;
  private readonly activeSpanTtlMs = 5 * 60 * 1000; // 5 minutes
  private activeSpanSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Sweep stale active spans every 60 seconds
    this.activeSpanSweepTimer = setInterval(() => this.sweepStaleActiveSpans(), 60_000);
  }

  onModuleDestroy(): void {
    if (this.activeSpanSweepTimer) {
      clearInterval(this.activeSpanSweepTimer);
      this.activeSpanSweepTimer = null;
    }
  }

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
      // Truncate error stack to prevent memory abuse
      const stack = error.stack
        ? error.stack.substring(0, MAX_ERROR_STACK_LENGTH)
        : undefined;
      this.addLog(spanId, 'error', error.message, { stack });
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

      // Store in trace-indexed map
      const traceSpans = this.completedSpansByTrace.get(span.traceId);
      if (traceSpans) {
        traceSpans.push(span);
      } else {
        this.completedSpansByTrace.set(span.traceId, [span]);
        this.completedTraceIds.push(span.traceId);
      }
      this.totalCompletedSpans++;

      // Evict oldest traces if over limit
      this.evictOldTraces();

      this.logger.debug(
        `Finished span ${spanId}: ${span.operationName} (${span.duration}ms)`,
      );
    }
  }

  /**
   * Get trace by ID (O(1) lookup by traceId)
   */
  getTrace(traceId: string): TraceSpan[] {
    const activeInTrace = Array.from(this.activeSpans.values()).filter(
      (s) => s.traceId === traceId,
    );
    const completedInTrace = this.completedSpansByTrace.get(traceId) || [];
    return [...activeInTrace, ...completedInTrace].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );
  }

  /**
   * Get recent traces, including in-progress traces that have no completed spans yet.
   * Results are ordered newest-first by the most recent span start time in each trace.
   */
  getRecentTraces(limit: number = 100): TraceSpan[][] {
    const safeLimit = this.clampLimit(limit);
    const seenTraceIds = new Set<string>();
    const traces: TraceSpan[][] = [];

    // Walk completed trace IDs from newest to oldest
    for (
      let i = this.completedTraceIds.length - 1;
      i >= 0 && traces.length < safeLimit;
      i--
    ) {
      const traceId = this.completedTraceIds[i];
      if (traceId && !seenTraceIds.has(traceId)) {
        seenTraceIds.add(traceId);
        traces.push(this.getTrace(traceId));
      }
    }

    // Also include purely in-progress traces (active spans whose traceId has no
    // completed spans yet), so callers see all ongoing operations.
    if (traces.length < safeLimit) {
      const inProgressTraceIds = new Set<string>();
      for (const span of this.activeSpans.values()) {
        if (
          !seenTraceIds.has(span.traceId) &&
          !this.completedSpansByTrace.has(span.traceId)
        ) {
          inProgressTraceIds.add(span.traceId);
        }
      }
      for (const traceId of inProgressTraceIds) {
        if (traces.length >= safeLimit) break;
        seenTraceIds.add(traceId);
        traces.push(this.getTrace(traceId));
      }
    }

    return traces;
  }

  /**
   * Get slow traces (duration > threshold), sorted by duration descending
   */
  getSlowTraces(thresholdMs: number, limit: number = 50): TraceSpan[][] {
    const safeLimit = this.clampLimit(limit);

    // Collect root spans that exceeded threshold
    const slowRootSpans: TraceSpan[] = [];
    for (const spans of this.completedSpansByTrace.values()) {
      for (const s of spans) {
        if (!s.parentSpanId && s.duration !== undefined && s.duration > thresholdMs) {
          slowRootSpans.push(s);
        }
      }
    }

    // Sort by duration descending (slowest first) and take top N
    slowRootSpans.sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
    const topSlow = slowRootSpans.slice(0, safeLimit);

    return topSlow.map((s) => this.getTrace(s.traceId));
  }

  /**
   * Get error traces
   */
  getErrorTraces(limit: number = 50): TraceSpan[][] {
    const safeLimit = this.clampLimit(limit);
    const errorTraceIds = new Set<string>();
    const result: TraceSpan[][] = [];

    // Walk from newest completed traces
    for (let i = this.completedTraceIds.length - 1; i >= 0 && result.length < safeLimit; i--) {
      const traceId = this.completedTraceIds[i];
      if (traceId && !errorTraceIds.has(traceId)) {
        const spans = this.completedSpansByTrace.get(traceId);
        if (spans?.some((s) => s.status === 'error')) {
          errorTraceIds.add(traceId);
          result.push(this.getTrace(traceId));
        }
      }
    }

    return result;
  }

  /**
   * Parse trace context from headers with W3C traceparent validation
   */
  parseTraceContext(headers: Record<string, string>): TraceContext | null {
    const traceparent = headers['traceparent'];
    if (!traceparent) {
      return null;
    }

    // W3C Trace Context format: version-traceId-spanId-flags
    const parts = traceparent.split('-');
    if (parts.length < 4) {
      this.logger.warn(`Malformed traceparent: insufficient parts`);
      return null;
    }

    const traceId = parts[1];
    const spanId = parts[2];

    // Validate traceId (32 hex chars) and spanId (16 hex chars)
    if (!traceId || !TRACE_ID_REGEX.test(traceId)) {
      this.logger.warn(`Malformed traceparent: invalid traceId`);
      return null;
    }
    if (!spanId || !SPAN_ID_REGEX.test(spanId)) {
      this.logger.warn(`Malformed traceparent: invalid spanId`);
      return null;
    }

    return {
      traceId,
      spanId,
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
    return this.totalCompletedSpans;
  }

  /**
   * Evict oldest traces when total completed spans exceeds the limit
   */
  private evictOldTraces(): void {
    while (this.totalCompletedSpans > this.maxCompletedSpans && this.completedTraceIds.length > 0) {
      const oldestTraceId = this.completedTraceIds.shift();
      if (oldestTraceId) {
        const spans = this.completedSpansByTrace.get(oldestTraceId);
        if (spans) {
          this.totalCompletedSpans -= spans.length;
          this.completedSpansByTrace.delete(oldestTraceId);
        }
      }
    }
  }

  /**
   * Sweep active spans that have been running longer than the TTL
   */
  private sweepStaleActiveSpans(): void {
    const now = Date.now();
    let swept = 0;
    for (const [spanId, span] of this.activeSpans) {
      if (now - span.startTime.getTime() > this.activeSpanTtlMs) {
        this.activeSpans.delete(spanId);
        swept++;
      }
    }
    if (swept > 0) {
      this.logger.warn(`Swept ${swept} stale active spans (TTL exceeded)`);
    }
  }

  /**
   * Clamp limit to valid range [1, 1000], guard against NaN
   */
  private clampLimit(limit: number): number {
    if (isNaN(limit)) return 100;
    return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)));
  }
}
