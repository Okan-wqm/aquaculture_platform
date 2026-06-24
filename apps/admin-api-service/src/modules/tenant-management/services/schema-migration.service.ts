import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';

/**
 * HR-MEDIUM-006: Schema name validation regex.
 *
 * Strict alphanumeric + underscore validation prevents SQL injection when
 * schema names are interpolated into DDL statements. Schema DDL identifiers
 * cannot be parameterized in PostgreSQL, so input
 * validation is the ONLY defense.
 *
 * Constraints:
 * - Must start with a lowercase letter (PostgreSQL convention)
 * - Only lowercase letters, digits, and underscores allowed
 * - Max 63 characters (PostgreSQL identifier limit)
 */
const SCHEMA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Validates a schema name against the strict pattern.
 * Throws BadRequestException if the name contains any disallowed characters.
 *
 * @param schemaName - The schema name to validate
 * @throws BadRequestException if invalid
 */
export function validateSchemaName(schemaName: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw new BadRequestException(
      `Invalid schema name "${schemaName}". Schema names must match /^[a-z][a-z0-9_]{0,62}$/ ` +
      `(start with lowercase letter, only lowercase letters/digits/underscores, max 63 chars).`,
    );
  }
}

@Injectable()
export class SchemaMigrationService {
  private readonly logger = new Logger(SchemaMigrationService.name);

  /**
   * Create a new tenant schema.
   *
   * HR-MEDIUM-006: Schema name is validated against a strict regex BEFORE
   * being interpolated into DDL. SQL injection through schema names is
   * STRUCTURALLY IMPOSSIBLE because only /^[a-z][a-z0-9_]{0,62}$/ passes.
   *
   * @param schemaName - Tenant schema name (validated)
   */
  createSchema(schemaName: string): never {
    // SECURITY: Validate BEFORE any SQL interpolation
    validateSchemaName(schemaName);
    throw new ConflictException(
      'Runtime tenant schema creation is workflow-owned. Use SchemaManagerService through tenant provisioning.',
    );
  }

  /**
   * Drop a tenant schema.
   *
   * @param schemaName - Tenant schema name (validated)
   */
  dropSchema(schemaName: string): never {
    // SECURITY: Validate BEFORE any SQL interpolation
    validateSchemaName(schemaName);
    throw new ConflictException(
      'Runtime tenant schema drop is deprovision-workflow-owned and requires CleanupDropProof.',
    );
  }

  /**
   * Run migrations on a specific tenant schema.
   *
   * @param schemaName - Tenant schema name (validated)
   */
  async migrateSchema(schemaName: string): Promise<void> {
    // SECURITY: Validate BEFORE any SQL interpolation
    validateSchemaName(schemaName);
    this.logger.warn(`Rejected runtime migration request for schema: ${schemaName}`);
    throw new ConflictException(
      'Runtime tenant schema migrations are aqua-db-migrate-owned. Use the deploy migration workflow.',
    );
  }
}
