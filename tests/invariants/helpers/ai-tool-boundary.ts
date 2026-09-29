/**
 * The AI tool boundary rules (K10 layer 1, PR-T1 — V-T1a-2/3/4/8), checked on
 * the TypeScript AST of one tool source.
 *
 * WHY here and not only in ESLint: ai-service lint runs as a warning in the
 * affected lane (INFRA-MEDIUM-154 quarantine), so an ESLint rule alone cannot
 * fail a PR. The invariants project runs on every PR; these checks are the
 * gate, and the ESLint block in eslint.config.mjs mirrors them for editors.
 *
 * A "tool source" is any file under apps/ai-service/src/tools/ or any file
 * that declares a `@Tool(` class (the boundary follows the decorator, not the
 * directory — V-T1a-4).
 */
import * as ts from 'typescript';

/** Module specifiers a tool may not import (exact) — transports, databases, HTTP. */
const BANNED_MODULES = new Set([
  '@nestjs/microservices',
  '@aquaculture/backend-common/nats',
  '@aquaculture/backend-common/http',
  '@platform/event-bus',
  '@nestjs/axios',
  'axios',
  'undici',
  'node-fetch',
  'http',
  'https',
  'node:http',
  'node:https',
  'http2',
  'node:http2',
  'net',
  'node:net',
  'typeorm',
  '@nestjs/typeorm',
]);

/** Module-specifier fragments a tool may not import (paths into libraries, minting). */
const BANNED_MODULE_FRAGMENTS: readonly RegExp[] = [
  /^@nats-io\//,
  /backend-common\/src\/nats/,
  /backend-common\/src\/http/,
  /libs\/event-bus/,
  /service-identity/,
  // Minting a context or binding is the trusted entry points' job (V-T1a-2).
  /tenant-boundary\/tool-context\.factory$/,
];

/** Identifiers that name a raw transport, its token or a DI escape hatch (V-T1a-3/8). */
const BANNED_IDENTIFIERS = new Set([
  'ClientProxy',
  'NatsV3Client',
  'NatsRequestReply',
  'NatsEventBus',
  'getRawConnection',
  // @nestjs/core stays importable for the registry's DiscoveryService; the DI
  // escape hatches that resolve an arbitrary provider are named here instead.
  'ModuleRef',
  'LazyModuleLoader',
  'HttpService',
  'XMLHttpRequest',
  'WebSocket',
  'AI_TENANT_BOUND_TRANSPORT',
  'DataSource',
  'QueryRunner',
  'EntityManager',
  'buildHumanTurnContext',
  'buildConfirmedProposalContext',
  'buildServicePrincipalContext',
  'fromTrustedRequest',
  'SignedHttpClient',
]);

/** String tokens that resolve a raw client through DI. */
const BANNED_STRING_TOKENS = new Set(['EVENT_BUS', 'NATS_SERVICE', 'NATS_CLIENT']);

/** The only class a tool may receive by injection. */
const TOOL_INJECTABLE = 'TenantBoundNatsClient';

function typeName(type: ts.TypeNode | undefined): string | null {
  if (type === undefined || !ts.isTypeReferenceNode(type)) return null;
  return ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
}

/** Violations of the tool boundary in one source file. */
export function toolBoundaryViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const push = (node: ts.Node, reason: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    out.push(`${file}:${line + 1}: ${reason}`);
  };

  // Properties of `this` that hold the bound client (constructor-injected).
  const boundClientProps = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = (node.moduleSpecifier as ts.StringLiteral).text;
      if (BANNED_MODULES.has(spec) || BANNED_MODULE_FRAGMENTS.some((re) => re.test(spec))) {
        push(node, `imports ${spec}`);
      }
      // A TenantBinding may be named as a TYPE only; its value (and minting) is not for tools.
      const clause = node.importClause;
      if (
        /tenant-boundary\/tenant-binding$/.test(spec) &&
        clause !== undefined &&
        !clause.isTypeOnly
      ) {
        const bindings = clause.namedBindings;
        const valueImport =
          clause.name !== undefined ||
          (bindings !== undefined &&
            (!ts.isNamedImports(bindings) || bindings.elements.some((e) => !e.isTypeOnly)));
        if (valueImport)
          push(node, 'imports TenantBinding as a value (only a type import is allowed)');
      }
    }
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) {
      push(node, `names ${node.text}`);
    }
    if (ts.isStringLiteralLike(node) && BANNED_STRING_TOKENS.has(node.text)) {
      push(node, `names the DI token '${node.text}'`);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'fetch') push(node, 'calls the global fetch');
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'request') {
        const target = callee.expression;
        const onBoundClient =
          ts.isPropertyAccessExpression(target) &&
          target.expression.kind === ts.SyntaxKind.ThisKeyword &&
          boundClientProps.has(target.name.text);
        if (!onBoundClient)
          push(node, '.request( on something other than the injected TenantBoundNatsClient');
      }
    }
    if (ts.isDecorator(node)) {
      const expr = node.expression;
      if (
        ts.isCallExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'Inject'
      ) {
        const [arg] = expr.arguments;
        if (arg === undefined || !ts.isIdentifier(arg) || arg.text !== TOOL_INJECTABLE) {
          push(
            node,
            `@Inject(${arg?.getText(source) ?? ''}) — a tool injects only ${TOOL_INJECTABLE}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  // First pass: which `this.x` hold the bound client, and what tool classes inject.
  // A tool class is one decorated @Tool(…) or a Base…Tool it extends: those are
  // the DI singletons whose code the model's tool_use drives.
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const isToolClass =
      (ts.getDecorators(statement) ?? []).some((d) => d.getText(source).startsWith('@Tool(')) ||
      /^Base\w*Tool$/.test(statement.name?.text ?? '');
    const ctor = statement.members.find(ts.isConstructorDeclaration);
    for (const param of ctor?.parameters ?? []) {
      const injected = typeName(param.type);
      if (injected === TOOL_INJECTABLE) {
        boundClientProps.add(param.name.getText(source));
        continue;
      }
      if (isToolClass) {
        push(
          param,
          `injects ${injected ?? param.getText(source)} — a tool injects only ${TOOL_INJECTABLE}`,
        );
      }
    }
  }
  visit(source);
  return out;
}

/** True when the file declares a class decorated with `@Tool(`. */
export function declaresTool(text: string): boolean {
  return /@Tool\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));
}
