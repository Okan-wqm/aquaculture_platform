/**
 * no-unverified-tenant-param — on the platform-admin surface a tenant id is
 * never taken raw from the request (ADMIN-CRITICAL-009).
 *
 * `@Param('tenantId')`, `@Query('tenantId')` and a validated body DTO with a
 * `tenantId` property hand the handler a transport value: any UUID, any
 * lifecycle state, possibly no tenant at all. `@TenantParam(...)` resolves the
 * id through `VerifiedTenantPipe` against `auth.tenants` before the handler
 * runs, and states which lifecycle statuses the route admits. The rule makes
 * the raw forms an error, whatever the handler does with the value.
 *
 * Scope: admin-api controllers and validated input DTOs. Query / filter DTOs
 * (`…QueryDto`, `…FilterDto`, `…SearchDto`) may FILTER by tenant on a read;
 * the ban is on taking a tenant identity as an operand.
 */
import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/okan-wqm/aquaculture_platform/blob/main/tools/eslint-rules/rules/${name}.ts`,
);

/** Request keys that name a tenant. Extend here, never per-file. */
export const TENANT_KEYS: ReadonlySet<string> = new Set(['tenantId', 'tenant_id', 'tenantid']);

const RAW_PARAM_DECORATORS: ReadonlySet<string> = new Set(['Param', 'Query']);
const VALIDATOR_DECORATOR =
  /^(Is[A-Z]|Validate|Matches$|Length$|MinLength$|MaxLength$|Min$|Max$|ArrayNotEmpty$|ArrayMinSize$|ArrayMaxSize$|Equals$|NotEquals$|Contains$)/;
/** Read-side DTOs filter BY tenant; the ban is on taking a tenant identity as an operand. */
const READ_ONLY_DTO = /^(Query|Filter|Search)[A-Z]|(Query|Filter|Search)Dto$/;

function decoratorCall(
  decorator: TSESTree.Decorator,
): { name: string; args: TSESTree.CallExpressionArgument[] } | null {
  const expr = decorator.expression;
  if (
    expr.type === AST_NODE_TYPES.CallExpression &&
    expr.callee.type === AST_NODE_TYPES.Identifier
  ) {
    return { name: expr.callee.name, args: expr.arguments };
  }
  return null;
}

function decoratorName(decorator: TSESTree.Decorator): string | null {
  const expr = decorator.expression;
  if (
    expr.type === AST_NODE_TYPES.CallExpression &&
    expr.callee.type === AST_NODE_TYPES.Identifier
  ) {
    return expr.callee.name;
  }
  if (expr.type === AST_NODE_TYPES.Identifier) return expr.name;
  return null;
}

function propertyName(node: TSESTree.PropertyDefinition): string | null {
  if (node.key.type === AST_NODE_TYPES.Identifier) return node.key.name;
  if (node.key.type === AST_NODE_TYPES.Literal && typeof node.key.value === 'string')
    return node.key.value;
  return null;
}

/**
 * `@TenantIdCarrier() readonly tenantId?: undefined` — the whitelisted body key
 * @TenantParam('body') reads; typed `undefined` so the handler cannot use it.
 */
function isTenantIdCarrier(member: TSESTree.PropertyDefinition): boolean {
  const carrier = (member.decorators ?? []).some((d) => decoratorName(d) === 'TenantIdCarrier');
  const annotation = member.typeAnnotation?.typeAnnotation;
  return carrier && annotation?.type === AST_NODE_TYPES.TSUndefinedKeyword;
}

function isValidatedInputClass(
  node: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
): boolean {
  return node.body.body.some(
    (member) =>
      member.type === AST_NODE_TYPES.PropertyDefinition &&
      (member.decorators ?? []).some((d) => {
        const name = decoratorName(d);
        return name !== null && VALIDATOR_DECORATOR.test(name);
      }),
  );
}

export default createRule({
  name: 'no-unverified-tenant-param',
  meta: {
    type: 'problem',
    docs: {
      description:
        'A handler takes a tenant id only through @TenantParam(), which resolves it against auth.tenants before the handler runs (ADMIN-CRITICAL-009).',
    },
    messages: {
      rawTenantParam:
        "@{{decorator}}('{{key}}') hands the handler an unverified tenant id. Use @TenantParam('{{source}}') — it resolves the id against auth.tenants and states which lifecycle statuses the route admits.",
      tenantInInputDto:
        "'{{name}}' on a validated input DTO is an unverified tenant identity. Take it with @TenantParam('body') on the handler and declare the key as `@TenantIdCarrier() readonly {{name}}?: undefined`; a read filter belongs on a *QueryDto.",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    function checkParameter(param: TSESTree.Parameter): void {
      for (const decorator of param.decorators ?? []) {
        const call = decoratorCall(decorator);
        if (!call || !RAW_PARAM_DECORATORS.has(call.name)) continue;
        const first = call.args[0];
        if (!first || first.type !== AST_NODE_TYPES.Literal || typeof first.value !== 'string')
          continue;
        if (!TENANT_KEYS.has(first.value)) continue;
        context.report({
          node: decorator,
          messageId: 'rawTenantParam',
          data: {
            decorator: call.name,
            key: first.value,
            source: call.name === 'Param' ? 'param' : 'query',
          },
        });
      }
    }

    function checkClass(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): void {
      if (!isValidatedInputClass(node)) return;
      if (node.id && READ_ONLY_DTO.test(node.id.name)) return;
      for (const member of node.body.body) {
        if (member.type !== AST_NODE_TYPES.PropertyDefinition) continue;
        const name = propertyName(member);
        if (!name || !TENANT_KEYS.has(name)) continue;
        if (isTenantIdCarrier(member)) continue;
        context.report({ node: member.key, messageId: 'tenantInInputDto', data: { name } });
      }
    }

    return {
      MethodDefinition(node): void {
        if (node.value.type !== AST_NODE_TYPES.FunctionExpression) return;
        for (const param of node.value.params) checkParameter(param);
      },
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    };
  },
});
