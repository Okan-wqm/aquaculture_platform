'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.ACTOR_PROPERTY_NAMES = void 0;
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
const utils_1 = require('@typescript-eslint/utils');
const createRule = utils_1.ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`,
);
/** Property names that claim an actor. Extend here, never per-file. */
exports.ACTOR_PROPERTY_NAMES = new Set([
  'performedBy',
  'performedByEmail',
  'performedByName',
  'terminatedBy',
  'requestedBy',
  'initiatedBy',
  'approvedBy',
  'changedBy',
  'changedByName',
  'changedByEmail',
  'createdBy',
  'createdByName',
  'createdByEmail',
  'updatedBy',
  'actorId',
  'actorEmail',
  'adminId',
  'superAdminId',
]);
const VALIDATOR_DECORATOR =
  /^(Is[A-Z]|Validate|Matches$|Length$|MinLength$|MaxLength$|Min$|Max$|ArrayNotEmpty$|ArrayMinSize$|ArrayMaxSize$|Equals$|NotEquals$|Contains$)/;
const READ_ONLY_DTO = /(Query|Filter|Search)Dto$/;
function decoratorName(decorator) {
  const expr = decorator.expression;
  if (
    expr.type === utils_1.AST_NODE_TYPES.CallExpression &&
    expr.callee.type === utils_1.AST_NODE_TYPES.Identifier
  ) {
    return expr.callee.name;
  }
  if (expr.type === utils_1.AST_NODE_TYPES.Identifier) return expr.name;
  return null;
}
function propertyName(node) {
  if (node.key.type === utils_1.AST_NODE_TYPES.Identifier) return node.key.name;
  if (node.key.type === utils_1.AST_NODE_TYPES.Literal && typeof node.key.value === 'string')
    return node.key.value;
  return null;
}
function isValidatedInputClass(node) {
  return node.body.body.some(
    (member) =>
      member.type === utils_1.AST_NODE_TYPES.PropertyDefinition &&
      (member.decorators ?? []).some((d) => {
        const name = decoratorName(d);
        return name !== null && VALIDATOR_DECORATOR.test(name);
      }),
  );
}
exports.default = createRule({
  name: 'no-actor-in-input-dto',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A validated input DTO must not declare a field that names who acted; the actor comes from the verified request frame (ADMIN-CRITICAL-008).',
    },
    messages: {
      actorFromClient:
        "'{{name}}' names an actor. Input DTOs cannot claim who acted — the audit writer reads the principal the guard verified from the request frame. Remove the field; if the value is a filter, put it on a *QueryDto.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function check(node) {
      if (!isValidatedInputClass(node)) return;
      if (node.id && READ_ONLY_DTO.test(node.id.name)) return;
      for (const member of node.body.body) {
        if (member.type !== utils_1.AST_NODE_TYPES.PropertyDefinition) continue;
        const name = propertyName(member);
        if (name && exports.ACTOR_PROPERTY_NAMES.has(name)) {
          context.report({ node: member.key, messageId: 'actorFromClient', data: { name } });
        }
      }
    }
    return {
      ClassDeclaration: check,
      ClassExpression: check,
    };
  },
});
//# sourceMappingURL=no-actor-in-input-dto.js.map
