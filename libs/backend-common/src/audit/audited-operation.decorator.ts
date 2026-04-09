import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for the @AuditedOperation() decorator.
 * Used by AuditedOperationInterceptor to read decorator options via Reflector.
 */
export const AUDITED_OPERATION_KEY = 'audited_operation';

/**
 * Status of the audited operation — written into the audit row
 * so queries can distinguish successful from failed operations.
 */
export enum AuditedOperationStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

/**
 * Configuration options for the @AuditedOperation() decorator.
 */
export interface AuditedOperationOptions {
  /**
   * Resource/entity type being operated on.
   * E.g. 'Invoice', 'Farm', 'Batch', 'TenantRole'
   */
  resource: string;

  /**
   * Action being performed on the resource.
   * E.g. 'CREATE', 'UPDATE', 'DELETE', 'ASSIGN_ROLE'
   */
  action: string;

  /**
   * Optional human-readable description of the operation.
   */
  description?: string;

  /**
   * Optional function to extract additional details from handler arguments.
   * Receives the raw arguments array (controller method params or CQRS command).
   * The returned record is persisted as JSONB metadata on the audit row.
   *
   * SECURITY: The interceptor sanitizes the output, but callers should still
   * avoid returning secrets, passwords, or tokens from this function.
   *
   * @param args - The handler's argument list
   * @returns Key-value pairs to store in audit metadata
   */
  extractDetails?: (args: unknown[]) => Record<string, unknown>;

  /**
   * Optional function to extract the resource ID from the handler result.
   * By default the interceptor looks for result.id or returns null.
   *
   * @param result - The handler's return value
   * @returns The resource ID string, or null
   */
  extractResourceId?: (result: unknown) => string | null;
}

/**
 * @AuditedOperation() -- Makes audit logging AUTOMATIC and MANDATORY.
 *
 * When applied to a CQRS command handler's `execute()` or a controller method:
 *
 * 1. Captures the operation context BEFORE execution (who, what, when)
 * 2. Executes the handler
 * 3. Writes the audit row INSIDE the same transaction (if QueryRunner is available)
 * 4. If audit write fails -> the entire operation fails (no fire-and-forget)
 *
 * This makes it STRUCTURALLY IMPOSSIBLE to:
 * - Forget audit logging on a handler
 * - Have audit succeed but operation fail (or vice versa)
 * - Swallow audit failures with .catch()
 *
 * @example Controller usage:
 * ```ts
 * @AuditedOperation({ resource: 'Invoice', action: 'CREATE' })
 * @Post()
 * async createInvoice(@Body() dto: CreateInvoiceDto) { ... }
 * ```
 *
 * @example CQRS command handler usage:
 * ```ts
 * @AuditedOperation({
 *   resource: 'Farm',
 *   action: 'CREATE',
 *   extractDetails: (args) => {
 *     const cmd = args[0] as CreateFarmCommand;
 *     return { farmName: cmd.name, region: cmd.region };
 *   },
 * })
 * @CommandHandler(CreateFarmCommand)
 * export class CreateFarmHandler implements ICommandHandler<CreateFarmCommand> { ... }
 * ```
 */
export const AuditedOperation = (options: AuditedOperationOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(AUDITED_OPERATION_KEY, options);
