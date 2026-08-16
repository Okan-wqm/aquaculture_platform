import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveEdgeRules } from '@aquaculture/backend-common/rate-limit';
import ts from 'typescript';

import { ADMIN_RATE_LIMIT_EDGE_CONFIG } from '../../security/admin-rate-limit.policy';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const ADMIN_SOURCE_ROOT = resolve(REPO_ROOT, 'apps/admin-api-service/src');
const MUTATION_DECORATORS = new Set(['Post', 'Put', 'Patch', 'Delete']);
const LEGACY_THROTTLE_DECORATORS = new Set([
  'Throttle',
  'ThrottleSensitive',
  'ThrottleExport',
  'ThrottlePasswordReset',
  'SkipThrottle',
]);

function controllerFiles(): string[] {
  return ts.sys.readDirectory(ADMIN_SOURCE_ROOT, ['.ts'], undefined, ['**/*controller.ts']);
}

function decoratorName(decorator: ts.Decorator, checker: ts.TypeChecker): string | undefined {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return undefined;
  }
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.getName();
}

function decoratorsOf(node: ts.Node, checker: ts.TypeChecker): string[] {
  if (!ts.canHaveDecorators(node)) {
    return [];
  }
  return (ts.getDecorators(node) ?? [])
    .map((decorator) => decoratorName(decorator, checker))
    .filter((name): name is string => name !== undefined);
}

describe('admin rate-limit semantic boundary', () => {
  const files = controllerFiles();
  const program = ts.createProgram(files, {
    experimentalDecorators: true,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();

  it('discovers every controller mutation and gives all of them an automatic additive tier', () => {
    const mutations: Array<{ file: string; method: string }> = [];
    for (const sourceFile of program.getSourceFiles()) {
      if (!files.includes(sourceFile.fileName)) {
        continue;
      }
      ts.forEachChild(sourceFile, (node) => {
        if (!ts.isClassDeclaration(node) || !decoratorsOf(node, checker).includes('Controller')) {
          return;
        }
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) {
            continue;
          }
          const decorators = decoratorsOf(member, checker);
          if (decorators.some((name) => MUTATION_DECORATORS.has(name))) {
            mutations.push({
              file: sourceFile.fileName,
              method: member.name.getText(sourceFile),
            });
          }
        }
      });
    }

    expect(mutations.length).toBeGreaterThan(250);
    expect(ADMIN_RATE_LIMIT_EDGE_CONFIG.httpMutationTier).toBe('mutation');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        resolveEdgeRules(
          { headers: {}, method, url: '/arbitrary', userId: 'admin-1' },
          ADMIN_RATE_LIMIT_EDGE_CONFIG,
        ).map((rule) => rule.name),
      ).toEqual(['admin-default', 'admin-mutation']);
    }
  });

  it('contains no legacy throttle decorator that could create a second authority', () => {
    const violations: string[] = [];
    for (const sourceFile of program.getSourceFiles()) {
      if (!files.includes(sourceFile.fileName)) {
        continue;
      }
      const visit = (node: ts.Node): void => {
        for (const name of decoratorsOf(node, checker)) {
          if (LEGACY_THROTTLE_DECORATORS.has(name)) {
            violations.push(`${sourceFile.fileName}:${node.getStart(sourceFile)}:${name}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect(violations).toEqual([]);
  });

  it('keeps exemptions central, exact, GET-only, and limited to public process probes', () => {
    expect(ADMIN_RATE_LIMIT_EDGE_CONFIG.exemptions).toEqual([
      {
        methods: ['GET'],
        paths: [
          '/health',
          '/health/live',
          '/health/ready',
          '/health/startup',
          '/v1/health',
          '/v1/health/live',
          '/v1/health/ready',
          '/v1/health/startup',
        ],
      },
    ]);
    expect(
      resolveEdgeRules(
        { headers: {}, method: 'POST', url: '/health/live' },
        ADMIN_RATE_LIMIT_EDGE_CONFIG,
      ).map((rule) => rule.name),
    ).toEqual(['admin-anonymous', 'admin-mutation']);
  });

  it('requires distributed authority for every admin identity and mutation tier', () => {
    for (const tier of Object.values(ADMIN_RATE_LIMIT_EDGE_CONFIG.tiers)) {
      expect(tier.requiresDistributedStore).toBe(true);
    }
  });

  it('orders authentication before identity throttling and recent-MFA authorization', () => {
    const appModule = readFileSync(resolve(ADMIN_SOURCE_ROOT, 'app.module.ts'), 'utf8');
    const guardOrder = [
      ...appModule.matchAll(/provide:\s*APP_GUARD,[\s\S]*?useExisting:\s*(\w+)/g),
    ].map((match) => match[1]);

    expect(guardOrder).toEqual(['PlatformAdminGuard', 'RateLimitGuard', 'RecentMfaGuard']);
  });

  it('imports only the read-only revocation capability, never auth-owned writers', () => {
    const appModule = readFileSync(resolve(ADMIN_SOURCE_ROOT, 'app.module.ts'), 'utf8');

    expect(appModule).toContain('TokenRevocationReaderModule');
    expect(appModule).toContain('TOKEN_REVOCATION_READER');
    expect(appModule).not.toContain('TokenBlacklistModule');
    expect(appModule).not.toContain('UserTokenRevocationModule');
    expect(appModule).not.toContain('TOKEN_BLACKLIST');
    expect(appModule).not.toContain('USER_TOKEN_REVOCATION');
  });
});
