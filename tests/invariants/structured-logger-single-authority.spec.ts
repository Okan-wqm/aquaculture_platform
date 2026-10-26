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
 * libs/backend-common/src/logging/__tests__/structured-logger.spec.ts). The boot
 * options are pinned too: `nestFactoryOptions` is spread after the logger, so its
 * type must not be able to carry a `logger` that replaces the redaction sink.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#OBS-CRITICAL-008
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';

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

/**
 * The compiler's errors for each `nestFactoryOptions` literal, assigned to the real
 * `ServiceBootstrapOptions` in one in-memory program (line 0 is the import).
 */
function nestFactoryOptionsErrors(literals: string[]): Array<[string, string[]]> {
  const probePath = join(REPO_ROOT, 'libs/backend-common/src/bootstrap/options.probe.ts');
  const probe = [
    "import type { ServiceBootstrapOptions } from './create-service-app';",
    ...literals.map(
      (l, i) => `export const p${i}: ServiceBootstrapOptions['nestFactoryOptions'] = ${l};`,
    ),
  ].join('\n');
  const base = ts.readConfigFile(join(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile).config;
  const { options } = ts.convertCompilerOptionsFromJson(
    { ...base.compilerOptions, types: ['node'], noEmit: true },
    REPO_ROOT,
  );
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === probePath
      ? ts.createSourceFile(name, probe, ts.ScriptTarget.ES2021)
      : readSource(name, ...rest);
  const program = ts.createProgram([probePath], options, host);
  const source = program.getSourceFile(probePath);
  if (!source) throw new Error('probe source missing from the program');
  const diagnostics = program.getSemanticDiagnostics(source);
  return literals.map((literal, i) => [
    literal,
    diagnostics
      .filter((d) => source.getLineAndCharacterOfPosition(d.start ?? 0).line === i + 1)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
  ]);
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

describe('nestFactoryOptions cannot replace the kernel logger', () => {
  const REJECTED = ['{ logger: false }', "{ rawBody: true, logger: ['error'] }"];
  // Near-misses: what billing, event-store and gateway-api pass today.
  const ACCEPTED = ['{ rawBody: true }', '{ bodyParser: true }', '{ rawBody: false }'];
  let errors: Map<string, string[]>;
  beforeAll(() => {
    errors = new Map(nestFactoryOptionsErrors([...REJECTED, ...ACCEPTED]));
  }, 120_000);

  it.each(REJECTED)('rejects %s at compile time, and the error names logger', (literal) => {
    expect(errors.get(literal)?.length).toBeGreaterThan(0);
    expect(errors.get(literal)?.every((message) => /\blogger\b/.test(message))).toBe(true);
  });

  it.each(ACCEPTED)('still accepts %s', (literal) => {
    expect(errors.get(literal)).toEqual([]);
  });
});
