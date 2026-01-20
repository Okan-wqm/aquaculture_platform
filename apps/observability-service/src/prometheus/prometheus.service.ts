import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as client from 'prom-client';

export interface ServiceMetric {
  service: string;
  tenantId?: string;
  labels: Record<string, string>;
  value: number;
  timestamp: Date;
}

@Injectable()
export class PrometheusService implements OnModuleInit {
  private readonly logger = new Logger(PrometheusService.name);
  private registry: client.Registry;

  // Platform metrics
  private httpRequestDuration!: client.Histogram;
  private httpRequestsTotal!: client.Counter;
  private httpRequestsInFlight!: client.Gauge;
  private activeConnections!: client.Gauge;

  // Business metrics
  private tenantCount!: client.Gauge;
  private activeUsers!: client.Gauge;
  private sensorReadings!: client.Counter;
  private alertsTriggered!: client.Counter;
  private eventProcessed!: client.Counter;

  // Resource metrics
  private memoryUsage!: client.Gauge;
  private cpuUsage!: client.Gauge;
  private dbConnectionPool!: client.Gauge;

  constructor() {
    this.registry = new client.Registry();
  }

  onModuleInit(): void {
    this.initializeMetrics();
    this.startDefaultMetrics();
    this.logger.log('Prometheus metrics initialized');
  }

  private initializeMetrics(): void {
    // HTTP metrics
    this.httpRequestDuration = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code', 'service'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code', 'service'],
      registers: [this.registry],
    });

    this.httpRequestsInFlight = new client.Gauge({
      name: 'http_requests_in_flight',
      help: 'Number of HTTP requests currently being processed',
      labelNames: ['service'],
      registers: [this.registry],
    });

    this.activeConnections = new client.Gauge({
      name: 'active_connections',
      help: 'Number of active WebSocket/SSE connections',
      labelNames: ['service', 'type'],
      registers: [this.registry],
    });

    // Business metrics
    this.tenantCount = new client.Gauge({
      name: 'aquaculture_tenants_total',
      help: 'Total number of tenants by status',
      labelNames: ['status', 'tier'],
      registers: [this.registry],
    });

    this.activeUsers = new client.Gauge({
      name: 'aquaculture_active_users',
      help: 'Number of active users',
      labelNames: ['tenant_id', 'role'],
      registers: [this.registry],
    });

    this.sensorReadings = new client.Counter({
      name: 'aquaculture_sensor_readings_total',
      help: 'Total number of sensor readings processed',
      labelNames: ['tenant_id', 'sensor_type', 'farm_id'],
      registers: [this.registry],
    });

    this.alertsTriggered = new client.Counter({
      name: 'aquaculture_alerts_triggered_total',
      help: 'Total number of alerts triggered',
      labelNames: ['tenant_id', 'severity', 'rule_type'],
      registers: [this.registry],
    });

    this.eventProcessed = new client.Counter({
      name: 'aquaculture_events_processed_total',
      help: 'Total number of domain events processed',
      labelNames: ['event_type', 'service'],
      registers: [this.registry],
    });

    // Resource metrics
    this.memoryUsage = new client.Gauge({
      name: 'service_memory_bytes',
      help: 'Memory usage in bytes',
      labelNames: ['service', 'type'],
      registers: [this.registry],
    });

    this.cpuUsage = new client.Gauge({
      name: 'service_cpu_usage',
      help: 'CPU usage percentage',
      labelNames: ['service'],
      registers: [this.registry],
    });

    this.dbConnectionPool = new client.Gauge({
      name: 'db_connection_pool',
      help: 'Database connection pool status',
      labelNames: ['service', 'state'],
      registers: [this.registry],
    });
  }

  private startDefaultMetrics(): void {
    client.collectDefaultMetrics({
      register: this.registry,
      prefix: 'nodejs_',
    });
  }

  /**
   * Get all metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get metrics content type
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Record HTTP request metrics
   */
  recordHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    duration: number,
    service: string,
  ): void {
    const labels = { method, route, status_code: String(statusCode), service };
    this.httpRequestDuration.observe(labels, duration);
    this.httpRequestsTotal.inc(labels);
  }

  /**
   * Update in-flight requests
   */
  updateInFlightRequests(service: string, delta: number): void {
    if (delta > 0) {
      this.httpRequestsInFlight.inc({ service }, delta);
    } else {
      this.httpRequestsInFlight.dec({ service }, Math.abs(delta));
    }
  }

  /**
   * Set tenant count
   */
  setTenantCount(status: string, tier: string, count: number): void {
    this.tenantCount.set({ status, tier }, count);
  }

  /**
   * Set active users count
   */
  setActiveUsers(tenantId: string, role: string, count: number): void {
    this.activeUsers.set({ tenant_id: tenantId, role }, count);
  }

  /**
   * Record sensor reading
   */
  recordSensorReading(
    tenantId: string,
    sensorType: string,
    farmId: string,
  ): void {
    this.sensorReadings.inc({
      tenant_id: tenantId,
      sensor_type: sensorType,
      farm_id: farmId,
    });
  }

  /**
   * Record alert triggered
   */
  recordAlert(tenantId: string, severity: string, ruleType: string): void {
    this.alertsTriggered.inc({
      tenant_id: tenantId,
      severity,
      rule_type: ruleType,
    });
  }

  /**
   * Record event processed
   */
  recordEvent(eventType: string, service: string): void {
    this.eventProcessed.inc({ event_type: eventType, service });
  }

  /**
   * Update memory usage
   */
  setMemoryUsage(service: string, heapUsed: number, rss: number): void {
    this.memoryUsage.set({ service, type: 'heap_used' }, heapUsed);
    this.memoryUsage.set({ service, type: 'rss' }, rss);
  }

  /**
   * Update CPU usage
   */
  setCpuUsage(service: string, usage: number): void {
    this.cpuUsage.set({ service }, usage);
  }

  /**
   * Update database connection pool status
   */
  setDbConnectionPool(
    service: string,
    active: number,
    idle: number,
    waiting: number,
  ): void {
    this.dbConnectionPool.set({ service, state: 'active' }, active);
    this.dbConnectionPool.set({ service, state: 'idle' }, idle);
    this.dbConnectionPool.set({ service, state: 'waiting' }, waiting);
  }

  /**
   * Set active connections
   */
  setActiveConnections(service: string, type: string, count: number): void {
    this.activeConnections.set({ service, type }, count);
  }

  /**
   * Reset all metrics (for testing)
   */
  resetMetrics(): void {
    this.registry.resetMetrics();
    this.logger.warn('All metrics have been reset');
  }
}
