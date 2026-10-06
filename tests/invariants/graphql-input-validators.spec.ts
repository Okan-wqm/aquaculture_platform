/**
 * Invariant (SENSOR-HIGH-141 / PLAT-HIGH-922): every GraphQL input property
 * declares a class-validator decorator.
 *
 * Every service registers the global ValidationPipe with whitelist +
 * forbidNonWhitelisted (create-service-app). A property that carries only
 * `@Field` is therefore "not whitelisted": any request that sends it fails
 * with "property X should not exist", while the schema advertises the field
 * as valid. The add-device wizard, sensor edits and every edge-device / IO
 * config write failed this way, and nothing caught it before a user did.
 *
 * Scope: `@InputType` classes in tracked `apps/**` sources. A field passes
 * when any of its decorators is a class-validator or class-transformer one
 * (`Is*`, `Validate*`, `Min`/`Max`, `Length`, `Matches`, `Allow`, `Type`, …).
 *
 * KNOWN_GAPS is a per-file ratchet tied to PLAT-HIGH-922 (owner claude,
 * deadline 2026-10-27): a listed file may not gain a gap, a fixed file must
 * leave the list, and an unlisted file must be clean.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const VALIDATOR_DECORATOR =
  /^(Is[A-Z]\w*|Validate\w*|Min|Max|MinLength|MaxLength|Length|Matches|Allow|Equals|NotEquals|ArrayMinSize|ArrayMaxSize|ArrayNotEmpty|Contains|NotContains|Type)$/;

/** PLAT-HIGH-922: undecorated input fields per file. May only shrink. */
const KNOWN_GAPS: Readonly<Record<string, number>> = {
  'apps/auth-service/src/modules/gdpr/dto/user-consent.dto.ts': 1,
  'apps/auth-service/src/modules/support/dto/support.dto.ts': 2,
  'apps/auth-service/src/modules/tenant/dto/mobile-settings.dto.ts': 1,
  'apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts': 1,
  'apps/farm-service/src/batch/dto/batch-resolver.dto.ts': 16,
  'apps/farm-service/src/farm/dto/create-farm.input.ts': 1,
  'apps/farm-service/src/finance/dto/finance-inputs.dto.ts': 1,
  'apps/farm-service/src/growth/resolvers/growth.resolver.ts': 30,
  'apps/farm-service/src/maintenance/resolvers/spare-part.resolver.ts': 3,
  'apps/farm-service/src/regulatory/dto/regulatory-report-draft.dto.ts': 1,
  'apps/farm-service/src/regulatory/dto/report-prefill.dto.ts': 5,
  'apps/hr-service/src/aquaculture/dto/create-work-area.input.ts': 2,
  'apps/hr-service/src/hr/dto/create-department.input.ts': 8,
  'apps/hr-service/src/hr/dto/update-department.input.ts': 11,
};

function decoratorName(decorator: ts.Decorator): string {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) ? expression.expression.getText() : expression.getText();
}

/** file → `Class.property` entries whose decorators include @Field but no validator. */
function undecoratedInputFields(): Map<string, string[]> {
  const files = execFileSync('git', ['ls-files', 'apps'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !/__tests__\/|\.(spec|test)\.ts$/.test(file));

  const gaps = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (!source.includes('@InputType')) continue;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isClassDeclaration(node) &&
        (ts.getDecorators(node) ?? []).some((decorator) => decoratorName(decorator) === 'InputType')
      ) {
        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member)) continue;
          const names = (ts.getDecorators(member) ?? []).map(decoratorName);
          if (names.includes('Field') && !names.some((name) => VALIDATOR_DECORATOR.test(name))) {
            const entry = `${node.name?.text ?? '<anonymous>'}.${member.name.getText(sourceFile)}`;
            gaps.set(file, [...(gaps.get(file) ?? []), entry]);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return gaps;
}

describe('GraphQL input properties declare a validator (SENSOR-HIGH-141)', () => {
  const gaps = undecoratedInputFields();

  it('no unlisted file has an undecorated input field', () => {
    const unlisted = [...gaps.entries()]
      .filter(([file]) => KNOWN_GAPS[file] === undefined)
      .map(([file, fields]) => `${file}: ${fields.join(', ')}`);
    expect(unlisted).toEqual([]);
  });

  it('no listed file gains a gap (PLAT-HIGH-922 ratchet)', () => {
    const grown = Object.entries(KNOWN_GAPS)
      .filter(([file, ceiling]) => (gaps.get(file)?.length ?? 0) > ceiling)
      .map(([file, ceiling]) => `${file}: ceiling ${ceiling}, live ${gaps.get(file)?.length}`);
    expect(grown).toEqual([]);
  });

  it('a listed file that shrank lowers its ceiling (remove it at zero)', () => {
    const stale = Object.entries(KNOWN_GAPS)
      .filter(([file, ceiling]) => (gaps.get(file)?.length ?? 0) < ceiling)
      .map(([file, ceiling]) => `${file}: ceiling ${ceiling}, live ${gaps.get(file)?.length ?? 0}`);
    expect(stale).toEqual([]);
  });
});
