/**
 * Scheduled-method table — every method the fleet schedules, read from the
 * source with the TypeScript compiler (ADMIN-HIGH-013).
 *
 * `@Cron` / `@Interval` / `@Timeout` are the raw NestJS decorators; a method
 * carrying one runs on every replica with no lease and no heartbeat.
 * `@ScheduledJob` is the kernel decorator that applies the schedule AND
 * routes the tick through `ScheduledJobRunner` (advisory lock + heartbeat).
 * The gate `scheduled-jobs-leased.spec.ts` reads this table; the scan lives
 * here so the ratchet's generator and the gate cannot drift.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export type SchedulerDecorator = 'Cron' | 'Interval' | 'Timeout' | 'ScheduledJob';

const SCHEDULER_DECORATORS: ReadonlySet<string> = new Set<SchedulerDecorator>([
  'Cron',
  'Interval',
  'Timeout',
  'ScheduledJob',
]);

export interface ScheduledMethod {
  /** `<repo-relative file>#<method>` */
  readonly id: string;
  readonly file: string;
  /** `apps/<name>` for a service, `libs/<name>` / `platform/libs/<name>` for a library. */
  readonly project: string;
  readonly className: string;
  readonly method: string;
  readonly decorator: SchedulerDecorator;
  /** `@ScheduledJob({ name })` — the declared job name; null for raw decorators. */
  readonly jobName: string | null;
  readonly line: number;
}

/** Production source only: tests, fixtures, archives and built output schedule nothing. */
const NOT_PRODUCTION =
  /(^|\/)(__tests__|__mocks__|test|tests|e2e|dist|\.archive|node_modules)\/|\.(spec|test)\.tsx?$|\.d\.ts$/;

export function listScheduledSourceFiles(): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      // git pathspec `*` spans '/' — `**/` would skip files directly under src/.
      'apps/*/src/*.ts',
      'libs/*/src/*.ts',
      'platform/libs/*/src/*.ts',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((rel) => rel.length > 0 && !NOT_PRODUCTION.test(rel));
}

export function projectOf(file: string): string {
  const parts = file.split('/');
  return parts[0] === 'platform' ? parts.slice(0, 3).join('/') : parts.slice(0, 2).join('/');
}

function decoratorCall(
  decorator: ts.Decorator,
): { name: string; args: readonly ts.Expression[] } | null {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { name: expr.expression.text, args: expr.arguments };
  }
  return null;
}

function jobNameOf(args: readonly ts.Expression[]): string | null {
  const first = args[0];
  if (!first || !ts.isObjectLiteralExpression(first)) return null;
  for (const prop of first.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'name' &&
      (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
    ) {
      return prop.initializer.text;
    }
  }
  return null;
}

/** Every scheduled method in one source file, in declaration order. */
export function scheduledMethodsIn(file: string): ScheduledMethod[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(REPO_ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: ScheduledMethod[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        for (const decorator of ts.getDecorators(member) ?? []) {
          const call = decoratorCall(decorator);
          if (!call || !SCHEDULER_DECORATORS.has(call.name)) continue;
          found.push({
            id: `${file}#${member.name.text}`,
            file,
            project: projectOf(file),
            className: node.name.text,
            method: member.name.text,
            decorator: call.name as SchedulerDecorator,
            jobName: call.name === 'ScheduledJob' ? jobNameOf(call.args) : null,
            line: source.getLineAndCharacterOfPosition(member.name.getStart()).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every scheduled method across apps, libs and platform libs. */
export function allScheduledMethods(): ScheduledMethod[] {
  return listScheduledSourceFiles().flatMap(scheduledMethodsIn);
}
