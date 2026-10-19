import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { holdsRustTests, rustTestFiles } from './rust-test-files';

// ARIA-LOW-545 — the repository map's Rust test files are this reader's answer.

{
  // Test functions, wherever the reader finds them in code.
  for (const source of [
    '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {}\n}\n',
    '#[tokio::test]\nasync fn runs() {}\n',
    '#[::core::prelude::v1::test]\nfn runs() {}\n',
    'mod inner {\n    #[async_std::test]\n    async fn runs() {}\n}\n',
  ]) {
    assert.deepEqual(holdsRustTests(source), { ok: true, tests: true }, source);
  }
  // No test function: a declaration of an out-of-line test module, an empty
  // cfg(test) module, a compile-fail input, the attribute in a comment or a
  // string, a `#[test_case]`-shaped attribute, a macro template.
  for (const source of [
    '#[cfg(test)]\nmod tests;\n',
    '#[cfg(test)]\nmod tests {}\n',
    'fn main() { let x: u8 = 300; }\n',
    '//! `#[cfg(test)]`-gated by `crate::mock`; see #[test] below\npub fn f() {}\n',
    'const S: &str = "#[test] fn x() {}";\n',
    '#[test_case(1)]\nfn table(n: u8) {}\n',
    'macro_rules! gen {\n    ($n:ident) => {\n        #[test]\n        fn $n() {}\n    };\n}\n',
  ]) {
    assert.deepEqual(holdsRustTests(source), { ok: true, tests: false }, source);
  }
  const broken = holdsRustTests('fn f() { "unterminated }\n');
  assert.equal(broken.ok, false);
}

{
  const base = makeFixtureTree('aria-rust-test-files-');
  const workspace = join(base, 'ws');
  const outside = join(base, 'outside');
  const files: Record<string, string> = {
    // The out-of-line test module the old map rule missed: gated where it is
    // declared, so the file itself carries no `#[cfg(test)]`.
    'gw/src/scripting/mod.rs': '#[cfg(test)]\nmod bytecode_e2e_tests;\n',
    'gw/src/scripting/bytecode_e2e_tests.rs': '#[tokio::test]\nasync fn e2e() {}\n',
    // Under tests/ without a test function: a compile-fail input.
    'gw/tests/compile_fail/no_token.rs': 'fn main() { let _ = Client::connect(); }\n',
    'gw/tests/round_trip.rs': '#[test]\nfn round_trip() {}\n',
    'gw/src/plain.rs': '/// Mentions #[cfg(test)] in prose only.\npub fn g() {}\n',
    'gw/src/broken.rs': 'fn f() { "unterminated }\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), text);
  }
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.rs'), '#[test]\nfn outside() {}\n');
  symlinkSync(resolve(outside, 'secret.rs'), join(workspace, 'gw/src/linked.rs'));

  const answer = rustTestFiles(workspace, [
    ...Object.keys(files),
    'gw/src/linked.rs',
    'gw/src/absent.rs',
    '../outside/secret.rs',
    'gw/README.md',
  ]);
  assert.deepEqual(answer.test_files, [
    'gw/src/scripting/bytecode_e2e_tests.rs',
    'gw/tests/round_trip.rs',
  ]);
  assert.deepEqual(
    answer.unreadable.map((row) => [row.path, row.reason.split(':')[0]]),
    [
      ['../outside/secret.rs', 'not_a_workspace_rust_path'],
      ['gw/README.md', 'not_a_workspace_rust_path'],
      ['gw/src/absent.rs', 'not_a_contained_file'],
      ['gw/src/broken.rs', 'lex_failed'],
      ['gw/src/linked.rs', 'not_a_contained_file'],
    ],
  );
}

process.stdout.write('rust-test-files.test.ts OK\n');
