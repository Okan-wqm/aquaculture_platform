/**
 * Load Balancer Service
 *
 * Distributes traffic across multiple service instances.
 * Supports various load balancing algorithms and health-aware routing.
 * Provides sticky sessions and weighted distribution.
 */

import { EventEmitter } from 'events';

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Load balancing algorithms
 */
export enum LoadBalancingAlgorithm {
  ROUND_ROBIN = 'round_robin',
  LEAST_CONNECTIONS = 'least_connections',
  WEIGHTED_ROUND_ROBIN = 'weighted_round_robin',
  IP_HASH = 'ip_hash',
  RANDOM = 'random',
  LEAST_RESPONSE_TIME = 'least_response_time',
}

/**
 * Service instance health status
 */
export enum InstanceHealth {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  DEGRADED = 'degraded',
  UNKNOWN = 'unknown',
}

/**
 * Service instance configuration
 */
export interface ServiceInstance {
  id: string;
  host: string;
  port: number;
  weight?: number;
  zone?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * Service instance with runtime stats
 */
export interface ServiceInstanceStats extends ServiceInstance {
  health: InstanceHealth;
  activeConnections: number;
  totalRequests: number;
  failedRequests: number;
  avgResponseTime: number;
  lastHealthCheck?: Date;
  lastSuccessfulRequest?: Date;
  consecutiveFailures: number;
}

/**
 * Service configuration
 */
export interface ServiceConfig {
  name: string;
  instances: ServiceInstance[];
  algorithm: LoadBalancingAlgorithm;
  healthCheckInterval?: number;
  healthCheckPath?: string;
  healthCheckTimeout?: number;
  stickySession?: StickySessionConfig;
  retryConfig?: RetryConfig;
}

/**
 * Sticky session configuration
 */
export interface StickySessionConfig {
  enabled: boolean;
  cookieName?: string;
  ttlSeconds?: number;
  headerName?: string;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxRetries: number;
  retryableStatuses: number[];
  retryDelay: number;
  backoffMultiplier: number;
}

/**
 * Request context for load balancing decisions
 */
export interface LoadBalancerContext {
  clientIp?: string;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  headers?: Record<string, string>;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  instanceId: string;
  healthy: boolean;
  responseTime?: number;
  statusCode?: number;
  error?: string;
  timestamp: Date;
}

/**
 * Response time tracker for instances
 */
class ResponseTimeTracker {
  private readonly samples: number[] = [];
  private readonly maxSamples = 100;

  record(responseTime: number): void {
    this.samples.push(responseTime);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  getAverage(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  getPercentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  }

  reset(): void {
    this.samples.length = 0;
  }
}

/**
 * Load Balancer Service
 * Manages traffic distribution across service instances
 */
@Injectable()
export class LoadBalancerService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoadBalancerService.name);
  private readonly services = new Map<string, ServiceConfig>();
  private readonly instanceStats = new Map<string, ServiceInstanceStats>();
  private readonly responseTrackers = new Map<string, ResponseTimeTracker>();
  private readonly roundRobinCounters = new Map<string, number>();
  private readonly stickySessionMap = new Map<string, { instanceId: string; expiry: number }>();
  private healthCheckIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(private readonly configService: ConfigService) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Load default services from config
    await this.loadServicesFromConfig();
    this.logger.log('Load Balancer Service initialized');
  }

  onModuleDestroy(): void {
    // Clear all health check intervals
    for (const interval of this.healthCheckIntervals.values()) {
      clearInterval(interval);
    }
    this.healthCheckIntervals.clear();
  }

  /**
   * Register a service with its instances
   */
  registerService(config: ServiceConfig): void {
    this.services.set(config.name, config);

    // Initialize instance stats
    for (const instance of config.instances) {
      const statsKey = this.getInstanceKey(config.name, instance.id);
      this.instanceStats.set(statsKey, {
        ...instance,
        health: InstanceHealth.UNKNOWN,
        activeConnections: 0,
        totalRequests: 0,
        failedRequests: 0,
        avgResponseTime: 0,
        consecutiveFailures: 0,
      });
      this.responseTrackers.set(statsKey, new ResponseTimeTracker());
    }

    // Initialize round-robin counter
    this.roundRobinCounters.set(config.name, 0);

    // Start health checks
    this.startHealthChecks(config);

    this.logger.log(`Service registered: ${config.name} with ${config.instances.length} instances`);
  }

  /**
   * Unregister a service
   */
  unregisterService(serviceName: string): void {
    const config = this.services.get(serviceName);
    if (!config) return;

    // Stop health checks
    const interval = this.healthCheckIntervals.get(serviceName);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(serviceName);
    }

    // Clean up instance stats
    for (const instance of config.instances) {
      const statsKey = this.getInstanceKey(serviceName, instance.id);
      this.instanceStats.delete(statsKey);
      this.responseTrackers.delete(statsKey);
    }

    this.services.delete(serviceName);
    this.roundRobinCounters.delete(serviceName);

    this.logger.log(`Service unregistered: ${serviceName}`);
  }

  /**
   * Get next instance for a service
   */
  getNextInstance(
    serviceName: string,
    context?: LoadBalancerContext,
  ): ServiceInstanceStats | null {
    const config = this.services.get(serviceName);
    if (!config) {
      this.logger.warn(`Service not found: ${serviceName}`);
      return null;
    }

    // Check sticky session
    if (config.stickySession?.enabled && context) {
      const stickyInstance = this.getStickyInstance(serviceName, context);
      if (stickyInstance) {
        return stickyInstance;
      }
    }

    // Get healthy instances
    const healthyInstances = this.getHealthyInstances(serviceName);
    if (healthyInstances.length === 0) {
      this.logger.warn(`No healthy instances for service: ${serviceName}`);
      return null;
    }

    // Select instance based on algorithm
    let selected: ServiceInstanceStats | null = null;

    switch (config.algorithm) {
      case LoadBalancingAlgorithm.ROUND_ROBIN:
        selected = this.selectRoundRobin(serviceName, healthyInstances);
        break;

      case LoadBalancingAlgorithm.LEAST_CONNECTIONS:
        selected = this.selectLeastConnections(healthyInstances);
        break;

      case LoadBalancingAlgorithm.WEIGHTED_ROUND_ROBIN:
        selected = this.selectWeightedRoundRobin(serviceName, healthyInstances);
        break;

      case LoadBalancingAlgorithm.IP_HASH:
        selected = this.selectIpHash(context?.clientIp || '', healthyInstances);
        break;

      case LoadBalancingAlgorithm.RANDOM:
        selected = this.selectRandom(healthyInstances);
        break;

      case LoadBalancingAlgorithm.LEAST_RESPONSE_TIME:
        selected = this.selectLeastResponseTime(serviceName, healthyInstances);
        break;

      default:
        selected = this.selectRoundRobin(serviceName, healthyInstances);
    }

    // Set sticky session if enabled
    if (selected && config.stickySession?.enabled && context) {
      this.setStickySession(serviceName, context, selected.id, config.stickySession.ttlSeconds);
    }

    return selected;
  }

  /**
   * Get all instances for a service
   */
  getInstances(serviceName: string): ServiceInstanceStats[] {
    const config = this.services.get(serviceName);
    if (!config) return [];

    const instances: ServiceInstanceStats[] = [];
    for (const instance of config.instances) {
      const statsKey = this.getInstanceKey(serviceName, instance.id);
      const stats = this.instanceStats.get(statsKey);
      if (stats) {
        instances.push(stats);
      }
    }
    return instances;
  }

  /**
   * Get healthy instances for a service
   */
  getHealthyInstances(serviceName: string): ServiceInstanceStats[] {
    return this.getInstances(serviceName).filter(
      (i) => i.health === InstanceHealth.HEALTHY || i.health === InstanceHealth.DEGRADED,
    );
  }

  /**
   * Record request start (increment connection count)
   */
  recordRequestStart(serviceName: string, instanceId: string): void {
    const statsKey = this.getInstanceKey(serviceName, instanceId);
    const stats = this.instanceStats.get(statsKey);
    if (stats) {
      stats.activeConnections++;
      stats.totalRequests++;
    }
  }

  /**
   * Record request completion
   */
  recordRequestEnd(
    serviceName: string,
    instanceId: string,
    success: boolean,
    responseTime: number,
  ): void {
    const statsKey = this.getInstanceKey(serviceName, instanceId);
    const stats = this.instanceStats.get(statsKey);
    const tracker = this.responseTrackers.get(statsKey);

    if (stats) {
      stats.activeConnections = Math.max(0, stats.activeConnections - 1);

      if (success) {
        stats.consecutiveFailures = 0;
        stats.lastSuccessfulRequest = new Date();
      } else {
        stats.failedRequests++;
        stats.consecutiveFailures++;
      }

      if (tracker) {
        tracker.record(responseTime);
        stats.avgResponseTime = tracker.getAverage();
      }
    }
  }

  /**
   * Mark instance as healthy
   */
  markHealthy(serviceName: string, instanceId: string): void {
    const statsKey = this.getInstanceKey(serviceName, instanceId);
    const stats = this.instanceStats.get(statsKey);
    if (stats) {
      const previousHealth = stats.health;
      stats.health = InstanceHealth.HEALTHY;
      stats.lastHealthCheck = new Date();
      stats.consecutiveFailures = 0;

      if (previousHealth !== InstanceHealth.HEALTHY) {
        this.emit('instanceHealthChanged', {
          serviceName,
          instanceId,
          previousHealth,
          newHealth: InstanceHealth.HEALTHY,
        });
      }
    }
  }

  /**
   * Mark instance as unhealthy
   */
  markUnhealthy(serviceName: string, instanceId: string): void {
    const statsKey = this.getInstanceKey(serviceName, instanceId);
    const stats = this.instanceStats.get(statsKey);
    if (stats) {
      const previousHealth = stats.health;
      stats.health = InstanceHealth.UNHEALTHY;
      stats.lastHealthCheck = new Date();

      if (previousHealth !== InstanceHealth.UNHEALTHY) {
        this.emit('instanceHealthChanged', {
          serviceName,
          instanceId,
          previousHealth,
          newHealth: InstanceHealth.UNHEALTHY,
        });
        this.logger.warn(`Instance marked unhealthy: ${serviceName}/${instanceId}`);
      }
    }
  }

  /**
   * Add instance to a service
   */
  addInstance(serviceName: string, instance: ServiceInstance): void {
    const config = this.services.get(serviceName);
    if (!config) {
      this.logger.warn(`Cannot add instance to unknown service: ${serviceName}`);
      return;
    }

    // Check if instance already exists
    if (config.instances.some((i) => i.id === instance.id)) {
      this.logger.warn(`Instance already exists: ${serviceName}/${instance.id}`);
      return;
    }

    config.instances.push(instance);

    const statsKey = this.getInstanceKey(serviceName, instance.id);
    this.instanceStats.set(statsKey, {
      ...instance,
      health: InstanceHealth.UNKNOWN,
      activeConnections: 0,
      totalRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
      consecutiveFailures: 0,
    });
    this.responseTrackers.set(statsKey, new ResponseTimeTracker());

    this.logger.log(`Instance added: ${serviceName}/${instance.id}`);
    this.emit('instanceAdded', { serviceName, instance });
  }

  /**
   * Remove instance from a service
   */
  removeInstance(serviceName: string, instanceId: string): void {
    const config = this.services.get(serviceName);
    if (!config) return;

    const index = config.instances.findIndex((i) => i.id === instanceId);
    if (index === -1) return;

    config.instances.splice(index, 1);

    const statsKey = this.getInstanceKey(serviceName, instanceId);
    this.instanceStats.delete(statsKey);
    this.responseTrackers.delete(statsKey);

    this.logger.log(`Instance removed: ${serviceName}/${instanceId}`);
    this.emit('instanceRemoved', { serviceName, instanceId });
  }

  /**
   * Get service statistics
   */
  getServiceStats(serviceName: string): {
    totalInstances: number;
    healthyInstances: number;
    totalRequests: number;
    failedRequests: number;
    avgResponseTime: number;
  } | null {
    const instances = this.getInstances(serviceName);
    if (instances.length === 0) return null;

    const healthyCount = instances.filter((i) => i.health === InstanceHealth.HEALTHY).length;
    const totalRequests = instances.reduce((sum, i) => sum + i.totalRequests, 0);
    const failedRequests = instances.reduce((sum, i) => sum + i.failedRequests, 0);
    const avgResponseTime =
      instances.reduce((sum, i) => sum + i.avgResponseTime, 0) / instances.length;

    return {
      totalInstances: instances.length,
      healthyInstances: healthyCount,
      totalRequests,
      failedRequests,
      avgResponseTime,
    };
  }

  // ============ Private Methods ============

  private getInstanceKey(serviceName: string, instanceId: string): string {
    return `${serviceName}:${instanceId}`;
  }

  private selectRoundRobin(
    serviceName: string,
    instances: ServiceInstanceStats[],
  ): ServiceInstanceStats {
    const counter = this.roundRobinCounters.get(serviceName) || 0;
    const selected = instances[counter % instances.length] as ServiceInstanceStats;
    this.roundRobinCounters.set(serviceName, counter + 1);
    return selected;
  }

  private selectLeastConnections(instances: ServiceInstanceStats[]): ServiceInstanceStats {
    return instances.reduce((min, instance) =>
      instance.activeConnections < min.activeConnections ? instance : min,
    );
  }

  private selectWeightedRoundRobin(
    serviceName: string,
    instances: ServiceInstanceStats[],
  ): ServiceInstanceStats {
    const totalWeight = instances.reduce((sum, i) => sum + (i.weight || 1), 0);
    const counter = this.roundRobinCounters.get(serviceName) || 0;
    const targetWeight = counter % totalWeight;

    let currentWeight = 0;
    for (const instance of instances) {
      currentWeight += instance.weight || 1;
      if (currentWeight > targetWeight) {
        this.roundRobinCounters.set(serviceName, counter + 1);
        return instance;
      }
    }

    this.roundRobinCounters.set(serviceName, counter + 1);
    return instances[0] as ServiceInstanceStats;
  }

  private selectIpHash(clientIp: string, instances: ServiceInstanceStats[]): ServiceInstanceStats {
    let hash = 0;
    for (let i = 0; i < clientIp.length; i++) {
      const char = clientIp.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    const index = Math.abs(hash) % instances.length;
    return instances[index] as ServiceInstanceStats;
  }

  private selectRandom(instances: ServiceInstanceStats[]): ServiceInstanceStats {
    const index = Math.floor(Math.random() * instances.length);
    return instances[index] as ServiceInstanceStats;
  }

  private selectLeastResponseTime(
    serviceName: string,
    instances: ServiceInstanceStats[],
  ): ServiceInstanceStats {
    // Filter instances with response time data
    const instancesWithData = instances.filter((i) => i.avgResponseTime > 0);

    if (instancesWithData.length === 0) {
      // Fall back to round-robin if no data
      return this.selectRoundRobin(serviceName, instances);
    }

    return instancesWithData.reduce((min, instance) =>
      instance.avgResponseTime < min.avgResponseTime ? instance : min,
    );
  }

  private getStickyInstance(
    serviceName: string,
    context: LoadBalancerContext,
  ): ServiceInstanceStats | null {
    const sessionKey = this.buildStickySessionKey(serviceName, context);
    const session = this.stickySessionMap.get(sessionKey);

    if (!session || session.expiry < Date.now()) {
      this.stickySessionMap.delete(sessionKey);
      return null;
    }

    const statsKey = this.getInstanceKey(serviceName, session.instanceId);
    const stats = this.instanceStats.get(statsKey);

    // Only return if instance is healthy
    if (stats && stats.health === InstanceHealth.HEALTHY) {
      return stats;
    }

    // Clear stale session
    this.stickySessionMap.delete(sessionKey);
    return null;
  }

  private setStickySession(
    serviceName: string,
    context: LoadBalancerContext,
    instanceId: string,
    ttlSeconds = 3600,
  ): void {
    const sessionKey = this.buildStickySessionKey(serviceName, context);
    this.stickySessionMap.set(sessionKey, {
      instanceId,
      expiry: Date.now() + ttlSeconds * 1000,
    });
  }

  private buildStickySessionKey(serviceName: string, context: LoadBalancerContext): string {
    const identifier = context.sessionId || context.userId || context.clientIp || 'anonymous';
    return `${serviceName}:${identifier}`;
  }

  private startHealthChecks(config: ServiceConfig): void {
    const interval = config.healthCheckInterval || 30000;
    const healthCheckPath = config.healthCheckPath || '/health';
    const timeout = config.healthCheckTimeout || 5000;

    const intervalId = setInterval(async () => {
      for (const instance of config.instances) {
        await this.performHealthCheck(config.name, instance, healthCheckPath, timeout);
      }
    }, interval);

    this.healthCheckIntervals.set(config.name, intervalId);

    // Perform initial health check
    for (const instance of config.instances) {
      this.performHealthCheck(config.name, instance, healthCheckPath, timeout);
    }
  }

  private async performHealthCheck(
    serviceName: string,
    instance: ServiceInstance,
    healthCheckPath: string,
    timeout: number,
  ): Promise<void> {
    const url = `http://${instance.host}:${instance.port}${healthCheckPath}`;
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseTime = Date.now() - startTime;

      if (response.ok) {
        this.markHealthy(serviceName, instance.id);
      } else {
        this.markUnhealthy(serviceName, instance.id);
      }

      const result: HealthCheckResult = {
        instanceId: instance.id,
        healthy: response.ok,
        responseTime,
        statusCode: response.status,
        timestamp: new Date(),
      };

      this.emit('healthCheck', { serviceName, result });
    } catch (error) {
      this.markUnhealthy(serviceName, instance.id);

      const result: HealthCheckResult = {
        instanceId: instance.id,
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };

      this.emit('healthCheck', { serviceName, result });
    }
  }

  private async loadServicesFromConfig(): Promise<void> {
    // Load services from environment/config
    const servicesConfig = this.configService.get<string>('LOAD_BALANCER_SERVICES', '');

    if (!servicesConfig) return;

    try {
      const services = JSON.parse(servicesConfig) as ServiceConfig[];
      for (const service of services) {
        this.registerService(service);
      }
    } catch (error) {
      this.logger.warn('Failed to parse load balancer services config', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

/**
 * Create a simple hash from string
 */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}
