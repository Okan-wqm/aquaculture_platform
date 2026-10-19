import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import {
  collectFiles,
  isWorkspaceRelativePath,
  normalizeWorkspacePath,
  resolveInsideWorkspace,
} from './adapter-fs';
import {
  cargoTargetDirSkip,
  crateTargets,
  discoverCrates,
  parseCargoManifest,
  parseUpstreamManifest,
  upstreamVendoredFiles,
} from './rust-cargo';
import {
  classifyRustWorkspace,
  lexRust,
  moduleTree,
  testSpans,
  workspaceRustIo,
  type RustLexResult,
  type RustToken,
} from './rust-source';

// ARIA-HIGH-010 (part: the one Rust reader, rust-source.ts + rust-cargo.ts).
// Nothing in this repository read Rust source for meaning: only banned-phrase
// matched `*.rs`, as text. These cases pin the reader every Rust-aware adapter
// imports (the runtime-safety adapter, G010's Rust test adjacency), so none of
// them grows a second lexer or a second reading of cargo's conventions.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lexOk(source: string): Extract<RustLexResult, { ok: true }> {
  const result = lexRust(source);
  if (!result.ok) {
    assert.fail(`expected the source to lex, got ${result.reason} at line ${result.line}`);
  }
  return result;
}

function idents(tokens: readonly RustToken[]): string[] {
  return tokens.filter((token) => token.kind === 'ident').map((token) => token.text);
}

interface MemoryIo {
  readonly exists: (path: string) => boolean;
  readonly allowed: (path: string) => boolean;
  readonly read: (path: string) => string;
  readonly reads: string[];
}

/** An in-memory workspace; `forbidden/` stands in for a path outside allowed_read_globs. */
function memoryIo(files: Readonly<Record<string, string>>): MemoryIo {
  const reads: string[] = [];
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    allowed: (path) => !path.startsWith('forbidden/'),
    read: (path) => {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    reads,
  };
}

function treeIo(io: MemoryIo): Parameters<typeof moduleTree>[2] {
  return { exists: io.exists, allowed: io.allowed, lex: (path) => lexRust(io.read(path)) };
}

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

{
  // Nested block comments: rustc nests them; a lexer that stops at the first
  // `*/` leaks `unsafe` from the comment into code.
  const lexed = lexOk('/* outer /* inner */ unsafe { } */\nfn after() {}');
  assert.deepEqual(idents(lexed.tokens), ['fn', 'after']);
  assert.equal(lexed.comments.length, 1);
  assert.equal(lexed.comments[0]?.line, 1);
  assert.equal(lexed.tokens[0]?.line, 2, 'the token after a comment keeps its line');
}

{
  // Raw strings with 0..3 hashes; the body never becomes tokens.
  const source = [
    'let a = r"unsafe {";',
    'let b = r#"a "quoted" unsafe { b"#;',
    'let c = r##"a "# still inside unsafe {"##;',
    'let d = r###"x"##y spawn("###;',
  ].join('\n');
  const lexed = lexOk(source);
  assert.deepEqual(idents(lexed.tokens), ['let', 'a', 'let', 'b', 'let', 'c', 'let', 'd']);
  const values = lexed.tokens
    .filter((token) => token.literal === 'str')
    .map((token) => token.value);
  assert.deepEqual(values, [
    'unsafe {',
    'a "quoted" unsafe { b',
    'a "# still inside unsafe {',
    'x"##y spawn(',
  ]);
}

{
  // Byte, C and raw byte/C strings; byte chars, including an escaped quote.
  const lexed = lexOk(
    `let a = b"x{"; let b = br#"y"#; let c = c"z("; let d = cr"w["; let e = b'\\''; let f = b'a';`,
  );
  assert.deepEqual(idents(lexed.tokens), [
    'let',
    'a',
    'let',
    'b',
    'let',
    'c',
    'let',
    'd',
    'let',
    'e',
    'let',
    'f',
  ]);
  assert.equal(lexed.tokens.filter((token) => token.kind === 'literal').length, 6);
}

{
  // Char literal versus lifetime: a quote that closes after one char or one
  // escape is a char; otherwise it is a lifetime or label.
  const lexed = lexOk(
    "fn f<'a>(x: &'a str) -> char { let c = '{'; let q = '\\''; let u = '\\u{1F600}'; let e = 'é'; 'outer: loop { break 'outer; } '}' }",
  );
  const lifetimes = lexed.tokens
    .filter((token) => token.kind === 'lifetime')
    .map((token) => token.text);
  assert.deepEqual(lifetimes, ["'a", "'a", "'outer", "'outer"]);
  const chars = lexed.tokens.filter((token) => token.literal === 'char').map((token) => token.text);
  assert.deepEqual(chars, ["'{'", "'\\''", "'\\u{1F600}'", "'é'", "'}'"]);
  // The '{' and '}' chars did not unbalance the braces.
  assert.equal(
    lexed.tokens.filter((token) => token.kind === 'open' && token.text === '{').length,
    2,
  );
}

{
  // Line fidelity after multi-line literals and comments.
  const source = [
    'let s = "one',
    'two',
    'three";',
    '/* a',
    'b */',
    'let r = r#"x',
    'y"#;',
    'unsafe {}',
  ].join('\n');
  const lexed = lexOk(source);
  const unsafeToken = lexed.tokens.find((token) => token.text === 'unsafe');
  assert.equal(unsafeToken?.line, 8);
  const multi = lexed.tokens.find((token) => token.literal === 'str');
  assert.deepEqual([multi?.line, multi?.endLine], [1, 3]);
}

{
  // Malformed input is refused, never half-read.
  const refusals: [string, string][] = [
    ['let s = "open', 'unterminated_string'],
    ['/* open /* nested */', 'unterminated_block_comment'],
    ['fn f() { )', 'unbalanced_delimiter'],
    ['fn f() {', 'unclosed_delimiter'],
    ['let a = (1];', 'unbalanced_delimiter'],
    ['let r = r##"x"#;', 'unterminated_raw_string'],
    ["let c = '\\u{12;", 'bad_char_literal'],
  ];
  for (const [source, reason] of refusals) {
    const result = lexRust(source);
    assert.equal(result.ok, false, source);
    if (!result.ok) assert.equal(result.reason, reason, source);
  }
}

{
  // Raw identifiers are normalised and flagged; joined punctuation.
  const lexed = lexOk('let r#type = a::b -> c => d;');
  const raw = lexed.tokens.find((token) => token.text === 'type');
  assert.equal(raw?.kind, 'ident');
  assert.equal(raw?.raw, true);
  const puncts = lexed.tokens.filter((token) => token.kind === 'punct').map((token) => token.text);
  assert.deepEqual(puncts, ['=', '::', '->', '=>', ';']);
}

{
  // Comment index: doc and inner flags follow rustc.
  const lexed = lexOk(
    [
      '/// outer doc',
      '//! inner doc',
      '//// plain',
      '/** block doc */',
      '/*! inner block */',
      '/**/',
      '// SAFETY: ok',
    ].join('\n'),
  );
  const flags = lexed.comments.map((comment) => [comment.line, comment.doc, comment.inner]);
  assert.deepEqual(flags, [
    [1, true, false],
    [2, true, true],
    [3, false, false],
    [4, true, false],
    [5, true, true],
    [6, false, false],
    [7, false, false],
  ]);
  assert.equal(lexed.comments[6]?.text, '// SAFETY: ok');
}

{
  // A shebang line is skipped; an inner attribute at the start is not a shebang.
  assert.deepEqual(idents(lexOk('#!/usr/bin/env run-cargo-script\nfn main() {}').tokens), [
    'fn',
    'main',
  ]);
  assert.deepEqual(idents(lexOk('#![allow(dead_code)]\nfn main() {}').tokens), [
    'allow',
    'dead_code',
    'fn',
    'main',
  ]);
}

{
  // Every open token knows its partner, so callers skip whole groups.
  const lexed = lexOk('fn f() { g([1, 2]); }');
  lexed.tokens.forEach((token, index) => {
    if (token.kind === 'open' || token.kind === 'close') {
      assert.equal(lexed.tokens[token.match]?.match, index);
    } else {
      assert.equal(token.match, -1);
    }
  });
}

// ---------------------------------------------------------------------------
// test spans
// ---------------------------------------------------------------------------

{
  const source = [
    '#[test]', //                                                       1
    'fn plain_test() { unsafe { a() } }', //                            2
    '#[tokio::test(flavor = "multi_thread")]', //                       3
    'async fn tokio_test() { tokio::spawn(async { loop {} }); }', //    4
    '#[cfg(test)]', //                                                  5
    'mod tests { fn helper<A, B>() { unsafe {} } }', //                 6
    'macro_rules! template { () => { unsafe { $crate::x() } } }', //    7
    '#[cfg(any(test, feature = "sim"))]', //                            8
    'fn shipped_with_feature() { unsafe {} }', //                       9
    '#![cfg_attr(not(test), deny(warnings))]', //                       10
    'fn production() { unsafe {} }', //                                 11
    '#[cfg(all(test, unix))] use std::{fs, io};', //                    12
    '#[allow(dead_code)]', //                                           13
    '#[cfg(not(not(test)))]', //                                        14
    'fn double_negation() { unsafe {} }', //                            15
    '#[cfg(not(test))]', //                                             16
    'fn not_test() { unsafe {} }', //                                   17
    '#[test] fn generic<A, B>() where A: Into<[u8; 3]> { unsafe {} }', // 18
  ].join('\n');
  const lexed = lexOk(source);
  const spans = testSpans(lexed.tokens);
  const lines = spans.map((span) => [span.kind, span.startLine, span.endLine]);
  assert.deepEqual(lines, [
    ['test_fn', 1, 2],
    ['test_fn', 3, 4],
    ['cfg_test', 5, 6],
    ['macro_rules', 7, 7],
    ['cfg_test', 12, 12],
    ['cfg_test', 13, 15],
    ['test_fn', 18, 18],
  ]);
  // The unsafe on lines 9, 11 and 17 is production code: no span holds it.
  const productionUnsafe = lexed.tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.text === 'unsafe' && [9, 11, 17].includes(token.line));
  assert.equal(productionUnsafe.length, 3);
  for (const { index } of productionUnsafe) {
    assert.ok(!spans.some((span) => span.start <= index && index <= span.end));
  }
}

{
  // An inner #![cfg(test)] makes the whole file a test span.
  const lexed = lexOk('//! e2e\n#![cfg(test)]\nfn a() { unsafe {} }\n');
  const spans = testSpans(lexed.tokens);
  assert.equal(spans.length, 1);
  assert.deepEqual([spans[0]?.start, spans[0]?.end], [0, lexed.tokens.length - 1]);
}

{
  // A test-gated block expression, braced macro call, or match arm with a
  // block-like body ends at its block. Running on to the next `;` or `,` put
  // the shipped code after it into the span, where every consumer drops it.
  const cases: readonly {
    readonly name: string;
    readonly source: readonly string[];
    readonly spans: readonly (readonly [string, number, number])[];
    readonly shippedUnsafeLines: readonly number[];
  }[] = [
    {
      name: 'braced macro item',
      source: [
        '#[cfg(test)]',
        'mockall::mock! {',
        '    pub Clock {}',
        '}',
        '',
        'pub fn shipped() {',
        '    unsafe { raw() }',
        '}',
        '',
        'const LIMIT: u8 = 1;',
      ],
      spans: [['cfg_test', 1, 4]],
      shippedUnsafeLines: [7],
    },
    {
      name: 'block statement',
      source: [
        'fn run() {',
        '    #[cfg(test)]',
        '    {',
        '        probe();',
        '    }',
        '    let v = unsafe { raw() };',
        '}',
      ],
      spans: [['cfg_test', 2, 5]],
      shippedUnsafeLines: [6],
    },
    {
      name: 'braced macro inside a module',
      source: [
        'mod inner {',
        '    #[cfg(test)]',
        '    thread_local! { static X: u8 = 0; }',
        '    pub fn shipped() { unsafe { raw() } }',
        '}',
      ],
      spans: [['cfg_test', 2, 3]],
      shippedUnsafeLines: [4],
    },
    {
      name: 'block-like expression statements',
      // `else`, `.` and `?` after a block continue the expression.
      source: [
        'fn run() {',
        '    #[cfg(test)]',
        '    if probe() {',
        '        a()',
        '    } else if b() {',
        '        c()',
        '    }',
        '    unsafe { raw() };',
        '    #[cfg(test)]',
        "    'outer: for x in xs { e(x) }",
        '    let v = unsafe { raw() };',
        '    #[cfg(test)]',
        '    match m { _ => f() }',
        '        .unwrap()?;',
        '    #[cfg(test)] unsafe { probe() }',
        '    unsafe { g() }',
        '}',
      ],
      spans: [
        ['cfg_test', 2, 7],
        ['cfg_test', 9, 10],
        ['cfg_test', 12, 14],
        ['cfg_test', 15, 15],
      ],
      shippedUnsafeLines: [8, 11, 16],
    },
    {
      name: 'match arms with block-like bodies',
      source: [
        'fn pick(m: Mode) -> u8 {',
        '    match m {',
        '        #[cfg(test)]',
        '        Mode::Test => { probe() }',
        '        Mode::Prod => unsafe { raw() },',
        '        #[cfg(test)]',
        '        Mode::Sim => unsafe { sim() }',
        '        Mode::Edge => { unsafe { edge() } }',
        '    }',
        '}',
      ],
      spans: [
        ['cfg_test', 3, 4],
        ['cfg_test', 6, 7],
      ],
      shippedUnsafeLines: [5, 8],
    },
  ];
  for (const testCase of cases) {
    const lexed = lexOk(testCase.source.join('\n'));
    const spans = testSpans(lexed.tokens);
    assert.deepEqual(
      spans.map((span) => [span.kind, span.startLine, span.endLine]),
      testCase.spans,
      testCase.name,
    );
    const shipped = lexed.tokens
      .map((token, index) => ({ token, index }))
      .filter(
        ({ token }) => token.text === 'unsafe' && testCase.shippedUnsafeLines.includes(token.line),
      );
    assert.equal(shipped.length, testCase.shippedUnsafeLines.length, testCase.name);
    for (const { index, token } of shipped) {
      assert.ok(
        !spans.some((span) => span.start <= index && index <= span.end),
        `${testCase.name}: the shipped unsafe on line ${token.line} is in a test span`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cargo manifests, crates and targets
// ---------------------------------------------------------------------------

{
  // The manifest reader understands the TOML a Cargo.toml uses: headers with
  // comments, multi-line arrays whose lines start with `[`, inline tables,
  // dotted and quoted keys, and literal strings.
  const manifest = [
    '# leading comment',
    '[package] # trailing comment',
    "name = 'demo'",
    'keywords = [',
    '  ["nested"],',
    '  "x",',
    ']',
    'description = """',
    '[lib]',
    'not a header"""',
    '[dependencies]',
    'local = { path = "../local" }',
    '[dependencies.other]',
    'path = ".."',
    '[[bin]]',
    'name = "tool"',
    'path = "src/tool.rs"',
  ].join('\n');
  const parsed = parseCargoManifest(manifest);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    const headers = parsed.entries.flatMap((entry) =>
      entry.kind === 'header' ? [[entry.name, entry.array, entry.line]] : [],
    );
    assert.deepEqual(headers, [
      ['package', false, 2],
      ['dependencies', false, 11],
      ['dependencies.other', false, 13],
      ['bin', true, 15],
    ]);
    const pathPairs = parsed.entries.flatMap((entry) =>
      entry.kind === 'pair' && entry.key === 'path' ? [[entry.table, entry.value]] : [],
    );
    assert.deepEqual(pathPairs, [
      ['dependencies.other', { kind: 'string', value: '..' }],
      ['bin', { kind: 'string', value: 'src/tool.rs' }],
    ]);
  }
  const broken = parseCargoManifest('[package\nname = "x"');
  assert.equal(broken.ok, false);
  // An escape above U+10FFFF is refused, not thrown out of the reader.
  assert.equal(parseCargoManifest('[package]\nname = "\\UFFFFFFFF"\n').ok, false);
}

{
  const files: Record<string, string> = {
    'Cargo.toml': '[workspace]\nmembers = ["crates/core"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "core"\n',
    'crates/core/src/lib.rs': 'pub mod a;\n',
    'crates/core/src/a.rs': '',
    'crates/core/src/main.rs': 'fn main() {}\n',
    'crates/core/src/bin/one.rs': 'fn main() {}\n',
    'crates/core/src/bin/two/main.rs': 'fn main() {}\n',
    'crates/core/tests/it.rs': '',
    'crates/core/tests/suite/main.rs': '',
    'crates/core/benches/speed.rs': '',
    'crates/core/examples/demo.rs': '',
    'crates/core/build.rs': 'fn main() {}\n',
    'crates/core/fuzz/Cargo.toml':
      '[package]\nname = "core-fuzz"\n[package.metadata]\ncargo-fuzz = true\n[dependencies.core]\npath = ".."\n[[bin]]\nname = "parse"\npath = "fuzz_targets/parse.rs"\n',
    'crates/core/fuzz/fuzz_targets/parse.rs': '',
    'tools/broker/main.rs': 'fn main() {}\n',
    'tests/loose.rs': '',
  };
  const io = memoryIo(files);
  const paths = Object.keys(files);
  const crates = discoverCrates(paths, io.read);
  assert.deepEqual(
    crates.crates.map((crate) => [crate.root, crate.kind, crate.manifest]),
    [
      ['crates/core', 'package', 'crates/core/Cargo.toml'],
      ['crates/core/fuzz', 'fuzz_harness', 'crates/core/fuzz/Cargo.toml'],
      ['tools/broker', 'standalone_rustc', null],
    ],
  );
  assert.deepEqual(crates.ownerless, ['tests/loose.rs'], 'a workspace-only manifest owns no files');
  const core = crates.crates[0];
  assert.ok(core);
  assert.ok(
    !core.files.includes('crates/core/fuzz/fuzz_targets/parse.rs'),
    'a nested package owns its own files',
  );

  const targets = crateTargets(core, io);
  assert.deepEqual(targets.production.map((root) => root.path).sort(), [
    'crates/core/src/bin/one.rs',
    'crates/core/src/bin/two/main.rs',
    'crates/core/src/lib.rs',
    'crates/core/src/main.rs',
  ]);
  assert.deepEqual(targets.harness.map((root) => root.path).sort(), [
    'crates/core/benches/speed.rs',
    'crates/core/build.rs',
    'crates/core/examples/demo.rs',
    'crates/core/tests/it.rs',
    'crates/core/tests/suite/main.rs',
  ]);
  assert.deepEqual(targets.unclassified, []);

  const fuzz = crates.crates[1];
  assert.ok(fuzz);
  const fuzzTargets = crateTargets(fuzz, io);
  assert.deepEqual(fuzzTargets.production, []);
  assert.deepEqual(
    fuzzTargets.harness.map((root) => root.path),
    ['crates/core/fuzz/fuzz_targets/parse.rs'],
  );

  const broker = crates.crates[2];
  assert.ok(broker);
  assert.deepEqual(
    crateTargets(broker, io).production.map((root) => root.path),
    ['tools/broker/main.rs'],
  );
}

{
  // Explicit targets, auto-discovery switches, and the drift detector: a
  // layout the file rule cannot classify is reported, never guessed.
  const files: Record<string, string> = {
    'k/Cargo.toml': [
      '[package]',
      'name = "k"',
      'build = "tools/gen.rs"',
      'autobins = false',
      'autotests = false',
      '[lib]',
      'path = "lib/root.rs"',
      '[[bin]]',
      'name = "misplaced"',
      'path = "tests/bin_in_tests.rs"',
      '[[test]]',
      'name = "in_src"',
      'path = "src/test_in_src.rs"',
      '[[example]]',
      'name = "gone"',
      'path = "examples/gone.rs"',
      '[[bench]]',
      'name = "named"',
    ].join('\n'),
    'k/lib/root.rs': '',
    'k/src/bin/ignored.rs': '',
    'k/tests/bin_in_tests.rs': '',
    'k/tests/auto_ignored.rs': '',
    'k/src/test_in_src.rs': '',
    'k/benches/named.rs': '',
    'k/tools/gen.rs': '',
  };
  const io = memoryIo(files);
  const crate = discoverCrates(Object.keys(files), io.read).crates[0];
  assert.ok(crate);
  const targets = crateTargets(crate, io);
  assert.deepEqual(
    targets.production.map((root) => [root.path, root.section, root.line]),
    [['k/lib/root.rs', 'lib', 6]],
  );
  assert.deepEqual(targets.harness.map((root) => [root.path, root.section]).sort(), [
    ['k/benches/named.rs', 'bench'],
    ['k/tools/gen.rs', 'build'],
  ]);
  assert.deepEqual(
    targets.unclassified.map((issue) => [issue.reason, issue.line]),
    [
      ['custom_build_script', 3],
      ['production_target_in_harness_dir', 8],
      ['harness_target_in_src', 11],
      ['target_path_missing', 14],
    ],
  );
}

{
  // A bin without a path takes cargo's inferred location (autobins is off, so
  // only that inference can find these files); an unparseable manifest is
  // reported, not skipped.
  const files: Record<string, string> = {
    'p/Cargo.toml':
      '[package]\nname = "p"\nautobins = false\n[[bin]]\nname = "p"\n[[bin]]\nname = "aux"\n',
    'p/src/main.rs': '',
    'p/src/bin/aux/main.rs': '',
    'q/Cargo.toml': '[package]\nname = "q"\nversion = "1\n',
    'q/src/lib.rs': '',
  };
  const io = memoryIo(files);
  const { crates } = discoverCrates(Object.keys(files), io.read);
  const p = crates.find((crate) => crate.root === 'p');
  const q = crates.find((crate) => crate.root === 'q');
  assert.ok(p && q);
  assert.deepEqual(
    crateTargets(p, io)
      .production.map((root) => root.path)
      .sort(),
    ['p/src/bin/aux/main.rs', 'p/src/main.rs'],
  );
  assert.deepEqual(crateTargets(p, io).unclassified, []);
  const broken = crateTargets(q, io);
  assert.deepEqual(broken.production, []);
  assert.deepEqual(
    broken.unclassified.map((issue) => issue.reason),
    ['manifest_unparsed'],
  );
}

{
  // The drift forms beyond the design's three, each reported with its line:
  // a root-level inline target array, a non-string target path, a non-string
  // build value, an inline package.metadata (it can hide cargo-fuzz), and a
  // target path that leaves the workspace, relatively or as an absolute path.
  const files: Record<string, string> = {
    'm/Cargo.toml': [
      'bin = [{ name = "x", path = "tests/x.rs" }]', // 1
      '[package]', // 2
      'name = "m"', // 3
      'build = ["gen.rs"]', // 4
      'metadata = { cargo-fuzz = true }', // 5
      '[[bin]]', // 6
      'path = 1', // 7
      '[[test]]', // 8
      'name = "up"', // 9
      'path = "../../x.rs"', // 10
      '[[example]]', // 11
      'name = "abs"', // 12
      'path = "/m/examples/abs.rs"', // 13
    ].join('\n'),
    'm/src/lib.rs': '',
    'x.rs': '',
    // Where joining the absolute path under the crate would land: never read.
    'm/m/examples/abs.rs': '',
  };
  const io = memoryIo(files);
  const crate = discoverCrates(Object.keys(files), io.read).crates[0];
  assert.ok(crate);
  const targets = crateTargets(crate, io);
  assert.deepEqual(
    targets.unclassified.map((issue) => [issue.reason, issue.line]),
    [
      ['target_syntax_unsupported', 1],
      ['target_syntax_unsupported', 4],
      ['target_syntax_unsupported', 5],
      ['target_path_missing', 6],
      ['target_syntax_unsupported', 7],
      ['target_path_outside_workspace', 8],
      ['target_path_outside_workspace', 11],
    ],
  );
  assert.deepEqual(
    targets.production.map((root) => root.path),
    ['m/src/lib.rs'],
  );
  assert.deepEqual(targets.harness, []);
  // An absolute or escaping custom build script is reported, not rooted.
  const build = memoryIo({
    'b/Cargo.toml': '[package]\nname = "b"\nbuild = "/b/gen.rs"\n',
    'b/b/gen.rs': '',
  });
  const buildCrate = discoverCrates(['b/Cargo.toml'], build.read).crates[0];
  assert.ok(buildCrate);
  const buildTargets = crateTargets(buildCrate, build);
  assert.deepEqual(
    buildTargets.unclassified.map((issue) => [issue.reason, issue.line]),
    [
      ['custom_build_script', 3],
      ['target_path_outside_workspace', 3],
    ],
  );
  assert.deepEqual(buildTargets.harness, []);
}

{
  // cargo drops a discovered target whose name or path a declared target of
  // the same kind uses: with `[[bin]] name = "k"` at another path,
  // src/main.rs is not built.
  const files: Record<string, string> = {
    'k/Cargo.toml': '[package]\nname = "k"\n[[bin]]\nname = "k"\npath = "src/bin/real.rs"\n',
    'k/src/main.rs': '',
    'k/src/bin/real.rs': '',
    'k/src/bin/aux.rs': '',
  };
  const io = memoryIo(files);
  const crate = discoverCrates(Object.keys(files), io.read).crates[0];
  assert.ok(crate);
  const targets = crateTargets(crate, io);
  assert.deepEqual(targets.production.map((root) => root.path).sort(), [
    'k/src/bin/aux.rs',
    'k/src/bin/real.rs',
  ]);
  assert.deepEqual(targets.unclassified, []);
}

// ---------------------------------------------------------------------------
// module tree
// ---------------------------------------------------------------------------

{
  const files: Record<string, string> = {
    'c/src/lib.rs': [
      'mod flat;', // c/src/flat.rs (mod-rs root)
      'mod dir;', // c/src/dir/mod.rs
      'pub(crate) mod inline_parent { mod nested; }', // c/src/inline_parent/nested.rs
      '#[path = "elsewhere/picked.rs"] mod picked;', // relative to the declaring file
      '#[path = "custom"] mod custom_dir { mod inside; }', // inline with path: a directory
      '#[cfg(test)] mod unit;', // harness edge
      '#[cfg(all(test, unix))] mod unit_unix;',
      '#[cfg(any(test, feature = "sim"))] mod shipped;',
      '#[cfg(not(test))] mod not_test;',
      '#[cfg(test)] mod tests { mod helper; }',
      'mod inner_gate;',
      'mod both;',
      'mod gone;',
      '// mod commented;',
      'const S: &str = "mod in_string;";',
      'macro_rules! m { () => { mod in_macro; } }',
      'mod r#type;',
    ].join('\n'),
    'c/src/flat.rs': 'mod child;', // non-mod-rs: c/src/flat/child.rs
    'c/src/flat/child.rs': '',
    'c/src/dir/mod.rs': 'mod sub;', // mod-rs: c/src/dir/sub.rs
    'c/src/dir/sub.rs': '',
    'c/src/inline_parent/nested.rs': '',
    'c/src/elsewhere/picked.rs': 'mod sibling;', // #[path] files are mod-rs
    'c/src/elsewhere/sibling.rs': '',
    'c/src/custom/inside.rs': '',
    'c/src/unit.rs': 'mod deeper;',
    'c/src/unit/deeper.rs': '',
    'c/src/unit_unix.rs': '',
    'c/src/shipped.rs': '',
    'c/src/not_test.rs': '',
    'c/src/tests/helper.rs': '',
    'c/src/inner_gate.rs': '#![cfg(test)]\nmod below;',
    'c/src/inner_gate/below.rs': '',
    'c/src/both.rs': '',
    'c/src/both/mod.rs': '',
    'c/src/commented.rs': '',
    'c/src/in_string.rs': '',
    'c/src/in_macro.rs': '',
    'c/src/type.rs': '',
  };
  const io = memoryIo(files);
  const tree = moduleTree('c/src/lib.rs', 'production', treeIo(io));
  assert.deepEqual(Object.fromEntries([...tree.files.entries()].sort()), {
    'c/src/custom/inside.rs': 'production',
    'c/src/dir/mod.rs': 'production',
    'c/src/dir/sub.rs': 'production',
    'c/src/elsewhere/picked.rs': 'production',
    'c/src/elsewhere/sibling.rs': 'production',
    'c/src/flat.rs': 'production',
    'c/src/flat/child.rs': 'production',
    'c/src/inline_parent/nested.rs': 'production',
    'c/src/inner_gate.rs': 'harness',
    'c/src/inner_gate/below.rs': 'harness',
    'c/src/lib.rs': 'production',
    'c/src/not_test.rs': 'production',
    'c/src/shipped.rs': 'production',
    'c/src/tests/helper.rs': 'harness',
    'c/src/type.rs': 'production',
    'c/src/unit.rs': 'harness',
    'c/src/unit/deeper.rs': 'harness',
    'c/src/unit_unix.rs': 'harness',
  });
  assert.deepEqual(
    tree.issues.map((issue) => [issue.reason, issue.path, issue.line]),
    [
      ['module_ambiguous', 'c/src/lib.rs', 12],
      ['module_missing', 'c/src/lib.rs', 13],
    ],
  );
  assert.ok(!io.reads.includes('c/src/in_macro.rs'));
  assert.ok(!io.reads.includes('c/src/commented.rs'));
}

{
  // Inline modules inside a non-mod-rs file nest under the file's own name.
  const files: Record<string, string> = {
    'd/src/main.rs': 'mod a;',
    'd/src/a.rs': 'mod i { mod j; }',
    'd/src/a/i/j.rs': '',
  };
  const tree = moduleTree('d/src/main.rs', 'production', treeIo(memoryIo(files)));
  assert.deepEqual([...tree.files.keys()].sort(), [
    'd/src/a.rs',
    'd/src/a/i/j.rs',
    'd/src/main.rs',
  ]);
}

{
  // A #[path] that leaves the workspace (relatively or as an absolute path)
  // or the allowed globs is refused and never read. Every target exists, so
  // only the refusal stops it: the absolute one also has a same-suffix decoy
  // inside the crate, which joining it under the crate would have read.
  // A #[path] holding a control character is a per-declaration issue that
  // never reaches io (a NUL used to throw out of node's fs).
  const files: Record<string, string> = {
    'e/src/lib.rs': [
      '#[path = "../../../outside.rs"] mod esc;',
      '#[path = "../../forbidden/secret.rs"] mod hidden;',
      'mod ok;',
      '#[path = "/abs/outside.rs"] mod abs;',
      '#[path = "a\\0.rs"] mod nul;',
      '#[path = "/abs"] mod abs_dir { mod child; }',
      '#[path = "b\\u{1}"] mod ctl_dir { mod child; }',
    ].join('\n'),
    'e/src/ok.rs': '',
    '../outside.rs': 'unsafe fn f() {}',
    'forbidden/secret.rs': 'unsafe fn f() {}',
    'e/src/abs/outside.rs': 'unsafe fn decoy() {}',
    'e/src/abs/child.rs': 'unsafe fn decoy() {}',
  };
  const io = memoryIo(files);
  const tree = moduleTree('e/src/lib.rs', 'production', treeIo(io));
  assert.deepEqual(tree.refused, [
    '../outside.rs',
    'forbidden/secret.rs',
    '/abs/outside.rs',
    '/abs/child.rs',
  ]);
  assert.deepEqual([...tree.files.keys()].sort(), ['e/src/lib.rs', 'e/src/ok.rs']);
  assert.deepEqual(
    tree.issues.map((issue) => [issue.reason, issue.line]),
    [
      ['module_path_invalid', 5],
      ['module_path_invalid', 7],
    ],
  );
  for (const unread of ['../outside.rs', 'forbidden/secret.rs', 'e/src/abs/outside.rs']) {
    assert.ok(!io.reads.includes(unread), unread);
  }
}

{
  // Inside one tree: a file reached first through a cfg(test) edge and then
  // through a shipped edge is production; a #[path] cycle ends; an inner
  // #![cfg(test)] inside an inline module makes its out-of-line children harness.
  const files: Record<string, string> = {
    'c/src/lib.rs': [
      '#[cfg(test)] #[path = "shared.rs"] mod t;',
      'mod shared;',
      '#[path = "lib.rs"] mod again;',
      'mod tests { #![cfg(test)] mod helper; }',
    ].join('\n'),
    'c/src/shared.rs': '',
    'c/src/tests/helper.rs': '',
  };
  const tree = moduleTree('c/src/lib.rs', 'production', treeIo(memoryIo(files)));
  assert.deepEqual(Object.fromEntries([...tree.files.entries()].sort()), {
    'c/src/lib.rs': 'production',
    'c/src/shared.rs': 'production',
    'c/src/tests/helper.rs': 'harness',
  });
  assert.deepEqual(tree.issues, []);
}

{
  // A harness root reaches everything it declares as harness; a file that
  // fails to lex is still placed, and its failure is reported.
  const files: Record<string, string> = {
    'f/tests/it.rs': 'mod common;',
    'f/tests/common.rs': 'fn broken( {',
  };
  const tree = moduleTree('f/tests/it.rs', 'harness', treeIo(memoryIo(files)));
  assert.deepEqual(Object.fromEntries(tree.files), {
    'f/tests/it.rs': 'harness',
    'f/tests/common.rs': 'harness',
  });
  assert.deepEqual(
    tree.issues.map((issue) => [issue.reason, issue.path]),
    [['parse_failed', 'f/tests/common.rs']],
  );
}

// ---------------------------------------------------------------------------
// vendored upstream files
// ---------------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

{
  const upstreamLib = 'pub mod edited;\npub unsafe fn untouched() {}\n';
  const files: Record<string, string> = {
    'v/Cargo.toml': '[package]\nname = "v"\n',
    'v/src/lib.rs': upstreamLib,
    'v/src/edited.rs': 'pub fn ours() { unsafe {} }\n',
    'v/UPSTREAM-MANIFEST.sha256': [
      `${sha256(upstreamLib)}  ./src/lib.rs`,
      `${sha256('pub fn upstream() {}\n')}  ./src/edited.rs`,
      'not a manifest line',
    ].join('\n'),
  };
  const io = memoryIo(files);
  const upstream = upstreamVendoredFiles('v', io);
  assert.equal(upstream.manifest, 'v/UPSTREAM-MANIFEST.sha256');
  assert.deepEqual([...upstream.files], ['v/src/lib.rs']);
  assert.deepEqual(upstreamVendoredFiles('nomanifest', memoryIo({})).files.size, 0);
  // The owning gate's grammar exactly (local-rumqttc-fork-hygiene.spec.ts):
  // a line without `./`, or with sha256sum's `*` marker, is no upstream line
  // for the gate, so it is none here either.
  const text = 'pub fn same() {}\n';
  const strict = upstreamVendoredFiles(
    'w',
    memoryIo({
      'w/UPSTREAM-MANIFEST.sha256': `${sha256(text)}  src/lib.rs\n${sha256(text)} *./src/a.rs\n`,
      'w/src/lib.rs': text,
      'w/src/a.rs': text,
    }),
  );
  assert.deepEqual([...strict.files], []);
  assert.deepEqual(
    [...parseUpstreamManifest(`${sha256(text)}  ./src/a b.rs\nnot a line\n`)],
    [['./src/a b.rs', sha256(text)]],
  );
  // Linear: a 1 MiB whitespace run cannot stall the reader (the old pattern
  // backtracked quadratically: 13 s at 80k spaces).
  const started = Date.now();
  parseUpstreamManifest(
    `${'0'.repeat(64)} x${' '.repeat(1 << 20)}y\n${'0'.repeat(64)}${' '.repeat(1 << 20)}y`,
  );
  assert.ok(Date.now() - started < 2_000, `manifest parse took ${Date.now() - started} ms`);
}

// ARIA-LOW-544: the `<sha256>  ./<path>` manifest grammar has one copy,
// parseUpstreamManifest. The fork-hygiene gate (the owner of both manifests,
// tools/gates/local-rumqttc-fork-hygiene.spec.ts) reads UPSTREAM-MANIFEST.sha256
// and FORK-EDITS.sha256 through it; no other file under tools/ spells the
// pattern, so the gate and this reader cannot disagree about a line.
{
  const toolsDir = resolve(__dirname, '..');
  const grammar = '[0-9a-f]{64})\\s+(\\.\\/';
  const holders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'fixtures') walk(path);
      } else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes(grammar)) {
        holders.push(relative(toolsDir, path).split('\\').join('/'));
      }
    }
  };
  walk(toolsDir);
  assert.deepEqual(holders, ['aria-adapters/rust-cargo.ts']);
  const gate = readFileSync(join(toolsDir, 'gates', 'local-rumqttc-fork-hygiene.spec.ts'), 'utf8');
  assert.match(gate, /import \{ parseUpstreamManifest \} from '\.\.\/aria-adapters\/rust-cargo';/);
}

// ---------------------------------------------------------------------------
// whole-workspace classification
// ---------------------------------------------------------------------------

{
  const upstreamLib = 'pub mod edited;\npub mod shared;\npub unsafe fn untouched() {}\n';
  const files: Record<string, string> = {
    'g/Cargo.toml': '[package]\nname = "g"\n',
    'g/src/main.rs': 'mod shared;\n#[cfg(test)] mod unit;\n',
    'g/src/shared.rs': '',
    'g/src/unit.rs': '',
    'g/src/orphan.rs': '',
    'g/src/broken.rs': 'fn x( {',
    'g/tests/it.rs':
      '#[path = "../src/shared.rs"] mod shared;\n#[path = "../src/only_tests.rs"] mod only_tests;',
    'g/src/only_tests.rs': '',
    'g/build.rs': '',
    'g/target/debug/gen.rs': '',
    'v/Cargo.toml': '[package]\nname = "v"\n',
    'v/src/lib.rs': upstreamLib,
    'v/src/edited.rs': '',
    'v/src/shared.rs': '',
    'v/UPSTREAM-MANIFEST.sha256': [
      `${sha256(upstreamLib)}  ./src/lib.rs`,
      `${sha256('changed upstream')}  ./src/edited.rs`,
    ].join('\n'),
  };
  const io = memoryIo(files);
  const walked = Object.keys(files).filter((path) => !path.includes('/target/'));
  const workspace = classifyRustWorkspace(walked, io);
  const contexts = Object.fromEntries(
    [...workspace.files.values()].map((file) => [file.path, file.context]),
  );
  assert.deepEqual(contexts, {
    'g/build.rs': 'harness',
    'g/src/broken.rs': 'unreached',
    'g/src/main.rs': 'production',
    // Compiled into the shipped binary AND included by a test: it is shipped
    // code, so production wins over harness.
    'g/src/shared.rs': 'production',
    'g/src/only_tests.rs': 'harness',
    'g/src/orphan.rs': 'unreached',
    'g/src/unit.rs': 'harness',
    'g/tests/it.rs': 'harness',
    'v/src/edited.rs': 'production',
    'v/src/lib.rs': 'upstream',
    'v/src/shared.rs': 'production',
  });
  assert.equal(workspace.files.get('v/src/edited.rs')?.crate, 'v');
  assert.deepEqual(
    workspace.issues.parseFailures.map((failure) => failure.path),
    ['g/src/broken.rs'],
  );
  assert.deepEqual(workspace.issues.unclassifiedTargets, []);
  assert.ok(workspace.readPaths.includes('v/UPSTREAM-MANIFEST.sha256'));
  assert.ok(workspace.readPaths.includes('g/Cargo.toml'));
  assert.ok(!workspace.readPaths.some((path) => path.includes('/target/')));
  // Deterministic: a second run is identical.
  assert.deepEqual(
    JSON.stringify(
      [...classifyRustWorkspace(walked, memoryIo(files)).files.entries()].map(([path, file]) => [
        path,
        file.context,
      ]),
    ),
    JSON.stringify([...workspace.files.entries()].map(([path, file]) => [path, file.context])),
  );
}

// ---------------------------------------------------------------------------
// cargo build directories are not walked
// ---------------------------------------------------------------------------

{
  const workspace = makeFixtureTree('aria-rust-source-');
  const write = (path: string, text: string): void => {
    mkdirSync(resolve(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), text, 'utf8');
  };
  write('crate/Cargo.toml', '[package]\nname = "crate"\n');
  write('crate/src/lib.rs', '');
  // `deps`, not `build`: ADAPTER_EXCLUDED_DIRS already drops any `build` dir,
  // which would let this case pass without the option under test.
  write('crate/target/debug/deps/generated.rs', 'unsafe fn g() {}');
  write('notes/target/kept.rs', ''); // a `target` dir with no manifest beside it is source
  const walked = collectFiles(workspace, workspace, {
    extensions: ['.rs', 'Cargo.toml'],
    skipDir: cargoTargetDirSkip,
  })
    .map((path) => normalizeWorkspacePath(relative(workspace, path)))
    .sort();
  assert.deepEqual(walked, ['crate/Cargo.toml', 'crate/src/lib.rs', 'notes/target/kept.rs']);
  // Without the option the walk is unchanged for every existing importer.
  const unchanged = collectFiles(workspace, workspace, { extensions: ['.rs'] }).length;
  assert.equal(unchanged, 3);
}

// ---------------------------------------------------------------------------
// filesystem access: no symlink is followed
// ---------------------------------------------------------------------------

{
  // The one containment predicate (adapter-fs.ts): normalised, relative,
  // inside, no NUL. resolveInsideWorkspace is expressed through it.
  for (const path of ['a.rs', 'c/src/lib.rs', '..foo/x.rs', 'a/.b']) {
    assert.ok(isWorkspaceRelativePath(path), path);
  }
  for (const path of [
    '',
    '.',
    '..',
    '../a',
    '/a',
    './a',
    'a/../b',
    'a/./b',
    'a//b',
    'a/',
    'c/../../x.rs',
    'a\0b',
  ]) {
    assert.ok(!isWorkspaceRelativePath(path), JSON.stringify(path));
  }
  assert.throws(() => resolveInsideWorkspace('/w', '../x'), /escapes workspace root/);
  assert.throws(() => resolveInsideWorkspace('/w', '/etc/passwd'), /escapes workspace root/);
  assert.equal(resolveInsideWorkspace('/w', 'a/../b'), '/w/b');
  assert.equal(resolveInsideWorkspace('/w', '..foo/x'), '/w/..foo/x');
  assert.equal(resolveInsideWorkspace('/w', '.'), '/w');
}

{
  // A symlinked module file and a #[path] through a symlinked directory both
  // point outside the workspace: refused and never read, like the walk, which
  // never follows a symlink either. The workspace sits in `base`, beside a
  // real `escape.rs`, so only the containment rule keeps `../escape.rs` and
  // the non-normalised `c/../../escape.rs` out.
  const base = makeFixtureTree('aria-rust-io-');
  const workspace = join(base, 'ws');
  mkdirSync(workspace);
  writeFileSync(join(base, 'escape.rs'), 'unsafe fn outside() {}', 'utf8');
  const outside = makeFixtureTree('aria-rust-outside-');
  writeFileSync(join(outside, 'secret.rs'), 'unsafe fn leaked() {}', 'utf8');
  const write = (path: string, text: string): void => {
    mkdirSync(resolve(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), text, 'utf8');
  };
  write('c/Cargo.toml', '[package]\nname = "c"\n');
  write('c/src/lib.rs', 'mod plain;\nmod linked;\n#[path = "dirlink/secret.rs"] mod via_dir;\n');
  write('c/src/plain.rs', '');
  symlinkSync(join(outside, 'secret.rs'), join(workspace, 'c/src/linked.rs'));
  symlinkSync(outside, join(workspace, 'c/src/dirlink'));
  const walked = collectFiles(workspace, workspace, {
    extensions: ['.rs', 'Cargo.toml'],
    skipDir: cargoTargetDirSkip,
  })
    .map((path) => normalizeWorkspacePath(relative(workspace, path)))
    .sort();
  assert.deepEqual(walked, ['c/Cargo.toml', 'c/src/lib.rs', 'c/src/plain.rs']);
  const io = workspaceRustIo(workspace, () => true);
  const result = classifyRustWorkspace(walked, io);
  assert.deepEqual([...result.files.keys()], ['c/src/lib.rs', 'c/src/plain.rs']);
  assert.deepEqual(result.issues.refused, ['c/src/dirlink/secret.rs', 'c/src/linked.rs']);
  assert.deepEqual(result.readPaths, ['c/Cargo.toml', 'c/src/lib.rs', 'c/src/plain.rs']);
  assert.throws(() => io.read('c/src/linked.rs'), /refused workspace read/);
  for (const escape of ['../escape.rs', 'c/../../escape.rs']) {
    assert.equal(io.allowed(escape), false, escape);
    assert.throws(() => io.read(escape), /refused workspace read/, escape);
  }
  // Nothing behind a symlink is examined: a present and a missing file in
  // the linked directory get the same answer (both refused, never missing).
  assert.equal(io.exists('c/src/dirlink/secret.rs'), true);
  assert.equal(io.exists('c/src/dirlink/no-such.rs'), true);
  assert.equal(io.allowed('c/src/dirlink/secret.rs'), false);
  // A NUL in a path is refused, never thrown out of node's fs.
  assert.equal(io.exists('c/src/a\0.rs'), true);
  assert.equal(io.allowed('c/src/a\0.rs'), false);
  // Paths a caller lists (git ls-files lists tracked symlinks) are refused
  // the same way, without a read and without throwing.
  const listed = classifyRustWorkspace([...walked, 'c/src/linked.rs', 'c/../../escape.rs'], io);
  assert.deepEqual(listed.issues.refused, [
    'c/../../escape.rs',
    'c/src/dirlink/secret.rs',
    'c/src/linked.rs',
  ]);
  assert.deepEqual(listed.readPaths, ['c/Cargo.toml', 'c/src/lib.rs', 'c/src/plain.rs']);
  // The caller's allowed set still applies on top.
  const narrowed = workspaceRustIo(workspace, (path) => path !== 'c/src/plain.rs');
  assert.equal(narrowed.allowed('c/src/plain.rs'), false);
  assert.throws(() => narrowed.read('c/src/plain.rs'), /refused Rust read/);
}

{
  // An absolute #[path] names a file outside the workspace (rustc joins it
  // as-is): refused, and the same-suffix decoy inside the crate is not read.
  const workspace = makeFixtureTree('aria-rust-abs-');
  const outside = makeFixtureTree('aria-rust-abs-out-');
  writeFileSync(join(outside, 'real.rs'), 'pub fn compiled() {}', 'utf8');
  const write = (path: string, text: string): void => {
    mkdirSync(resolve(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), text, 'utf8');
  };
  const target = posix.join(normalizeWorkspacePath(outside), 'real.rs');
  const decoy = posix.join('c/src', target);
  write(decoy, '// decoy');
  write('c/Cargo.toml', '[package]\nname = "c"\n');
  write('c/src/lib.rs', `#[path = ${JSON.stringify(target)}] mod x;\n`);
  const result = classifyRustWorkspace(
    ['c/Cargo.toml', 'c/src/lib.rs'],
    workspaceRustIo(workspace, () => true),
  );
  assert.deepEqual([...result.files.keys()], ['c/src/lib.rs']);
  assert.deepEqual(result.issues.refused, [target]);
  assert.deepEqual(result.readPaths, ['c/Cargo.toml', 'c/src/lib.rs']);
}

{
  // Content never throws out of the reader. A NUL in a cfg-stripped #[path]
  // (rustc never loads it, the tree still follows it), inline modules and a
  // cfg predicate nested 20k deep, and Cargo.toml arrays and inline tables
  // nested 20k deep each become a per-file issue; the other crates are still
  // classified.
  const workspace = makeFixtureTree('aria-rust-vectors-');
  const write = (path: string, text: string): void => {
    mkdirSync(resolve(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), text, 'utf8');
  };
  const depth = 20_000;
  const crates: Record<string, string> = {
    nul: '#[cfg(any())] #[path = "a\\0.rs"] mod x;\n',
    mods: `${'mod a {'.repeat(depth)}${'}'.repeat(depth)}\n`,
    cfg: `#[cfg(${'all('.repeat(depth)}test${')'.repeat(depth)})] mod x;\n`,
    arrays: '',
    tables: '',
    ok: 'pub fn shipped() {}\n',
  };
  for (const [name, lib] of Object.entries(crates)) {
    write(`${name}/Cargo.toml`, `[package]\nname = "${name}"\n`);
    write(`${name}/src/lib.rs`, lib);
  }
  write(
    'arrays/Cargo.toml',
    `[package]\nname = "arrays"\nk = ${'['.repeat(depth)}${']'.repeat(depth)}\n`,
  );
  write(
    'tables/Cargo.toml',
    `[package]\nname = "tables"\nk = ${'{ a = '.repeat(depth)}1${' }'.repeat(depth)}\n`,
  );
  const paths = Object.keys(crates).flatMap((name) => [`${name}/Cargo.toml`, `${name}/src/lib.rs`]);
  const result = classifyRustWorkspace(
    paths,
    workspaceRustIo(workspace, () => true),
  );
  assert.deepEqual(
    result.issues.parseFailures.map((failure) => [failure.path, failure.reason]),
    [
      ['cfg/src/lib.rs', 'nesting_too_deep'],
      ['mods/src/lib.rs', 'nesting_too_deep'],
    ],
  );
  assert.deepEqual(
    result.issues.unclassifiedTargets.map((issue) => [issue.crate, issue.reason, issue.detail]),
    [
      ['arrays', 'manifest_unparsed', 'nesting_too_deep'],
      ['tables', 'manifest_unparsed', 'nesting_too_deep'],
    ],
  );
  assert.deepEqual(
    result.issues.moduleIssues.map((found) => [found.reason, found.path, found.line]),
    [['module_path_invalid', 'nul/src/lib.rs', 1]],
  );
  assert.equal(result.files.get('ok/src/lib.rs')?.context, 'production');
  assert.equal(result.files.get('nul/src/lib.rs')?.context, 'production');
}

// ---------------------------------------------------------------------------
// the real repository
// ---------------------------------------------------------------------------

{
  const repoRoot = resolve(__dirname, '..', '..');
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.rs', '*Cargo.toml'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.length > 0 && existsSync(join(repoRoot, path)));
  const started = Date.now();
  // The same filesystem access every adapter gets: no symlink is followed.
  const workspace = classifyRustWorkspace(
    tracked,
    workspaceRustIo(repoRoot, () => true),
  );
  const elapsed = Date.now() - started;
  assert.deepEqual(workspace.issues.parseFailures, [], 'every tracked Rust file lexes');
  assert.deepEqual(
    workspace.issues.unclassifiedTargets,
    [],
    'every cargo target classifies by the file rule',
  );
  assert.deepEqual(workspace.issues.refused, []);
  const context = (path: string): string | undefined => workspace.files.get(path)?.context;
  // The three out-of-line #[cfg(test)] modules are test code.
  assert.equal(context('sens-api-gateway/src/contract_fixtures_tests.rs'), 'harness');
  assert.equal(context('sens-api-gateway/src/scripting/bytecode_e2e_tests.rs'), 'harness');
  assert.equal(context('crates/outbox-rs/src/mock.rs'), 'harness');
  assert.equal(context('sens-api-gateway/src/main.rs'), 'production');
  // Shipped code that a fuzz target also includes by #[path] stays production.
  assert.equal(context('sens-api-gateway/src/st_validator.rs'), 'production');
  assert.equal(context('tools/backup-ssh-broker/main.rs'), 'production');
  assert.equal(context('apps/sensor-ingestion/src/main.rs'), 'production');
  assert.equal(context('sensorprotocols/wasm-decoder-template/src/lib.rs'), 'production');
  // The vendored fork: upstream bytes are read but not ours; our edit is.
  assert.equal(context('crates/local-rumqttc/src/lib.rs'), 'upstream');
  assert.equal(context('crates/local-rumqttc/src/tls.rs'), 'production');
  assert.ok(workspace.readPaths.includes('crates/local-rumqttc/UPSTREAM-MANIFEST.sha256'));
  // Only the gate-owned fork may exempt files as upstream: a manifest in any
  // other crate would silently drop its claims, so a new one turns this red.
  assert.deepEqual(
    workspace.crates.filter((crate) => crate.upstreamManifest !== null).map((crate) => crate.root),
    ['crates/local-rumqttc'],
  );
  for (const file of workspace.files.values()) {
    if (
      file.path.startsWith('crates/protocol-codec/fuzz/') ||
      file.path.startsWith('sens-api-gateway/fuzz/')
    ) {
      assert.notEqual(file.context, 'production', `${file.path} is a fuzz harness`);
    }
  }
  assert.ok(elapsed < 30_000, `classifying the repository took ${elapsed} ms`);
}

process.stdout.write('rust-source.test.ts OK\n');
