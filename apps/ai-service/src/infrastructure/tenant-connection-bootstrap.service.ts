import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRequestContext } from '@platform/backend-common';

/**
 * Enterprise-grade tenant schema routing at the PostgreSQL connection pool level.
 *
 * Problem: TenantSchemaMiddleware sets search_path on a dedicated QueryRunner,
 * but TypeORM repositories internally create their OWN QueryRunners from the pool.
 * Those QueryRunners use the default search_path (ai, public), so all queries
 * hit the source schema instead of tenant schemas.
 *
 * Solution: Monkey-patch pg Pool's connect() method to auto-set search_path
 * from AsyncLocalStorage (populated by the middleware chain) on EVERY connection
 * checkout. This is transparent to all handlers, services, and repositories.
 */
@Injectable()
export class TenantConnectionBootstrap implements OnModuleInit {
  private readonly logger = new Logger(TenantConnectionBootstrap.name);
  private readonly SOURCE_SCHEMA = 'ai';

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.patchConnectionPool();
  }

  private patchConnectionPool(): void {
    const driver = this.dataSource.driver as any;
    const pool = driver.master;

    if (!pool || typeof pool.connect !== 'function') {
      this.logger.error('Cannot patch connection pool -- pg Pool not found on DataSource driver');
      return;
    }

    const originalConnect = pool.connect.bind(pool);
    const sourceSchema = this.SOURCE_SCHEMA;
    const logger = this.logger;

    pool.connect = function (callback?: any) {
      if (typeof callback === 'function') {
        return originalConnect((err: any, client: any, done: any) => {
          if (err) return callback(err, client, done);

          let schemaName: string | undefined;
          try {
            const ctx = getRequestContext();
            schemaName = ctx?.schemaName;
          } catch {
            // Not in request context (migrations, cron jobs)
          }

          if (schemaName && schemaName !== sourceSchema && /^[a-z0-9_]+$/.test(schemaName)) {
            client.query(
              `SET search_path TO "${schemaName}", ${sourceSchema}, public`,
              (qErr: any) => {
                if (qErr) {
                  logger.error(`Failed to set search_path to ${schemaName}: ${qErr.message}`);
                }
                callback(null, client, done);
              },
            );
          } else {
            callback(null, client, done);
          }
        });
      }

      // Promise style (fallback)
      return originalConnect().then(async (client: any) => {
        let schemaName: string | undefined;
        try {
          const ctx = getRequestContext();
          schemaName = ctx?.schemaName;
        } catch {
          // Not in request context
        }

        if (schemaName && schemaName !== sourceSchema && /^[a-z0-9_]+$/.test(schemaName)) {
          await client.query(`SET search_path TO "${schemaName}", ${sourceSchema}, public`);
        }
        return client;
      });
    };

    this.logger.log('PostgreSQL connection pool patched for tenant-aware search_path routing');
  }
}
