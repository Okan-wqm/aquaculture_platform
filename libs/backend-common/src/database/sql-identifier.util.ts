import { BadRequestException } from '@nestjs/common';

/**
 * Validate a Postgres identifier (schema name, table name, column name)
 * for safe interpolation into SQL.
 *
 * # Why this util exists
 *
 * Several DDL paths in backend-common need to template identifiers into
 * SQL — Postgres has no parameterised binding for identifiers, only for
 * VALUES. The historical pattern was a private validateSqlIdentifier in
 * schema-manager.service.ts; the same logic was needed in
 * tenant-schema-sync.service.ts (DATA-CRITICAL-002 — raw pg_attribute.attname
 * was interpolated unchecked, opening a SQL-injection surface). Extracting
 * the helper into a shared util closes the gap with one canonical source
 * and lets future DDL writers reuse it without re-deriving the regex.
 *
 * # Contract
 *
 * - Input must match `^[a-zA-Z_][a-zA-Z0-9_]*$` (Postgres unquoted-identifier
 *   shape) AND be ≤ 63 characters (Postgres NAMEDATALEN cap).
 * - Returns the identifier unchanged on success — call sites can chain it
 *   directly into a template literal: `"${validateSqlIdentifier(name, 'table')}"`.
 * - Throws `BadRequestException` on any violation. The exception message
 *   names the rejected identifier so the operator can pinpoint the offender.
 *
 * # What this prevents
 *
 *   - SQL injection via stray semicolons, quotes, or comment markers.
 *   - Invalid identifiers that PostgreSQL would refuse with a generic
 *     parser error (this util surfaces a clearer message).
 *   - Identifier-length attacks where >63 char names truncate inside
 *     pg_attribute lookups, causing the wrong column to be modified.
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-CRITICAL-002 (sql-injection surface)
 */
export type SqlIdentifierKind = 'schema' | 'table' | 'column' | 'index' | 'role';

const POSTGRES_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const POSTGRES_NAMEDATALEN = 63;

export function validateSqlIdentifier(
  identifier: string,
  kind: SqlIdentifierKind = 'schema',
): string {
  if (
    !POSTGRES_IDENTIFIER_REGEX.test(identifier) ||
    identifier.length > POSTGRES_NAMEDATALEN
  ) {
    throw new BadRequestException(
      `SECURITY: Invalid ${kind} identifier "${identifier}": only alphanumeric and underscore allowed, must start with letter or underscore, max ${POSTGRES_NAMEDATALEN} characters.`,
    );
  }
  return identifier;
}
