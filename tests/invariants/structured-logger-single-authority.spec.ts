/**
 * One logger, one redaction boundary.
 *
 * `StructuredLoggerService` in libs/backend-common is the logger every Nest
 * service boots with (`create-service-app.ts` passes it to NestFactory). It
 * is where `maskPii` is applied to the message, the stack and the metadata,
 * so it is the only place a log line can be made safe to ship. A second
 * `LoggerService` implementation — admin-api carried one until 2026-09-05, a
 * `ConsoleLogger` subclass with the same class name and no masking — is a
 * second boundary that masks nothing, and nothing structural stopped a
 * module from wiring it. This spec makes a second implementation a build
 * failure, and pins that the kernel logger's free-text fields all pass
 * through the PII masker (the behavioural half lives in
 * libs/backend-common/src/logging/__tests__/structured-logger.spec.ts).
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#OBS-CRITICAL-004
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const KERNEL_LOGGER = 'libs/backend-common/src/logging/structured-logger.service.ts';
const SCAN_ROOTS = ['apps', 'libs', 'platform/libs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '.archive', 'coverage']);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts'))
      out.push(full);
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  return files;
}

describe('structured logging has a single implementation and a single redaction boundary', () => {
  it('exactly one class implements LoggerService or extends ConsoleLogger, and it is the kernel logger', () => {
    const implementations = sourceFiles()
      .filter((file) =>
        /\b(?:implements\s+LoggerService|extends\s+ConsoleLogger)\b/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(REPO_ROOT, file));

    expect(implementations).toEqual([KERNEL_LOGGER]);
  });

  it('the kernel logger passes the message and the stack through maskPii', () => {
    const source = readFileSync(join(REPO_ROOT, KERNEL_LOGGER), 'utf8');
    const writeLog = source.slice(source.indexOf('private writeLog('));

    expect(writeLog).toMatch(/message:\s*maskPii\(/);
    expect(writeLog).toMatch(/stack:\s*maskPii\(stack\)/);
  });

  it('every Nest service boots with the kernel logger', () => {
    const bootstrap = readFileSync(
      join(REPO_ROOT, 'libs/backend-common/src/bootstrap/create-service-app.ts'),
      'utf8',
    );
    expect(bootstrap).toContain('logger: new StructuredLoggerService(serviceName)');
  });
});
