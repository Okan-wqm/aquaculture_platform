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
//     A long-lived `loop` or `while` in async code (an async fn's body, an
//     async block): its span — keyword to the loop body's closing brace —
//     holds an `.await`, so it waits on the executor, and nothing ends it.
//     No cancellation evidence in the span: no `select!`, no identifier
//     naming shutdown or cancellation (`shutdown_rx`, `CancellationToken`,
//     …), no `abort`. Nothing bounds its rounds: the `while` condition names
//     no deadline the loop never moves and is no `while let Ok(…)` over a
//     timeout call (an elapsed wait ends that `while`); and not every round
//     that goes around again passes an exit check (an `if` one branch of
//     which leaves the loop on every path) on such a deadline, or a counter
//     the loop only advances, advanced and checked against a fixed cap. A
//     check one `match` arm or one branch holds, or one a `continue` skips,
//     bounds only the rounds that reach it. No timeout call takes the async
//     block it runs in as an argument (`tokio::time::timeout(d, async { …
//     })`). And it is not the handler of a `select!` arm whose future names
//     shutdown or cancellation: that drain runs once the task has observed
//     the shutdown. A loop no `.await` drives (a parse, a `try_recv` drain)
//     and a sync loop never wait on the executor; `for` is out: an iterator
//     bounds it.
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
// claimed; inside a production file, nothing in the spans the one reader's
// testSpans marks (its own `#[cfg(test)]` items, `#[test]` fns,
// `macro_rules!` templates) is claimed. Bounds: files, bytes per file, total
// bytes and cost units are capped, and a cap that fires is an observation,
// never a hole.
import { createHash } from 'node:crypto';
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
  workspaceFileBytes,
} from './adapter-fs';
import { cargoTargetDirSkip } from './rust-cargo';
import {
  classifyRustWorkspace,
  type RustFileContext,
  type RustToken,
  type RustWorkspaceIo,
  testSpans,
  workspaceRustIo,
} from './rust-source';

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
/**
 * A single `.rs` file above this is refused with an observation and never
 * read, on every path the reader reaches it by: the walk, a `mod`
 * declaration, a `#[path]`. The cap is decided in the read gate
 * (`withinFileByteCap`), not in the walk.
 */
const MAX_FILE_BYTES = 2_000_000;
/** The whole scan stops (throws) past this: a budget is a refusal, not a hole. */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const RUST_EXTENSIONS = ['.rs', '.toml', '.lock'] as const;

interface AdapterInput {
  readonly roots?: readonly string[];
  readonly repo_snapshot?: RepoSnapshot & { readonly base_commit_sha?: string | null };
}

/** Every claim cites the line it is about: the evidence line is never absent. */
interface EvidenceRef {
  readonly path: string;
  readonly line: number;
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

/**
 * Whether tokens `from..to` (inclusive) name a call with `timeout` in it:
 * `tokio::time::timeout(`, `timeout_at(`, `with_timeout(`, `.timeout(`,
 * `connection_timeout(`. The one timeout vocabulary of both the I/O and the
 * loop rule.
 */
function namesTimeoutCall(tokens: readonly RustToken[], from: number, to: number): boolean {
  for (let j = from; j <= to; j += 1) {
    const token = tokens[j];
    if (token === undefined) continue;
    if (token.kind === 'ident' && /timeout/i.test(token.text) && isCallName(tokens, j)) return true;
  }
  return false;
}

/** Whether the statement around `anchor` names a call with `timeout` in it. */
function statementBoundsTimeout(tokens: readonly RustToken[], anchor: number): boolean {
  const { start, end } = statementSpan(tokens, anchor);
  return namesTimeoutCall(tokens, start, end);
}

/** A delimited group: its open token's index, its partner's index and its symbol. */
interface TokenGroup {
  readonly open: number;
  readonly close: number;
  readonly text: string;
}

/**
 * The innermost group enclosing token `index`, or null at file level.
 * Walking back jumps over every balanced group that closes before `index`,
 * so the first open token reached is one `index` sits inside.
 */
function enclosingGroup(tokens: readonly RustToken[], index: number): TokenGroup | null {
  for (let j = index - 1; j >= 0; j -= 1) {
    const token = tokens[j];
    if (token === undefined) return null;
    if (token.kind === 'close') j = token.match;
    else if (token.kind === 'open') return { open: j, close: token.match, text: token.text };
  }
  return null;
}

/** The groups enclosing token `index`, innermost first. */
function enclosingGroups(tokens: readonly RustToken[], index: number): TokenGroup[] {
  const groups: TokenGroup[] = [];
  for (
    let group = enclosingGroup(tokens, index);
    group !== null;
    group = enclosingGroup(tokens, group.open)
  ) {
    groups.push(group);
  }
  return groups;
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
 * A `loop`, `while` or `for`: its keyword, the `{` that opens its body,
 * that body's `}` and the loop's label (`'outer`), if any. The span runs
 * keyword to close; a `while` condition or a `for` head sits between the
 * keyword and the body.
 */
interface LoopSite {
  readonly kind: 'loop' | 'while' | 'for';
  readonly keyword: number;
  readonly open: number;
  readonly close: number;
  readonly label: string | null;
}

function isLoopKind(text: string): text is LoopSite['kind'] {
  return text === 'loop' || text === 'while' || text === 'for';
}

/**
 * The `{` that opens the block of the `if` / `while` / `match` / `for` /
 * `loop` keyword at `keyword`: the first `{` at its own level after it. The
 * `(…)` / `[…]` groups between are skipped (a closure argument's braces sit
 * in them), and so are a `let` pattern up to its `=` and a `for` pattern up
 * to `in`, because a struct pattern (`let Frame { id, .. } = …`) holds
 * braces. Null when a `;` or the enclosing group's close comes first.
 */
function blockOpenAfter(tokens: readonly RustToken[], keyword: number): number | null {
  let inPattern = isIdent(tokens, keyword, 'for');
  for (let j = keyword + 1; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (token === undefined) return null;
    if (token.kind === 'open') {
      if (token.text === '{' && !inPattern) return j;
      j = token.match;
      continue;
    }
    if (token.kind === 'close' || (token.kind === 'punct' && token.text === ';')) return null;
    if (isIdent(tokens, j, 'let')) inPattern = true;
    else if (inPattern && (isPunct(tokens, j, '=') || isIdent(tokens, j, 'in'))) inPattern = false;
  }
  return null;
}

/**
 * Every `loop`, `while` and `for` expression. Only `loop`/`while` can be
 * claimed (an iterator bounds a `for`); every kind is a loop that a
 * `continue` in its body goes around. A `for` counts only where an
 * expression starts (after `;`, `{`, `}`, `=>` or a label's `:`), never
 * `impl Trait for Type` or a `for<'a>` bound.
 */
function loopSites(tokens: readonly RustToken[]): readonly LoopSite[] {
  const found: LoopSite[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.kind !== 'ident' || token.raw) continue;
    const kind = token.text;
    if (!isLoopKind(kind)) continue;
    // `loop` as a type or a method name (`fn loop(`, `.loop(`) is not this.
    if (isCallName(tokens, i)) continue;
    const before = tokens[i - 1];
    if (before !== undefined && before.kind === 'punct' && before.text === '.') continue;
    if (before !== undefined && before.kind === 'ident' && before.text === 'fn') continue;
    if (kind === 'for') {
      if (isPunct(tokens, i + 1, '<')) continue;
      const startsExpression =
        before === undefined ||
        (before.kind === 'punct' && [';', '=>', ':'].includes(before.text)) ||
        (before.kind === 'open' && before.text === '{') ||
        (before.kind === 'close' && before.text === '}');
      if (!startsExpression) continue;
    }
    const open = blockOpenAfter(tokens, i);
    const body = open === null ? undefined : tokens[open];
    if (open === null || body === undefined) continue;
    const labelToken = tokens[i - 2];
    const label =
      isPunct(tokens, i - 1, ':') && labelToken !== undefined && labelToken.kind === 'lifetime'
        ? labelToken.text
        : null;
    found.push({ kind, keyword: i, open, close: body.match, label });
  }
  return found;
}

/**
 * The first `.await` in the loop's span, or null. A loop with none never
 * yields to the executor: it is a computation over values already in hand
 * (a parse, a `try_recv` drain), not a wait that can outlive shutdown.
 */
function firstAwait(tokens: readonly RustToken[], loop: LoopSite): number | null {
  for (let j = loop.keyword + 1; j < loop.close; j += 1) {
    if (isIdent(tokens, j, 'await') && isPunct(tokens, j - 1, '.')) return j;
  }
  return null;
}

/** Compound-assignment operators: `name <op>= …` (the lexer joins no `=` pair). */
const COMPOUND_ASSIGNMENT = new Set(['+', '-', '*', '/', '%', '&', '|', '^']);

/**
 * What the occurrence of `name` at token `j` does to it: `advance` adds to
 * it (`name += …`, `name = name + …`, `name = name.saturating_add(…)`),
 * `other` binds or assigns it any other way (`let name`, `let mut name`,
 * `name = …`, `name -= …`), `none` only reads it (`name == …` and `name >= …`
 * are comparisons: the lexer joins no `=` pair).
 */
function writeOf(
  tokens: readonly RustToken[],
  j: number,
  name: string,
): 'advance' | 'other' | 'none' {
  if (
    isIdent(tokens, j - 1, 'let') ||
    (isIdent(tokens, j - 1, 'mut') && isIdent(tokens, j - 2, 'let'))
  ) {
    return 'other';
  }
  const operator = tokens[j + 1];
  if (operator === undefined || operator.kind !== 'punct') return 'none';
  if (COMPOUND_ASSIGNMENT.has(operator.text) && isPunct(tokens, j + 2, '=')) {
    return operator.text === '+' ? 'advance' : 'other';
  }
  if (operator.text !== '=' || isPunct(tokens, j + 2, '=')) return 'none';
  if (!isIdent(tokens, j + 2, name)) return 'other';
  if (isPunct(tokens, j + 3, '+')) return 'advance';
  const method = tokens[j + 4];
  return isPunct(tokens, j + 3, '.') &&
    method !== undefined &&
    method.kind === 'ident' &&
    /^(saturating_|wrapping_|checked_)?add$/.test(method.text) &&
    isCallName(tokens, j + 4)
    ? 'advance'
    : 'other';
}

/** The writes the loop's span makes to `name`. */
function loopWrites(
  tokens: readonly RustToken[],
  loop: LoopSite,
  name: string,
): ReadonlySet<'advance' | 'other'> {
  const writes = new Set<'advance' | 'other'>();
  for (let j = loop.keyword; j <= loop.close; j += 1) {
    if (!isIdent(tokens, j, name)) continue;
    const write = writeOf(tokens, j, name);
    if (write !== 'none') writes.add(write);
  }
  return writes;
}

/**
 * Whether the loop's span binds or assigns `name` at all: a deadline or cap
 * the loop moves on every round bounds one wait, never the loop.
 */
function loopMoves(tokens: readonly RustToken[], loop: LoopSite, name: string): boolean {
  return loopWrites(tokens, loop, name).size > 0;
}

/**
 * Whether the loop only ever advances `name` by addition: a counter that
 * grows every time it is written and is never reset.
 */
function loopAdvances(tokens: readonly RustToken[], loop: LoopSite, name: string): boolean {
  const writes = loopWrites(tokens, loop, name);
  return writes.has('advance') && !writes.has('other');
}

/**
 * Whether tokens `from..to` name a deadline (an identifier with `deadline`
 * in it) the loop never moves.
 */
function namesFixedDeadline(
  tokens: readonly RustToken[],
  loop: LoopSite,
  from: number,
  to: number,
): boolean {
  for (let j = from; j <= to; j += 1) {
    const token = tokens[j];
    if (token === undefined || token.kind !== 'ident' || token.raw) continue;
    if (/deadline/i.test(token.text) && !loopMoves(tokens, loop, token.text)) return true;
  }
  return false;
}

/**
 * The counters tokens `from..to` compare with a cap the loop never moves,
 * where the loop only ever advances the counter: `n >= CAP` / `n > CAP`
 * (`operator` `>`, true once the cap is reached) or `n < CAP` / `n <= CAP`
 * (`operator` `<`, true while it is not). The cap is a number or a plain
 * path (`MAX_RETRIES`, `Self::MAX`, `max_chunks`); a call or field read
 * (`frame.len()`) is a value the loop may change.
 */
function cappedCounters(
  tokens: readonly RustToken[],
  loop: LoopSite,
  from: number,
  to: number,
  operator: '<' | '>',
): readonly string[] {
  const counters: string[] = [];
  for (let j = from; j + 2 <= to; j += 1) {
    const counter = tokens[j];
    if (counter === undefined || counter.kind !== 'ident' || counter.raw) continue;
    if (!isPunct(tokens, j + 1, operator)) continue;
    const capStart = isPunct(tokens, j + 2, '=') ? j + 3 : j + 2;
    const cap = tokens[capStart];
    if (cap === undefined || capStart > to) continue;
    let capEnd = capStart;
    if (cap.kind === 'ident') {
      while (isPunct(tokens, capEnd + 1, '::') && tokens[capEnd + 2]?.kind === 'ident') capEnd += 2;
    } else if (cap.kind !== 'literal' || cap.literal !== 'number') {
      continue;
    }
    if (isPunct(tokens, capEnd + 1, '.') || isPunct(tokens, capEnd + 1, '(')) continue;
    const capName = tokens[capEnd];
    const capFixed =
      capName !== undefined &&
      (capName.kind === 'literal' || !loopMoves(tokens, loop, capName.text));
    if (capFixed && loopAdvances(tokens, loop, counter.text)) counters.push(counter.text);
  }
  return counters;
}

// ------------------------------------------- what every round of a loop passes
//
// A deadline or counter check bounds a loop only when every round that goes
// around again passes it: a check in one branch of a `match`, or behind a
// `continue`, leaves the other rounds unbounded (an error counter that only
// the error arm advances never ends a loop whose receives succeed). The
// round walk reads the loop body statement by statement, branch by branch,
// and carries what every path has passed.

/** One `if` / `else if` of a chain: its condition and its block. */
interface IfLink {
  readonly condition: { readonly from: number; readonly to: number };
  readonly open: number;
  readonly close: number;
}

/**
 * One statement-level construct of a run of loop-body tokens. `leave` is a
 * `break` or `return`; `block` a block every path runs (`optional`: a
 * `let … else` block, which one path runs); `opaque` a group the walk does
 * not enter (a nested loop's body, a closure, an async block, a macro's
 * tokens, call arguments); `advance` an addition to a counter.
 */
type BodyItem =
  | { readonly kind: 'leave' }
  | { readonly kind: 'continue'; readonly at: number }
  | { readonly kind: 'advance'; readonly name: string }
  | {
      readonly kind: 'block';
      readonly open: number;
      readonly close: number;
      readonly optional: boolean;
    }
  | { readonly kind: 'opaque'; readonly open: number; readonly close: number }
  | {
      readonly kind: 'if';
      readonly from: number;
      readonly to: number;
      readonly links: readonly IfLink[];
      readonly otherwise: { readonly open: number; readonly close: number } | null;
    }
  | {
      readonly kind: 'match';
      readonly from: number;
      readonly to: number;
      readonly arms: readonly { readonly from: number; readonly to: number }[];
    };

/**
 * Whether the `{` at `index` opens a block statement or block expression the
 * walk enters: it follows a statement boundary (`;`, `{`, `}`, `=>`), an `=`
 * or `unsafe`. After any other token it is a loop body, a closure, an async
 * block, a struct literal, a macro's tokens or a labeled block, all opaque.
 */
function opensBlock(tokens: readonly RustToken[], index: number): boolean {
  const before = tokens[index - 1];
  if (before === undefined) return true;
  if (before.kind === 'open' || before.kind === 'close')
    return before.text === '{' || before.text === '}';
  if (before.kind === 'punct') return [';', '=', '=>'].includes(before.text);
  return before.kind === 'ident' && !before.raw && before.text === 'unsafe';
}

/** The `if … else if … else …` chain at `start`, and its last token. */
function ifChainAt(
  tokens: readonly RustToken[],
  start: number,
): { readonly item: BodyItem & { readonly kind: 'if' }; readonly end: number } | null {
  const links: IfLink[] = [];
  for (let at = start; ; ) {
    const open = blockOpenAfter(tokens, at);
    const block = open === null ? undefined : tokens[open];
    if (open === null || block === undefined) return null;
    links.push({ condition: { from: at + 1, to: open - 1 }, open, close: block.match });
    if (!isIdent(tokens, block.match + 1, 'else')) {
      return {
        item: { kind: 'if', from: start, to: block.match, links, otherwise: null },
        end: block.match,
      };
    }
    if (isIdent(tokens, block.match + 2, 'if')) {
      at = block.match + 2;
      continue;
    }
    const otherwise = tokens[block.match + 2];
    if (otherwise === undefined || otherwise.kind !== 'open' || otherwise.text !== '{') return null;
    return {
      item: {
        kind: 'if',
        from: start,
        to: otherwise.match,
        links,
        otherwise: { open: block.match + 2, close: otherwise.match },
      },
      end: otherwise.match,
    };
  }
}

/**
 * The last token of a block-like expression at `start` (`{ … }`, `if`,
 * `match`, `loop`, `while`, `for`, `unsafe { … }`), or null when `start`
 * opens none. A match arm whose body is one needs no `,` after it.
 */
function blockLikeEnd(tokens: readonly RustToken[], start: number): number | null {
  const token = tokens[start];
  if (token === undefined) return null;
  if (token.kind === 'open' && token.text === '{') return token.match;
  if (isIdent(tokens, start, 'if')) {
    const chain = ifChainAt(tokens, start);
    return chain === null ? null : chain.end;
  }
  if (isIdent(tokens, start, 'unsafe')) return blockLikeEnd(tokens, start + 1);
  if (!['match', 'loop', 'while', 'for'].some((keyword) => isIdent(tokens, start, keyword))) {
    return null;
  }
  const open = blockOpenAfter(tokens, start);
  const block = open === null ? undefined : tokens[open];
  return block === undefined ? null : block.match;
}

/** The arms of the `match` at `start` (each arm's body as a token range), and its last token. */
function matchAt(
  tokens: readonly RustToken[],
  start: number,
): { readonly item: BodyItem & { readonly kind: 'match' }; readonly end: number } | null {
  const open = blockOpenAfter(tokens, start);
  const body = open === null ? undefined : tokens[open];
  if (open === null || body === undefined) return null;
  const arms: { from: number; to: number }[] = [];
  for (let j = open + 1; j < body.match; ) {
    // The arm's `=>`: its pattern and any `if` guard sit before it.
    let arrow = -1;
    for (let k = j; k < body.match; k += 1) {
      const token = tokens[k];
      if (token === undefined) break;
      if (token.kind === 'open') {
        k = token.match;
        continue;
      }
      if (isPunct(tokens, k, '=>')) {
        arrow = k;
        break;
      }
    }
    if (arrow < 0) break;
    const from = arrow + 1;
    // A block-like body ends at its block unless `.` or `?` continues it;
    // any other body ends before the `,` that separates it from the next arm.
    let to = blockLikeEnd(tokens, from);
    if (to === null || isPunct(tokens, to + 1, '.') || isPunct(tokens, to + 1, '?')) {
      to = body.match - 1;
      for (let k = from; k < body.match; k += 1) {
        const token = tokens[k];
        if (token === undefined) break;
        if (token.kind === 'open') {
          k = token.match;
          continue;
        }
        if (isPunct(tokens, k, ',')) {
          to = k - 1;
          break;
        }
      }
    }
    arms.push({ from, to });
    j = isPunct(tokens, to + 1, ',') ? to + 2 : to + 1;
  }
  return { item: { kind: 'match', from: start, to: body.match, arms }, end: body.match };
}

/** The statement-level constructs of tokens `from..to` (inclusive). */
function bodyItems(tokens: readonly RustToken[], from: number, to: number): readonly BodyItem[] {
  const items: BodyItem[] = [];
  for (let j = from; j <= to; j += 1) {
    const token = tokens[j];
    if (token === undefined) break;
    if (token.kind === 'open') {
      if (token.text === '{' && (j === from || opensBlock(tokens, j))) {
        items.push({ kind: 'block', open: j, close: token.match, optional: false });
      } else if (token.text === '{' && isIdent(tokens, j - 1, 'else')) {
        items.push({ kind: 'block', open: j, close: token.match, optional: true });
      } else {
        items.push({ kind: 'opaque', open: j, close: token.match });
      }
      j = token.match;
      continue;
    }
    if (token.kind !== 'ident' || token.raw) continue;
    if (token.text === 'break' || token.text === 'return') {
      items.push({ kind: 'leave' });
    } else if (token.text === 'continue') {
      items.push({ kind: 'continue', at: j });
    } else if (token.text === 'if' || token.text === 'match') {
      const construct = token.text === 'if' ? ifChainAt(tokens, j) : matchAt(tokens, j);
      if (construct === null) continue;
      items.push(construct.item);
      j = construct.end;
    } else if (writeOf(tokens, j, token.text) === 'advance') {
      items.push({ kind: 'advance', name: token.text });
    }
  }
  return items;
}

/**
 * What every path through part of a loop body has passed. `bounded`: a
 * complete bound — an exit check on a fixed deadline, or a capped counter's
 * advance and its exit check. `advanced` / `checked`: the counters every path
 * has advanced / passed the exit check of.
 */
interface RoundState {
  readonly bounded: boolean;
  readonly advanced: ReadonlySet<string>;
  readonly checked: ReadonlySet<string>;
}

/**
 * Where the paths through a run of loop-body tokens go. `live`: the state of
 * the paths that reach the run's end, null when none does (each left the
 * loop or went around it). `leaked`: some path went around the loop again (a
 * `continue`) before it passed a bound.
 */
interface RoundFlow {
  readonly live: RoundState | null;
  readonly leaked: boolean;
}

/** The facts two sets of paths share. */
function meet(a: RoundState, b: RoundState): RoundState {
  return {
    bounded: a.bounded && b.bounded,
    advanced: new Set([...a.advanced].filter((name) => b.advanced.has(name))),
    checked: new Set([...a.checked].filter((name) => b.checked.has(name))),
  };
}

/** The paths of several flows together: a fact holds after them when it holds on each. */
function mergeFlows(flows: readonly RoundFlow[]): RoundFlow {
  let live: RoundState | null = null;
  let leaked = false;
  for (const flow of flows) {
    leaked = leaked || flow.leaked;
    if (flow.live !== null) live = live === null ? flow.live : meet(live, flow.live);
  }
  return { live, leaked };
}

function withAdvance(state: RoundState, name: string): RoundState {
  return {
    bounded: state.bounded || state.checked.has(name),
    advanced: new Set([...state.advanced, name]),
    checked: state.checked,
  };
}

function withCheck(state: RoundState, name: string): RoundState {
  return {
    bounded: state.bounded || state.advanced.has(name),
    advanced: state.advanced,
    checked: new Set([...state.checked, name]),
  };
}

/** One loop's round walk: its tokens, the `continue`s that go around it, and memoized runs. */
interface RoundWalk {
  readonly tokens: readonly RustToken[];
  readonly loop: LoopSite;
  readonly continues: ReadonlySet<number>;
  readonly items: Map<number, readonly BodyItem[]>;
  readonly leaves: Map<number, boolean>;
}

/**
 * The `continue` tokens in the loop's body that go around this loop: the
 * innermost loop around an unlabeled `continue`, or the innermost one with
 * the label a labeled `continue` names, is this one.
 */
function continuesOf(
  tokens: readonly RustToken[],
  loops: readonly LoopSite[],
  loop: LoopSite,
): ReadonlySet<number> {
  const found = new Set<number>();
  for (let j = loop.open + 1; j < loop.close; j += 1) {
    if (!isIdent(tokens, j, 'continue')) continue;
    const labelToken = tokens[j + 1];
    const label =
      labelToken !== undefined && labelToken.kind === 'lifetime' ? labelToken.text : null;
    let target: LoopSite | null = null;
    for (const candidate of loops) {
      if (!(candidate.open < j && j < candidate.close)) continue;
      if (label !== null && candidate.label !== label) continue;
      if (target === null || candidate.open > target.open) target = candidate;
    }
    if (target !== null && target.keyword === loop.keyword) found.add(j);
  }
  return found;
}

function itemsOf(walk: RoundWalk, from: number, to: number): readonly BodyItem[] {
  const known = walk.items.get(from);
  if (known !== undefined) return known;
  const items = bodyItems(walk.tokens, from, to);
  walk.items.set(from, items);
  return items;
}

/** Whether a `continue` that goes around this loop sits inside tokens `start..end`. */
function holdsContinue(walk: RoundWalk, start: number, end: number): boolean {
  return [...walk.continues].some((at) => start < at && at < end);
}

/**
 * Whether every path through tokens `from..to` leaves the loop (`break`,
 * `return`, a `continue` to an outer loop) before it reaches the run's end
 * or goes around this loop again. A construct holding a `continue` that goes
 * around this loop leaves on no path the walk can vouch for.
 */
function leavesEveryPath(walk: RoundWalk, from: number, to: number): boolean {
  const known = walk.leaves.get(from);
  if (known !== undefined) return known;
  let leaves = false;
  for (const item of itemsOf(walk, from, to)) {
    if (item.kind === 'leave' || item.kind === 'continue') {
      leaves = item.kind === 'leave' || !walk.continues.has(item.at);
      break;
    }
    if (item.kind === 'advance') continue;
    const span =
      item.kind === 'block' || item.kind === 'opaque'
        ? { start: item.open, end: item.close }
        : { start: item.from, end: item.to };
    if (holdsContinue(walk, span.start, span.end)) break;
    if (item.kind === 'block' && !item.optional) {
      leaves = leavesEveryPath(walk, item.open + 1, item.close - 1);
    } else if (item.kind === 'if' && item.otherwise !== null) {
      const { otherwise } = item;
      leaves =
        item.links.every((link) => leavesEveryPath(walk, link.open + 1, link.close - 1)) &&
        leavesEveryPath(walk, otherwise.open + 1, otherwise.close - 1);
    } else if (item.kind === 'match') {
      leaves =
        item.arms.length > 0 && item.arms.every((arm) => leavesEveryPath(walk, arm.from, arm.to));
    }
    if (leaves) break;
  }
  walk.leaves.set(from, leaves);
  return leaves;
}

/**
 * The state on the branch of an `if` that stays in the loop, once the other
 * branch leaves it on every path: a condition on a fixed deadline completes
 * a bound, and a condition on a capped counter is its exit check — `n >= CAP`
 * (`>`) when the `if` block leaves, `n < CAP` (`<`) when the `else` does.
 */
function passedExitCheck(
  walk: RoundWalk,
  state: RoundState,
  link: IfLink,
  operator: '<' | '>',
): RoundState {
  const { tokens, loop } = walk;
  const { from, to } = link.condition;
  let next = namesFixedDeadline(tokens, loop, from, to) ? { ...state, bounded: true } : state;
  for (const name of cappedCounters(tokens, loop, from, to, operator)) next = withCheck(next, name);
  return next;
}

/** The paths through tokens `from..to` from `entry`, statement by statement. */
function walkRun(walk: RoundWalk, from: number, to: number, entry: RoundState): RoundFlow {
  let state = entry;
  let leaked = false;
  for (const item of itemsOf(walk, from, to)) {
    let flow: RoundFlow;
    switch (item.kind) {
      case 'leave':
        return { live: null, leaked };
      case 'continue':
        return { live: null, leaked: leaked || (walk.continues.has(item.at) && !state.bounded) };
      case 'advance':
        state = withAdvance(state, item.name);
        continue;
      case 'opaque': {
        // Its tokens are not walked, so its `break`s are not counted; a
        // `continue` in it that goes around this loop is a round that may
        // not have passed a bound.
        leaked = leaked || (holdsContinue(walk, item.open, item.close) && !state.bounded);
        continue;
      }
      case 'block': {
        const inner = walkRun(walk, item.open + 1, item.close - 1, state);
        flow = item.optional ? mergeFlows([inner, { live: state, leaked: false }]) : inner;
        break;
      }
      case 'if': {
        const flows: RoundFlow[] = [];
        let rest = state;
        for (const [index, link] of item.links.entries()) {
          // Only the last link has the chain's `else`; an earlier link's
          // else is the next `else if`.
          const otherwise = index === item.links.length - 1 ? item.otherwise : null;
          const thenLeaves = leavesEveryPath(walk, link.open + 1, link.close - 1);
          const elseLeaves =
            otherwise !== null && leavesEveryPath(walk, otherwise.open + 1, otherwise.close - 1);
          const thenEntry = elseLeaves ? passedExitCheck(walk, rest, link, '<') : rest;
          rest = thenLeaves ? passedExitCheck(walk, rest, link, '>') : rest;
          flows.push(walkRun(walk, link.open + 1, link.close - 1, thenEntry));
          if (otherwise !== null) {
            flows.push(walkRun(walk, otherwise.open + 1, otherwise.close - 1, rest));
          }
        }
        // No `else`: the paths that took no block go on with the checks they passed.
        if (item.otherwise === null) flows.push({ live: rest, leaked: false });
        flow = mergeFlows(flows);
        break;
      }
      case 'match':
        flow = mergeFlows(item.arms.map((arm) => walkRun(walk, arm.from, arm.to, state)));
        break;
    }
    leaked = leaked || flow.leaked;
    if (flow.live === null) return { live: null, leaked };
    state = flow.live;
  }
  return { live: state, leaked };
}

/**
 * Whether the loop's rounds are bounded, by time or by count. Its `while`
 * condition names a fixed deadline, or is a `while let Ok(…)` over a timeout
 * call (an elapsed wait ends the `while`); or every round that goes around
 * again passes a bound: an exit check on a fixed deadline (an `if` one of
 * whose branches leaves the loop on every path), or a counter the loop only
 * advances — advanced, and checked against a fixed cap in the `while`
 * condition or in such an exit check.
 */
function exitBounded(
  tokens: readonly RustToken[],
  loops: readonly LoopSite[],
  loop: LoopSite,
): boolean {
  let entry: RoundState = { bounded: false, advanced: new Set(), checked: new Set() };
  if (loop.kind === 'while') {
    const from = loop.keyword + 1;
    const to = loop.open - 1;
    const elapsedEnds =
      isIdent(tokens, from, 'let') &&
      isIdent(tokens, from + 1, 'Ok') &&
      namesTimeoutCall(tokens, from, to);
    if (elapsedEnds || namesFixedDeadline(tokens, loop, from, to)) return true;
    for (const name of cappedCounters(tokens, loop, from, to, '<')) entry = withCheck(entry, name);
  }
  const walk: RoundWalk = {
    tokens,
    loop,
    continues: continuesOf(tokens, loops, loop),
    items: new Map(),
    leaves: new Map(),
  };
  const flow = walkRun(walk, loop.open + 1, loop.close - 1, entry);
  return !flow.leaked && (flow.live === null || flow.live.bounded);
}

/**
 * Whether the loop runs whole inside a timeout: the nearest async block
 * around it (no fn body between) is an argument of a timeout call
 * (`tokio::time::timeout(d, async { … })`), which ends that future and the
 * loop in it.
 */
function runsInsideTimeout(
  tokens: readonly RustToken[],
  frameByOpen: ReadonlyMap<number, BlockFrame>,
  loop: LoopSite,
): boolean {
  for (const group of enclosingGroups(tokens, loop.keyword)) {
    const frame = frameByOpen.get(group.open);
    if (frame === undefined) continue;
    if (frame.isFnBody) return false;
    if (!frame.declaredAsync) continue;
    const asyncKeyword = isIdent(tokens, group.open - 1, 'move') ? group.open - 2 : group.open - 1;
    const call = enclosingGroup(tokens, asyncKeyword);
    return (
      call !== null && call.text === '(' && namesTimeoutCall(tokens, call.open - 1, call.open - 1)
    );
  }
  return false;
}

/**
 * The future (`pattern = future`, before any `, if precondition`) of the arm
 * of the `select!` body `select` whose handler holds token `index`, or null
 * (an `else =>` arm has none).
 */
function selectArmFuture(
  tokens: readonly RustToken[],
  select: TokenGroup,
  index: number,
): { readonly start: number; readonly end: number } | null {
  const { open, close } = select;
  let armStart = open + 1;
  for (let j = open + 1; j < close; j += 1) {
    const token = tokens[j];
    if (token === undefined) return null;
    if (token.kind === 'open') {
      j = token.match;
      continue;
    }
    // `biased;`, and the `,` that separates one arm from the next (a `,`
    // inside a header belongs to its `, if precondition`).
    if (isPunct(tokens, j, ';') || (isPunct(tokens, j, ',') && j === armStart)) {
      armStart = j + 1;
      continue;
    }
    if (!isPunct(tokens, j, '=>')) continue;
    const handler = tokens[j + 1];
    let handlerEnd = close - 1;
    if (handler !== undefined && handler.kind === 'open' && handler.text === '{') {
      handlerEnd = handler.match;
    } else {
      for (let k = j + 1; k < close; k += 1) {
        const inner = tokens[k];
        if (inner === undefined) break;
        if (inner.kind === 'open') {
          k = inner.match;
          continue;
        }
        if (isPunct(tokens, k, ',')) {
          handlerEnd = k - 1;
          break;
        }
      }
    }
    if (j < index && index <= handlerEnd) {
      // The header's own-level `=` ends the pattern (a pattern holds none);
      // its own-level `,` starts the precondition.
      let assign = -1;
      let end = j - 1;
      for (let k = armStart; k < j; k += 1) {
        const inner = tokens[k];
        if (inner === undefined) break;
        if (inner.kind === 'open') {
          k = inner.match;
          continue;
        }
        if (assign < 0 && isPunct(tokens, k, '=')) assign = k;
        else if (assign >= 0 && isPunct(tokens, k, ',')) {
          end = k - 1;
          break;
        }
      }
      return assign < 0 ? null : { start: assign + 1, end };
    }
    j = handlerEnd;
    armStart = handlerEnd + 1;
  }
  return null;
}

/**
 * Whether the loop is the handler of a `select!` arm whose future names
 * shutdown or cancellation (no async block or fn body between): it runs once
 * the task has observed the shutdown, as that shutdown's drain, so it is the
 * shutdown path rather than a loop that never observes one. A pattern or a
 * precondition naming shutdown does not make a data arm the shutdown arm.
 */
function inShutdownArm(
  tokens: readonly RustToken[],
  frameByOpen: ReadonlyMap<number, BlockFrame>,
  loop: LoopSite,
): boolean {
  for (const group of enclosingGroups(tokens, loop.keyword)) {
    const frame = frameByOpen.get(group.open);
    if (frame !== undefined && (frame.isFnBody || frame.declaredAsync)) return false;
    if (!isPunct(tokens, group.open - 1, '!') || !isIdent(tokens, group.open - 2, 'select')) {
      continue;
    }
    const future = selectArmFuture(tokens, group, loop.keyword);
    return future !== null && hasCancellationEvidence(tokens, future.start, future.end);
  }
  return false;
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

  // The per-file byte cap is a read permission, so it is decided where every
  // Rust read is permitted: the `allowed` of the reader's own io
  // (`workspaceRustIo`), which `read` re-checks. The walk only lists
  // candidates; the reader also reaches files the walk never filtered (a
  // `mod big;` or `#[path]` resolves through `allowed`/`read`), and a cap on
  // walk candidates alone reported such a file skipped while the reader read,
  // classified and claimed it whole. The size is the containment owner's
  // answer, asked once per path; a refused path is one observation and lands
  // in the summary's `refused`, so the scan is not reported clean.
  const byteCapVerdicts = new Map<string, boolean>();
  const withinFileByteCap = (path: string): boolean => {
    if (!path.endsWith('.rs')) return true;
    const known = byteCapVerdicts.get(path);
    if (known !== undefined) return known;
    const bytes = workspaceFileBytes(workspaceRoot, path);
    const within = bytes <= MAX_FILE_BYTES;
    byteCapVerdicts.set(path, within);
    if (!within) {
      observations.push({
        id: `${TOOL_ID}:skipped:${path}`,
        type: 'rust_runtime_scan_refusal',
        path,
        details: { reason: 'file_over_byte_cap', bytes, cap: MAX_FILE_BYTES },
      });
    }
    return within;
  };
  const containedRustIo = workspaceRustIo(
    workspaceRoot,
    (path) => pathAllowedBySnapshot(workspaceRoot, path, input) && withinFileByteCap(path),
  );
  let totalBytes = 0;
  const rustIo: RustWorkspaceIo = {
    exists: containedRustIo.exists,
    allowed: containedRustIo.allowed,
    read: (path) => {
      const text = containedRustIo.read(path);
      totalBytes += Buffer.byteLength(text, 'utf8');
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`${TOOL_ID}: the scan passed the ${MAX_TOTAL_BYTES} byte budget`);
      }
      return text;
    },
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
    const frameByOpen = new Map(frames.map((frame) => [frame.open, frame]));
    // The file context says only that the file ships. Inside it, the one
    // Rust reader's testSpans marks what does not: the file's own
    // `#[cfg(test)]` items, `#[test]` / `#[<path>::test]` fns, and
    // `macro_rules!` templates (code only once expanded, where the expansion
    // site decides the async context and statement boundaries every rule
    // reads). No rule claims an anchor inside one of those spans.
    const notShipped = testSpans(tokens);
    const ships = (index: number): boolean =>
      !notShipped.some((span) => span.start <= index && index <= span.end);

    // ------------------------------------------------------ detached_task
    for (const site of spawnSites(tokens)) {
      if (!ships(site.pathStart)) continue;
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
    // Long-lived means the loop waits on the executor (an `.await` in its
    // span) and nothing ends it: no cancellation evidence in the span; no
    // bound its rounds pass (a fixed deadline or a `while let Ok(…)` timeout
    // in the `while` condition, or on every round that goes around again an
    // exit check on a fixed deadline or a capped counter it advances); no
    // timeout around the async block it runs in; and it is not the drain a
    // select! shutdown arm runs once the task has observed the shutdown.
    const loops = loopSites(tokens);
    for (const loop of loops) {
      const { kind, keyword, close } = loop;
      if (kind === 'for' || !ships(keyword)) continue;
      const frame = enclosingFrame(frames, keyword);
      if (frame !== null && !frame.asyncContext) continue;
      const awaitAt = firstAwait(tokens, loop);
      if (awaitAt === null) continue;
      if (hasCancellationEvidence(tokens, keyword, close)) continue;
      if (exitBounded(tokens, loops, loop)) continue;
      if (runsInsideTimeout(tokens, frameByOpen, loop)) continue;
      if (inShutdownArm(tokens, frameByOpen, loop)) continue;
      const line = tokens[keyword]?.line ?? 1;
      const awaitLine = tokens[awaitAt]?.line ?? line;
      const endLine = tokens[close]?.endLine ?? line;
      emit(
        RULES.uncancellable_long_lived_loop,
        file.path,
        line,
        endLine,
        kind,
        kind,
        `\`${kind}\` at line ${line} waits on the executor (\`.await\` on line ${awaitLine}) in async ` +
          `code with no cancellation evidence: no select!, no shutdown or cancellation token, no abort ` +
          `between the keyword and line ${endLine}. Nothing bounds its rounds: no fixed deadline or ` +
          'elapsed timeout ends its `while`, no exit check on a fixed deadline or a capped counter is ' +
          'passed on every round that goes around again, no timeout wraps the async block it runs in, ' +
          'and it is no select! shutdown arm.',
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
      if (!isIdent(tokens, i, 'unsafe') || !ships(i)) continue;
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
      if (!ships(site.anchor)) continue;
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

  // One count per contracted rule, zero included: a rule with no finding is
  // an observed zero (the real-repo baseline pins `unbounded_external_io: 0`),
  // never an absent key the fixture judge cannot tell from a missing rule.
  const findingCounts = new Map<RustRuntimeRule, number>(
    Object.values(RULES).map((projection) => [projection.rule, 0]),
  );
  for (const finding of findings) {
    findingCounts.set(finding.rule, (findingCounts.get(finding.rule) ?? 0) + 1);
  }
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
      findings: Object.fromEntries(findingCounts),
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
