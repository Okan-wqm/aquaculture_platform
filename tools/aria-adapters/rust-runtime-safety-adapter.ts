#!/usr/bin/env ts-node
// ARIA-HIGH-010 — Rust runtime-safety observation (plan Task 13).
//
// WHY: ARIA read no Rust for runtime meaning. The banned-phrase adapter
// reads text; rust-source.ts reads tokens but answers classification
// questions (which file is production, which is harness, which is vendored
// upstream), never safety ones. Nothing observed a discarded task handle, a
// loop with no cancellation path, an `unsafe` block without its contract,
// or an external connection with no timeout bound — the four ways Rust
// runtime code in this repository can strand work past its shutdown.
//
// WHAT: an observation over the Rust the workspace classifier marks
// `production` under the manifest's roots (sens-api-gateway,
// apps/sensor-ingestion, crates, sensorprotocols). Every claim is
// syntactic, from the one Rust reader (rust-source.ts lexes; rust-cargo.ts
// resolves crates and targets; no cargo, no rustc, no git — the adapter
// room binds node only), and every finding cites the bounded evidence that
// made it unsafe:
//
//   detached_task
//     A `tokio::spawn` / `tokio::task::spawn` / `tokio::spawn_blocking` /
//     `thread::spawn` call that forms an expression statement by itself:
//     nothing binds the handle (no `=`, argument, `return` or match-arm
//     value before it) and nothing follows the call (`;` directly, not
//     `.await`, `.join()`, `.abort()` or a tail return). The handle drops,
//     and with it the only way to join or cancel the work.
//   uncancellable_long_lived_loop
//     A `loop` or `while` in async code (an async fn's body, an async
//     block) whose span — keyword to the loop body's closing brace — holds
//     no cancellation evidence: no `select!`, no identifier naming shutdown
//     or cancellation (`shutdown_rx`, `CancellationToken`, …), no `abort`.
//     A sync loop is out: it never waits on the executor. `for` is out: an
//     iterator bounds it.
//   unsafe_without_safety_contract
//     An `unsafe` block or `unsafe impl` with no `SAFETY:` comment ending
//     on the line directly above it (the convention clippy's
//     undocumented_unsafe_blocks asks for; this repository writes it 91
//     times). An `unsafe fn` declaration is not claimed: the contract is
//     owed at its call sites, where the block appears.
//   unbounded_external_io
//     A path-form I/O entry point that creates its primitive in the same
//     statement — `TcpStream::connect`, an `async_nats::connect…` free
//     function, `reqwest::get`, `reqwest::Client::builder` / `new` — in
//     async code (builders anywhere: a client is often built in a sync
//     constructor) whose maximal statement — walked out over balanced
//     parentheses to the `;`, `{` or `}` that ends it — names no call with
//     `timeout` in it (`with_timeout(`, `tokio::time::timeout(`,
//     `.timeout(`, `connection_timeout(`). A method call on a stored value
//     (`.connect(…)` on options, a request on a stored client) is not a
//     claim: its bound is set by whatever built the receiver in a different
//     statement, outside any bounded evidence window.
//
// Data is not code: comments and string literals are stripped by the lexer
// before any rule sees a token (the corpus carries a decoy of each). A
// file the lexer refuses is an observation with `clean: false` on the
// summary, never a silent skip. Harness files (tests, benches, examples,
// build scripts, fuzz, cfg(test) modules) are read and classified but
// never claimed; upstream bytes of the vendored fork are read and never
// claimed. Bounds: files, bytes per file, total bytes and cost units are
// capped, and a cap that fires is an observation, never a hole.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  collectFiles,
  containedWorkspace,
  filterFilesBySnapshot,
  isArchivedWorkspacePath,
  normalizeWorkspacePath,
  pathAllowedBySnapshot,
  requireScanRoots,
  type RepoSnapshot,
} from './adapter-fs';
import { cargoTargetDirSkip } from './rust-cargo';
import { classifyRustWorkspace, type RustFileContext, type RustToken } from './rust-source';

const TOOL_ID = 'rust-runtime-safety-adapter';

const READER = 'tools/aria-adapters/rust-source.ts';
const CARGO_READER = 'tools/aria-adapters/rust-cargo.ts';
const CONTAINMENT = 'tools/aria-adapters/adapter-fs.ts';
const SELF = 'tools/aria-adapters/rust-runtime-safety-adapter.ts';

/**
 * The files whose text decides a verdict here: the one Rust reader, its
 * cargo conventions module, the containment owner and this adapter's own
 * rules. Their hashes are the observation's provenance.
 */
const AUTHORITY_PATHS: readonly string[] = [READER, CARGO_READER, CONTAINMENT, SELF];

/** The walk stops here far above the repository's ~470 files. */
const MAX_SOURCE_FILES = 4000;
/** A single file above this is skipped with an observation, never read. */
const MAX_FILE_BYTES = 2_000_000;
/** The whole scan stops (throws) past this: a budget is a refusal, not a hole. */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const RUST_EXTENSIONS = ['.rs', '.toml', '.lock'] as const;

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly repo_snapshot?: RepoSnapshot & { readonly base_commit_sha?: string | null };
}

interface EvidenceRef {
  readonly path: string;
  readonly line?: number;
}

interface AdapterObservation {
  readonly id: string;
  readonly type: string;
  readonly path?: string;
  readonly details?: Record<string, unknown>;
}

type RustRuntimeRule =
  | 'detached_task'
  | 'uncancellable_long_lived_loop'
  | 'unsafe_without_safety_contract'
  | 'unbounded_external_io';

type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

interface AdapterFinding {
  readonly id: string;
  readonly rule: RustRuntimeRule;
  readonly severity: FindingSeverity;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly evidence: readonly EvidenceRef[];
  readonly confidence: number;
  /** The module whose rule decided the verdict, and the id it reports under. */
  readonly owner: string;
  readonly owner_rule_id: string;
  readonly range: { readonly start_line: number; readonly end_line: number };
  /** The construct the verdict is about (`tokio::spawn`, `loop`, …). */
  readonly subject: string | null;
  readonly remediation: string;
  readonly target_sha: string | null;
  readonly fingerprint: string;
}

interface AriaOutput {
  readonly observations: readonly AdapterObservation[];
  readonly findings: readonly AdapterFinding[];
  readonly read_paths: readonly string[];
  readonly evidence_sources: readonly string[];
  readonly belief_candidates: readonly unknown[];
  readonly cost_units: number;
  readonly metadata: Record<string, unknown>;
}

interface Projection {
  readonly rule: RustRuntimeRule;
  readonly severity: FindingSeverity;
  readonly confidence: number;
}

/**
 * One entry per rule the manifest contracts. Each rule id is written here
 * as a literal: the rule-contract pin (aria-kernel/tests/test_rule_contract_
 * manifests.py) reads the emitted vocabulary from this source.
 */
const RULES: Readonly<Record<RustRuntimeRule, Projection>> = {
  detached_task: { rule: 'detached_task', severity: 'high', confidence: 0.8 },
  uncancellable_long_lived_loop: {
    rule: 'uncancellable_long_lived_loop',
    severity: 'medium',
    confidence: 0.7,
  },
  unsafe_without_safety_contract: {
    rule: 'unsafe_without_safety_contract',
    severity: 'high',
    confidence: 0.85,
  },
  unbounded_external_io: { rule: 'unbounded_external_io', severity: 'medium', confidence: 0.75 },
};

// ------------------------------------------------------------------ helpers
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function isIdent(tokens: readonly RustToken[], index: number, text: string): boolean {
  const token = tokens[index];
  return token !== undefined && token.kind === 'ident' && !token.raw && token.text === text;
}

function isPunct(tokens: readonly RustToken[], index: number, text: string): boolean {
  const token = tokens[index];
  return token !== undefined && token.kind === 'punct' && token.text === text;
}

/**
 * The index of the first token of the `ident (:: ident)*` path that ends
 * just before `end` (which is the `(` of a call, or the path's last ident).
 * A method receiver (`.` before the name) is not part of any path.
 */
function pathStart(tokens: readonly RustToken[], end: number): number {
  let start = end;
  for (;;) {
    if (!isPunct(tokens, start - 1, '::')) break;
    if (!(tokens[start - 2]?.kind === 'ident')) break;
    start -= 2;
  }
  return start;
}

/** The `a::b::c` segments of the path ending at (and including) `end`. */
function pathSegments(tokens: readonly RustToken[], end: number): string[] {
  const start = pathStart(tokens, end);
  const segments: string[] = [];
  for (let i = start; i <= end; i += 2) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'ident') break;
    segments.push(token.text);
    if (i < end && !isPunct(tokens, i + 1, '::')) break;
  }
  return segments;
}

/** Whether `ident` at `index` is a call/method name: `(` follows it. */
function isCallName(tokens: readonly RustToken[], index: number): boolean {
  const next = tokens[index + 1];
  return next !== undefined && next.kind === 'open' && next.text === '(';
}

/**
 * The maximal statement span (inclusive token indices) around `anchor`: the
 * `;`, `{` or `}` that terminates it in both directions. Walking back jumps
 * over balanced `()`/`[]` groups (the wrapper of a call is outside its
 * arguments); walking forward stops at the first `;`, `{` or `}`, which is
 * the statement end however deeply the expression nests arguments.
 */
function statementSpan(
  tokens: readonly RustToken[],
  anchor: number,
): { start: number; end: number } {
  let start = anchor;
  for (let j = anchor; j >= 0; j -= 1) {
    const token = tokens[j];
    if (token === undefined) break;
    if (token.kind === 'close' && (token.text === ')' || token.text === ']')) {
      j = token.match;
      continue;
    }
    if (
      (token.kind === 'punct' && token.text === ';') ||
      (token.kind === 'open' && token.text === '{') ||
      (token.kind === 'close' && token.text === '}')
    ) {
      break;
    }
    start = j;
  }
  let end = anchor;
  for (let j = anchor; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (token === undefined) break;
    if (
      (token.kind === 'punct' && token.text === ';') ||
      (token.kind === 'open' && token.text === '{') ||
      (token.kind === 'close' && token.text === '}')
    ) {
      break;
    }
    end = j;
  }
  return { start, end };
}

/** Whether the statement around `anchor` names a call with `timeout` in it. */
function statementBoundsTimeout(tokens: readonly RustToken[], anchor: number): boolean {
  const { start, end } = statementSpan(tokens, anchor);
  for (let j = start; j <= end; j += 1) {
    const token = tokens[j];
    if (token === undefined) continue;
    if (token.kind === 'ident' && /timeout/i.test(token.text) && isCallName(tokens, j)) return true;
  }
  return false;
}

// ------------------------------------------------- the async scope machinery

interface BlockFrame {
  readonly open: number;
  readonly close: number;
  readonly isFnBody: boolean;
  readonly declaredAsync: boolean;
  /** Computed: an fn body resets to its own declaration, others inherit. */
  readonly asyncContext: boolean;
}

/**
 * `{` block frames with their async context. An `async fn` marks the body
 * it opens; `async {` / `async move {` mark their block; every other block
 * inherits the context of the block it sits in, and a plain `fn` body
 * resets it to false (a nested fn never awaits).
 */
function blockFrames(tokens: readonly RustToken[]): readonly BlockFrame[] {
  const declared = new Map<number, boolean>();
  const isFnBodyOpen = new Set<number>();
  /**
   * The `{` that opens the body of the function whose `fn` keyword sits at
   * `from`: the first `{` outside the parameter `(...)` group. A `;` or `}`
   * first means no function body follows (a `fn` written in type position,
   * `let f: fn(&str) -> bool`, whose body is not this token's to name).
   */
  const bodyOpenOf = (from: number): number | null => {
    for (let j = from; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token === undefined) return null;
      if (token.kind === 'open' && token.text === '(') {
        j = token.match;
        continue;
      }
      if (token.kind === 'open' && token.text === '{') return j;
      if ((token.kind === 'punct' && token.text === ';') || token.text === '}') return null;
    }
    return null;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isIdent(tokens, i, 'fn')) continue;
    const body = bodyOpenOf(i);
    if (body !== null) isFnBodyOpen.add(body);
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isIdent(tokens, i, 'async')) continue;
    // async fn name <…> (…) -> Ret { — the body it opens is async.
    let k = i + 1;
    if (isIdent(tokens, k, 'unsafe')) k += 1;
    if (isIdent(tokens, k, 'fn')) {
      const body = bodyOpenOf(k);
      if (body !== null) declared.set(body, true);
      continue;
    }
    // async move { / async {
    if (
      isIdent(tokens, k, 'move') &&
      tokens[k + 1]?.kind === 'open' &&
      tokens[k + 1]?.text === '{'
    ) {
      declared.set(k + 1, true);
    } else if (tokens[k]?.kind === 'open' && tokens[k]?.text === '{') {
      declared.set(k, true);
    }
  }
  const frames: BlockFrame[] = [];
  const stack: BlockFrame[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token?.kind === 'open' && token.text === '{') {
      const parent = stack[stack.length - 1];
      const isFnBody = isFnBodyOpen.has(i);
      const declaredAsync = declared.get(i) === true;
      const asyncContext = isFnBody
        ? declaredAsync
        : declaredAsync || (parent?.asyncContext ?? false);
      const frame: BlockFrame = {
        open: i,
        close: token.match,
        isFnBody,
        declaredAsync,
        asyncContext,
      };
      frames.push(frame);
      stack.push(frame);
    } else if (token?.kind === 'close' && token.text === '}') {
      stack.pop();
    }
  }
  return frames;
}

/** The innermost frame containing token `index`, or null at file level. */
function enclosingFrame(frames: readonly BlockFrame[], index: number): BlockFrame | null {
  let found: BlockFrame | null = null;
  for (const frame of frames) {
    if (frame.open < index && index < frame.close) found = frame;
  }
  return found;
}

// ------------------------------------------------------------- the claim set

/** Spawn callees whose returned handle is the only join/cancel path. */
const SPAWN_SECOND_TO_LAST = new Set(['tokio', 'task', 'thread']);
const SPAWN_NAMES = new Set(['spawn', 'spawn_blocking']);

interface SpawnSite {
  readonly name: string;
  readonly callOpen: number;
  readonly pathStart: number;
}

/** Every spawn call site: `tokio::spawn(…)`, `std::thread::spawn(…)`, … */
function spawnSites(tokens: readonly RustToken[]): readonly SpawnSite[] {
  const sites: SpawnSite[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (!isCallName(tokens, i)) continue;
    const token = tokens[i];
    if (token === undefined || token.kind !== 'ident' || token.raw) continue;
    if (!SPAWN_NAMES.has(token.text)) continue;
    const start = pathStart(tokens, i);
    const before = tokens[start - 1];
    // A method call `x.spawn(…)` is not a task spawn: its receiver is an
    // ordinary value (`SubscriptionBridge::spawn`, an iterator method…).
    if (before !== undefined && before.kind === 'punct' && before.text === '.') continue;
    const segments = pathSegments(tokens, i);
    if (segments.length < 2) continue;
    const secondToLast = segments[segments.length - 2] ?? '';
    if (!SPAWN_SECOND_TO_LAST.has(secondToLast)) continue;
    sites.push({ name: segments.join('::'), callOpen: i + 1, pathStart: start });
  }
  return sites;
}

/**
 * A discarded handle: the token before the path is a statement boundary
 * (`;`, `{`, `}` — never `=`, an argument, `return` or a match-arm value),
 * and the token after the call group is `;` (never `.await`, `.join()`,
 * `.abort()` or a tail return).
 */
function isDetached(tokens: readonly RustToken[], site: SpawnSite): boolean {
  const before = tokens[site.pathStart - 1];
  if (before !== undefined) {
    const boundary =
      (before.kind === 'punct' && before.text === ';') ||
      (before.kind === 'open' && before.text === '{') ||
      (before.kind === 'close' && before.text === '}') ||
      (before.kind === 'ident' && before.text === 'else');
    if (!boundary) return false;
  }
  const group = tokens[site.callOpen];
  if (group === undefined || group.kind !== 'open') return false;
  const after = tokens[group.match + 1];
  return after !== undefined && after.kind === 'punct' && after.text === ';';
}

/** Cancellation evidence inside a token range: select!, shutdown/cancel, abort. */
function hasCancellationEvidence(tokens: readonly RustToken[], from: number, to: number): boolean {
  for (let i = from; i <= to; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind !== 'ident' || token.raw) continue;
    if (token.text === 'select' && isPunct(tokens, i + 1, '!')) return true;
    if (/shutdown|cancel/i.test(token.text)) return true;
    if (token.text === 'abort' && isCallName(tokens, i)) return true;
  }
  return false;
}

/**
 * The `loop`/`while` token indices whose span runs to their body's close.
 * `for` is excluded (an iterator bounds it); `while` includes its condition.
 */
function loopKeywords(tokens: readonly RustToken[]): readonly { keyword: number; close: number }[] {
  const found: { keyword: number; close: number }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'ident' || token.raw) continue;
    if (token.text !== 'loop' && token.text !== 'while') continue;
    // `loop` as a type or a method name (`fn loop(`, `.loop(`) is not this.
    if (isCallName(tokens, i)) continue;
    const before = tokens[i - 1];
    if (before !== undefined && before.kind === 'punct' && before.text === '.') continue;
    if (before !== undefined && before.kind === 'ident' && before.text === 'fn') continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const body = tokens[j];
      if (body === undefined) break;
      if (body.kind === 'open' && body.text === '{') {
        found.push({ keyword: i, close: body.match });
        break;
      }
      // A `;` before any `{` (a malformed or non-block construct) ends it.
      if (body.kind === 'punct' && body.text === ';') break;
    }
  }
  return found;
}

/** External I/O entry points whose bound must be local to their statement. */
interface IoSite {
  readonly subject: string;
  readonly anchor: number;
  readonly requiresAsync: boolean;
}

function ioSites(tokens: readonly RustToken[]): readonly IoSite[] {
  const sites: IoSite[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (!isCallName(tokens, i)) continue;
    const token = tokens[i];
    if (token === undefined || token.kind !== 'ident' || token.raw) continue;
    // A method call on a stored value (`.connect(…)`, `.get(…)`) is out of
    // the claim's evidence window: whatever built the receiver — an options
    // builder's `connection_timeout(…)`, a client builder's `.timeout(…)` —
    // is a different statement, so a per-statement scan cannot see the
    // bound and must not claim the call. Only path-form entry points,
    // whose bound has to be local because the primitive is created in the
    // same statement, are named.
    const before = tokens[i - 1];
    if (before !== undefined && before.kind === 'punct' && before.text === '.') continue;
    const segments = pathSegments(tokens, i);
    if (segments.length < 2) continue;
    const last = segments[segments.length - 1] ?? '';
    const secondToLast = segments[segments.length - 2] ?? '';
    if (last === 'connect' && secondToLast === 'TcpStream') {
      sites.push({
        subject: 'TcpStream::connect',
        anchor: pathStart(tokens, i),
        requiresAsync: true,
      });
    } else if (token.text.startsWith('connect') && secondToLast === 'async_nats') {
      sites.push({
        subject: segments.join('::'),
        anchor: pathStart(tokens, i),
        requiresAsync: true,
      });
    } else if (segments.includes('reqwest')) {
      // `reqwest::get(…)` and the client constructors `reqwest::Client::
      // builder(…)` / `reqwest::Client::new(…)`: a client without a
      // `.timeout(…)` leaves every request it issues unbounded.
      if (last === 'get') {
        sites.push({
          subject: segments.join('::'),
          anchor: pathStart(tokens, i),
          requiresAsync: true,
        });
      } else if (secondToLast === 'Client' && (last === 'builder' || last === 'new')) {
        sites.push({
          subject: segments.join('::'),
          anchor: pathStart(tokens, i),
          requiresAsync: false,
        });
      }
    }
  }
  return sites;
}

// ------------------------------------------------------------------ the scan

export function analyzeRustRuntimeSafety(
  input: AdapterInput,
  workspaceRoot = process.cwd(),
): AriaOutput {
  const roots = requireScanRoots(TOOL_ID, input.roots);
  const workspace = containedWorkspace(workspaceRoot);
  const targetSha = input.repo_snapshot?.base_commit_sha ?? null;
  const readPaths = new Set<string>();
  const observations: AdapterObservation[] = [];
  const findings: AdapterFinding[] = [];

  const rootDirs = roots.filter((root) => {
    const entry = workspace.entry(root);
    if (entry === 'refused') {
      throw new Error(`${TOOL_ID}: root is not a contained workspace-relative path: ${root}`);
    }
    return entry === 'directory';
  });
  const candidates = filterFilesBySnapshot(
    rootDirs.flatMap((root) =>
      collectFiles(workspaceRoot, join(workspaceRoot, root), {
        extensions: [...RUST_EXTENSIONS],
        skipDir: cargoTargetDirSkip,
        includeFile: (name, path) => {
          if (!name.endsWith('.rs')) return true;
          const bytes = statSync(path).size;
          if (bytes <= MAX_FILE_BYTES) return true;
          observations.push({
            id: `${TOOL_ID}:skipped:${normalizeWorkspacePath(relative(workspaceRoot, path))}`,
            type: 'rust_runtime_scan_refusal',
            path: normalizeWorkspacePath(relative(workspaceRoot, path)),
            details: { reason: 'file_over_byte_cap', bytes, cap: MAX_FILE_BYTES },
          });
          return false;
        },
      }),
    ),
    workspaceRoot,
    input,
  );
  if (candidates.length > MAX_SOURCE_FILES) {
    throw new Error(
      `${TOOL_ID}: the scan surface holds ${candidates.length} files, above the ${MAX_SOURCE_FILES} file cap`,
    );
  }

  let totalBytes = 0;
  const budgetedRead = (path: string): string => {
    const text = workspace.readFile(path);
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`${TOOL_ID}: the scan passed the ${MAX_TOTAL_BYTES} byte budget`);
    }
    return text;
  };
  const rustIo = {
    exists: (path: string) => workspace.entry(path) !== 'absent',
    allowed: (path: string) =>
      workspace.entry(path) === 'file' && pathAllowedBySnapshot(workspaceRoot, path, input),
    read: budgetedRead,
  };
  const walked = candidates.map((absolute) =>
    normalizeWorkspacePath(relative(workspaceRoot, absolute)),
  );
  const classified = classifyRustWorkspace(
    walked.filter((path) => !isArchivedWorkspacePath(path)),
    rustIo,
  );
  const readBack = new Set(classified.readPaths);
  const dependencyLocks: Record<string, string> = {};
  for (const path of walked) {
    if (!path.endsWith('.lock') || !rustIo.allowed(path) || !rustIo.exists(path)) continue;
    dependencyLocks[path] = sha256(rustIo.read(path));
    readBack.add(path);
  }

  const occurrences = new Map<string, number>();
  const emit = (
    projection: Projection,
    path: string,
    line: number,
    endLine: number,
    snippet: string,
    subject: string,
    message: string,
    remediation: string,
  ): void => {
    const { rule, severity, confidence } = projection;
    const key = [rule, path, rule, snippet.replace(/\s+/g, ' ').trim()].join('\n');
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const fingerprint = sha256(`${key}\n${occurrence}`);
    const at = Math.max(1, line);
    findings.push({
      id: `${TOOL_ID}:${rule}:${path}:${fingerprint.slice(7, 23)}`,
      rule,
      severity,
      path,
      line: at,
      message: `${message} (line ${at})`,
      evidence: [{ path, line: at }],
      confidence,
      owner: SELF,
      owner_rule_id: rule,
      range: { start_line: at, end_line: Math.max(at, endLine) },
      subject,
      remediation,
      target_sha: targetSha,
      fingerprint,
    });
  };

  const parseFailures = classified.issues.parseFailures;
  for (const failure of parseFailures) {
    observations.push({
      id: `${TOOL_ID}:parse-failure:${failure.path}`,
      type: 'rust_runtime_parse_failure',
      path: failure.path,
      details: { line: failure.line, reason: failure.reason },
    });
  }

  const counts = {
    production: 0,
    harness: 0,
    upstream: 0,
    unreached: 0,
  };
  const contextsByPath = new Map<string, RustFileContext>();
  for (const file of classified.files.values()) {
    contextsByPath.set(file.path, file.context);
    counts[file.context] += 1;
    const findingsOfPath = new Map<string, number>();
    if (file.context !== 'production' || !file.lex.ok) {
      observations.push({
        id: `${TOOL_ID}:file:${file.path}`,
        type: 'rust_runtime_file',
        path: file.path,
        details: {
          context: file.context,
          crate: file.crate,
          findings: 0,
          parsed: file.lex.ok,
        },
      });
      continue;
    }
    const tokens = file.lex.tokens;
    const frames = blockFrames(tokens);

    // ------------------------------------------------------ detached_task
    for (const site of spawnSites(tokens)) {
      if (!isDetached(tokens, site)) continue;
      const line = tokens[site.pathStart]?.line ?? 1;
      emit(
        RULES.detached_task,
        file.path,
        line,
        line,
        site.name,
        site.name.split('::').slice(-2).join('::'),
        `\`${site.name}(…)\` runs as a bare statement: the handle it returns is dropped on line ${line}, ` +
          'and with it the only way to join, abort or await the work it started.',
        'Bind the handle (`let handle = …`) and join it, await it, or abort it on shutdown — ' +
          'the runtime never cancels a dropped task for you.',
      );
      findingsOfPath.set('detached_task', (findingsOfPath.get('detached_task') ?? 0) + 1);
    }

    // ------------------------------------------- uncancellable_long_lived_loop
    for (const { keyword, close } of loopKeywords(tokens)) {
      const frame = enclosingFrame(frames, keyword);
      if (frame !== null && !frame.asyncContext) continue;
      if (hasCancellationEvidence(tokens, keyword, close)) continue;
      const kind = tokens[keyword]?.text ?? 'loop';
      const line = tokens[keyword]?.line ?? 1;
      const endLine = tokens[close]?.endLine ?? line;
      emit(
        RULES.uncancellable_long_lived_loop,
        file.path,
        line,
        endLine,
        kind,
        kind,
        `\`${kind}\` at line ${line} runs in async code with no cancellation evidence: ` +
          `no select!, no shutdown or cancellation token, no abort between the keyword and line ${endLine}.`,
        'Give the loop a shutdown path: select! over a shutdown channel or CancellationToken, ' +
          'or check a shutdown flag between iterations.',
      );
      findingsOfPath.set(
        'uncancellable_long_lived_loop',
        (findingsOfPath.get('uncancellable_long_lived_loop') ?? 0) + 1,
      );
    }

    // --------------------------------------- unsafe_without_safety_contract
    // The contract is a comment block whose last line sits directly above
    // the construct: walk the contiguous comment run upwards from line-1
    // (a `SAFETY:` heading can span several `//` lines).
    const commentsByEndLine = new Map<number, (typeof file.lex.comments)[number]>();
    for (const comment of file.lex.comments) {
      if (!commentsByEndLine.has(comment.endLine)) commentsByEndLine.set(comment.endLine, comment);
    }
    const hasSafetyContract = (line: number): boolean => {
      for (let k = line - 1; ; ) {
        const comment = commentsByEndLine.get(k);
        if (comment === undefined) return false;
        if (comment.text.includes('SAFETY:')) return true;
        k = comment.line - 1;
      }
    };
    for (let i = 0; i + 1 < tokens.length; i += 1) {
      if (!isIdent(tokens, i, 'unsafe')) continue;
      const next = tokens[i + 1];
      if (next === undefined) continue;
      const isBlock = next.kind === 'open' && next.text === '{';
      const isImpl = next.kind === 'ident' && next.text === 'impl';
      if (!isBlock && !isImpl) continue;
      const line = tokens[i]?.line ?? 1;
      if (hasSafetyContract(line)) continue;
      const endLine = isBlock ? (tokens[next.match]?.endLine ?? line) : line;
      const subject = isBlock ? 'unsafe block' : 'unsafe impl';
      emit(
        RULES.unsafe_without_safety_contract,
        file.path,
        line,
        endLine,
        subject,
        subject,
        `${subject} at line ${line} carries no \`SAFETY:\` comment on the line directly above it: ` +
          'the invariants that make the unsafe sound are nowhere stated, so no reader or reviewer can check them.',
        'State the invariants as a `// SAFETY:` comment directly above the construct, or remove the unsafe.',
      );
      findingsOfPath.set(
        'unsafe_without_safety_contract',
        (findingsOfPath.get('unsafe_without_safety_contract') ?? 0) + 1,
      );
    }

    // ------------------------------------------------- unbounded_external_io
    for (const site of ioSites(tokens)) {
      if (site.requiresAsync) {
        const frame = enclosingFrame(frames, site.anchor);
        if (frame !== null && !frame.asyncContext) continue;
      }
      if (statementBoundsTimeout(tokens, site.anchor)) continue;
      const line = tokens[site.anchor]?.line ?? 1;
      emit(
        RULES.unbounded_external_io,
        file.path,
        line,
        line,
        site.subject,
        site.subject,
        `\`${site.subject}(…)\` at line ${line} starts external I/O with no timeout in its statement: ` +
          'neither a wrapper (`tokio::time::timeout`, `with_timeout`) nor a builder `.timeout(…)`. ' +
          'A peer that never answers parks this await forever.',
        'Wrap the call in `tokio::time::timeout(…)` (or the codebase `with_timeout` helper), ' +
          'or configure the timeout on the client builder this call uses.',
      );
      findingsOfPath.set(
        'unbounded_external_io',
        (findingsOfPath.get('unbounded_external_io') ?? 0) + 1,
      );
    }

    observations.push({
      id: `${TOOL_ID}:file:${file.path}`,
      type: 'rust_runtime_file',
      path: file.path,
      details: {
        context: file.context,
        crate: file.crate,
        findings: [...findingsOfPath.values()].reduce((a, b) => a + b, 0),
        parsed: true,
      },
    });
  }

  for (const path of readBack) readPaths.add(path);

  // ------------------------------------------------------------ provenance
  const authorities: Record<string, string | null> = {};
  for (const path of AUTHORITY_PATHS) {
    if (workspace.entry(path) === 'file' && pathAllowedBySnapshot(workspaceRoot, path, input)) {
      authorities[path] = sha256(workspace.readFile(path));
      readPaths.add(path);
    } else {
      authorities[path] = null;
    }
  }

  const findingCounts: Record<string, number> = {};
  for (const finding of findings)
    findingCounts[finding.rule] = (findingCounts[finding.rule] ?? 0) + 1;
  observations.push({
    id: `${TOOL_ID}:summary`,
    type: 'rust_runtime_summary',
    details: {
      files: classified.files.size,
      production_files: counts.production,
      harness_files: counts.harness,
      upstream_files: counts.upstream,
      unreached_files: counts.unreached,
      crates: classified.crates.length,
      module_issues: classified.issues.moduleIssues.length,
      unclassified_targets: classified.issues.unclassifiedTargets.length,
      refused: classified.issues.refused,
      parse_failures: parseFailures.length,
      clean:
        parseFailures.length === 0 &&
        classified.issues.unclassifiedTargets.length === 0 &&
        classified.issues.refused.length === 0,
      findings: findingCounts,
      bytes_read: totalBytes,
      dependency_locks: dependencyLocks,
      authorities,
      authorities_complete: Object.values(authorities).every((hash) => hash !== null),
      target_sha: targetSha,
    },
  });

  const sortedReadPaths = [...readPaths].sort();
  return {
    observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
    read_paths: sortedReadPaths,
    evidence_sources: sortedReadPaths,
    belief_candidates: [],
    cost_units: sortedReadPaths.length,
    metadata: { scanMode: 'rust_runtime_safety_v1', authorities },
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
  const rawInput = await readStdin();
  const input = rawInput.trim().length > 0 ? (JSON.parse(rawInput) as AdapterInput) : {};
  process.stdout.write(`${JSON.stringify(analyzeRustRuntimeSafety(input))}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
