/**
 * Source scanner for the ADR-051 classification invariant (module-access-classification.spec.ts)
 * and the e2e access matrix. It reads each handler the way Nest registers it — root fields
 * (`@Query`, `@Mutation`, `@Subscription`), REST handlers (`@Get` … in a `@Controller`),
 * reference resolvers (`@ResolveReference`) and field resolvers (`@ResolveField`) — with the
 * `@Access`, `@Public`, `@Roles` (and its aliases, ./roles-aliases.ts) and parameter decorators on
 * the handler and its class, from the syntax tree (comments and strings never count).
 */
import {
  isOwnerModuleCode,
  isPlatformRole,
  isTenantCapability,
  type MemberAccessSpec,
  type PlatformRole,
} from '@aquaculture/shared-contracts';
import ts from 'typescript';

import { readRepoFile, trackedFiles } from './module-dictionary-sources';
import {
  localRolesAliasesOf,
  roleArgumentNames,
  rolesAliases,
  type RolesAliases,
} from './roles-aliases';

export type HandlerRole = 'query' | 'mutation' | 'subscription' | 'rest' | 'reference' | 'field';

export interface AccessUse {
  /** The builder after `Access.`: module, scoped, company, self, account (or anything else). */
  readonly kind: string;
  /** Each argument's literal text, or null when it is not a string literal. */
  readonly args: readonly (string | null)[];
}

export interface ScannedHandler {
  readonly file: string;
  readonly line: number;
  readonly className: string;
  readonly method: string;
  readonly role: HandlerRole;
  /** The type `@Resolver(() => T)` names, for references and fields; null when none. */
  readonly typeName: string | null;
  /** The GraphQL field name of a field resolver (its first string argument, `name:`, or the method). */
  readonly fieldName: string;
  readonly handlerAccess: AccessUse | null;
  readonly classAccess: AccessUse | null;
  readonly handlerPublic: boolean;
  readonly classPublic: boolean;
  /** `@Roles` or an alias of it, on the handler, else on the class: role names, `[]` when none. */
  readonly roles: readonly string[];
  /** Names of the parameter decorators, e.g. `Parent`, `AccessCaller`. */
  readonly params: readonly string[];
}

const ROOT_ROLES: Readonly<Record<string, HandlerRole>> = {
  Query: 'query',
  Mutation: 'mutation',
  Subscription: 'subscription',
  ResolveReference: 'reference',
  ResolveField: 'field',
};
const REST_VERBS: ReadonlySet<string> = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Options',
  'Head',
  'All',
]);

interface DecoratorCall {
  readonly name: string;
  readonly args: readonly ts.Expression[];
}

function decoratorCalls(node: ts.Node): DecoratorCall[] {
  const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  return decorators.map((decorator) => {
    const expression = decorator.expression;
    const callee = ts.isCallExpression(expression) ? expression.expression : expression;
    const args = ts.isCallExpression(expression) ? [...expression.arguments] : [];
    return { name: callee.getText(), args };
  });
}

function literalOrNull(node: ts.Expression): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function accessOf(calls: readonly DecoratorCall[]): AccessUse | null {
  const access = calls.find((call) => call.name.startsWith('Access.'));
  if (access === undefined) return null;
  return { kind: access.name.slice('Access.'.length), args: access.args.map(literalOrNull) };
}

/**
 * The roles the first `@Roles(...)` or alias of one target sets. The first in source order is the
 * one applied last, whose ROLES_KEY metadata the guards read.
 */
function rolesOf(calls: readonly DecoratorCall[], aliases: RolesAliases): readonly string[] | null {
  for (const call of calls) {
    if (call.name === 'Roles') return roleArgumentNames(call.args);
    const aliased = aliases.get(call.name);
    if (aliased !== undefined) return aliased;
  }
  return null;
}

/** `@Resolver(() => T)`, `@Resolver(T)` or `@Resolver('T')`: T. */
function resolverTypeName(calls: readonly DecoratorCall[]): string | null {
  const resolver = calls.find((call) => call.name === 'Resolver');
  const [arg] = resolver === undefined ? [] : resolver.args;
  if (arg === undefined) return null;
  if (ts.isStringLiteralLike(arg) || ts.isIdentifier(arg)) return arg.text;
  if (ts.isArrowFunction(arg) && ts.isIdentifier(arg.body)) return arg.body.text;
  return null;
}

function fieldNameOf(call: DecoratorCall | undefined, method: string): string {
  if (call === undefined) return method;
  for (const arg of call.args) {
    if (ts.isStringLiteralLike(arg)) return arg.text;
    if (ts.isObjectLiteralExpression(arg)) {
      for (const property of arg.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText() === 'name' &&
          ts.isStringLiteralLike(property.initializer)
        ) {
          return property.initializer.text;
        }
      }
    }
  }
  return method;
}

function handlerRole(calls: readonly DecoratorCall[], isController: boolean): HandlerRole | null {
  for (const call of calls) {
    const role = ROOT_ROLES[call.name];
    if (role !== undefined) return role;
    if (isController && REST_VERBS.has(call.name)) return 'rest';
  }
  return null;
}

/** Every handler of one source file; `@Roles` aliases resolve through `aliases`. */
export function scanSource(
  file: string,
  source: string,
  aliases: RolesAliases = rolesAliases(),
): ScannedHandler[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const handlers: ScannedHandler[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const classCalls = decoratorCalls(node);
      const isController = classCalls.some((call) => call.name === 'Controller');
      const classAccess = accessOf(classCalls);
      const classPublic = classCalls.some((call) => call.name === 'Public');
      const classRoles = rolesOf(classCalls, aliases);
      const typeName = resolverTypeName(classCalls);
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const calls = decoratorCalls(member);
        const role = handlerRole(calls, isController);
        if (role === null) continue;
        const method = member.name.getText();
        handlers.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile)).line + 1,
          className: node.name.text,
          method,
          role,
          typeName,
          fieldName: fieldNameOf(
            calls.find((call) => call.name === 'ResolveField'),
            method,
          ),
          handlerAccess: accessOf(calls),
          classAccess,
          handlerPublic: calls.some((call) => call.name === 'Public'),
          classPublic,
          roles: rolesOf(calls, aliases) ?? classRoles ?? [],
          params: member.parameters.flatMap((parameter) =>
            decoratorCalls(parameter).map((call) => call.name),
          ),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return handlers;
}

/** Production sources of a service: no specs, test helpers, fixtures or migrations. */
export function serviceSources(service: string): string[] {
  return trackedFiles([`apps/${service}/src`]).filter(
    (file) =>
      file.endsWith('.ts') &&
      !file.endsWith('.d.ts') &&
      !/\.(spec|test|e2e-spec)\.ts$/.test(file) &&
      !/(^|\/)(__tests__|__mocks__|__fixtures__|test-utils|testing|migrations)\//.test(file),
  );
}

export function scanService(service: string): ScannedHandler[] {
  return serviceSources(service).flatMap((file) => scanSource(file, readRepoFile(file)));
}

/**
 * Rule 5 reads `@Roles` aliases from their owner file only, so a service that sets the `@Roles`
 * metadata any other way (a local alias, `SetMetadata(ROLES_KEY, …)`) breaks the rule.
 */
export function serviceRolesAliasViolations(service: string): string[] {
  return serviceSources(service).flatMap((file) => localRolesAliasesOf(file, readRepoFile(file)));
}

export interface ClassificationRules {
  /** The owner modules the service may name in `Access.module` (SERVICE_ACCESS_MODULES). */
  readonly ownModules: readonly string[];
  /** `<Type>.<field>` → reason (PARENT_SCOPED_FIELDS of the service). */
  readonly parentScoped: Readonly<Record<string, string>>;
}

const MEMBER_KINDS: ReadonlySet<string> = new Set([
  'module',
  'scoped',
  'company',
  'self',
  'account',
]);
const ROLE_FREE_KINDS: ReadonlySet<string> = new Set(['company', 'self', 'account']);

function where(handler: ScannedHandler): string {
  return `${handler.file}:${handler.line} ${handler.className}.${handler.method}`;
}

export function fieldKey(handler: ScannedHandler): string {
  return `${handler.typeName ?? '?'}.${handler.fieldName}`;
}

function accessViolations(handler: ScannedHandler, rules: ClassificationRules): string[] {
  const out: string[] = [];
  const effective = handler.handlerAccess ?? handler.classAccess;
  for (const access of [handler.handlerAccess, handler.classAccess]) {
    if (access === null) continue;
    if (!MEMBER_KINDS.has(access.kind)) {
      out.push(`${where(handler)}: Access.${access.kind} is no member access kind`);
    }
    if (access.kind === 'module') {
      const [module] = access.args;
      if (module === undefined || module === null || !rules.ownModules.includes(module)) {
        out.push(
          `${where(handler)}: Access.module(${String(module)}) is not a module this service owns ` +
            `(${rules.ownModules.join(', ') || 'none'})`,
        );
      }
    }
  }
  if (effective !== null && effective.kind === 'company') {
    if (!handler.file.includes('/company-layer/') || handler.role !== 'query') {
      out.push(`${where(handler)}: Access.company is only for a Query under */company-layer/`);
    }
  }
  if (effective !== null && ROLE_FREE_KINDS.has(effective.kind) && handler.roles.length > 0) {
    out.push(`${where(handler)}: Access.${effective.kind} reads no @Roles, but @Roles is declared`);
  }
  return out;
}

function shapeViolations(handler: ScannedHandler, rules: ClassificationRules): string[] {
  const hasAccess = handler.handlerAccess !== null || handler.classAccess !== null;
  const isPublic = handler.handlerPublic || handler.classPublic;
  const takesCaller = handler.params.includes('AccessCaller');
  const out: string[] = [];
  if (takesCaller && !hasAccess) {
    out.push(`${where(handler)}: takes @AccessCaller() but neither it nor its class has @Access`);
  }
  switch (handler.role) {
    case 'query':
    case 'mutation':
    case 'subscription':
    case 'rest':
      if (!hasAccess && !isPublic)
        out.push(`${where(handler)}: ${handler.role} has no @Access and no @Public`);
      break;
    case 'reference':
      if (!handler.params.includes('Parent') || !takesCaller) {
        out.push(`${where(handler)}: a @ResolveReference takes @Parent() and @AccessCaller()`);
      }
      if (!hasAccess)
        out.push(`${where(handler)}: a @ResolveReference needs @Access on it or its class`);
      if (isPublic) out.push(`${where(handler)}: a @ResolveReference is never @Public`);
      break;
    case 'field': {
      const reason = rules.parentScoped[fieldKey(handler)];
      if (!takesCaller && (reason === undefined || reason.trim() === '')) {
        out.push(
          `${where(handler)}: field ${fieldKey(handler)} takes no @AccessCaller() and is not in ` +
            'PARENT_SCOPED_FIELDS with a reason',
        );
      }
      break;
    }
  }
  return out;
}

/**
 * `@Public` and `@Access` resolve by specificity at run time (libs/backend-common/src/security/
 * handler-access.ts): the handler's own declaration beats its class's, and on one target `@Access`
 * beats `@Public`. Each combination in which that order has to decide is forbidden, so every
 * operation states one classification and a class-level `@Public` never sits over a handler that
 * asks for a decision.
 */
function publicAccessViolations(handler: ScannedHandler): string[] {
  const out: string[] = [];
  if (handler.handlerAccess !== null && handler.handlerPublic) {
    out.push(`${where(handler)}: declares both @Access and @Public`);
  }
  if (handler.classAccess !== null && handler.classPublic) {
    out.push(`${where(handler)}: its class declares both @Access and @Public`);
  }
  if (handler.handlerAccess !== null && handler.classPublic) {
    out.push(`${where(handler)}: declares @Access under a class-level @Public`);
  }
  return out;
}

/** Every rule of ADR-051's classification invariant a module-access service's handlers break. */
export function classificationViolations(
  handlers: readonly ScannedHandler[],
  rules: ClassificationRules,
): string[] {
  const out = handlers.flatMap((handler) => [
    ...shapeViolations(handler, rules),
    ...accessViolations(handler, rules),
    ...publicAccessViolations(handler),
  ]);
  const fields = new Set(handlers.filter((h) => h.role === 'field').map(fieldKey));
  for (const [key, reason] of Object.entries(rules.parentScoped)) {
    if (!fields.has(key))
      out.push(`PARENT_SCOPED_FIELDS names ${key}, which no field resolver resolves`);
    if (reason.trim() === '') out.push(`PARENT_SCOPED_FIELDS gives ${key} no reason`);
  }
  return out;
}

/** The member access spec an `Access.*` decorator declares, or null when it declares none valid. */
export function memberSpecOf(use: AccessUse | null): MemberAccessSpec | null {
  if (use === null) return null;
  const [argument] = use.args;
  switch (use.kind) {
    case 'module':
      return isOwnerModuleCode(argument) ? { kind: 'module', module: argument } : null;
    case 'scoped':
      return argument === 'common-registry' || argument === 'workforce' || argument === 'alerts'
        ? { kind: 'scoped', scope: argument }
        : null;
    case 'company':
      return { kind: 'company' };
    case 'self':
      return { kind: 'self' };
    case 'account':
      return typeof argument === 'string' && isTenantCapability(argument)
        ? { kind: 'account', capability: argument }
        : null;
    default:
      return null;
  }
}

/** Role names a handler's `@Roles` lists that are platform roles (the rest cannot compile). */
export function platformRolesOf(handler: ScannedHandler): PlatformRole[] {
  return handler.roles.filter(isPlatformRole);
}

export interface ReferenceInventoryEntry {
  readonly service: string;
  readonly handler: ScannedHandler;
}

/** Every `@ResolveReference` of every service under `apps/`. */
export function referenceInventory(): ReferenceInventoryEntry[] {
  const services = new Set(
    trackedFiles(['apps'])
      .map((file) => /^apps\/([^/]+)\/src\//.exec(file))
      .flatMap((match) => (match !== null && match[1] !== undefined ? [match[1]] : [])),
  );
  return [...services].sort().flatMap((service) =>
    serviceSources(service)
      .map((file) => [file, readRepoFile(file)] as const)
      .filter(([, source]) => source.includes('ResolveReference'))
      .flatMap(([file, source]) => scanSource(file, source))
      .filter((handler) => handler.role === 'reference')
      .map((handler) => ({ service, handler })),
  );
}
