/**
 * INVARIANT: pay and HR finance are decided as hr module data, by the module grant, on every
 * operation that serves them (owner decision D6; ADR-054 draft one-way door 2, its rollout PR-9;
 * HR-CRITICAL-065, RBAC-HIGH-031).
 *
 * WHY: hr-service gated payroll, HR finance and payroll cost settings on
 * `@Roles(TENANT_ADMIN, MODULE_MANAGER)` alone. While hr-service is `account-role`
 * (libs/backend-common/src/security/access-enrolment.ts), RolesGuard compares that with the
 * tenant-wide `users.role`, and Assign Manager writes MODULE_MANAGER there for any module, so a farm
 * or sensor manager listed every payroll with base salary and gross pay and edited HR finance.
 * D6: salary and HR finance are visible only inside HR, that is to TENANT_ADMIN and to the holder
 * of an hr MODULE_MANAGER grant (which only the hr primary-manager choice writes,
 * apps/auth-service/src/modules/tenant/services/assignment-module-role.ts).
 *
 * WHAT, for every root operation of hr-service that serves pay or HR finance — every operation
 * under `src/finance/`, and every operation whose GraphQL type names a pay type (Payroll,
 * PayrollConnection, PayrollCostSettings, HrFinance*, HrLabourCost, HrPersonnelTable):
 *   1. it declares `@Access.module('hr')` on itself or its class;
 *   2. it takes `@AccessCaller()`. In `account-role` mode that parameter is the one place the
 *      `@Access` spec is decided (RolesGuard's account-role path never reads it): `decideAccess`
 *      runs with the operation's `@Roles` against the verified `moduleAccess` claim, so the global
 *      role still has to pass the guard and the hr grant (or the TENANT_ADMIN account role over a
 *      tenant with hr enabled) has to pass the decision. Once hr-service enrols, RolesGuard
 *      decides the same spec, and the parameter keeps deciding it;
 *   3. its `@Roles` names no MODULE_USER (every member would pass it) and is not empty.
 * The self-tests make sure the scan reads the real tree, so no rule passes because it reads
 * nothing.
 *
 * It changes no runtime behaviour; the decision itself is pinned by
 * apps/hr-service/src/finance/__tests__/pay-module-access.spec.ts and by the hr.payrolls cells of
 * e2e/tests/security/module-access-layers.expected.ts.
 */
import ts from 'typescript';

import { readRepoFile } from './helpers/module-dictionary-sources';
import { scanSource, serviceSources, type ScannedHandler } from './helpers/module-access-handlers';

const HR_SOURCES = 'apps/hr-service/src';
const FINANCE_DIR = `${HR_SOURCES}/finance/`;
/** The GraphQL types that carry pay or HR finance. */
const PAY_TYPE = /\b(Payroll\w*|HrFinance\w*|HrLabourCost|HrPersonnelTable|PayrollCostSettings)\b/;
const ROOT_DECORATORS: ReadonlySet<string> = new Set(['Query', 'Mutation', 'Subscription']);

/** `Class.method` → the text of the root decorator's type argument, e.g. `() => [Payroll]`. */
function rootTypeTexts(file: string, source: string): Map<string, string> {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const className = node.name.text;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        for (const decorator of ts.getDecorators(member) ?? []) {
          const call = decorator.expression;
          if (!ts.isCallExpression(call)) continue;
          if (!ROOT_DECORATORS.has(call.expression.getText(tree))) continue;
          out.set(`${className}.${member.name.text}`, call.arguments[0]?.getText(tree) ?? '');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

interface PayOperation {
  readonly handler: ScannedHandler;
  readonly key: string;
}

function payOperations(): PayOperation[] {
  return serviceSources('hr-service').flatMap((file) => {
    const source = readRepoFile(file);
    const types = rootTypeTexts(file, source);
    return scanSource(file, source)
      .filter((handler) => ['query', 'mutation', 'subscription'].includes(handler.role))
      .filter(
        (handler) =>
          file.startsWith(FINANCE_DIR) ||
          PAY_TYPE.test(types.get(`${handler.className}.${handler.method}`) ?? ''),
      )
      .map((handler) => ({ handler, key: `${file}#${handler.className}.${handler.method}` }));
  });
}

function isHrModuleSpec(handler: ScannedHandler): boolean {
  const access = handler.handlerAccess ?? handler.classAccess;
  return access !== null && access.kind === 'module' && access.args[0] === 'hr';
}

describe('INVARIANT: pay and HR finance are hr module data, decided by the grant (D6, HR-CRITICAL-065)', () => {
  const operations = payOperations();

  it('the scan reads the real tree: it finds the payroll and HR finance operations', () => {
    const fields = operations.map((operation) => operation.handler.fieldName);
    for (const canary of [
      'payrolls',
      'pendingPayrolls',
      'createPayroll',
      'approvePayroll',
      'hrLabourCost',
      'hrFinanceEntries',
      'updatePayrollCostSettings',
    ]) {
      expect(fields).toContain(canary);
    }
    expect(operations.length).toBeGreaterThanOrEqual(18);
  });

  it("every one declares @Access.module('hr') on itself or its class", () => {
    expect(
      operations.filter(({ handler }) => !isHrModuleSpec(handler)).map(({ key }) => key),
    ).toEqual([]);
  });

  it('every one takes @AccessCaller(), the decision point while hr-service is account-role', () => {
    expect(
      operations
        .filter(({ handler }) => !handler.params.includes('AccessCaller'))
        .map(({ key }) => key),
    ).toEqual([]);
  });

  it('every one names roles, and none of them MODULE_USER', () => {
    expect(
      operations
        .filter(
          ({ handler }) => handler.roles.length === 0 || handler.roles.includes('MODULE_USER'),
        )
        .map(({ handler, key }) => `${key}: @Roles(${handler.roles.join(', ')})`),
    ).toEqual([]);
  });
});
