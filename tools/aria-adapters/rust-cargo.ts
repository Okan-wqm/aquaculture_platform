/**
 * Cargo's file conventions, read from files (ARIA-HIGH-010): the companion of
 * `rust-source.ts`, which imports it.
 *
 * WHY files and not `cargo metadata`: the adapter room binds only node, and
 * cargo is an external tool, not an in-repo owner. Reading its documented
 * conventions creates no second in-repo copy, and a host without Rust can
 * still classify Rust.
 *
 *  - `parseCargoManifest`: the TOML structure a Cargo.toml uses.
 *  - `discoverCrates`: the package root of a file is the nearest ancestor
 *    `Cargo.toml` with a `[package]` table; a directory with `main.rs` /
 *    `lib.rs` and no package above it is a crate rustc builds directly.
 *  - `crateTargets`: cargo's default target discovery and the `[lib]` /
 *    `[[bin]]` / `[[test]]` / `[[bench]]` / `[[example]]` / `build`
 *    declarations. A layout the file rule cannot classify is reported as
 *    `unclassified`, never guessed (tier 3: tools/aria-adapters/rust-source.test.ts
 *    pins the real repository at zero, and the aria-adapters test target
 *    declares every `*.rs`, `Cargo.toml` and `UPSTREAM-MANIFEST.sha256` as an
 *    nx input, so a PR that touches only Rust runs that pin too).
 *  - `upstreamVendoredFiles`: files whose bytes equal a vendored crate's
 *    `UPSTREAM-MANIFEST.sha256` line (that manifest is owned by
 *    tools/gates/local-rumqttc-fork-hygiene.spec.ts, which reads it and
 *    FORK-EDITS.sha256 through `parseUpstreamManifest`, the grammar's one copy,
 *    ARIA-LOW-544).
 *  - `cargoTargetDirSkip`: cargo's build directory, for `collectFiles`.
 *
 * Paths are workspace-relative and POSIX throughout. Containment is
 * `isWorkspaceRelativePath` from adapter-fs.ts, applied before any `exists` /
 * `allowed` / `read` call, so an escaping or absolute target path never
 * reaches the filesystem.
 */
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';

import { isWorkspaceRelativePath, workspacePathExists } from './adapter-fs';

// ---------------------------------------------------------------------------
// paths and bounds
// ---------------------------------------------------------------------------

function within(root: string, path: string): boolean {
  return root === '.'
    ? isWorkspaceRelativePath(path)
    : path === root || path.startsWith(`${root}/`);
}

/**
 * A path value written in a source or manifest, resolved the way rustc and
 * cargo resolve it: relative to `dir`, or itself when absolute (`Path::join`
 * replaces the base with an absolute path). The result can leave the
 * workspace; callers test it with `isWorkspaceRelativePath`, so an absolute
 * value is refused instead of being re-read as a same-suffix file inside.
 */
export function resolveSourcePath(dir: string, value: string): string {
  return posix.isAbsolute(value) ? posix.normalize(value) : posix.join(dir, value);
}

/**
 * The deepest delimiter (Rust `()[]{}`, TOML arrays and inline tables) the
 * readers accept. Every recursion over their output is bounded by it, so a
 * file nested deeper is refused (`nesting_too_deep`) instead of overflowing
 * the stack and aborting the whole workspace. The repository's deepest Rust
 * nesting is 18.
 */
export const RUST_READER_MAX_NESTING = 256;

export const CARGO_MANIFEST = 'Cargo.toml';

export function isCargoManifest(path: string): boolean {
  return path === CARGO_MANIFEST || path.endsWith(`/${CARGO_MANIFEST}`);
}

/**
 * `collectFiles` `skipDir`: cargo's default build directory is `target/` beside
 * a `Cargo.toml` (.gitignore ignores a `target/` at any depth); a `target/`
 * dir with no manifest beside it is ordinary source. The manifest's
 * existence is asked through containment (ARIA-LOW-593): a symlinked
 * `Cargo.toml` is not a manifest, so the `target` beside a link is walked as
 * source instead of vanishing from the scan.
 */
export function cargoTargetDirSkip(
  name: string,
  parentPath: string,
  workspaceRoot: string,
): boolean {
  return name === 'target' && workspacePathExists(workspaceRoot, join(parentPath, CARGO_MANIFEST));
}

// ---------------------------------------------------------------------------
// Cargo.toml
// ---------------------------------------------------------------------------

export type CargoTomlValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'other' };

export type CargoTomlEntry =
  | {
      readonly kind: 'header';
      readonly name: string;
      readonly array: boolean;
      readonly line: number;
    }
  | {
      readonly kind: 'pair';
      readonly table: string;
      readonly key: string;
      readonly value: CargoTomlValue;
      readonly line: number;
    };

export type CargoTomlResult =
  | { readonly ok: true; readonly entries: readonly CargoTomlEntry[] }
  | { readonly ok: false; readonly reason: string; readonly line: number };

class TomlError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
  ) {
    super(reason);
  }
}

/**
 * The TOML structure a Cargo.toml uses: table headers and the key/value pairs
 * directly under them (values inside arrays and inline tables are skipped as
 * `other`). Multi-line arrays and strings are followed, so a `[` that starts a
 * line inside them is never mistaken for a header.
 */
export function parseCargoManifest(text: string): CargoTomlResult {
  try {
    return { ok: true, entries: new CargoTomlReader(text).run() };
  } catch (error) {
    if (error instanceof TomlError) return { ok: false, reason: error.reason, line: error.line };
    throw error;
  }
}

class CargoTomlReader {
  private i = 0;
  private line = 1;

  constructor(private readonly src: string) {}

  run(): CargoTomlEntry[] {
    const entries: CargoTomlEntry[] = [];
    let table = '';
    for (;;) {
      this.skipBlank();
      if (this.i >= this.src.length) return entries;
      const line = this.line;
      if (this.src.charAt(this.i) === '[') {
        const array = this.src.charAt(this.i + 1) === '[';
        this.i += array ? 2 : 1;
        table = this.key();
        this.skipInline();
        this.expect(array ? ']]' : ']');
        entries.push({ kind: 'header', name: table, array, line });
      } else {
        const key = this.key();
        this.skipInline();
        this.expect('=');
        this.skipInline();
        entries.push({ kind: 'pair', table, key, value: this.value(0), line });
      }
      this.endOfLine();
    }
  }

  private fail(reason: string): never {
    throw new TomlError(reason, this.line);
  }

  private expect(text: string): void {
    if (!this.src.startsWith(text, this.i)) this.fail(`expected ${text}`);
    this.i += text.length;
  }

  private skipInline(): void {
    while (this.src.charAt(this.i) === ' ' || this.src.charAt(this.i) === '\t') this.i += 1;
  }

  /** Whitespace, newlines and comments. */
  private skipBlank(): void {
    while (this.i < this.src.length) {
      const c = this.src.charAt(this.i);
      if (c === '\n') {
        this.line += 1;
        this.i += 1;
      } else if (c === ' ' || c === '\t' || c === '\r') {
        this.i += 1;
      } else if (c === '#') {
        while (this.i < this.src.length && this.src.charAt(this.i) !== '\n') this.i += 1;
      } else {
        return;
      }
    }
  }

  private endOfLine(): void {
    this.skipInline();
    if (this.src.charAt(this.i) === '#') {
      while (this.i < this.src.length && this.src.charAt(this.i) !== '\n') this.i += 1;
    }
    if (this.src.charAt(this.i) === '\r') this.i += 1;
    if (this.i < this.src.length && this.src.charAt(this.i) !== '\n') this.fail('trailing_content');
  }

  /** A dotted key of bare, "basic" and 'literal' parts, joined with `.`. */
  private key(): string {
    const parts: string[] = [];
    for (;;) {
      this.skipInline();
      const c = this.src.charAt(this.i);
      if (c === '"') {
        parts.push(this.basicString());
      } else if (c === "'") {
        parts.push(this.literalString());
      } else {
        const bare = /^[A-Za-z0-9_-]+/.exec(this.src.slice(this.i, this.i + 256));
        if (bare === null) this.fail('bad_key');
        parts.push(bare[0]);
        this.i += bare[0].length;
      }
      this.skipInline();
      if (this.src.charAt(this.i) !== '.') return parts.join('.');
      this.i += 1;
    }
  }

  private basicString(): string {
    let value = '';
    this.i += 1;
    while (this.i < this.src.length) {
      const c = this.src.charAt(this.i);
      if (c === '"') {
        this.i += 1;
        return value;
      }
      if (c === '\n') break;
      if (c === '\\') {
        value += this.tomlEscape();
        continue;
      }
      value += c;
      this.i += 1;
    }
    return this.fail('unterminated_string');
  }

  private tomlEscape(): string {
    const kind = this.src.charAt(this.i + 1);
    const simple: Readonly<Record<string, string>> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };
    const width = kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
    if (width > 0) {
      const hex = this.src.slice(this.i + 2, this.i + 2 + width);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) this.fail('bad_escape');
      const point = parseInt(hex, 16);
      // TOML admits Unicode scalar values only; String.fromCodePoint throws above U+10FFFF.
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) this.fail('bad_escape');
      this.i += 2 + width;
      return String.fromCodePoint(point);
    }
    const decoded = simple[kind];
    if (decoded === undefined) this.fail('bad_escape');
    this.i += 2;
    return decoded;
  }

  private literalString(): string {
    const close = this.src.indexOf("'", this.i + 1);
    const newline = this.src.indexOf('\n', this.i + 1);
    if (close < 0 || (newline >= 0 && newline < close)) this.fail('unterminated_string');
    const value = this.src.slice(this.i + 1, close);
    this.i = close + 1;
    return value;
  }

  private multiLineString(delimiter: '"""' | "'''"): string {
    const start = this.i + 3;
    let j = start;
    for (;;) {
      const close = this.src.indexOf(delimiter, j);
      if (close < 0) this.fail('unterminated_string');
      if (delimiter === "'''" || !this.escaped(close)) {
        // Up to two quotes right before the closing delimiter belong to the content.
        let end = close;
        while (
          end + 3 < this.src.length &&
          this.src.charAt(end + 3) === delimiter.charAt(0) &&
          end - close < 2
        )
          end += 1;
        const value = this.src.slice(start, end);
        this.line += value.split('\n').length - 1;
        this.i = end + 3;
        return value;
      }
      j = close + 1;
    }
  }

  private escaped(index: number): boolean {
    let backslashes = 0;
    for (let k = index - 1; k >= 0 && this.src.charAt(k) === '\\'; k -= 1) backslashes += 1;
    return backslashes % 2 === 1;
  }

  /** One value; `depth` counts the arrays and inline tables around it. */
  private value(depth: number): CargoTomlValue {
    const src = this.src;
    const c = src.charAt(this.i);
    if ((c === '[' || c === '{') && depth >= RUST_READER_MAX_NESTING) this.fail('nesting_too_deep');
    if (src.startsWith('"""', this.i))
      return { kind: 'string', value: this.multiLineString('"""') };
    if (src.startsWith("'''", this.i))
      return { kind: 'string', value: this.multiLineString("'''") };
    if (c === '"') return { kind: 'string', value: this.basicString() };
    if (c === "'") return { kind: 'string', value: this.literalString() };
    if (c === '[') {
      this.i += 1;
      for (;;) {
        this.skipBlank();
        if (src.charAt(this.i) === ']') break;
        this.value(depth + 1);
        this.skipBlank();
        if (src.charAt(this.i) === ',') {
          this.i += 1;
        } else if (src.charAt(this.i) !== ']') {
          this.fail('bad_array');
        }
      }
      this.i += 1;
      return { kind: 'other' };
    }
    if (c === '{') {
      this.i += 1;
      for (;;) {
        this.skipBlank();
        if (src.charAt(this.i) === '}') break;
        this.key();
        this.skipInline();
        this.expect('=');
        this.skipInline();
        this.value(depth + 1);
        this.skipBlank();
        if (src.charAt(this.i) === ',') {
          this.i += 1;
        } else if (src.charAt(this.i) !== '}') {
          this.fail('bad_inline_table');
        }
      }
      this.i += 1;
      return { kind: 'other' };
    }
    const scalar = /^[^,\]}#\r\n]*/.exec(src.slice(this.i));
    const raw = scalar === null ? '' : scalar[0].trimEnd();
    if (raw === '') this.fail('missing_value');
    this.i += raw.length;
    if (raw === 'true' || raw === 'false') return { kind: 'boolean', value: raw === 'true' };
    return { kind: 'other' };
  }
}

// ---------------------------------------------------------------------------
// crates and targets
// ---------------------------------------------------------------------------

export type RustCrateKind = 'package' | 'fuzz_harness' | 'standalone_rustc';

export interface RustCrate {
  /** The crate directory (`.` for the workspace root). */
  readonly root: string;
  /** The package manifest, or null for a crate rustc builds directly. */
  readonly manifest: string | null;
  readonly kind: RustCrateKind;
  /** The `.rs` files this crate owns by the package-root rule. */
  readonly files: readonly string[];
}

export interface RustCrateDiscovery {
  readonly crates: readonly RustCrate[];
  /** `.rs` files no package and no standalone crate root owns. */
  readonly ownerless: readonly string[];
}

const PACKAGE_HEADER = /^\s*\[package\]\s*(#.*)?$/m;

function fullKey(entry: { readonly table: string; readonly key: string }): string {
  return entry.table === '' ? entry.key : `${entry.table}.${entry.key}`;
}

function manifestShape(text: string): { readonly isPackage: boolean; readonly fuzz: boolean } {
  const parsed = parseCargoManifest(text);
  if (!parsed.ok) return { isPackage: PACKAGE_HEADER.test(text), fuzz: false };
  const isPackage = parsed.entries.some((entry) =>
    entry.kind === 'header' ? entry.name === 'package' : fullKey(entry).startsWith('package.'),
  );
  const fuzz = parsed.entries.some(
    (entry) =>
      entry.kind === 'pair' &&
      fullKey(entry) === 'package.metadata.cargo-fuzz' &&
      entry.value.kind === 'boolean' &&
      entry.value.value,
  );
  return { isPackage, fuzz };
}

/** The nearest ancestor directory of `path` in `roots` (`.` is the workspace root). */
export function nearestRoot(path: string, roots: ReadonlySet<string>): string | undefined {
  let dir = posix.dirname(path);
  for (;;) {
    if (roots.has(dir)) return dir;
    if (dir === '.' || dir === '/') return undefined;
    dir = posix.dirname(dir);
  }
}

/**
 * Crates by cargo's package-root rule: the nearest ancestor `Cargo.toml`
 * holding a `[package]` table owns a file (a workspace-only manifest owns
 * nothing). A directory with `main.rs` / `lib.rs` and no package above it is a
 * crate rustc builds directly (`standalone_rustc`, e.g. tools/backup-ssh-broker).
 * `paths` are the walked files; only manifests among them are consulted.
 */
export function discoverCrates(
  paths: readonly string[],
  read: (path: string) => string,
): RustCrateDiscovery {
  const kinds = new Map<
    string,
    { readonly manifest: string | null; readonly kind: RustCrateKind }
  >();
  for (const manifest of paths.filter(isCargoManifest).sort()) {
    const shape = manifestShape(read(manifest));
    if (shape.isPackage)
      kinds.set(posix.dirname(manifest), {
        manifest,
        kind: shape.fuzz ? 'fuzz_harness' : 'package',
      });
  }
  const sources = paths.filter((path) => path.endsWith('.rs')).sort();
  const packageRoots = new Set(kinds.keys());
  const unpackaged = sources.filter((path) => nearestRoot(path, packageRoots) === undefined);
  for (const path of unpackaged) {
    const name = posix.basename(path);
    if (name === 'main.rs' || name === 'lib.rs')
      kinds.set(posix.dirname(path), { manifest: null, kind: 'standalone_rustc' });
  }
  const allRoots = new Set(kinds.keys());
  const owned = new Map<string, string[]>();
  const ownerless: string[] = [];
  for (const path of sources) {
    const root = nearestRoot(path, allRoots);
    if (root === undefined) {
      ownerless.push(path);
    } else {
      owned.set(root, [...(owned.get(root) ?? []), path]);
    }
  }
  const crates = [...kinds.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([root, { manifest, kind }]) => ({ root, manifest, kind, files: owned.get(root) ?? [] }));
  return { crates, ownerless };
}

export type RustTargetRole = 'production' | 'harness';
export type RustTargetSection = 'lib' | 'bin' | 'test' | 'bench' | 'example' | 'build' | 'rustc';

export interface RustTargetRoot {
  readonly path: string;
  readonly role: RustTargetRole;
  readonly section: RustTargetSection;
  /** The manifest line declaring it; 0 when found by cargo's default discovery. */
  readonly line: number;
}

export type RustTargetIssueReason =
  | 'production_target_in_harness_dir'
  | 'harness_target_in_src'
  | 'custom_build_script'
  | 'target_path_missing'
  | 'target_path_outside_workspace'
  | 'target_syntax_unsupported'
  | 'manifest_unparsed';

export interface RustTargetIssue {
  readonly crate: string;
  readonly manifest: string | null;
  readonly line: number;
  readonly reason: RustTargetIssueReason;
  readonly detail: string;
}

export interface RustCrateTargets {
  readonly production: readonly RustTargetRoot[];
  readonly harness: readonly RustTargetRoot[];
  readonly unclassified: readonly RustTargetIssue[];
}

interface DeclaredTarget {
  readonly section: Exclude<RustTargetSection, 'build' | 'rustc'>;
  readonly line: number;
  name?: string;
  path?: string;
}

const SECTION_ROLE: Readonly<Record<RustTargetSection, RustTargetRole>> = {
  lib: 'production',
  bin: 'production',
  rustc: 'production',
  test: 'harness',
  bench: 'harness',
  example: 'harness',
  build: 'harness',
};
type ArrayTargetSection = 'bin' | 'test' | 'bench' | 'example';
const TARGET_KEYS = new Set(['lib', 'bin', 'test', 'bench', 'example']);

function isArrayTargetSection(name: string): name is ArrayTargetSection {
  return name === 'bin' || name === 'test' || name === 'bench' || name === 'example';
}
const HARNESS_DIRS: Readonly<Record<'test' | 'bench' | 'example', string>> = {
  test: 'tests',
  bench: 'benches',
  example: 'examples',
};
// cargo's default target discovery, relative to the package root.
const AUTO_DISCOVERY: readonly {
  readonly flag: string;
  readonly section: RustTargetSection;
  readonly pattern: RegExp;
}[] = [
  {
    flag: 'autobins',
    section: 'bin',
    pattern: /^src\/(main\.rs|bin\/[^/]+\.rs|bin\/[^/]+\/main\.rs)$/,
  },
  { flag: 'autotests', section: 'test', pattern: /^tests\/([^/]+\.rs|[^/]+\/main\.rs)$/ },
  { flag: 'autobenches', section: 'bench', pattern: /^benches\/([^/]+\.rs|[^/]+\/main\.rs)$/ },
  { flag: 'autoexamples', section: 'example', pattern: /^examples\/([^/]+\.rs|[^/]+\/main\.rs)$/ },
];

/** The name cargo infers for a discovered target file (`inCrate` is relative to the package root). */
function inferredTargetName(inCrate: string, packageName: string | undefined): string | undefined {
  if (inCrate === 'src/main.rs') return packageName;
  const segments = inCrate.split('/');
  const file = segments[segments.length - 1] ?? '';
  return file === 'main.rs' ? segments[segments.length - 2] : file.slice(0, -'.rs'.length);
}

/** Where cargo looks for a declared target that names no `path`. */
function inferredTargetPaths(target: DeclaredTarget, packageName: string | undefined): string[] {
  const name = target.name;
  if (target.section === 'lib') return ['src/lib.rs'];
  if (name === undefined) return [];
  if (target.section === 'bin') {
    return [
      `src/bin/${name}.rs`,
      `src/bin/${name}/main.rs`,
      ...(name === packageName ? ['src/main.rs'] : []),
    ];
  }
  const dir = HARNESS_DIRS[target.section];
  return [`${dir}/${name}.rs`, `${dir}/${name}/main.rs`];
}

/**
 * The crate's build targets, classified by cargo's conventions: `[lib]` and
 * bins are production roots; tests, benches, examples and the build script
 * are harness roots; every target of a cargo-fuzz crate is harness.
 *
 * Drift detector: a production target under `tests/`/`benches/`/`examples/`,
 * a harness target under `src/`, a custom `build = "…"` script, a declared
 * target that does not exist or leaves the workspace (an absolute path
 * included), and a target or `package.metadata` written in a form this reader
 * does not follow are reported in `unclassified`. Such a target becomes no
 * root (a custom build script inside the workspace stays a harness root).
 */
export function crateTargets(
  crate: RustCrate,
  io: { readonly exists: (path: string) => boolean; readonly read: (path: string) => string },
): RustCrateTargets {
  const roots: RustTargetRoot[] = [];
  const issues: RustTargetIssue[] = [];
  const issue = (line: number, reason: RustTargetIssueReason, detail: string): void => {
    issues.push({ crate: crate.root, manifest: crate.manifest, line, reason, detail });
  };
  const finish = (): RustCrateTargets => {
    const seen = new Set<string>();
    const unique = roots
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
      .filter((root) => {
        const key = `${root.role}:${root.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      production: unique.filter((root) => root.role === 'production'),
      harness: unique.filter((root) => root.role === 'harness'),
      unclassified: issues.sort((a, b) => a.line - b.line || (a.reason < b.reason ? -1 : 1)),
    };
  };

  if (crate.manifest === null) {
    for (const name of ['lib.rs', 'main.rs']) {
      const path = posix.join(crate.root, name);
      if (io.exists(path)) roots.push({ path, role: 'production', section: 'rustc', line: 0 });
    }
    return finish();
  }

  const parsed = parseCargoManifest(io.read(crate.manifest));
  if (!parsed.ok) {
    issue(parsed.line, 'manifest_unparsed', parsed.reason);
    return finish();
  }

  const declared: DeclaredTarget[] = [];
  const packageKeys = new Map<string, { readonly value: CargoTomlValue; readonly line: number }>();
  let lib: DeclaredTarget | undefined;
  let current: DeclaredTarget | undefined;
  for (const entry of parsed.entries) {
    if (entry.kind === 'header') {
      current = undefined;
      if (entry.name === 'lib' && !entry.array) {
        lib = { section: 'lib', line: entry.line };
        current = lib;
      } else if (entry.array && isArrayTargetSection(entry.name)) {
        current = { section: entry.name, line: entry.line };
        declared.push(current);
      }
      continue;
    }
    const key = fullKey(entry);
    if (key.startsWith('package.')) {
      packageKeys.set(key.slice('package.'.length), { value: entry.value, line: entry.line });
      continue;
    }
    // A pair inside a target table, or a root-level dotted `lib.path` / `lib.name`.
    let target = current;
    let field = entry.key;
    if (target === undefined && entry.table === '') {
      const [head, ...rest] = entry.key.split('.');
      if (head === 'lib' && rest.length === 1) {
        lib = lib ?? { section: 'lib', line: entry.line };
        target = lib;
        field = rest[0] ?? '';
      } else if (head !== undefined && TARGET_KEYS.has(head)) {
        // `bin = [{ … }]` and similar inline forms: not followed, so reported.
        issue(entry.line, 'target_syntax_unsupported', key);
        continue;
      }
    }
    if (target === undefined || (field !== 'path' && field !== 'name')) continue;
    if (entry.value.kind !== 'string') {
      issue(entry.line, 'target_syntax_unsupported', key);
    } else if (field === 'path') {
      target.path = entry.value.value;
    } else {
      target.name = entry.value.value;
    }
  }

  const fuzz = crate.kind === 'fuzz_harness';
  const roleOf = (section: RustTargetSection): RustTargetRole =>
    fuzz ? 'harness' : SECTION_ROLE[section];
  const packageString = (key: string): string | undefined => {
    const entry = packageKeys.get(key);
    return entry !== undefined && entry.value.kind === 'string' ? entry.value.value : undefined;
  };
  const autoEnabled = (flag: string): boolean => {
    const entry = packageKeys.get(flag);
    return entry === undefined || entry.value.kind !== 'boolean' || entry.value.value;
  };
  const packageName = packageString('name');
  // An inline `metadata = { … }` hides `cargo-fuzz = true` from manifestShape,
  // which reads only the header and dotted forms: report it, never guess.
  const metadata = packageKeys.get('metadata');
  if (metadata !== undefined) issue(metadata.line, 'target_syntax_unsupported', 'package.metadata');
  const targetPath = (value: string, line: number): string | undefined => {
    const path = resolveSourcePath(crate.root, value);
    if (isWorkspaceRelativePath(path)) return path;
    issue(line, 'target_path_outside_workspace', value);
    return undefined;
  };

  for (const target of lib === undefined ? declared : [lib, ...declared]) {
    let path: string | undefined;
    if (target.path !== undefined) {
      path = targetPath(target.path, target.line);
      if (path === undefined) continue;
    } else {
      path = inferredTargetPaths(target, packageName)
        .map((candidate) => posix.join(crate.root, candidate))
        .find((candidate) => io.exists(candidate));
    }
    if (path === undefined || !io.exists(path)) {
      issue(
        target.line,
        'target_path_missing',
        `${target.section} ${target.path ?? target.name ?? ''}`.trim(),
      );
      continue;
    }
    const role = roleOf(target.section);
    const inCrate = posix.relative(crate.root, path);
    if (!fuzz && role === 'production' && /^(tests|benches|examples)\//.test(inCrate)) {
      issue(target.line, 'production_target_in_harness_dir', inCrate);
      continue;
    }
    if (!fuzz && role === 'harness' && inCrate.startsWith('src/')) {
      issue(target.line, 'harness_target_in_src', inCrate);
      continue;
    }
    roots.push({ path, role, section: target.section, line: target.line });
  }

  if (lib === undefined && autoEnabled('autolib')) {
    const path = posix.join(crate.root, 'src/lib.rs');
    if (io.exists(path)) roots.push({ path, role: roleOf('lib'), section: 'lib', line: 0 });
  }
  for (const auto of AUTO_DISCOVERY) {
    if (!autoEnabled(auto.flag)) continue;
    // cargo's toml_targets_and_inferred: a discovered target whose name or
    // path a declared target of the same kind uses is not built.
    const taken = declared.filter((target) => target.section === auto.section);
    const takenNames = new Set(taken.map((target) => target.name));
    const takenPaths = new Set(
      taken.map((target) =>
        target.path === undefined ? undefined : resolveSourcePath(crate.root, target.path),
      ),
    );
    for (const path of crate.files) {
      const inCrate = posix.relative(crate.root, path);
      if (!auto.pattern.test(inCrate)) continue;
      const name = inferredTargetName(inCrate, packageName);
      if ((name !== undefined && takenNames.has(name)) || takenPaths.has(path)) continue;
      roots.push({ path, role: roleOf(auto.section), section: auto.section, line: 0 });
    }
  }

  const build = packageKeys.get('build');
  const defaultBuild = posix.join(crate.root, 'build.rs');
  if (build === undefined || (build.value.kind === 'boolean' && build.value.value)) {
    if (io.exists(defaultBuild))
      roots.push({
        path: defaultBuild,
        role: 'harness',
        section: 'build',
        line: build === undefined ? 0 : build.line,
      });
  } else if (build.value.kind === 'string' && build.value.value === 'build.rs') {
    if (io.exists(defaultBuild))
      roots.push({ path: defaultBuild, role: 'harness', section: 'build', line: build.line });
  } else if (build.value.kind === 'string') {
    issue(build.line, 'custom_build_script', build.value.value);
    const custom = targetPath(build.value.value, build.line);
    if (custom !== undefined && io.exists(custom))
      roots.push({ path: custom, role: 'harness', section: 'build', line: build.line });
  } else if (build.value.kind === 'other') {
    issue(build.line, 'target_syntax_unsupported', 'package.build');
  }
  return finish();
}

// ---------------------------------------------------------------------------
// vendored upstream
// ---------------------------------------------------------------------------

export const UPSTREAM_MANIFEST = 'UPSTREAM-MANIFEST.sha256';

export interface RustUpstreamFiles {
  /** The manifest read, or null when the crate has none. */
  readonly manifest: string | null;
  /** A manifest that exists but the caller may not read. */
  readonly refused: string | null;
  /** `.rs` files whose current bytes equal their upstream manifest line. */
  readonly files: ReadonlySet<string>;
}

/**
 * A `<sha256>  ./<path>` manifest (`UPSTREAM-MANIFEST.sha256`,
 * `FORK-EDITS.sha256`): one entry per line, every other line ignored. Keys are
 * the paths as written (`./src/lib.rs`), values the digests. This is the
 * grammar's one copy (ARIA-LOW-544): the owning gate
 * (tools/gates/local-rumqttc-fork-hygiene.spec.ts) imports it, so a line the
 * gate ignores never makes a file upstream here. It is linear (no
 * backtracking over a long whitespace run).
 */
export function parseUpstreamManifest(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split('\n')) {
    const entry = /^([0-9a-f]{64})\s+(\.\/.+)$/.exec(line);
    const digest = entry === null ? undefined : entry[1];
    const path = entry === null ? undefined : entry[2];
    if (digest !== undefined && path !== undefined) entries.set(path, digest);
  }
  return entries;
}

/**
 * Upstream bytes of a vendored crate: a `.rs` file whose sha256 equals its
 * `<crate>/UPSTREAM-MANIFEST.sha256` line is upstream code (read and counted,
 * never claimed); a fork-edited file no longer matches and is ours. Hashing
 * decodes text as UTF-8, so a non-UTF-8 file can only fail to match: it is
 * then scanned as ours, never silently skipped.
 */
export function upstreamVendoredFiles(
  crateRoot: string,
  io: {
    readonly exists: (path: string) => boolean;
    readonly allowed: (path: string) => boolean;
    readonly read: (path: string) => string;
  },
): RustUpstreamFiles {
  const manifest = posix.join(crateRoot, UPSTREAM_MANIFEST);
  if (!io.exists(manifest)) return { manifest: null, refused: null, files: new Set() };
  if (!io.allowed(manifest)) return { manifest: null, refused: manifest, files: new Set() };
  const files = new Set<string>();
  for (const [relativePath, digest] of parseUpstreamManifest(io.read(manifest))) {
    if (!relativePath.endsWith('.rs')) continue;
    const path = posix.join(crateRoot, relativePath);
    if (!within(crateRoot, path) || !isWorkspaceRelativePath(path)) continue;
    if (!io.exists(path) || !io.allowed(path)) continue;
    if (createHash('sha256').update(io.read(path), 'utf8').digest('hex') === digest)
      files.add(path);
  }
  return { manifest, refused: null, files };
}
