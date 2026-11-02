/**
 * Readers for the three shrink-only access-surface invariants of ADR-054 D-F (draft) 1-3:
 *
 *   - `ratchetSetsOf`: per `account-role` service, the root operations RolesGuard lets every
 *     authenticated member through (account-role-ungated-ratchet.spec.ts);
 *   - `gatewaySurfaceOf`: every REST handler, socket message handler and socket connection of
 *     gateway-api, and whether it names an access decision (gateway-surface-access.spec.ts);
 *   - `referenceTenantViolationsOf`: every `@ResolveReference` that takes the tenant from the
 *     federation representation instead of the request (reference-resolver-tenant.spec.ts);
 *   - `baselineDiff`: the one comparison all three make against their committed baseline.
 *
 * Everything is read from the syntax tree (comments and strings never count), with the decorator
 * reader of the ADR-051 classification scanner (./module-access-handlers.ts), so the two scanners
 * cannot disagree about what a decorator is.
 */
import { PLATFORM_ROLES_BY_PRIVILEGE } from '@aquaculture/shared-contracts';
import ts from 'typescript';

import {
  decoratorCalls,
  REST_VERBS,
  type DecoratorCall,
  type ScannedHandler,
} from './module-access-handlers';

// ---------------------------------------------------------------------------------------------
// Shared: identity of a handler and the baseline comparison
// ---------------------------------------------------------------------------------------------

/** `file#Class.method`: stable across edits that only move lines. */
export function handlerKey(file: string, className: string, method: string): string {
  return `${file}#${className}.${method}`;
}

export interface BaselineDiff {
  /** In the code, not in the baseline: the invariant fails on any of these. */
  readonly grown: readonly string[];
  /** In the baseline, no longer in the code: the baseline should shrink (the spec passes). */
  readonly shrunk: readonly string[];
}

export function baselineDiff(
  current: readonly string[],
  baseline: readonly string[],
): BaselineDiff {
  const now = new Set(current);
  const frozen = new Set(baseline);
  return {
    grown: [...now].filter((key) => !frozen.has(key)).sort(),
    shrunk: [...frozen].filter((key) => !now.has(key)).sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// D-F 1: the account-role ratchet
// ---------------------------------------------------------------------------------------------

/** The roles every member holds through the hierarchy: the lowest platform role. */
const FLOOR_ROLE: string = ((): string => {
  const lowest: string | undefined =
    PLATFORM_ROLES_BY_PRIVILEGE[PLATFORM_ROLES_BY_PRIVILEGE.length - 1];
  if (lowest === undefined) throw new Error('PLATFORM_ROLES_BY_PRIVILEGE is empty');
  return lowest;
})();

/** Root operations RolesGuard runs on (it never runs on reference or field resolvers). */
const ROOT_OPERATION_ROLES: ReadonlySet<ScannedHandler['role']> = new Set([
  'query',
  'mutation',
  'subscription',
  'rest',
]);

export interface RatchetSets {
  /** No `@Roles` (or alias), no `@Access` and no `@Public` on the handler or its class. */
  readonly ungated: readonly string[];
  /** Its effective `@Roles` lists the floor role (MODULE_USER), so every member passes. */
  readonly moduleUserOnly: readonly string[];
  /** `@Public()` on the handler or its class, and no `@Access`: open to anyone. */
  readonly public: readonly string[];
}

/**
 * The three sets of one `account-role` service, decided the way `canActivateByAccountRole`
 * decides (libs/backend-common/src/guards/roles.guard.ts): `isPublic` and `@Roles` are read with
 * `getAllAndOverride([handler, class])`, so the handler's declaration beats its class's, and an
 * empty `@Roles()` is the same as none. The scanner applies the same precedence
 * (`ScannedHandler.roles` is the handler's `@Roles`, else the class's).
 *
 * `@Access` gates in an `account-role` service only where the handler takes `@AccessCaller()`:
 * that parameter decides the spec whatever the guard mode (libs/backend-common/src/security/
 * access-caller.ts, `resolveHandlerAccess`), while `canActivateByAccountRole` never reads
 * `@Access`. So a handler with `@Access` and no `@AccessCaller()` is classified by its `@Roles`
 * and `@Public` like any other, and adding `@Access` alone cannot take an open operation out of
 * the ungated set.
 */
export function ratchetSetsOf(handlers: readonly ScannedHandler[]): RatchetSets {
  const ungated: string[] = [];
  const moduleUserOnly: string[] = [];
  const open: string[] = [];
  for (const handler of handlers) {
    if (!ROOT_OPERATION_ROLES.has(handler.role)) continue;
    const key = handlerKey(handler.file, handler.className, handler.method);
    const hasAccess = handler.handlerAccess !== null || handler.classAccess !== null;
    const decidesInHandler = hasAccess && handler.params.includes('AccessCaller');
    const isPublic = handler.handlerPublic || handler.classPublic;
    if (decidesInHandler) continue;
    if (isPublic) open.push(key);
    else if (handler.roles.length === 0) ungated.push(key);
    else if (handler.roles.includes(FLOOR_ROLE)) moduleUserOnly.push(key);
  }
  return { ungated: ungated.sort(), moduleUserOnly: moduleUserOnly.sort(), public: open.sort() };
}

export interface RatchetDiff extends BaselineDiff {
  /** Ungated in the baseline, MODULE_USER-gated now: same reach, now declared; the key moves. */
  readonly moved: readonly string[];
}

/**
 * One ratchet set against the baseline. A key new to `moduleUserOnly` that the baseline lists as
 * `ungated` is a move, not growth: the operation reaches the same callers and now declares a
 * gate. No other move is allowed: an operation that loses its gate grows `ungated`, and one that
 * turns `@Public` grows `public` (open without a token).
 */
export function ratchetDiff(
  set: keyof RatchetSets,
  current: readonly string[],
  frozen: RatchetSets,
): RatchetDiff {
  const { grown, shrunk } = baselineDiff(current, frozen[set]);
  const movable = new Set(set === 'moduleUserOnly' ? frozen.ungated : []);
  return {
    grown: grown.filter((key) => !movable.has(key)),
    moved: grown.filter((key) => movable.has(key)),
    shrunk,
  };
}

// ---------------------------------------------------------------------------------------------
// D-F 2: the gateway surface
// ---------------------------------------------------------------------------------------------

export type GatewaySurfaceRole = 'rest' | 'message' | 'connection';

/**
 * The decorators that name an access decision on a gateway-api handler or its class:
 *   - `Access.*`: an ADR-051 access spec (libs/backend-common/src/decorators/access.decorator.ts);
 *   - `Public`: an explicit decision that no principal is needed (gateway-api's own
 *     guards/auth.guard.ts and guards/tenant-isolation.guard.ts, both setting `isPublic`);
 *   - `ApiKeyAuth`, `BasicAuth`: an explicit non-user (device or service) principal
 *     (gateway-api guards/auth.guard.ts).
 * A package that adds another principal marker adds its name here, in the same PR.
 */
const DECIDING_DECORATORS: ReadonlySet<string> = new Set(['Public', 'ApiKeyAuth', 'BasicAuth']);

function decisionOf(calls: readonly DecoratorCall[]): string | null {
  for (const call of calls) {
    if (call.name.startsWith('Access.')) return call.name;
    if (DECIDING_DECORATORS.has(call.name)) return call.name;
  }
  return null;
}

export interface GatewaySurfaceEntry {
  readonly key: string;
  readonly line: number;
  readonly role: GatewaySurfaceRole;
  /** The deciding decorator on the handler, else on its class; null when none. */
  readonly decision: string | null;
}

/**
 * Every surface of one gateway-api source file: each REST verb handler of a `@Controller`, each
 * `@SubscribeMessage` handler of a `@WebSocketGateway`, and the gateway's connection itself (its
 * `handleConnection`, or `<connection>` when the class has none: the socket is still accepted).
 */
export function gatewaySurfaceOf(file: string, source: string): GatewaySurfaceEntry[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const out: GatewaySurfaceEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const className = node.name.text;
      const classCalls = decoratorCalls(node);
      const isController = classCalls.some((call) => call.name === 'Controller');
      const isSocketGateway = classCalls.some((call) => call.name === 'WebSocketGateway');
      const classDecision = decisionOf(classCalls);
      const methods = node.members.filter(ts.isMethodDeclaration);
      if (isSocketGateway) {
        const connect = methods.find((member) => member.name.getText() === 'handleConnection');
        out.push({
          key: handlerKey(
            file,
            className,
            connect === undefined ? '<connection>' : 'handleConnection',
          ),
          line: lineOf(connect ?? node),
          role: 'connection',
          decision:
            (connect === undefined ? null : decisionOf(decoratorCalls(connect))) ?? classDecision,
        });
      }
      for (const member of methods) {
        const calls = decoratorCalls(member);
        const isRest = isController && calls.some((call) => REST_VERBS.has(call.name));
        const isMessage = isSocketGateway && calls.some((call) => call.name === 'SubscribeMessage');
        if (!isRest && !isMessage) continue;
        out.push({
          key: handlerKey(file, className, member.name.getText()),
          line: lineOf(member),
          role: isRest ? 'rest' : 'message',
          decision: decisionOf(calls) ?? classDecision,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

// ---------------------------------------------------------------------------------------------
// D-F 3: reference resolvers take the tenant from the request
// ---------------------------------------------------------------------------------------------

export type ReferenceTenantRule =
  | 'reads-tenant-from-representation'
  | 'passes-representation-whole';

export interface ReferenceTenantViolation {
  /** `file#Class.method:rule`. */
  readonly key: string;
  readonly line: number;
  readonly rule: ReferenceTenantRule;
}

const TENANT_PROPERTY = /^tenant(Id|_id)?$/i;

/** The identifier an access chain starts from: `a` for `a?.b!.c['d']`, `(a as T).b`. */
function rootIdentifier(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return null;
  }
}

/** The expression under parentheses, `as`, `!` and `satisfies`: `rep` for `(rep as T)!`. */
function unwrapped(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The names that still hold the whole object: `r` of `const r = rep`, `rest` of `{ id, ...rest }`. */
function wholeBindingsOf(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements.flatMap((element) =>
    element.dotDotDotToken !== undefined && ts.isIdentifier(element.name)
      ? [element.name.text]
      : [],
  );
}

function bindingNamesOf(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNamesOf(element.name),
  );
}

/** Whether an object binding pattern takes a tenant-named property (at any depth). */
function bindsTenant(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return false;
  return name.elements.some((element) => {
    if (ts.isOmittedExpression(element)) return false;
    const property = element.propertyName ?? element.name;
    if (
      ts.isObjectBindingPattern(name) &&
      ts.isIdentifier(property) &&
      TENANT_PROPERTY.test(property.text)
    ) {
      return true;
    }
    return bindsTenant(element.name);
  });
}

/**
 * The representation is the `@Parent()` parameter, else the first: Nest passes the federation
 * representation first and the GraphQL context second to a `@ResolveReference` without parameter
 * decorators. Every name derived from it by `const x = rep…` or destructuring joins it.
 */
function representationViolations(
  file: string,
  className: string,
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
): ReferenceTenantViolation[] {
  const parameters = [...method.parameters];
  const representation =
    parameters.find((parameter) =>
      decoratorCalls(parameter).some((call) => call.name === 'Parent'),
    ) ?? parameters[0];
  if (representation === undefined || method.body === undefined) return [];
  // `derived`: every name read out of the representation (a tenant read through any of them reads
  // the representation). `whole`: the names that ARE the representation object, or a rest copy of
  // it, which a callee could read a tenant from.
  const derived = new Set(bindingNamesOf(representation.name));
  const whole = new Set(ts.isIdentifier(representation.name) ? [representation.name.text] : []);
  const out = new Map<string, ReferenceTenantViolation>();
  const flag = (node: ts.Node, rule: ReferenceTenantRule): void => {
    const key = `${handlerKey(file, className, method.name.getText())}:${rule}`;
    if (!out.has(key)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      out.set(key, { key, line, rule });
    }
  };
  if (bindsTenant(representation.name)) flag(representation, 'reads-tenant-from-representation');

  let grew = true;
  while (grew) {
    grew = false;
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const root = rootIdentifier(node.initializer);
        if (root !== null && derived.has(root)) {
          for (const name of bindingNamesOf(node.name)) {
            if (!derived.has(name)) {
              derived.add(name);
              grew = true;
            }
          }
        }
        const alias = unwrapped(node.initializer);
        if (ts.isIdentifier(alias) && whole.has(alias.text)) {
          for (const name of wholeBindingsOf(node.name)) {
            if (!whole.has(name)) {
              whole.add(name);
              grew = true;
            }
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(method.body);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && TENANT_PROPERTY.test(node.name.text)) {
      const root = rootIdentifier(node.expression);
      if (root !== null && derived.has(root)) flag(node, 'reads-tenant-from-representation');
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      TENANT_PROPERTY.test(node.argumentExpression.text)
    ) {
      const root = rootIdentifier(node.expression);
      if (root !== null && derived.has(root)) flag(node, 'reads-tenant-from-representation');
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      bindsTenant(node.name)
    ) {
      const root = rootIdentifier(node.initializer);
      if (root !== null && derived.has(root)) flag(node, 'reads-tenant-from-representation');
    }
    // Handing the whole representation on lets the callee read its tenant out of sight.
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments !== undefined) {
      for (const argument of node.arguments) {
        const passed = unwrapped(argument);
        if (ts.isIdentifier(passed) && whole.has(passed.text)) {
          flag(argument, 'passes-representation-whole');
        }
      }
    }
    if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
      const spread = unwrapped(node.expression);
      if (ts.isIdentifier(spread) && whole.has(spread.text))
        flag(node, 'passes-representation-whole');
    }
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  return [...out.values()];
}

/** Every reference-tenant violation of one source file. */
export function referenceTenantViolationsOf(
  file: string,
  source: string,
): ReferenceTenantViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: ReferenceTenantViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        if (!decoratorCalls(member).some((call) => call.name === 'ResolveReference')) continue;
        out.push(...representationViolations(file, node.name.text, member, sourceFile));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}
