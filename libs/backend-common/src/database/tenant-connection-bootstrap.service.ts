import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRequestContext } from '../logging/request-context';
import { validateTenantSchemaName } from './schema-manager.service';

/**
 * Tenant schema regex — only matches tenant_<16 hex chars>.
 * Rejects source schemas (sensor, farm, hr, etc.) and public.
 */
const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;

/**
 * Factory: creates a service-specific TenantConnectionBootstrap class.
 *
 * Each multi-tenant service calls this once at import time:
 *   const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
 * The returned class is then registered as a NestJS provider.
 *
 * At startup the provider monkey-patches the pg Pool.connect() method so that
 * EVERY connection checkout automatically sets `search_path` from the current
 * AsyncLocalStorage request context.  This is transparent to all repositories,
 * query builders, and raw queries.
 */
export function createTenantConnectionBootstrap(sourceSchema: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(sourceSchema)) {
    throw new Error(`Invalid sourceSchema: "${sourceSchema}" — must be lowercase alphanumeric with underscores`);
  }

  @Injectable()
  class TenantConnectionBootstrapImpl implements OnModuleInit {
    readonly logger = new Logger(`TenantConnectionBootstrap[${sourceSchema}]`);

    constructor(readonly dataSource: DataSource) {}

    onModuleInit(): void {
      this.patchConnectionPool();
    }

    /** @internal */
    patchConnectionPool(): void {
      const driver = this.dataSource.driver as any;
      const pool = driver.master;

      if (!pool || typeof pool.connect !== 'function') {
        this.logger.error('Cannot patch connection pool — pg Pool not found on DataSource driver');
        return;
      }

      const originalConnect = pool.connect.bind(pool);
      const src = sourceSchema;
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
              // Not in request context (migrations, startup) — use default
            }

            if (schemaName && TENANT_SCHEMA_REGEX.test(schemaName)) {
              /** SEC-M13: Validate schema name before SQL interpolation as defense-in-depth */
              validateTenantSchemaName(schemaName);
              client.query(
                `SET search_path TO "${schemaName}", ${src}, public`,
                (qErr: any) => {
                  if (qErr) {
                    logger.error(`Failed to set search_path to ${schemaName}: ${qErr.message}`);
                    done(qErr);
                    callback(qErr);
                    return;
                  }
                  callback(null, client, done);
                },
              );
            } else {
              if (!schemaName) {
                logger.debug(`Pool checkout without tenant context — using default search_path (${src},public)`);
              }
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

          if (schemaName && TENANT_SCHEMA_REGEX.test(schemaName)) {
            try {
              /** SEC-M13: Validate schema name before SQL interpolation as defense-in-depth */
              validateTenantSchemaName(schemaName);
              await client.query(`SET search_path TO "${schemaName}", ${src}, public`);
            } catch (qErr) {
              logger.error(`Failed to set search_path to ${schemaName}: ${(qErr as Error).message}`);
              client.release(true); // release with error
              throw qErr;
            }
          } else if (!schemaName) {
            logger.debug(`Pool checkout (promise) without tenant context — using default search_path (${src},public)`);
          }
          return client;
        });
      };

      this.logger.log('PostgreSQL connection pool patched for tenant-aware search_path routing');
    }
  }

  return TenantConnectionBootstrapImpl;
}
