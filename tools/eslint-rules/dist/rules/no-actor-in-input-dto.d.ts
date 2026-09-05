/**
 * no-actor-in-input-dto — an input DTO may not carry a field that names who
 * acted (ADMIN-CRITICAL-008).
 *
 * Audit and activity rows name the principal the guard verified, read from the
 * AsyncLocalStorage request frame. A validated request body that carries
 * `performedBy`, `terminatedBy`, `requestedBy`, … is a second, unverified
 * source of the same fact, and every such field ended up on a ledger row. The
 * rule makes the field impossible to declare: a class-validator-decorated
 * property with an actor name is an error, whatever the class is called.
 *
 * Scope: classes with at least one class-validator decorator (`@IsString`,
 * `@IsOptional`, `@ValidateNested`, …) — that is what makes a class an input
 * DTO. Entities (`@Column`) and plain response types are untouched. Query /
 * filter DTOs (`…QueryDto`, `…FilterDto`) may FILTER by actor; the ban is on
 * claiming one.
 */
import { ESLintUtils } from '@typescript-eslint/utils';
/** Property names that claim an actor. Extend here, never per-file. */
export declare const ACTOR_PROPERTY_NAMES: ReadonlySet<string>;
declare const _default: ESLintUtils.RuleModule<
  'actorFromClient',
  [],
  unknown,
  ESLintUtils.RuleListener
> & {
  name: string;
};
export default _default;
//# sourceMappingURL=no-actor-in-input-dto.d.ts.map
