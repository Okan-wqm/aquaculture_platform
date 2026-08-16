import * as crypto from 'crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import {
  executeQueryResultNormalized,
  executeQueryRowsNormalized,
} from '../../database/query-result-normalizer';
import {
  IGdprService,
  DataExportResult,
  DataDeletionOptions,
  DataDeletionResult,
  ProcessingStatus,
} from '../interfaces';

import {
  GdprDataRequest,
  DataRequestType,
  DataRequestStatus,
} from './entities/data-request.entity';

/**
 * GDPR Service
 *
 * Implements GDPR data subject rights:
 * - Right to Access (Article 15)
 * - Right to Rectification (Article 16)
 * - Right to Erasure (Article 17)
 * - Right to Restriction (Article 18)
 * - Right to Data Portability (Article 20)
 *
 * SOLID Principles:
 * - Single Responsibility: Handles GDPR compliance
 * - Interface Segregation: Implements IGdprService
 * - Open/Closed: Extensible via data collectors
 */
@Injectable()
export class GdprService implements IGdprService {
  private readonly logger = new Logger(GdprService.name);

  // Tables to export for each entity type
  private readonly dataCollectors: Map<string, DataCollector> = new Map();

  constructor(
    @InjectRepository(GdprDataRequest)
    private readonly requestRepository: Repository<GdprDataRequest>,
    private readonly dataSource: DataSource,
  ) {
    // Register default data collectors
    this.registerDefaultCollectors();
  }

  /**
   * Export all user data (Right to Access / Data Portability)
   */
  async exportUserData(userId: string, format: 'json' | 'csv' = 'json'): Promise<DataExportResult> {
    this.logger.log(`Starting data export for user ${userId}`);

    // Create request record
    const request = await this.createRequest(userId, DataRequestType.EXPORT);

    try {
      // Collect all user data
      const data: Record<string, unknown> = {};

      for (const [name, collector] of this.dataCollectors) {
        try {
          const collectedData = await collector.collect(userId);
          if (collectedData && Object.keys(collectedData).length > 0) {
            data[name] = collectedData;
          }
        } catch (error) {
          this.logger.error(`Failed to collect ${name} data: ${(error as Error).message}`);
        }
      }

      // Mark request as completed
      await this.completeRequest(request.id, {
        recordsAffected: Object.keys(data).length,
      });

      const result: DataExportResult = {
        requestId: request.id,
        userId,
        format,
        data,
        generatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      };

      this.logger.log(
        `Data export completed for user ${userId}: ${Object.keys(data).length} categories`,
      );

      return result;
    } catch (error) {
      await this.failRequest(request.id, (error as Error).message);
      throw error;
    }
  }

  /**
   * Delete all user data (Right to Erasure)
   */
  async deleteUserData(
    userId: string,
    options: DataDeletionOptions = {},
  ): Promise<DataDeletionResult> {
    this.logger.log(`Starting data deletion for user ${userId}`);

    // Create request record
    const request = await this.createRequest(userId, DataRequestType.DELETION, {
      options,
    });

    try {
      let totalDeleted = 0;
      const errors: string[] = [];

      // Delete data from each collector
      for (const [name, collector] of this.dataCollectors) {
        if (collector.delete) {
          try {
            const deleted = await collector.delete(userId, options);
            totalDeleted += deleted;
          } catch (error) {
            errors.push(`${name}: ${(error as Error).message}`);
            this.logger.error(`Failed to delete ${name} data: ${(error as Error).message}`);
          }
        }
      }

      // Determine final status
      const status =
        errors.length === 0
          ? DataRequestStatus.COMPLETED
          : totalDeleted > 0
            ? DataRequestStatus.COMPLETED
            : DataRequestStatus.FAILED;

      await this.requestRepository.update(request.id, {
        status,
        recordsAffected: totalDeleted,
        processedAt: new Date(),
        errorMessage: errors.length > 0 ? errors.join('; ') : null,
      });

      const result: DataDeletionResult = {
        requestId: request.id,
        userId,
        status: status === DataRequestStatus.COMPLETED ? 'completed' : 'failed',
        deletedRecords: totalDeleted,
        errors: errors.length > 0 ? errors : undefined,
      };

      this.logger.log(`Data deletion completed for user ${userId}: ${totalDeleted} records`);

      return result;
    } catch (error) {
      await this.failRequest(request.id, (error as Error).message);
      throw error;
    }
  }

  /**
   * Anonymize user data
   */
  async anonymizeUserData(userId: string): Promise<void> {
    this.logger.log(`Starting data anonymization for user ${userId}`);

    const request = await this.createRequest(userId, DataRequestType.DELETION, {
      anonymize: true,
    });

    try {
      let totalAnonymized = 0;

      for (const [name, collector] of this.dataCollectors) {
        if (collector.anonymize) {
          try {
            const anonymized = await collector.anonymize(userId);
            totalAnonymized += anonymized;
          } catch (error) {
            this.logger.error(`Failed to anonymize ${name} data: ${(error as Error).message}`);
          }
        }
      }

      await this.completeRequest(request.id, {
        recordsAffected: totalAnonymized,
      });

      this.logger.log(
        `Data anonymization completed for user ${userId}: ${totalAnonymized} records`,
      );
    } catch (error) {
      await this.failRequest(request.id, (error as Error).message);
      throw error;
    }
  }

  /**
   * Rectify user data
   */
  async rectifyUserData(userId: string, data: Record<string, unknown>): Promise<void> {
    this.logger.log(`Starting data rectification for user ${userId}`);

    await this.createRequest(userId, DataRequestType.RECTIFICATION, {
      fieldsToUpdate: Object.keys(data),
    });

    // Rectification is typically handled by the specific service
    // This creates a record for compliance
  }

  /**
   * Restrict data processing
   */
  async restrictProcessing(userId: string, reason: string): Promise<void> {
    this.logger.log(`Restricting data processing for user ${userId}: ${reason}`);

    await this.createRequest(userId, DataRequestType.RESTRICTION, {
      reason,
    });

    // Store restriction flag
    // This should be checked before any data processing
  }

  /**
   * Get data processing status
   */
  async getProcessingStatus(userId: string): Promise<ProcessingStatus> {
    // Check for active restriction requests
    const restrictionRequest = await this.requestRepository.findOne({
      where: {
        userId,
        requestType: DataRequestType.RESTRICTION,
        status: DataRequestStatus.COMPLETED,
      },
      order: { createdAt: 'DESC' },
    });

    return {
      userId,
      isRestricted: !!restrictionRequest,
      restrictedSince: restrictionRequest?.processedAt || undefined,
      reason: (restrictionRequest?.requestDetails as { reason?: string })?.reason,
    };
  }

  /**
   * Get request by ID
   */
  async getRequest(requestId: string): Promise<GdprDataRequest> {
    const request = await this.requestRepository.findOne({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException(`Request ${requestId} not found`);
    }

    return request;
  }

  /**
   * Get user's requests
   */
  async getUserRequests(userId: string): Promise<GdprDataRequest[]> {
    return this.requestRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Register a data collector
   */
  registerCollector(name: string, collector: DataCollector): void {
    this.dataCollectors.set(name, collector);
    this.logger.debug(`Registered data collector: ${name}`);
  }

  /**
   * Create a request record
   */
  private async createRequest(
    userId: string,
    requestType: DataRequestType,
    details?: Record<string, unknown>,
  ): Promise<GdprDataRequest> {
    const request = this.requestRepository.create({
      userId,
      requestType,
      status: DataRequestStatus.PROCESSING,
      requestDetails: details,
    });

    return this.requestRepository.save(request);
  }

  /**
   * Complete a request
   */
  private async completeRequest(
    requestId: string,
    details: { recordsAffected?: number; downloadUrl?: string },
  ): Promise<void> {
    await this.requestRepository.update(requestId, {
      status: DataRequestStatus.COMPLETED,
      processedAt: new Date(),
      recordsAffected: details.recordsAffected || 0,
      downloadUrl: details.downloadUrl,
      downloadExpiresAt: details.downloadUrl
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null,
    });
  }

  /**
   * Fail a request
   */
  private async failRequest(requestId: string, errorMessage: string): Promise<void> {
    await this.requestRepository.update(requestId, {
      status: DataRequestStatus.FAILED,
      processedAt: new Date(),
      errorMessage,
    });
  }

  /**
   * Register default data collectors
   */
  private registerDefaultCollectors(): void {
    // User profile collector
    this.registerCollector('profile', {
      collect: async (userId: string) => {
        try {
          const rows = await executeQueryRowsNormalized<Record<string, unknown>>(
            this.dataSource,
            `SELECT id, email, "firstName", "lastName", "createdAt", "updatedAt"
             FROM users WHERE id = $1`,
            [userId],
          );
          return rows[0] ?? {};
        } catch {
          return {};
        }
      },
      delete: async (userId: string, options?: DataDeletionOptions) => {
        if (options?.retainAuditLogs) {
          // Anonymize instead of delete
          await this.dataSource.query(
            `UPDATE users SET
             email = $2,
             "firstName" = 'Deleted',
             "lastName" = 'User',
             password = NULL
             WHERE id = $1`,
            [userId, `deleted-${crypto.randomBytes(8).toString('hex')}@deleted.local`],
          );
          return 1;
        }
        const result = await executeQueryResultNormalized<Record<string, unknown>>(
          this.dataSource,
          `DELETE FROM users WHERE id = $1`,
          [userId],
        );
        return result.rowCount;
      },
      anonymize: async (userId: string) => {
        await this.dataSource.query(
          `UPDATE users SET
           email = $2,
           "firstName" = 'Anonymous',
           "lastName" = 'User',
           password = NULL
           WHERE id = $1`,
          [userId, `anon-${crypto.randomBytes(8).toString('hex')}@anonymous.local`],
        );
        return 1;
      },
    });

    // Audit logs collector
    this.registerCollector('auditLogs', {
      collect: async (userId: string) => {
        try {
          const rows = await executeQueryRowsNormalized<Record<string, unknown>>(
            this.dataSource,
            `SELECT * FROM shared.audit_logs WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1000`,
            [userId],
          );
          return { count: rows.length, logs: rows };
        } catch {
          return { count: 0, logs: [] };
        }
      },
    });

    // Sessions collector
    this.registerCollector('sessions', {
      collect: async (userId: string) => {
        try {
          const rows = await executeQueryRowsNormalized<Record<string, unknown>>(
            this.dataSource,
            `SELECT id, "createdAt", "ipAddress", "userAgent"
             FROM refresh_tokens WHERE "userId" = $1`,
            [userId],
          );
          return { count: rows.length, sessions: rows };
        } catch {
          return { count: 0, sessions: [] };
        }
      },
      delete: async (userId: string) => {
        const result = await executeQueryResultNormalized<Record<string, unknown>>(
          this.dataSource,
          `DELETE FROM refresh_tokens WHERE "userId" = $1`,
          [userId],
        );
        return result.rowCount;
      },
    });
  }
}

/**
 * Data Collector Interface
 */
export interface DataCollector {
  /**
   * Collect user data
   */
  collect(userId: string): Promise<Record<string, unknown>>;

  /**
   * Delete user data (optional)
   */
  delete?(userId: string, options?: DataDeletionOptions): Promise<number>;

  /**
   * Anonymize user data (optional)
   */
  anonymize?(userId: string): Promise<number>;
}
