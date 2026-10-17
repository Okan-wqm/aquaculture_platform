/**
 * Which Rust files hold tests, answered by the one Rust reader (ARIA-LOW-545).
 *
 * WHY: the kernel's repository map (`aria-kernel/aria_kernel/twin_test_surface.py`)
 * kept a second Rust rule beside `rust-source.ts`: a file under `tests/`, or
 * one whose text contains `#[cfg(test)]`. It disagreed with this reader both
 * ways. `sens-api-gateway/src/scripting/bytecode_e2e_tests.rs` holds four
 * `#[tokio::test]` functions and no `#[cfg(test)]` (its declaring `mod` is the
 * gate), so the map missed it; a compile-fail input or a lint fixture under
 * `tests/`, a doc comment that mentions `#[cfg(test)]`, and a file that only
 * declares an out-of-line test module hold no test, yet the map counted them.
 *
 * WHAT: stdin `{"paths": [...]}`, workspace-relative `.rs` files; the working
 * directory is the workspace. A file holds tests when the reader finds a test
 * function in its code: an outer `#[test]` or `#[<path>::test]` attribute
 * (`attributeMarksTestFn`; comments and strings are not code) outside the
 * `macro_rules!` templates `testSpans` reports. stdout `{"test_files": [...],
 * "unreadable": [{"path", "reason"}]}`, both sorted by path: a path the
 * reader refuses (not a contained workspace file: absent, behind a symlink,
 * outside the workspace) or cannot lex is `unreadable`, never "no tests". The
 * kernel runs this only inside the adapter room, like every adapter.
 */
import { containedWorkspace, isWorkspaceRelativePath } from './adapter-fs';
import { attributeAt, attributeMarksTestFn, lexRust, testSpans } from './rust-source';

export interface RustTestFilesAnswer {
  readonly test_files: readonly string[];
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
}

export type RustTestsVerdict =
  | { readonly ok: true; readonly tests: boolean }
  | { readonly ok: false; readonly reason: string };

/** Does this Rust source declare a test function outside a `macro_rules!` template? */
export function holdsRustTests(source: string): RustTestsVerdict {
  const lexed = lexRust(source);
  if (!lexed.ok) return { ok: false, reason: `lex_failed:${lexed.reason}:${lexed.line}` };
  const tokens = lexed.tokens;
  const templates = testSpans(tokens).filter((span) => span.kind === 'macro_rules');
  for (let index = 0; index < tokens.length; index += 1) {
    const attribute = attributeAt(tokens, index);
    if (attribute === undefined || attribute.inner || !attributeMarksTestFn(tokens, attribute))
      continue;
    if (!templates.some((span) => span.start <= index && index <= span.end))
      return { ok: true, tests: true };
  }
  return { ok: true, tests: false };
}

/** The answer for `paths`, every read going through `adapter-fs`'s containment of `workspaceRoot`. */
export function rustTestFiles(
  workspaceRoot: string,
  paths: readonly string[],
): RustTestFilesAnswer {
  const workspace = containedWorkspace(workspaceRoot);
  const testFiles = new Set<string>();
  const unreadable = new Map<string, string>();
  for (const path of paths) {
    if (!path.endsWith('.rs') || !isWorkspaceRelativePath(path)) {
      unreadable.set(path, 'not_a_workspace_rust_path');
      continue;
    }
    if (workspace.entry(path) !== 'file') {
      unreadable.set(path, 'not_a_contained_file');
      continue;
    }
    const verdict = holdsRustTests(workspace.readFile(path));
    if (!verdict.ok) unreadable.set(path, verdict.reason);
    else if (verdict.tests) testFiles.add(path);
  }
  return {
    test_files: [...testFiles].sort(),
    unreadable: [...unreadable.keys()].sort().map((path) => ({
      path,
      reason: unreadable.get(path) ?? '',
    })),
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      input += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    process.stdin.on('end', () => resolvePromise(input));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as { paths?: unknown };
  const paths = input.paths;
  if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) {
    throw new Error('rust-test-files: stdin must be {"paths": [string, ...]}');
  }
  process.stdout.write(`${JSON.stringify(rustTestFiles(process.cwd(), paths))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
