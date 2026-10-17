/**
 * Call one export of an ES module (`.mjs`) from an invariant spec.
 *
 * WHY. The invariant suite's jest transform handles `.ts` and `.js` only
 * (tests/invariants/jest.config.ts `moduleFileExtensions`), so a spec cannot
 * `import` scripts/ci/lib/*.mjs. Specs that needed a CI module's verdict
 * re-typed its rules instead, and the copies drifted: the dormant-invariant
 * spec accepted a waiver scripts/ci/lib/reviewed-exception.mjs refuses
 * (INFRA-LOW-229). Calling THE export in a child `node` keeps the module the
 * one owner of what it decides.
 *
 * Arguments cross on stdin and the result on stdout, both as JSON, so the
 * argument size is not bounded by the command line.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export interface EsmCallOutcome {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function callEsmExport(
  modulePath: string,
  exportName: string,
  args: readonly unknown[],
): EsmCallOutcome {
  const program = [
    `const lib = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    'const chunks = [];',
    'for await (const chunk of process.stdin) chunks.push(chunk);',
    "const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    `const result = lib[${JSON.stringify(exportName)}](...args);`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: JSON.stringify(args),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** The export's JSON result; throws with the child's stderr when the call fails. */
export function esmExportResult<T>(
  modulePath: string,
  exportName: string,
  args: readonly unknown[],
): T {
  const outcome = callEsmExport(modulePath, exportName, args);
  if (outcome.status !== 0) throw new Error(`${exportName} failed: ${outcome.stderr}`);
  return JSON.parse(outcome.stdout) as T;
}
