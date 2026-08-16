/**
 * PermissionMatrixGuard
 *
 * Runtime fail-closed check that every GraphQL root operation hit
 * by a live request exists in the phase-6.1 permission matrix
 * (MUTATION_ROLES / QUERY_ROLES). Unknown
 * operations — a new @Mutation or @Query that landed WITHOUT a
 * matrix entry — return 403 before the resolver body runs.
 *
 * This is the runtime counterpart to
 * `permission-matrix.spec.ts` — the spec catches unclassified
 * operations at PR time, the guard catches them if a merged PR
 * slipped by (stale branch, hot-fix, cherry-pick). Together they
 * make "new mutation without a matrix entry" a zero-time-to-
 * detect regression instead of a silent open door.
 *
 * Design choices:
 *
 *   - **Delegation to RolesGuard.** Operations that already carry
 *     an @Roles decorator are handled by the existing RolesGuard;
 *     the matrix guard only asserts their existence in the
 *     matrix, not their role-set match (that is invariant-test
 *     territory at build time). Double-checking at runtime would
 *     duplicate work without catching an additional attack vector.
 *
 *   - **GraphQL only.** The guard inspects `GqlExecutionContext`
 *     to pull `info.fieldName`. Non-GraphQL requests skip — REST
 *     controllers have their own authorization stack and are
 *     outside the matrix's scope.
 *
 *   - **Introspection skip.** `__schema` / `__type` introspection
 *     queries pass through; the matrix covers business operations,
 *     not the schema surface Apollo depends on.
 *
 * Phase 6.1.2 of the "Farm modülü kalan kör noktalar" plan.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';

import {
  MUTATION_ROLES,
  QUERY_ROLES,
} from './permission-matrix';

@Injectable()
export class PermissionMatrixGuard implements CanActivate {
  private readonly logger = new Logger(PermissionMatrixGuard.name);

  canActivate(context: ExecutionContext): boolean {
    if (context.getType<GqlContextType>() !== 'graphql') {
      return true;
    }

    const gqlCtx = GqlExecutionContext.create(context);
    const info = gqlCtx.getInfo<{
      fieldName?: string;
      parentType?: { name?: string };
    }>();

    const parentTypeName = info?.parentType?.name;
    if (parentTypeName !== 'Mutation' && parentTypeName !== 'Query') {
      // Child-field resolvers are handled by the parent operation's
      // matrix decision; no need to re-check per field.
      return true;
    }

    const operationName = info?.fieldName ?? 'unknown';

    // Introspection passes — Apollo needs it to operate.
    if (operationName.startsWith('__')) {
      return true;
    }

    const isKnown =
      Object.prototype.hasOwnProperty.call(MUTATION_ROLES, operationName) ||
      Object.prototype.hasOwnProperty.call(QUERY_ROLES, operationName);

    if (isKnown) {
      return true;
    }

    this.logger.error(
      `PermissionMatrixGuard: rejected unclassified operation "${operationName}". ` +
        'Every @Mutation / @Query must appear in permission-matrix.ts ' +
        '(MUTATION_ROLES / QUERY_ROLES). Add the ' +
        'matrix entry in code review before shipping the resolver.',
    );
    throw new ForbiddenException(
      `Operation "${operationName}" is not registered in the permission ` +
        'matrix. This is a fail-closed policy — new operations must land ' +
        'with a matrix entry. See apps/farm-service/src/common/authz/' +
        'permission-matrix.ts.',
    );
  }
}
